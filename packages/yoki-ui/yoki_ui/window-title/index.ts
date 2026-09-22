/**
 * yoki_ui window-title - cross-window agent feedback via terminal title +
 * end/intervention notify + BEL (host tab-bell side effect).
 *
 * Spec: docs/setWindowTitleUI.md
 *
 * Surfaces owned here:
 *   - ctx.ui.setTitle (spin / Action Required blink / base)
 *   - OS notify (OSC 777 / 99 / Windows Toast) + BEL
 *
 * Not owned: footer, working-indicator, host tab badge drawing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBlockingTools, loadConfig } from "./config.ts";
import { createController, type WindowTitleController } from "./controller.ts";
import { baseTitle } from "./title-format.ts";
import { ASK_USER_PROMPT_EVENT, NEED_USER_EVENT, USER_DONE_EVENT } from "./types.ts";

export type { WindowTitleConfig } from "./config.ts";
export { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, normalizeConfig } from "./config.ts";
export { createController, type WindowTitleController } from "./controller.ts";
export { baseTitle, busyTitle, cwdBasename, interventionFrames, spinnerFrames } from "./title-format.ts";
export {
	ASK_USER_PROMPT_EVENT,
	type AttentionReason,
	NEED_USER_EVENT,
	type Phase,
	USER_DONE_EVENT,
} from "./types.ts";

/** Module-level controller for cross-package enter/exit without circular deps. */
let active: WindowTitleController | null = null;
let lastCtx: ExtensionContext | null = null;

export function getActiveController(): WindowTitleController | null {
	return active;
}

/** Public API - call before a blocking UI is shown. */
export function enterBusy(): void {
	if (!active || !lastCtx) return;
	active.enterBusy(lastCtx);
}

export function enterAttention(reason: "complete" | "intervention"): void {
	if (!active || !lastCtx) return;
	active.enterAttention(lastCtx, reason);
}

export function exitAttentionToBusy(): void {
	if (!active || !lastCtx) return;
	active.exitAttentionToBusy(lastCtx);
}

export function ackAttention(): void {
	if (!active || !lastCtx) return;
	active.ackAttention(lastCtx);
}

function remember(ctx: ExtensionContext): void {
	lastCtx = ctx;
}

/** Focus-in sequence when focus reporting is enabled (\x1b[?1004h). */
const FOCUS_IN = "\x1b[I";

/** Register window-title lifecycle hooks on the host extension. */
export function registerWindowTitle(pi: ExtensionAPI): void {
	const { config, warnings } = loadConfig();
	const blockingTools = getBlockingTools(config);
	const controller = createController({ pi, config });
	active = controller;

	let configWarningsShown = false;

	const pendingBlocking = new Set<string>();
	let unsubTerminal: (() => void) | null = null;
	let focusReportingEnabled = false;

	function enableFocusReporting(): void {
		if (focusReportingEnabled) return;
		try {
			process.stdout.write("\x1b[?1004h");
			focusReportingEnabled = true;
		} catch {
			/* swallow */
		}
	}

	function disableFocusReporting(): void {
		if (!focusReportingEnabled) return;
		try {
			process.stdout.write("\x1b[?1004l");
		} catch {
			/* swallow */
		}
		focusReportingEnabled = false;
	}

	function attachAckListeners(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		unsubTerminal?.();
		unsubTerminal = null;

		if (!config.complete.ackOnKey && !config.complete.ackOnFocus) return;

		if (config.complete.ackOnFocus) enableFocusReporting();

		if (typeof ctx.ui.onTerminalInput !== "function") return;

		unsubTerminal = ctx.ui.onTerminalInput((data: string) => {
			if (!controller.pendingCompleteAck) return undefined;
			if (config.complete.ackOnFocus && data.includes(FOCUS_IN)) {
				controller.ackAttention(ctx);
				return undefined;
			}
			if (config.complete.ackOnKey && data.length > 0 && !data.startsWith("\x1b")) {
				controller.ackAttention(ctx);
			}
			return undefined;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		remember(ctx);
		if (ctx.mode !== "tui") return;
		if (!configWarningsShown && warnings.length > 0) {
			configWarningsShown = true;
			for (const warning of warnings) {
				ctx.ui.notify(warning, "warning");
			}
		}
		attachAckListeners(ctx);
		// Establish calm base title without notifying
		try {
			ctx.ui.setTitle(baseTitle(pi, ctx.cwd));
		} catch {
			/* swallow */
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		remember(ctx);
		controller.enterBusy(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		remember(ctx);
		// Drain any stuck blocking markers - settled means the loop is idle
		pendingBlocking.clear();
		controller.enterAttention(ctx, "complete");
	});

	pi.on("tool_call", async (event, ctx) => {
		remember(ctx);
		if (!blockingTools.has(event.toolName)) return;
		pendingBlocking.add(event.toolCallId);
		controller.enterAttention(ctx, "intervention");
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		remember(ctx);
		if (!pendingBlocking.has(event.toolCallId) && !blockingTools.has(event.toolName)) return;
		pendingBlocking.delete(event.toolCallId);
		// If more blocking tools still open, keep intervention
		if (pendingBlocking.size > 0) return;
		// Agent typically continues after a blocking tool - resume spin
		controller.exitAttentionToBusy(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		remember(ctx);
		if (!config.complete.ackOnKey) return;
		controller.ackAttention(ctx);
	});

	// Cross-package bus + ask-user-question prompt event
	const unsubs: Array<() => void> = [];
	if (pi.events && typeof pi.events.on === "function") {
		unsubs.push(
			pi.events.on(NEED_USER_EVENT, () => {
				if (!lastCtx) return;
				controller.enterAttention(lastCtx, "intervention");
			}),
		);
		unsubs.push(
			pi.events.on(USER_DONE_EVENT, () => {
				if (!lastCtx) return;
				controller.exitAttentionToBusy(lastCtx);
			}),
		);
		unsubs.push(
			pi.events.on(ASK_USER_PROMPT_EVENT, () => {
				if (!lastCtx) return;
				// Redundant with tool_call when ask_user_question is in blockingTools;
				// enterAttention is idempotent for already-blinking intervention.
				controller.enterAttention(lastCtx, "intervention");
			}),
		);
	}

	pi.on("session_shutdown", async () => {
		unsubTerminal?.();
		unsubTerminal = null;
		for (const u of unsubs) {
			try {
				u();
			} catch {
				/* swallow */
			}
		}
		unsubs.length = 0;
		disableFocusReporting();
		controller.shutdown();
		active = null;
		lastCtx = null;
		pendingBlocking.clear();
	});
}
