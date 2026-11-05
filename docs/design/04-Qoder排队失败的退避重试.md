# 04 · Qoder 排队失败的退避重试（yoki-model-busy-retry）

> 状态：**已实施（2026-11-01），2026-11-03 改为「按承诺追」**：provider 流层拦截不变，退避由
> 「30s 基指数 + 一次睡满报价」改成「长报价切 1/4 份额 + 不兜现就加大份额」；单测 51 例
> （包内四模块 100%），真机 e2e 两次（`12,8` / `205,150`）
> 关联：`packages/yoki-model-busy-retry/`、`~/.pi/agent/npm/node_modules/pi-provider-qoder/dist/index.js`
> 背景：Qoder 模型饱和时在 SSE 体内回 `10605`，PiDesk 把它渲染成
> 「模型调用失败 Qoder model is busy: request queued (10605 CALL_COUNT_LIMIT, ~30s wait, rate limit, retry-after-ms=30000)」

## 1. 问题

排队信息里已经写清楚要等 30s，但链路上没有任何一层等得到：

| 层 | 实测常量 | 为什么接不住 |
| --- | --- | --- |
| `pi-provider-qoder` 0.6.7 内部 busy 重试 | `DEFAULT_MODEL_BUSY_RETRIES = 2`、`MODEL_BUSY_MAX_WAIT_MS = 5000` | 等待被 `Math.min(5000, requestedMaxWaitMs)` 硬顶，配置再大也没用；而且 *queued* 分支抛的是 `formatQueuedBusyError()` 造的**普通 `Error`**，不是 `QoderModelBusyError`，`if (!(e instanceof QoderModelBusyError)) throw e` 直接原样上抛，一次都不等 |
| pi agent 级重试 | `retry.baseDelayMs = 2000`、`maxRetries = 3`、`retryDelayMs = base * 2^(n-1)` | 错误串含 `rate limit`，命中 `RETRYABLE_PROVIDER_ERROR_PATTERN`，于是按 2s / 4s / 8s 三次回到同一个队列——30s 还没排完，三次全废，一轮就此失败 |
| 设置改写 | 扩展只有 `ctx.getSettings()`（返回副本），`registerProvider` 才是唯一即时生效的写口 | 所以不能靠把 `baseDelayMs` 调到 30000 解决：那是全局档，一个 500 也要白等 30s |

结论：只有把等待做在 **provider 流层**，才能既等到 30s，又只对这一类错误生效。

## 2. 方案

扩展不改任何上游代码，而是在运行时把 provider 注册的 `streamSimple` 换成自己的包装，包装内部
调用原实现并在失败时重发同一个请求：

- **装在哪**：`session_start` / `before_agent_start` / `model_select` 上扫
  `modelRegistry.getRegisteredProviderIds()`，只包 `config.api === "qoder-api"` 的 provider
  （`qoder` 与 `qoder-cn` 两个 region 一起覆盖，其它网关完全不碰）。装的动作幂等：用 `WeakMap`
  记自己造出的函数，已包就跳过；provider 侧把原实现换回去（目录刷新等）时下一次事件再包上。
- **为什么能在运行时替换**：`model-runtime.registerProvider()` 是「按定义值合并、未定义的键保留」，
  只传 `{ api, streamSimple }` 就保住 models / oauth / usage；`provider-composer.streamWith()` 又写成
  `if (extension?.streamSimple && model.api === extension.api)` 优先，所以扩展注册的流函数压过内置与
  api 注册表；`prepareRequest` 在每次请求时才解析 provider，因此 `/reload` 之外也能生效。
  注意 `validateExtensionProvider()`：带 `streamSimple` 却不带 `api` 会直接抛，所以 `api` 必须原样回填。
- **转发契约**（本方案唯一有风险的地方）：`pi-agent-core/agent-loop.js` 在 `start` 事件时
  `context.messages.push(partial)`，在 `done`/`error` 时替换最后一条。于是**一次以上的事件流必须只出现
  一个 `start`**，否则历史里会留下失败那条 assistant message（多一个错误气泡、还污染上下文）。
  做法是把每次尝试的 `start` 先扣住，直到该次真的产出内容才放行；被吞掉的尝试不向消费者宣布任何事。
- **只重试「没有输出」的失败**：`reason === "error"` 且 `content.length === 0` 且命中 busy 判据，
  与 provider 自己的判断（`sawModelOutput` / 「rejected after partial output」）同一口径。
  内容已经上线就原样透传——响应已经定了，重发会重复输出。
- **放弃时原样交还**：最后一次尝试的 `start` + `error` 照原样发出，pi 自己的重试与 UI 行为完全不变。
- **中断**：等待用 `waitWithAbort(ms, options.signal)`（只 resolve、不 reject）。按 Esc 后循环再走一次
  原实现，provider 入口即 `throwIfAborted()`，于是拿到它自己产的 `aborted` 终态并透传——
  既不用伪造消息，也不会把 abort 当 busy 再重试。
