# yoki TUI Style Guide

Yoki 系 Pi 扩展的终端界面规范。所有 glyph、状态色、分隔线都收编在
[`yoki_ui/style.ts`](./yoki_ui/style.ts)（通过 `yoki_ui/style` 导入），
它是唯一的样式 tokens 来源；本文件定义语义和使用规则。

## 核心规则

1. **禁止硬编码 SGR 颜色码**（`\x1b[31m` 之类）。颜色一律通过 pi 的
   `Theme` 语义色名获取（`theme.fg("accent", ...)` 等），与 `yoki_themes`
   主题联动。唯一豁免：`BRAND_RGB`（header 品牌色）与 `piBadge()`
   （statusline "π" 徽章），见 style.ts 的 "Brand exception" 一节。
2. **禁止在包内重定义指针/状态 glyph**。需要哪个符号，从 `yoki_ui/style`
   导入；符号语义发生变化时只改 style.ts 一处。
3. **同类元素用同一符号**。选中指针全仓统一 `❯ `；完成态回显统一 `✓`；
   列表终态标记统一 `●`（两者并存是有意的，见下表）。
4. **分隔线/分节头一律走 `rule()` / `ruleWithLabel()`**（accent 色）。
   注意：经 `ctx.ui.notify` 输出的纯文本消息不走主题渲染，保持无色即可，
   但 glyph 仍应取自 style.ts。
5. 终端协议类转义（OSC 标题/通知、光标反显 `\x1b[7m`）不属于本规范约束
   范围，但应集中定义在各自包的常量文件里，不散落在渲染逻辑中。

## Glyph 语义表

| 符号 | 常量 | 语义 |
|---|---|---|
| `❯ ` | `POINTER` / `POINTER_INACTIVE`（`"  "`） | 选中/活动行指针（宽度 2，未选中行用空白对齐） |
| `✓` | `GLYPH_SUCCESS` | 成功/完成（操作结果回显） |
| `✗` | `GLYPH_ERROR` | 失败/错误 |
| `⚠` | `GLYPH_WARNING` | 警告（配合 `warning` 色） |
| `○` | `GLYPH_PENDING` | 排队/未开始；也用于"已中止"的结果回显 |
| `◐` | `GLYPH_RUNNING` | 进行中 |
| `●` | `GLYPH_DONE` | 列表中的完成终态标记 |
| `⊘` | `GLYPH_DELETED` | 已删除/丢弃 |
| `⋯` | `GLYPH_ACTIVITY` | 进行中但无进度可言的活动 |
| `…` | `ELLIPSIS` | 截断省略号 |

Spinner：行内组件统一用 `SPINNER_FRAMES`（`◐◓◑◒`，约 150ms/tick）。
写入终端标题的场景（如 warp-notify 的 tab 标题）可用 braille 帧，但帧表
应集中定义。

## 状态 → 颜色映射

两套语义表，按场景选用（值是主题语义色名的子集）：

- `STATUS_GLYPH` + `STATUS_COLOR` —— 队列式生命周期（todo 等任务列表）：
  `pending → dim`、`inProgress → warning`、`completed → success`、
  `deleted → muted`。
- `RESULT_GLYPH` + `RESULT_COLOR` —— 操作结果回显（请求、抓取、校验）：
  `success → success`、`error → error`、`running → warning`、
  `aborted → muted`。

"pending 用 `dim`、aborted/deleted 用 `muted`"的区分是有意的：前者是
"还没轮到"，后者是"不会再发生"。

## Helper

- `rule(theme, width)` —— accent 色 `───` 横线。
- `ruleWithLabel(theme, width, label)` —— `─── Label ─────…` 带标签分节头。
- `stripAnsi(text)` —— 剥离 SGR / OSC8 / APC 序列（测量、边框检测用）。

## 接入方式

1. 包的 `package.json` 增加依赖 `"yoki_ui": "*"`。
2. 从 `yoki_ui/style` 导入 tokens：

```ts
import { POINTER, RESULT_COLOR, RESULT_GLYPH, ruleWithLabel } from "yoki_ui/style";
```

包内有既有样式模块的（如 yoki-todo 的 `view/format.ts`、skills 的
`panel-style.ts`），保留其公共 API、内部改为引用共享 tokens，消费方无需
改动。

Telegram 端（pi-telegram-main）不适用本规范，见其
[`docs/ui-style.md`](../pi-telegram-main/docs/ui-style.md)；但 emoji 语义
（选中 `✓`、删除 `🗑` 等）应与本表的语义保持一致。

## 适用范围豁免

以下场景不受共享 tokens 约束，属合理自持：

- **组件内部结构字符**：带边框组件的 `┌─┐│└┘`（如 ask-user-question 的
  preview box）、树形缩进 `├─/└─`（todo overlay）、yoki-ui header 的圆角
  边框与 logo。这些是组件自身的绘制逻辑，不是跨包共享的语义符号。
- **领域动作前缀**：如 todo 的 `ACTION_GLYPH`（`+ → × › ☰ ∅`）标记工具
  调用动作，与选中指针/状态语义无关。
- **终端协议转义**：OSC 标题/通知、光标反显 `\x1b[7m` 等（warp-notify、
  inline input），不是样式，但应集中定义在包内常量里。
- **非终端媒介**：pi-telegram-main（HTML）与 web 页面（如 curator
  page）各有一套 UI 规范，见各自文档。
- **标题栏 spinner**：写入终端标题的 braille 帧（warp-notify、
  window-title）与行内 `SPINNER_FRAMES` 是不同场景，帧表留在各自包内。
