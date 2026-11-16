# 06 · Bash 作业守护：让 bash 有第三态「后台作业」

| 项 | 内容 |
| --- | --- |
| 状态 | 已实施（P0-a/b/c + P1-a/b/c 主体，2026-11-06；`long` 宽限期见 §7；回声与投递竞态修复见 §8–9；P1 的进度正则与 P2+ 端口探测未做） |
| 包 | `packages/pi-bash-jobs`（`@yoki/pi-bash-jobs`） |
| 上游设计 | PiDesk `docs/design/129-Bash作业守护与进度巡检扩展.md`（决策 D1–D9）、`docs/design/132-后台事件监听watch.md`（只落 seam） |
| 验证 | 18 文件 280 例单测（含真实 AgentSession 的 4 个投递场景）+ 真 `pi --mode rpc` 载入验证（见 §5） |

## 1. 解决什么

pi 的 bash 只有两种结局：**阻塞到退出**、**超时被杀**。dev server、15 小时下载、`ffmpeg` 两者都不是——
一个会永久占住 turn（bash 没有默认超时，模型忘了写 `&` 就是现场），一个会被 timeout 误杀。

这个包把 bash 扩成三态，核心不变量来自 129 §4：**默认只让路，不杀**。
唯一会 kill 的两条路径是「调用方显式给了 `timeout`」与「人或模型主动停」。

## 2. 与 129 的对照（逐条落地情况）

| 129 条目 | 状态 | 说明 |
| --- | --- | --- |
| D1 替换内置 bash | ✅ | 注册同名 `bash` 覆盖内置（`_refreshToolRegistry` 让扩展定义后置覆盖）；`replaceBuiltinBash:false` 逃生阀 |
| D2 `finish` 到软预算转 detach | ✅ | `policy.nextWaitAction`，先 idle-detach 后 budget |
| D3 pi 退出保活 + 快照 | ✅ | 子进程**不进 pi 的 tracked children**（自查 spawn），`session_shutdown` 落快照 |
| D4 唤醒时机 `followUp` | ✅ | 可配 `wakeOnExit`；阻塞调用正常返回时不发唤醒（同一件事不报两遍） |
| D5 自动 kill 卡死默认关 | ✅ | 策略里根本没有这条路径 |
| D6 `inspect` 带 `waitMs` | ✅ | 上限 `inspectWaitMaxMs`(120s)，任一行新输出或作业结束即返回 |
| D7 PiDesk 渲染 `role:"custom"` | ⏳ | 跨仓，归 PiDesk P2；本包已按 `customType:"bash-job"` 发出 |
| D8 命名 `tool_execution_inspect_output` | ✅ | 与 pi 事件族同构 |
| D9 同包 P3 追加 doc 132 `watch` | ⏳ | 本轮只落三个 seam（§4） |
| P0-a 纯模块 | ✅ | `classify` / `policy` / `ring` |
| P0-b bash execute + 注册表 + 软预算 | ✅ | `runBash` / `jobs` / `shell` |
| P0-c inspect（tail/cursor/grep） | ✅ | `inspect` / `inspectTool` |
| P1-a `\r` 切行 | ✅ | ring 内 `\r\n` 合成一处、单 `\r` 也算换行 |
| P1-a 进度正则 + `progress` 字段 | ❌ | 未做：先跑真机看 `tail` 够不够用，避免凭空设计字段 |
| P1-b 完成唤醒 + `bash_job_stop` | ✅ | `wake` 队列 + `stop`/`stopTool` |
| P1-c 快照 + 孤儿接管 | ✅ | `persist`；恢复的 `running` 一律 `orphaned`（退出码不可观测，不装还在等） |
| P2 PiDesk 渲染/徽标 | ⏳ | PiDesk 仓 |
| P2+ 端口探测 | ❌ | 刻意不做：PiDesk 已有唯一 `netstat` 口径，两套探测会打架 |

## 3. 实现上的三处偏离（都有理由）

**① 没有复用 `createLocalBashOperations()`，改为自己 spawn。**
129 §7.1/§6.3 建议复用它的 termination。但它的 `exec()` 有两个性质与需求冲突：
进程会 `trackDetachedChildPid`（pi 退出时 `killTrackedDetachedChildren()` 会把 dev server 杀掉），
且 promise 只在退出时 resolve（拿不到早退）。要「不杀服务」就必须自己持有子进程。
因此 `shell.ts` 复刻 pi 的平台行为（`getShellConfig()` 取 Git Bash、Unix `detached`、
Windows `taskkill /F /T` 用 System32 绝对路径），只是**不登记**到 pi 的跟踪表。

**② `bash_job_stop` 的 graceful 在 Windows 就是 tree-kill。**
Windows 没有进程树 SIGTERM。回执照实说「杀了树」，不假装优雅退出。
Unix 上先 `SIGTERM` 到进程组，`graceMs` 内没退再强杀。

**③ `timeout` 与 `mode` 同时给时，`timeout` 被忽略并写在回执里。**
129 §5.1 的优先级是 `mode` > `timeout`，但两者都给了却没有说明就是坑。
`mode=detach|long` 的回执明确写 “the timeout=Ns you passed is ignored”。

