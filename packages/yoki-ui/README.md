# yoki_ui

Pi TUI package that merges:

- **yoki_themes** dark theme + statusline
- **static Pi header** + Codex-style input
- **window title** spinner / Action Required blink / end notify + BEL

## Default look

On session start, yoki_ui applies:

1. Theme: `yoki_themes`
2. Header: static Pi logo + model/cwd tips
3. Footer: yoki statusline
4. Editor: straight-line borders + theme text caret
5. Shared input history: Up/Down browses a global list across all pi instances (`~/.pi/agent/input-history.json`), including slash commands
6. Window title: base title (`π - [session -] cwd`); spin while busy; blink on intervention

## Install

The theme and extension are bundled with the Yoki Git package:

```bash
pi install git:github.com/yokii89/MyPiExtension
```

For local workspace development, run from the monorepo root:

```bash
npm ci
npm run check:yoki-ui
npm run test:yoki-ui
pi -e .
```

Select the theme from `/settings` if needed (package also calls `setTheme("yoki_themes")` on start).

## Commands

- `/use-yoki-ui` — apply header + statusline + Codex editor (and theme)
- `/use-claude-code-tui` — alias for `/use-yoki-ui`
- `/use-default-tui` — restore pi built-in header/footer look (shared input history still enabled)

## Plan-mode bridge (`@yoki/yoki-plan`)

When `@yoki/yoki-plan` is also loaded, the Codex-style editor soft-couples via
`Symbol.for("@yoki/yoki-plan:bridge")` (no hard dependency):

| Key | With plan package | Without plan package |
|-----|-------------------|----------------------|
| Shift+Tab | Toggle plan ↔ edit | Pi default: cycle thinking |
| `/model` / Ctrl+L | Dual-axis model + thinking UI | Pi built-in model selector |

Thinking depth is cycled with ←→ inside `/model` when the plan package is active.

## Shared input history

All submissions (normal prompts, bash `!cmd`, and slash commands like `/model`) are appended to:

```text
~/.pi/agent/input-history.json
```

- Shared across every pi instance on this machine
- Cap: 100 entries (newest first)
- Reloaded from disk the first time you press Up to browse history (so concurrent instances see each other)
- Duplicates are collapsed (resubmitting an entry moves it to the top) and writes are atomic (temp file + rename), so a crash cannot corrupt the file
- If the file is ever corrupt, it is renamed to `input-history.json.corrupt-<ts>.bak` instead of being silently overwritten

## Config

### TUI look — `~/.pi/agent/yoki-ui.json`

```json
{
  "theme": "yoki_themes",
  "statusline": {
    "icon": true,
    "directory": true,
    "gitBranch": true,
    "gitStatus": true,
    "context": "auto",
    "model": true,
    "usage": true,
    "extensionStatuses": true
  }
}
```

- `statusline.context`: `true` | `false` | `"auto"` (show above 75%)
- Invalid fields are reported by name at session start, e.g. `statusline.context: "Auto"`
- Statusline extras:
  - Merge conflicts show as a red `!N` marker (highest-priority git segment)
  - Git status refreshes after pi tool runs / bash commands, before each agent run, and on a 15s poll — external edits show up without any pi activity
  - When `@yoki/yoki-plan` is loaded and plan mode is active, a `◇ plan` badge appears next to the model

### Window title — `~/.config/yoki-window-title/config.json`

```json
{
  "windowTitle": { "animation": true, "frames": "braille", "intervalMs": 80 },
  "intervention": { "enabled": true, "blinkMs": 500, "includeBase": false, "notify": true, "sound": true },
  "complete": {
    "notify": true,
    "sound": true,
    "soundLevel": "bel",
    "titleFlash": false,
    "minBusyMs": 3000,
    "minAlertGapMs": 2000,
    "completeSoundGraceMs": 5000,
    "ackOnFocus": true,
    "ackOnKey": true
  },
  "blockingTools": ["ask_user_question"]
}
```

- Invalid fields are reported by name at session start
- `complete.soundLevel`: only `"bel"` and `"system"` are supported; `"file"` is not implemented and warns before falling back to `"bel"`

Public helpers for other extensions:

```ts
import { enterAttention, exitAttentionToBusy, ackAttention } from "yoki_ui/yoki_ui/window-title/index.ts";

// before blocking UI
enterAttention("intervention");
// after dialog + agent continues
exitAttentionToBusy();
// user viewed complete result
ackAttention();
```

Events (on `pi.events`):

| Channel | Effect |
| --- | --- |
| `yoki:window-title:need-user` | enter intervention |
| `yoki:window-title:user-done` | exit to busy |
| `yoki:ask-user:prompt` | enter intervention (compat) |

Notes:

- Print (`-p`) / non-TUI modes are no-ops for window title.
- Title strings never embed ⏰/🔔 — tab bells are a **host** side effect of BEL/notify.
- Default complete trigger is `agent_settled` (not `agent_end`) to avoid retry noise.

## Development

```bash
npm run check:yoki-ui
npm run test:yoki-ui
```

## Layout

```
yoki_ui/
  index.ts           # entry: theme + header + statusline + editor + window-title
  header.ts          # static Pi startup header
  statusline.ts      # footer statusline
  editor.ts          # CodexStyleEditor
  render-utils.ts    # pure layout/editor helpers
  config.ts          # yoki-ui.json
  window-title/      # setTitle spin / blink / notify + BEL
themes/yoki_themes.json
```

## License

MIT (see LICENSE).
