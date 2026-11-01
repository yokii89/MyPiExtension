# 03 · newapi 模型能力匹配（pi-ai 内置目录）

> 状态：**已实施（2026-10-28）**：`reasoning` + `input`（多模态）+ 保守 `contextWindow`；
> `maxTokens` / `thinkingLevelMap` 未接
> 关联：`packages/yoki-newapi/capabilities.ts`、`packages/yoki-newapi/index.ts`
> 背景：中转站的 `GET /v1/models` 只返回 `id/object/created/owned_by/supported_endpoint_types`，
> 没有 reasoning / 模态 / 上下文窗口；扩展以前对全部模型写死 `reasoning: true`、1M 上下文，
> 视觉能力靠 id 正则猜。

## 1. 问题

`newapi` 是用户自配的中转 provider，能力无法从网关获得。pi-ai 的内置目录里，
官方模型带有 `reasoning`、`input`、`contextWindow`、`maxTokens` 等字段，但目录按
provider 组织，`newapi` 不在其中，直接 `getModel("newapi", id)` 查不到。

旧行为导致：

- 非推理模型（gpt-4o / gpt-4.1）也显示 5 档思考；
- Claude / DeepSeek 等明明支持图片，却被 id 正则判成纯文本，PiDesk 弹出
  「模型目录未声明支持图片」；
- 所有模型上下文都是 1M，gpt-4o（128k）被高估 8 倍，直接影响 pi 的压缩时机与
  PiDesk 的上下文占用展示。

## 2. 决策

在注册 provider 时，把模型 id 与 pi-ai 内置 chat 目录做**精确 ID 匹配**，按字段分别处理：

- **继承 `reasoning`**：API 无关；厂商目录优先；未命中回退 `true`。
- **继承 `input`**（`text` / `image`）：API 无关；厂商目录优先；未命中保留 id 正则猜测。
  这修复了 35 个被漏报的视觉模型，且本数据集中没有反向误报。
- **保守继承 `contextWindow`**：只有**所有**精确候选目录都给出相同值，且该值低于
  当前回退值（默认 1M）时才采纳；冲突或更高时保持回退。这样能修 17 个明确的
  高估（gpt-4o 128k、Claude 200k、GPT-5.1/5.2 400k、GLM 200k），又不会把
  `gpt-5.4`（272k ↔ 1.05M）误降到某一侧。
- **不继承 `maxTokens`**：51 个目录值高于当前 64k 预算，10 个更低，14 个冲突；
  调高输出上限可能触发上游 400，保持扩展预算，例外交给 `models.json` 覆盖。
- **不继承 `thinkingLevelMap` / `compat` / `samplingParams*`**：API 特定。
- **不继承 `cost`**：中转站价格与官方不同。
- **不做模糊匹配**：不剥 `-chat` / 日期 / 任意后缀（`gpt-5.2` 不能匹配 `gpt-5.2-chat`）。
- 匹配在**注册时运行时 overlay**，不写回 `newapi-models.json`；缓存字段只作回退。

## 3. 覆盖率（本机 116 个 newapi 模型，pi-ai 1.4.0）

精确 ID 命中 **76 / 116**；未命中 40 个，其中约 24 个是 image / video / embedding / tts，
其余是目录里没有的新模型（gpt-6.1-terra、kimi-k3.1-pro、doubao-* 等）。

| 字段 | 命中情况 |
|---|---|
| `reasoning` | 73 true / 3 false（gpt-4o、gpt-4.1、gpt-chat-latest）；同 ID 多目录 0 冲突 |
| `input` | 64 个 text+image、11 个 text、1 个冲突（glm-5.3-flash，厂商优先取 image）；当前正则有 35 个漏报、0 个反向误报 |
| `contextWindow` | 17 个候选一致且低于 1M（采纳）、18 个一致但高于 1M（保持 1M）、21 个等于 1M、20 个冲突（保持 1M，如 gpt-5.4 272k ↔ 1.05M、glm-5 202752 ↔ 204800） |
| `maxTokens` | 未继承：7 个一致且更低、41 个更高、14 个等于 64k、14 个冲突 |

## 4. 实现

- 新增 `packages/yoki-newapi/capabilities.ts`：
  - `buildCapabilityIndex(entries)`：按精确 id 分组；`reasoning` / `input` 取厂商优先候选；
    `contextWindow` 仅当组内全部候选一致时写入索引；
  - `resolveContextWindow(fallback, hit)`：只有目录值低于 fallback 时才采纳；
  - `ensureBuiltinCapabilityIndex()`：动态 import `@earendil-works/pi-ai/providers/all`，
    失败缓存 `null` 并回退；每进程一次；
  - `builtinCapabilitiesFor(id)`：未命中返回 `undefined`。
- `index.ts`：
  - `registerProxyProvider` / `refreshModels` 先 `await ensureBuiltinCapabilityIndex()`；
  - `toProviderModels` overlay `reasoning` / `input` / `contextWindow`；
    `maxTokens`、`cost` 保持扩展自己的值；
  - `newapi-models.json` 的字段只作回退。
- `models.json` 的 `modelOverrides` 仍是最高层。

## 5. 验证

- `npm run check`（biome 292 + tsc base）通过。
- `npm run test:yoki-newapi`：3 个文件 **59 例**全绿；`capabilities.test.ts` 9 例覆盖
  精确匹配、厂商优先、context 一致/冲突、只降不升、未知回退、真实目录集成。
- pi-ai 目录冷加载约 **128ms / 1599 模型**（每进程一次）。
- 真实 pi RPC（本地扩展 + `--no-session`，不发模型请求）：

| 模型 | reasoning | input | contextWindow | maxTokens | levels |
|---|---|---|---|---|---|
| `gpt-4o` | false | text+image | **128000** | 65536 | `["off"]` |
| `gpt-4.1` | false | text+image | 1000000（目录值更高，保持） | 65536 | `["off"]` |
| `claude-opus-4-6` | true | text+image | 1000000 | 65536 | 5 档 |
| `gpt-5.2` | true | text+image | **400000** | 65536 | 5 档 |
| `gpt-5.4` | true | text+image | 1000000（冲突，保持） | 65536 | 5 档 |
| `glm-5` | true | text | 1000000（冲突，保持） | 65536 | 5 档 |
| `deepseek-v4.1-flash` | true | text+image | 1000000 | 131072（models.json 覆盖） | 5 档 |
| `gpt-6.1-terra`（目录外） | true（回退） | text（正则） | 1000000 | 65536 | 5 档 |

## 6. 未做 / 后续

1. **`thinkingLevelMap`**（P1）——只有候选条目的 `api` 与扩展实际使用的 API
   （openai-completions / openai-responses）一致时才可考虑继承；需要先在真实网关
   验证 `max` / `xhigh` 是否被接受。
2. **`maxTokens`**——如要做，建议同样只在「所有候选一致且更低」时下调；
   调高保持 64k。
3. **`glm-5` 这类 1% 级 context 冲突**（202752 vs 204800）在“完全一致”策略下仍保持 1M，
   用户可用 `modelOverrides` 修正；若以后要放宽，可改为「所有候选均低于 fallback 时取厂商值」。
4. `name` 可继承（展示名，低价值）；`cost` / `promptCache` / `inputLimits` /
   `samplingParams*` 不继承。
5. 40 个未命中里约 24 个是 image / video / embedding / tts，目前仍被注册为 chat 模型；
   这是独立问题，不在本次匹配范围。