## 4. 给 doc 132 预留的三个 seam（本轮只留口，不做 `watch` 工具）

1. `jobs.onJobOutput(job, listener)`——按行订阅，132 的 `job` 源挂这里（不许读私有 ring）。
2. `wake.ts` 的合批队列——作业结束唤醒与将来的条件命中走同一个窗口/同一个每小时闸。
3. `persist` 快照的 `watchers: []` 字段——先留位置，回显「监听已失效」时有处可读。

## 5. 验证

- **单测**：`npx vitest run packages/pi-bash-jobs` → 18 文件 280 例通过。覆盖分类（含 `cd x &&`、
  `sudo -u`、`npx`、Windows 全路径、`docker compose up -d` 反例、curl 探测反向信号）、状态机转移表
  （先 warn 后 detach、explicit timeout 抢先于 detach、`long` 宽限窗内同步返回）、环形缓冲
  （`\r`、跨块多字节、字节/行上限、cursor 丢失标记、未提交尾行）、注册表（id/TTL/恢复为 orphan、
  已读状态单调推进）、唤醒合批与每小时闸、唤醒投递前的回声复查、持久化圆环比、工具 schema 与
  PI_* 环境注入、真实 spawn/exit/kill。
- **前一轮覆盖率记录（§9 修改前）**：本包 94.00% 语句 / 86.47% 分支 / 92.74% 函数 / 96.58% 行；当时仓库全局阈值（87/79/89/88）全绿。本轮另按仓库 pre-push 钩子执行全量覆盖率检查。
- **真 pi 载入**：`pi --mode rpc -e ./packages/pi-bash-jobs/index.ts` 启动，
  `getAllTools()` 里 `bash` 的 `sourceInfo.path` 指向本包、schema 含 `mode`——
  即覆盖生效、`tool_execution_inspect_output` 已注册（用一次性扩展打印后删除，不入库）。
- **未做的真机项**（转 PiDesk 侧验收）：`pnpm dev` 起服务后 PiDesk 工具行/后台进程面板的观感；
  Windows 上 `powershell -c "echo 中文"` 的编码（129 §12 第 3 条）。

## 6. 已知边界

- **孤儿不可等退出码**：重启后只能看 tail；`pid` 存活仅用于提示措辞（「上次的服务还在跑」）。
- **重启不重建在跑的作业**：它们已不在本进程的句柄里，装「还在盯着」才是撒谎。
- **`bash_job_stop` 不能停孤儿**：没有句柄，回执如实说停不了。
- **事件层的 `tool_execution_update`**：沿用 pi 的白名单链路，PiDesk 侧零协议改动；早退后不再推 update
  （否则 UI 会以为调用还活着），作业继续写自己的 ring。

## 7. `long` 的宽限期（2026-11-11）

**问题**：`mode=long` 原本无条件立即返回。真实会话数据（本机 43 份作业快照、38 条记录）显示
`long` 全是 `mode=long (explicit)`，而真正 detach 的只有 10 条；一条普通会话因此堆了 11 条
`bash-job` 通知卡，其中大半是 20 秒内就结束的 `pnpm typecheck` / `vitest run` / `biome check`。
每条结束都会经 `wake.ts` 唤醒模型一次，对话流里就多一张「后台作业」卡。

**改法**：`long` 先原地阻塞 `longGraceSec`（默认 180s）。

| 情况 | 结果 |
| --- | --- |
| 窗口内退出 | 与 `finish` 完全相同：普通结果、无作业回执、无唤醒、PiDesk 不打后台徽标 |
| 窗口后仍在跑 | 按 `detach` 回执转后台，结束照旧唤醒（`DetachReason: "grace"`） |
| `longGraceSec: 0` | 逃生阀，恢复旧的「立即返回」 |

**默认阈值必须叠成递进关系**（`test/config.test.ts` 有断言锁定）：

| 阈值 | 旧 | 新 | 含义 |
| --- | --- | --- | --- |
| `idleWarnSec` | 120 | 300 | 静默多久弹一次 toast |
| `idleDetachSec` | 180 | 420 | 静默多久转后台（卡住管道） |
| `longGraceSec` | 20 | 180 | `long` 宽限期 |
| `finishSoftBudgetSec` | 300 | 600 | `finish` 阻塞上限 |

断言：`idleWarn < idleDetach < finishSoftBudget`，且 `longGrace < finishSoftBudget`。

`idleDetachSec` 与 `longGraceSec` **不需要**排序：`nextWaitAction` 里 `long` 走自己的分支，
在 idle 检查之前就返回，静默路径截不到它。两条链各自独立：

```
finish:  空闲 300s 提醒 → 静默 420s 转后台 → 满 600s 不管输出都转后台
long:    满 180s 转后台（窗口内退出就当普通结果）
```

**为什么 `idleWarnSec` 一并拉到 300s**：`ctx.ui.notify` 在 PiDesk 里会落成 **toast 提示条**
（`ExtensionUiDialogHost` 把 `notice` 降级 `showToast`），对跑 5 分钟的构建弹在 120s 就是干扰。
300s 提醒、420s 转后台之间留了 120s 缓冲。

