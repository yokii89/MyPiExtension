# Changelog

All notable changes to `@yoki/yoki-plan` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- PiDesk composer mode-dropdown registration (`registerPlanModeOnDesktop`, `access-mode` slot per PiDesk docs/design/14): input-bar chip lists 计划模式, desktop clicks activate the real tool gates, and TUI toggles (`/plan`, Shift+Tab, session resume) sync the chip back via `PlanModeControllerHooks.onModeChange`. Soft-fallback to `/plan` on old hosts / terminal.
- `createPlanModeSupervisor` — thin wrapper over `@pidesk/view-sdk` `superviseAccessMode`.

### Changed
- Desktop chip lifecycle moved into the SDK: `acquireProcessViewClient` + `superviseAccessMode` own re-registration, backoff, in-process lease, and `session_shutdown` release (no force-dispose of the shared pipe). See PiDesk docs/design/15.
- `/model` dual-axis selector: thinking depth shown once as a bottom control strip; list rows no longer repeat depth or provider source badges.

### Removed
- Fuzzy search / typing filter from the dual-axis `/model` selector (list is navigated with ↑↓ only).
- Desktop (PiDesk) model+thinking selector view — PiDesk's input toolbar natively provides model and thinking controls; the dual-axis picker is TUI-only now.
- Post-plan desktop **modal** view — replaced by a compact **widget** docked above the input bar with four single-row action buttons.
- Hand-written desktop supervisor state machine in `index.ts` (replaced by SDK lifecycle).

### Added
- Plan/edit agent mode with `/plan` toggle, `--plan` flag, and session resume.
- Read-only tool gates in plan mode (`edit`/`write` disabled; bash allowlist + destructive block).
- `before_agent_start` plan-context injection and `context` cleanup on edit mode.
- Dual-axis `/model` selector (↑↓ model, ←→ thinking) via `ctx.ui.custom`.
- Soft bridge (`Symbol.for("@yoki/yoki-plan:bridge")`) for yoki-ui Shift+Tab and model UI interception.
- Post-plan TUI on `agent_settled` when assistant emits `Plan:` steps + `[PLAN READY]`.
- Four next-step options: execute same session, execute new session, keep exploring, save only.
- Plan artifact writer to `.pi/yoki/artifacts/plans/` (`source: yoki-plan`) via extension `fs` (not agent write tool).
- Fingerprint dedup (`lastPlanFingerprint` / `lastPlanPath`) persisted on session custom entry.
- `/plan save` force-archive of last assistant message without ready marker.
- `/plan new` fresh-session execute (command-ctx `newSession`); post-plan option 2 prefills this command when event ctx lacks session APIs.
