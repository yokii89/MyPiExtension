import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { cursorOpenFromFgAnsi, restyleEditorCursor } from "./render-utils.ts";
import {
	applySharedHistory,
	isNotBrowsingHistory,
	SharedInputHistoryStore,
} from "./shared-input-history.ts";

/** Soft-coupled plan bridge (no package dependency on @yoki/yoki-plan). */
export interface YokiPlanBridgeLike {
	isLoaded(): boolean;
	getMode(): "edit" | "plan";
	toggleMode(ctx: ExtensionContext): Promise<"edit" | "plan">;
	openModelUI(ctx: ExtensionContext): Promise<void>;
}

const PLAN_BRIDGE_SYMBOL = Symbol.for("@yoki/yoki-plan:bridge");

export function getPlanBridge(): YokiPlanBridgeLike | undefined {
	const bridge = (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
	if (!bridge || typeof bridge !== "object") return undefined;
	const b = bridge as YokiPlanBridgeLike;
	if (typeof b.isLoaded !== "function" || !b.isLoaded()) return undefined;
	return b;
}

export type CodexEditorOptions = {
	/** Live extension context for bridge callbacks (notify / custom UI). */
	getCtx: () => ExtensionContext | null;
};

/**
 * Codex-style editor: theme-colored reverse-video caret (no bar glyph, no blink yet).
 * When yoki-plan bridge is loaded:
 * - app.thinking.cycle (Shift+Tab) → plan/edit toggle
 * - app.model.select (Ctrl+L) → dual-axis model+thinking UI
 * - /model submit → dual-axis model+thinking UI
 */
export class CodexStyleEditor extends CustomEditor {
	private readonly cursorOpen: () => string;
	private readonly keybindingsRef: KeybindingsManager;
	private readonly getCtx: () => ExtensionContext | null;
	private readonly sharedHistory = new SharedInputHistoryStore();
	private baseOnSubmit: ((text: string) => void | Promise<void>) | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorOpen: () => string,
		options: CodexEditorOptions,
	) {
		super(tui, theme, keybindings, { paddingX: 1 });
		this.cursorOpen = cursorOpen;
		this.keybindingsRef = keybindings;
		this.getCtx = options.getCtx;

		// Seed Up/Down history from the global shared file.
		applySharedHistory(this, this.sharedHistory.load());

		// Pi assigns onSubmit after factory return. Intercept via accessor so
		// /model never hits the built-in hardcoded handler when plan is loaded,
		// and so slash commands are recorded into shared history.
		const self = this;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get() {
				return async (text: string) => {
					const trimmed = text.trim();
					if (trimmed) {
						self.recordSharedHistory(trimmed);
					}
					const bridge = getPlanBridge();
					const ctx = self.getCtx();
					if (
						bridge &&
						ctx &&
						(trimmed === "/model" || trimmed.startsWith("/model "))
					) {
						self.setText("");
						await bridge.openModelUI(ctx);
						return;
					}
					return self.baseOnSubmit?.(text);
				};
			},
			set(handler: ((text: string) => void | Promise<void>) | undefined) {
				self.baseOnSubmit = handler;
			},
		});
	}

	/** Persist submission and refresh in-memory history (queries + slash/bash). */
	private recordSharedHistory(text: string): void {
		const entries = this.sharedHistory.add(text);
		applySharedHistory(this, entries);
	}

	handleInput(data: string): void {
		const bridge = getPlanBridge();
		const ctx = this.getCtx();
		if (bridge && ctx) {
			if (this.keybindingsRef.matches(data, "app.thinking.cycle")) {
				void bridge.toggleMode(ctx).then(() => this.tui.requestRender());
				return;
			}
			if (this.keybindingsRef.matches(data, "app.model.select")) {
				void bridge.openModelUI(ctx);
				return;
			}
		}

		// Reload shared history before first entering Up/Down browse mode.
		if (
			isNotBrowsingHistory(this) &&
			(this.keybindingsRef.matches(data, "tui.editor.cursorUp") || data === "\x1b[A")
		) {
			applySharedHistory(this, this.sharedHistory.load());
		}

		super.handleInput(data);
	}

	render(width: number): string[] {
		const open = this.cursorOpen();
		// Solid caret (visible=true). No blink timer in this step.
		return super.render(width).map((line) => restyleEditorCursor(line, open, true));
	}

	dispose(): void {
		// No timers while blink is disabled.
	}
}

let activeEditor: CodexStyleEditor | undefined;

export function disposeActiveEditor(): void {
	activeEditor?.dispose();
	activeEditor = undefined;
}

export function createCodexStyleEditor(
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
	cursorOpen: () => string,
	options: CodexEditorOptions,
): CodexStyleEditor {
	disposeActiveEditor();
	activeEditor = new CodexStyleEditor(tui, theme, keybindings, cursorOpen, options);
	return activeEditor;
}

export function createCursorOpen(getAccentFgAnsi: () => string): () => string {
	return () => cursorOpenFromFgAnsi(getAccentFgAnsi());
}

/**
 * Minimal custom editor that only adds global shared Up/Down history.
 * Used for /use-default-tui so history still works without Codex styling.
 */
export class SharedHistoryEditor extends CustomEditor {
	private readonly keybindingsRef: KeybindingsManager;
	private readonly sharedHistory = new SharedInputHistoryStore();
	private baseOnSubmit: ((text: string) => void | Promise<void>) | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.keybindingsRef = keybindings;
		applySharedHistory(this, this.sharedHistory.load());

		const self = this;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get() {
				return async (text: string) => {
					const trimmed = text.trim();
					if (trimmed) {
						const entries = self.sharedHistory.add(trimmed);
						applySharedHistory(self, entries);
					}
					return self.baseOnSubmit?.(text);
				};
			},
			set(handler: ((text: string) => void | Promise<void>) | undefined) {
				self.baseOnSubmit = handler;
			},
		});
	}

	handleInput(data: string): void {
		if (
			isNotBrowsingHistory(this) &&
			(this.keybindingsRef.matches(data, "tui.editor.cursorUp") || data === "\x1b[A")
		) {
			applySharedHistory(this, this.sharedHistory.load());
		}
		super.handleInput(data);
	}
}
