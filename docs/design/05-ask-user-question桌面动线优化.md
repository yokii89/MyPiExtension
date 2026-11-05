# 05 · ask_user_question 桌面动线优化

> 状态：**已实施（2026-11-04，扩展侧三处；真机复测待做）**
> 基线：[04-ask-user-question-pidesk界面设计稿](./04-ask-user-question-pidesk界面设计稿.html)（状态「基准稿（待优化迭代）」，本篇是其首轮迭代）
> 关联：pidesk `docs/design/126-扩展View答题列表全量展示`（同日落地：list 不再 280 内滚，选项全量可见）
> 涉及范围：`packages/yoki-ask-user-question/desktop-view.ts`（+ 测试）；**pidesk 零改动（用户拍板，见 §4）**

## 1. 动线缺口（对照基准稿逐条复核）

复核基准稿 7 屏与 desktop-view.ts 实现，发现三处缺口：

| # | 缺口 | 现状行为 | 期望 |
|---|---|---|---|
| G1 | 单选题「即答即走」拉走补充中/回改中的用户 | 点选 → 立即跳下一未答题；想补一句说明必须 ←→ 或复核页「修改」绕回，而绕回后该题**没有出路按钮**（旧实现仅多选题有「下一题」），再选同一个选项也不会前进（已答不触发） | 补充草稿在时不被拉走；绕回后有显式出路 |
| G2 | 复核页键盘陷阱 | 答完最后一题自动前进落到复核页，Host 把首焦点给面板第一个可聚焦元素 = q0 的「修改」按钮，键盘 Enter 误跳回第 1 题 | 复核页首焦点 = 提交 |
| G3 | 复核页无进度 | 未答题只能逐行读 warning | 「已答 N / M」计数（对齐 TUI 的 `N of M answered`） |

G1 的语义再澄清（实现复核时的发现）：**「先写补充文本再点选」今天就不前进**——`isQuestionAnswered` 把纯文本草稿也算已答，`!wasAnswered` 守卫已经拦住。真正的缺口是**回改路径无出路**：自动前进后 ← 回某题补文本，该题已答、再选同选项不前进、页签无按钮，只能靠 Host 本地的 ←→ 环绕切页离开。本次把单选页签补上与多选一致的显式按钮，堵住这条路。

## 2. 改动（desktop-view.ts）

1. **单选页签补显式「下一题 →」**（`buildQuestionChildren`）：`tabsMode && multiSelect` → `tabsMode`。单选/多选页签结构统一为「选项 + 自由输入 + 下一题」；被抑制/回改后的前进有唯一明确出路。单题布局不变（footer 提交）。
2. **复核页进度 + 页内提交**（`buildReviewChildren`）：children 变为「`已答 N / M`（body）→ 说明（caption）→ `提交答案`（primary button）→ 摘要行」。提交按钮**先于**「修改」行：Host 把页签落点首焦点给第一个可聚焦元素，Enter 即提交而非误跳 q0。按钮 `id:"submit"` 与 footer「提交」同 actionId——Host 对 button 节点 `sendAction(entry.id, buttonId, entry.values)`（WidgetMount.tsx:46），同一取值路径（含 flush pending changes），无新协议语义。
3. **自动前进守卫显式写出「无补充草稿」**（`runDesktopSession`）：前进条件追加 `(state.customTexts[index] ?? "").trim() === ""`。当前被 `!wasAnswered` 隐含，显式写出是防御——`isQuestionAnswered` 语义若变，选中也不得拉走补充草稿。

### 修订后的交互不变量（基准稿 6 条中第 1 条）

> **自动前进**：多题布局下单选 `list` 的「未答→已答」change **且该题自由输入无草稿** → 跳下一未答题，无则复核页。文本 + 选择 = 该答案的 notes 补充，不前进（对齐 TUI）；出路为页签显式「下一题 →」。多选勾选、自由输入、备注不触发；回改已答题不触发。

其余 5 条不变量（两段式取消、自由输入语义、提交取值、状态词入文案、回落）不变。

## 3. 与 TUI 语义对齐表

| 场景 | TUI | 桌面（改后） |
|---|---|---|
| 纯选项作答 | Enter 确认 → 前进 | 点选项 → 前进（不变） |
| 文本 + 选择（notes） | Enter 提交草稿 → 留在本题 | 先写文本再点选 → 留在本题（本次显式化 + 防御）；「下一题 →」继续 |
| 回改已答题 | 回改不前进 | 回改不前进 + 显式按钮继续（本次补齐） |
| 复核页 | 进度 `N of M answered` | `已答 N / M`（本次补齐） |
| 复核页提交 | Submit picker | 页内 primary「提交答案」+ footer「提交」（本次补齐） |

## 4. host 动线缺口——本轮不动（用户拍板 2026-11-04）

复核中确认的 PiDesk 侧缺口，**用户决定本轮不改 pidesk**，记录备后续：

| 缺口 | 事实 | 备注 |
|---|---|---|
| Esc 死键 | 浮层是 blocking view（SessionView.tsx:128 抑制「Esc 停止会话」），但 WidgetMount 不处理 Escape——按了毫无反应 | TUI 里 Esc = 两段式取消 |
| X 绕过取消守卫 | WidgetMount.tsx:64 `dismiss` → viewHost.ts:1092 先发 dismiss 事件再 `destroyView(view, "user", true)` 同步销毁——作答瞬时丢弃，两段式布防来不及 | |
| Enter 在输入框无作用 | 无 form 包装、无 keydown 处理；单题布局纯文本作答收尾只能鼠标点「提交」 | 多题布局 Enter=提交有误提交面，需按布局区分 |
| widget 切页不复位滚动 | TabsView 的滚动复位锚在 `[data-panel-scroll]`，仅 ModalMount/PanelMount/SidebarMount 携带，widgetBody 没有 | 答题列表解除 280 内滚（pidesk doc 126）后更值得补 |

若后续做，host 侧最小改法：`ViewAction` 增加 `kind:"cancel"` 或按 id `"cancel"` 约定路由 Esc/X；Enter 按「root 无 tabs 节点」限定单题布局。

## 5. 验证

- `pnpm vitest run packages/yoki-ask-user-question/test/desktop-view.test.ts`：既有用例全绿 + 新增 2 例（补充草稿抑制 + 显式出路；复核页进度与页内提交首按钮）+ 修订 1 例（单选页签按钮断言）。
- 仓库门禁：`pnpm test` / biome / typecheck。
- **待做**：真机复测（PiDesk + 装载扩展）：① 选中带补充草稿不跳页 ② 单选页签「下一题 →」可用 ③ 复核页「已答 N / M」随作答刷新、Enter（首焦点）提交 ④ 页内「提交答案」与 footer「提交」同结果。
