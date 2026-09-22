import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, type YokiUiConfig } from "./config.ts";
import { createCodexStyleEditor, disposeActiveEditor, SharedHistoryEditor } from "./editor.ts";
import { applyHeader, disposeActiveHeader } from "./header.ts";
import { cursorOpenFromFgAnsi } from "./render-utils.ts";
import { createStatuslineRuntime } from "./statusline.ts";
import { registerWindowTitle } from "./window-title/index.ts";

export {
	ackAttention,
	enterAttention,
	enterBusy,
	exitAttentionToBusy,
	getActiveController,
} from "./window-title/index.ts";

type LookMode = "yoki" | "default";

let lookMode: LookMode = "yoki";
/** Last live ExtensionContext for bridge callbacks from the custom editor. */
let lastCtx: ExtensionContext | null = null;

function remember(ctx: ExtensionContext): void {
	lastCtx = ctx;
}

function applyTheme(ctx: ExtensionContext, themeName: string): void {
	if (ctx.mode !== "tui") return;
	const result = ctx.ui.setTheme(themeName);
	if (!result.success && result.error) {
		ctx.ui.notify(`yoki_ui: theme "${themeName}" not applied (${result.error})`, "warning");
	}
}

function applyEditor(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;

	if (lookMode === "default") {
		disposeActiveEditor();
		// Keep shared Up/Down history even without Codex styling.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return new SharedHistoryEditor(tui, theme, keybindings);
		});
		return;
	}

	const cursorOpen = () => cursorOpenFromFgAnsi(ctx.ui.theme.getFgAnsi("text"));
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		return createCodexStyleEditor(tui, theme, keybindings, cursorOpen, {
			getCtx: () => lastCtx,
		});
	});
}

function applyYokiLook(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	statusline: ReturnType<typeof createStatuslineRuntime>,
	config: YokiUiConfig,
): void {
	if (ctx.mode !== "tui") return;
	lookMode = "yoki";
	applyTheme(ctx, config.theme);
	applyHeader(pi, ctx);
	statusline.applyFooter(ctx, config.statusline);
	applyEditor(ctx);
}

function applyDefaultLook(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	lookMode = "default";
	disposeActiveHeader();
	ctx.ui.setHeader(undefined);
	ctx.ui.setFooter(undefined);
	ctx.ui.setWorkingIndicator(undefined);
	applyEditor(ctx);
}

export default function (pi: ExtensionAPI) {
	const statusline = createStatuslineRuntime(pi);
	statusline.registerHooks();
	registerWindowTitle(pi);
	let sessionConfig: YokiUiConfig | undefined;

	pi.on("session_start", async (_event, ctx) => {
		remember(ctx);
		const { config, warning } = await readConfig();
		sessionConfig = config;
		if (warning) ctx.ui.notify(warning, "warning");

		// Defer so we win over other session_start TUI customizers.
		const apply = setTimeout(() => {
			applyYokiLook(pi, ctx, statusline, config);
		}, 0);
		apply.unref?.();
	});

	pi.on("session_shutdown", () => {
		lastCtx = null;
		disposeActiveHeader();
		disposeActiveEditor();
	});

	pi.registerCommand("use-yoki-ui", {
		description: "Switch to yoki_ui look (Pi header + yoki statusline + Codex-style input)",
		handler: async (_args, ctx) => {
			remember(ctx);
			const config = sessionConfig ?? (await readConfig()).config;
			sessionConfig = config;
			applyYokiLook(pi, ctx, statusline, config);
			ctx.ui.notify("Using yoki_ui", "info");
		},
	});

	// Keep the old command name as an alias.
	pi.registerCommand("use-claude-code-tui", {
		description: "Alias for /use-yoki-ui",
		handler: async (_args, ctx) => {
			remember(ctx);
			const config = sessionConfig ?? (await readConfig()).config;
			sessionConfig = config;
			applyYokiLook(pi, ctx, statusline, config);
			ctx.ui.notify("Using yoki_ui", "info");
		},
	});

	pi.registerCommand("use-default-tui", {
		description: "Switch back to pi's built-in header/footer/editor",
		handler: async (_args, ctx) => {
			remember(ctx);
			const config = sessionConfig ?? (await readConfig()).config;
			sessionConfig = config;
			applyDefaultLook(ctx);
			ctx.ui.notify("Using default pi TUI", "info");
		},
	});
}
