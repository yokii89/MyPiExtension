# 06 · Bash 作业守护：让 bash 有第三态「后台作业」

| 项 | 内容 |
| --- | --- |
| 状态 | 已实施（P0-a/b/c + P1-a/b/c 主体，2026-11-06；P1 的进度正则与 P2+ 端口探测未做；`long` 宽限期见 §7） |
| 包 | `packages/pi-bash-jobs`（`@yoki/pi-bash-jobs`） |
| 上游设计 | PiDesk `docs/design/129-Bash作业守护与进度巡检扩展.md`（决策 D1–D9）、`docs/design/132-后台事件监听watch.md`（只落 seam） |
| 验证 | 163 例单测 + 真 `pi --mode rpc` 载入验证（见 §5） |

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

- **单测**：`npx vitest run packages/pi-bash-jobs` → 13 文件 163 例通过。覆盖分类（含 `cd x &&`、
  `sudo -u`、`npx`、Windows 全路径、`docker compose up -d` 反例）、状态机转移表（先 warn 后 detach、
  explicit timeout 抢先于 detach）、环形缓冲（`\r`、跨块多字节、字节/行上限、cursor 丢失标记）、
  注册表（id/TTL/恢复为 orphan）、唤醒合批与每小时闸、持久化圆环比、工具 schema 与 PI_* 环境注入、
  真实 spawn/exit/kill。
- **覆盖率**：本包 92.27% 语句 / 82.11% 分支 / 89.69% 函数；仓库全局阈值（87/79/89/88）仍全绿。
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