**为什么不给 `detach` 也加**：dev server 本来就该一直跑，等它 20 秒就是把本扩展要消除的
「turn 被占住」原样加回来。`detach` 仍是立即返回。

**为什么改策略层而不是只改提示词**：模型对 `pnpm typecheck` 写 `mode:"long"` 是理性的误用，
光靠提示词拦不住；宽限期让这种误用**没有代价**。提示词与 README 已同步说明这一点。

**未做**：`classify` 的默认 `long` 名单（`make`、`pnpm install`、`docker build`）未收窄——
宽限期已经让这些自动分类在 20 秒内结束时不留痕，再动名单只会增加「长任务被当 `finish`
占住 turn」的反向风险。

## 8. 现场回声缺陷修复（2026-11-10）

真实会话里，一个 2–4s 的 `curl` 探测被判为 `long` 转入后台；agent 已用 `inspect_output` 读到终态并
给出结论后，下一轮仍被注入 `Bash job J-14/J-27 finished` 完成通知——两条通知 = 两个只为回「收到」的
turn。四个缺陷分别落地：

| # | 缺陷 | 修复 | 位置 |
| --- | --- | --- | --- |
| A | 探测类命令被判 `long` | 反向信号先于 long 表：`--max-time`/`--connect-timeout`/`-m` 小值（< 60s）、`-o /dev/null\|nul`、`-I`、`-w %{http_code}` | `core/classify.ts` |
| A | 误判后仍立即转后台 | `long` 宽限窗 `longGraceSec`（默认 180s）：自动分类与显式 `mode:"long"` 均在窗内退出时直接返回真实结果，见 §7 | `run/runBash.ts`、`core/policy.ts` |
| B | 已读终态仍注入完成通知 | `job.consumed` 由 inspect 与唤醒路径共享；投递前按 cursor/状态判定 news vs echo；合批、限流与忙碌等待后均重新检查 | `core/notify.ts`、`core/jobs.ts`、`core/wake.ts`、`index.ts` |
| C | 通知重放旧 tail | 只附未读行 + cursor；无新输出时明说 `Nothing to collect`，不再引导 re-read | `core/format.ts`、`index.ts` |
| D | running 的 tail 像终态 | inspect 增加 `partial` 字段与文本行；被 `tailLines` 截断时另有 `more` 提示 | `run/inspect.ts`、`tools/inspectTool.ts` |

不变量：**「已读」只有一份状态**（`Job.consumed`）——inspect 详情写入、唤醒读取；列表不写（不展示
输出），`grep` 过滤仍写入（模型明确只要匹配）。未提交尾行按文本比对，因为 cursor 只描述已提交行。
后续修复取消了基于时间窗抑制 running 读取后退出的规则，见 §9。

`longGraceSec` 沿用 §7 的统一宽限期策略；`wakeRedundantWindowMs` 已弃用，兼容读取但不再影响通知。

## 9. 延迟完成通知的二级队列竞态

检查实现确认：§8 的复查只覆盖了本扩展的合批队列。`pi.sendMessage(..., { triggerTurn: true,
deliverAs: "followUp" })` 在 Agent 忙碌时仍只是入队到 Pi 的内部 follow-up 队列；此时扩展已经丢弃
`refresh` 回调。Agent 随后读到终态，无法撤销 Pi 队列里的旧通知，因此它仍可能在最终回复后触发新轮次。
`steer` 也存在相同的二级队列边界。

修复后的投递路径：

1. 任务结束后按任务 ID 入扩展队列，合批、限流和忙碌等待期间都保留 `refresh`。
2. Agent 忙碌时不调用 `sendMessage`。`followUp` 在 `agent_before_settle`、`steer` 在 `turn_end`
   （该工具批次结果已落盘）再次检查已读状态，再直接返回 `custom_message` 边界条目和 `continue: true`。
   这样投递后没有第二个等待 Agent 处理的队列。
3. 空闲时仍用 `sendMessage` 启动轮次。`agent_settled` 只重新挂定时器，保留尚未到期的合批截止时间，
   并处理计时器在忙碌期间已经到期的通知。
4. 只读到 `running` 始终保留完成通知，不再根据退出与读取的时间距离推断“已知退出”。已读终态不可
   被之后迟到的 running 读取降级；终态读取优先于墙上时钟回拨。弃用 `wakeRedundantWindowMs`。
5. 已消费通知在限流期间也会移除，不占发送额度；同 key 替换同时更新文本与刷新函数。

新增 `test/delivery.test.ts` 覆盖成功/失败终态、只读 running、批量通知按 ID 过滤、限流重试、零合批
窗口的 long poll、会话切换与停用通知。`test/delivery-sdk.test.ts` 使用真实 `AgentSession` / 扩展运行时
和本地脚本模型验证 follow-up / steer 的已读、未读四种场景：检查实际消息条目和模型调用次数，同时确认
工具、`/bash-jobs` 命令注册；无需网络或模型凭据。
