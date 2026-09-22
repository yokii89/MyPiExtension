# Completion audit

This audit records evidence for the Phase 1 Pi-managed delivery. It is not a claim that every item in `TASK.md` is complete.

## Proven

| Requirement | Evidence |
| --- | --- |
| Managed targets are non-hidden `skills/codex-managed/<name>/` directories. | `ManagedSkillInstaller.targetFor()` and installer tests. |
| The audited default Pi-adapted base assets (`plugin-creator`, `skill-creator`) are installable. | `BUNDLED_SKILLS`, `catalog.test.ts`, and the all-skill Pi loader smoke. |
| Managed writes use a plan, canonical containment, staging, hashes, backup recovery, and conservative uninstall. | `installer.ts` and installer tests for collision, drift, missing targets, unmanaged targets, links, and orphaning. |
| The manifest records schema, extension/Pi/Codex versions, bridge state, source hashes, recovery state, and loader state. | `types.ts`, `manifest.ts`, and installer tests. |
| Pi commands remain the execution mechanism. | Browse details prefill only Pi's native `/skill:<name>` command; Pi expands the selected skill. |
| Browse, details, management, doctor, plan, confirmation, cancellation, width handling, and keybinding use have component tests. | `skills-panel.test.ts`. |
| A real Pi RPC smoke discovers the managed skill at its canonical `SKILL.md` path. | `npm run test:pi-smoke`. |
| The npm package contains only the adapted asset and extension sources. | `npm pack --dry-run`. |

## Deliberately not implemented

| Item | Reason |
| --- | --- |
| Writes to `settings.json` for a Codex bridge. | The package must not alter global Pi settings without explicit user confirmation and a safe local settings-edit policy. |
| Copying or updating a user's `~/.codex/skills`, `~/.agents/skills`, or `.system` assets at runtime. | The adapted source snapshot is package content; local Codex caches remain read-only external state. |
| Executing retained Codex-only helpers as Pi runtime dependencies. | Adapted skill bodies explicitly gate or exclude helpers whose capability contracts are not available in Pi. |
| GitHub URL, marketplace, plugin, or remote updates. | They are outside the first-phase trusted-source boundary. |

## Still required before a full TASK completion claim

1. Product decision: whether to implement a read-only Codex bridge audit and manual `settings.skills` configuration guide, or retain documentation-only bridge guidance.
2. Manual interactive acceptance in clean-home, existing-Codex-home, same-name collision, and read-only-home environments. The automated loader smoke covers discovery after a managed install, but it is not a substitute for all four manual environments.