- **委托方式**：用 pi-ai 的 `lazyStream(model, () => 异步生成器)`，转发、终态取值、
  「setup 抛错就合成 error 终态」都由它做（原实现在建流前抛——例如取不到凭据——也不会把流挂住）。

## 3. 退避档位与预算

> **本节是 1.21.0 的记录，已被 §6（2026-11-03）替换**：一次性睡满服务端报出的等待时长，
> 在 205s 这种长队列上会把整轮预算押在一个估计上。档位与公式见 §6。

`policy.ts` 一处常量，无配置文件、无设置项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseDelayMs` | 30000 | 首档，也是后续每档翻倍的基数（对齐 10605 报出的 ~30s） |
| `maxDelayMs` | 120000 | 翻倍档的封顶 |
| `maxServerHintMs` | 300000 | 服务端明确要等更久时允许跟到多久 |
| `maxAttemptsPerRequest` | 3 | 单个模型请求的等待次数 |
| `maxWaitMsPerRun` | 240000 | 一轮 agent run 的总等待预算，`before_agent_start` 归零 |

`delay = min( max( base * 2^(attempt-1), min(hint, maxServerHintMs) ), 本轮剩余 )`，剩余不足一档 base 就放弃。

每轮预算必须是**共享**的：包装耗尽后 pi 还会按 2/4/8s 再试 3 次，每次都会重进包装，只按请求计次
就能把等待叠成十几分钟。等待期间发一条 `notify`（`model busy: waiting 30s, retry 1/3`）；
PiDesk 侧 `src/main/session/extensionUi.ts` 已把 `notify` 当发后即忘、降级成提示条，不会变成挂起的应答。

`busyError.ts` 认的是「饱和 + 给了等待时长」，不是某一句文案：命中 `10605`
（或 `model is busy` / `request queued` / `isQueued` 且带等待提示）才算，退避时长依次取
`retry-after-ms` / `retryAfterMs` / `requested delay Nms` / `retry-after-seconds` /
`retryAfterSeconds` / `waitTime` / `~Ns wait`；毫秒档优先于取整秒档，嵌套 JSON 体外层的转义先剥掉。
`insufficient_quota` / `billing` / 上下文溢出这类不判 busy，等也白等。

## 4. 验证

单元（`packages/yoki-model-busy-retry/test/`，vitest，36 例）逐条盯住契约：

- 正常响应事件序列一字不差（`start → text_* → done`），不查退避；
- busy 后成功：转发事件里 `start` **恰好一个**，最终 message 是成功那条、`errorMessage` 不存在；
- 已产出内容后失败 / 非 busy / `aborted` 三种都不重试（`plan` 一次不调）；
- 规划器拒绝时把 `start + error` 原样交还；原实现建流前抛错时以合成的 error 终态收尾；
- 等待中被 abort：只再多走一次原实现，透传 `aborted`；
- 包装幂等、`api` 回填、只包 `qoder-api`、拿到新原实现后重新包装。

真机（本机 `~/.pi/agent`，`defaultProvider: qoder-cn`，pi 1.4.0）：

| 跑法 | 结果 |
| --- | --- |
| `pi -p "Reply with exactly: PONG" --provider qoder-cn --model Qwen3.8-Flash` | `PONG`，4.5s——包装装上后正常问答（含流式与用量）无回归 |
| 临时假 provider（`api: "qoder-api"`，前两次报同一句 10605 queued，第三次出文本）：`pi -p hi --provider busy-fake --model fake-1 -e .pi/e2e-busy/busy-fake.ts` | 三次尝试 `queued → queued → serving`，墙钟 93.7s ≈ 30 + 60，终端输出 `served after queue`，全程没有失败气泡 |

假 provider 夹具放在 `.pi/e2e-busy/`（`.pi/` 已在 .gitignore，且不在 `.pi/extensions/` 扫描路径内，
不会被自动加载），只作复现用，不属于交付物。

门禁：`npx biome check packages/yoki-model-busy-retry` 干净；`npx tsc --noEmit -p tsconfig.base.json`
无错；`npm test` 122 文件 / 1218 例全过；`npm run coverage` 全局 89.92 / 82.09 / 91.84 / 91.46
（门槛 87 / 79 / 89 / 88），本包四个模块均 100%。

## 5. 已知边界

- 首帧气泡会晚一点：包装把 `start` 扣到该内容事件之前才放行，纯排队重试期间本来就没有内容，
  所以观感是「请求在进行中」而不是先亮一个错误气泡。这是保住 transcript 干净的必要代价。
- 排队超过约 4 分钟仍会失败：届时 pi 自己的 2/4/8s 仍会补三次快重试（每次立刻被每轮预算短路），
  最终照旧报错——不做无限等待。
- 只覆盖 `10605` 这一类「给了等待时长的饱和」错误；上游若改成别的码，需要补 `busyError.ts` 的判据。
- 没做开关与配置项（`/busy-retry` 命令、settings 持久化）：判据与档位都在代码里一处可查，
  需要时再加，避免先铺一层没人的配置。（§6 补了只读的 `/busy-retry` 状态命令，仍然没有配置项。）

## 6. 复盘 2026-11-03：205s 长队列，改为「按承诺追」

### 6.1 现象

真实报错：

```
Qoder model is busy: request queued (10605 CALL_COUNT_LIMIT (p3), 15254 ahead, ~205s wait, rate limit, retry-after-ms=205000)
```

判据与解析都没问题（`isModelBusyError` = true，`retry-after-ms` 读出 205000），包装也确实拦到了——
坏在档位上。用当时的规划器打一遍这组数：

```
plan(1, 205000) = 205000 | plan(2, 180000) = 35000 | plan(3, *) = undefined
```

一次 205s 的盲睡把 240s 的每轮预算吃掉 85%，剩下的 35s 只够在「还要 180s」的队列上再撞一次，
之后同一轮里所有请求（包括 pi 自己 2/4/8s 那三次）都被预算短路，直接失败。

**根因不是没拦住，是把一个「拒绝时刻的估计」当成「确定的睡眠时长」，还一次性押上了全部预算。**

### 6.2 新策略：睡一个份额，重新问，用新数字改写计划

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `probeFraction` | 0.25 | 长等待先睡 X/4 再重发（题主的直觉） |
| `minProbeMs` | 5000 | 份额下限：每次重发都要吃一次 `CALL_COUNT_LIMIT` 记账，不能几秒一撞 |
| `maxProbeMs` | 60000 | 估计还在往下掉时的单次上限；**报价 ≤ 60s 时直接睡满报价**，短队列不值得为切分再排一次队 |
| `fallbackDelayMs` | 30000 | 完全没有数字时（`RESOURCE_LIMIT` 那类）按 30/60 翻倍，仍封顶在一个份额内 |
| `maxServerHintMs` | 300000 | 愿意追的最长承诺 |
| `drainRatio` | 0.5 | 新报价相对旧报价下降不足「已经花掉的时间 × 0.5」即视为没兑现 |
| `maxStalledProbes` | 3 | 连续几次没兑现，且队列自己的报价已超过剩余预算 → 放弃 |
| `maxAttemptsPerRequest` | 6 | 单请求等待次数（份额切小后，同样的预算能多探几次） |
| `maxWaitMsPerRun` | 240000 | 每轮总等待预算不变 |

三条规则：

1. **睡满 or 切分**：报价 ≤ `maxProbeMs` 就睡满；更长才按 `probeFraction` 切。同一个队列的总耐心没变，
   变的是「一次押注」改成「几次小额下注 + 每次拿到新数字」。
2. **不兑现就加大份额**：份额按 `0.25 → 0.5 → 1.0` 升级。判据是时间而不是次数——拿上一次的报价、
   上一次报的时刻，跟现在的报价比，`旧报价 - 新报价 < 流逝时间 × drainRatio` 就算 stall；
   `15254 ahead → 20000 ahead`（排队位置变大）无论速率都算 stall，因为那正是「重发把我們挤到队尾」的特征。
   stall 一旦成立，探测已被证明买不到东西，就该老实睡它报的那个数。
3. **不追了两种情况**：`stall ≥ maxStalledProbes` 且队列自己的报价已超出剩余预算（再等也追不上）；
   或者预算余额 < `minProbeMs`。放弃时照旧原样交还 `start + error`，pi 自己的重试与 UI 行为不变。

同一 205s 队列（预算 240s）新曲线下：`51.25s → 102.5s → 86.25s(剩余预算)`，三次重发、每次都有新数字；
如果队列按它说的速率在排（205→150→100→50），则是 `51.25 → 37.5 → 25 → 50`，共 163.75s 就轮到。

`busyError.ts` 新增 `parseBusyQueueHint()`：除了等待时长，还把 `N ahead` 的排队位置一并读出来（provider
`formatQueuedBusyError` 已经印了），既给规划器当速率证据，也让提示能说出「谁在前面」。

### 6.3 可观测

新增只读命令 `/busy-retry`：包了哪些 provider、本轮已等 / 预算、最后一次决策、当前份额规则。
之前的「好像没拦住」只能从日志倒推，现在一眼能看出拦没拦、等到哪一步。

### 6.4 验证

单测 51 例（包内四模块 100%），新增盯住：报价 ≤ 60s 睡满、长报价切成 25%、不兑现时 25→50→100 升级、
`ahead` 变大即 stall、兑现后 stall 计数清零、无数字时按 `fallback` 翻倍、stall+预算不够时放弃、
以及真实 205s 文案的端到端三段曲线（`retryStream.test.ts` “with the real planner and a 205s queue”）。

真机（本机 pi 1.4.0 + 假 provider，`BUSY_FAKE_QUEUES` 控制每次报的时长）：

| 报的数 | 期望 | 实测 |
| --- | --- | --- |
| `12,8` | 5s + 8s 后出文本 | `served after queue`，墙钟 21.3s |
| `205,150` | 51.25s + 37.5s 后出文本 | `served after queue`，墙钟 128s |

（旧策略在第二行会是：睡 205s → 重发 → 只剩 35s → 再撞 → 放弃，而队到 150s 时其实已经能服务了。）
