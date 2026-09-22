/**
 * New API runtime control panel: status overview, action menu, and a
 * type-to-filter model picker. Opened via ctx.ui.custom overlays.
 *
 * Pure state/render helpers are exported for tests. All glyphs and colors
 * come from `yoki_ui/style` — no local SGR codes or pointer redefinitions.
 */

import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	GLYPH_SUCCESS,
	GLYPH_WARNING,
	POINTER,
	POINTER_INACTIVE,
	RESULT_COLOR,
	RESULT_GLYPH,
	SPINNER_FRAMES,
	ruleWithLabel,
} from "yoki_ui/style";

// ---------------------------------------------------------------------------
// Status snapshot
// ---------------------------------------------------------------------------

export type NewApiCommandAction =
	| "panel"
	| "status"
	| "model"
	| "refresh"
	| "test"
	| "clear"
	| "login"
	| "usage";

const COMMAND_ALIASES: Record<string, NewApiCommandAction> = {
	"": "panel",
	menu: "panel",
	open: "panel",
	panel: "panel",
	status: "status",
	info: "status",
	model: "model",
	models: "model",
	switch: "model",
	refresh: "refresh",
	reload: "refresh",
	test: "test",
	ping: "test",
	clear: "clear",
	reset: "clear",
	login: "login",
	import: "login",
};

/** Parse /newapi subcommand args; unknown input maps to "usage". */
export function parseNewApiArgs(args: string): NewApiCommandAction {
	return COMMAND_ALIASES[args.trim().toLowerCase()] ?? "usage";
}

/** Mask an API key for display: keep only the trailing 4 chars. */
export function maskKey(key: string): string {
	return key.length > 4 ? `****${key.slice(-4)}` : "****";
}

/** Human-friendly cache age: "just now", "5m ago", "3h ago", "2d ago". */
export function formatCacheAge(fetchedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export type NewApiStatusInfo = {
	configured: boolean;
	endpoint?: string;
	api: string;
	source: "auth.json" | "env" | "none";
	keyMask?: string;
	modelCount: number;
	cacheAge?: string;
	current?: string;
	thinking?: string;
	lastError?: string;
};

export type StatusRow = { label: string; value: string; tone: "normal" | "warning" | "muted" };

const LABEL_WIDTH = 10;

/** Structured status rows shared by the colored panel and the plain echo. */
export function buildStatusRows(info: NewApiStatusInfo): StatusRow[] {
	const rows: StatusRow[] = [];
	rows.push(
		info.endpoint
			? { label: "endpoint", value: `${info.endpoint} · ${info.api}`, tone: "normal" }
			: { label: "endpoint", value: "not configured — /newapi login", tone: "warning" },
	);
	rows.push(
		info.keyMask
			? { label: "auth", value: `${info.keyMask} · ${info.source}`, tone: "normal" }
			: { label: "auth", value: info.source, tone: "warning" },
	);
	rows.push(
		info.modelCount > 0
			? {
					label: "models",
					value: `${info.modelCount} cached${info.cacheAge ? ` · ${info.cacheAge}` : ""}`,
					tone: "normal",
				}
			: { label: "models", value: "no cache", tone: "warning" },
	);
	const current = [info.current, info.thinking ? `thinking ${info.thinking}` : undefined]
		.filter(Boolean)
		.join(" · ");
	rows.push(
		info.current
			? { label: "current", value: current, tone: "normal" }
			: { label: "current", value: "—", tone: "muted" },
	);
	if (info.lastError) {
		rows.push({ label: "error", value: `${GLYPH_WARNING} ${info.lastError}`, tone: "warning" });
	}
	return rows;
}

/** Plain-text status lines for ctx.ui.notify (no theme rendering there). */
export function formatStatusPlain(info: NewApiStatusInfo): string[] {
	const lines = [
		`${info.configured ? GLYPH_SUCCESS : GLYPH_WARNING} New API · ${info.endpoint ?? "not configured"} · ${info.api}`,
	];
	for (const row of buildStatusRows(info)) {
		lines.push(`  ${row.label.padEnd(LABEL_WIDTH - 2)}${row.value}`);
	}
	return lines;
}

/** Colored status section for the panel overlay. */
export function renderStatusLines(info: NewApiStatusInfo, theme: Theme, width: number): string[] {
	const lines = [ruleWithLabel(theme, width, "New API")];
	for (const row of buildStatusRows(info)) {
		const label = theme.fg("muted", row.label.padEnd(LABEL_WIDTH));
		const value =
			row.tone === "warning"
				? theme.fg("warning", row.value)
				: row.tone === "muted"
					? theme.fg("muted", row.value)
					: row.value;
		lines.push(`${label}${value}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Panel action menu
// ---------------------------------------------------------------------------

export type PanelActionId = "model" | "refresh" | "test" | "clear" | "login" | "close";

export type PanelActionResult = { ok: boolean; message: string };

export const PANEL_ACTION_LABELS: Record<PanelActionId, string> = {
	model: "Switch model",
	refresh: "Refresh models (re-discover)",
	test: "Test connection",
	clear: "Clear model cache",
	login: "Login… (Manual / Import from Codex)",
	close: "Close",
};

const PANEL_BUSY_LABELS: Partial<Record<PanelActionId, string>> = {
	refresh: "Refreshing models…",
	test: "Testing connection…",
	clear: "Clearing model cache…",
};

export function buildMenuItems(info: NewApiStatusInfo): PanelActionId[] {
	// Unconfigured: login first — it is the only action that unblocks the rest.
	return info.configured
		? ["model", "refresh", "test", "clear", "login", "close"]
		: ["login", "model", "refresh", "test", "clear", "close"];
}

export type PanelState = { items: PanelActionId[]; selectedIndex: number };

export function moveSelection(index: number, length: number, direction: 1 | -1): number {
	if (length <= 0) return 0;
	return (index + direction + length) % length;
}

export function applyPanelKey(
	state: PanelState,
	keyData: string,
): { state: PanelState; action: "none" | "confirm" | "cancel" } {
	if (matchesKey(keyData, "up")) {
		return {
			state: { ...state, selectedIndex: moveSelection(state.selectedIndex, state.items.length, -1) },
			action: "none",
		};
	}
	if (matchesKey(keyData, "down")) {
		return {
			state: { ...state, selectedIndex: moveSelection(state.selectedIndex, state.items.length, 1) },
			action: "none",
		};
	}
	if (matchesKey(keyData, "enter")) {
		return { state, action: "confirm" };
	}
	if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
		return { state, action: "cancel" };
	}
	return { state, action: "none" };
}

export function renderPanelLines(
	state: PanelState,
	info: NewApiStatusInfo,
	theme: Theme,
	width: number,
	busy?: { label: string; frame: number },
	result?: PanelActionResult,
): string[] {
	const lines = renderStatusLines(info, theme, width);
	lines.push("");
	lines.push(ruleWithLabel(theme, width, "Actions"));
	state.items.forEach((id, i) => {
		const selected = i === state.selectedIndex;
		const label = selected ? theme.fg("accent", PANEL_ACTION_LABELS[id]) : PANEL_ACTION_LABELS[id];
		lines.push(`${selected ? theme.fg("accent", POINTER) : POINTER_INACTIVE}${label}`);
	});
	lines.push("");
	if (busy) {
		const frame = SPINNER_FRAMES[busy.frame % SPINNER_FRAMES.length];
		lines.push(`${theme.fg("warning", frame)} ${theme.fg("warning", busy.label)}`);
	} else if (result) {
		const glyph = result.ok ? RESULT_GLYPH.success : RESULT_GLYPH.error;
		lines.push(theme.fg(RESULT_COLOR[result.ok ? "success" : "error"], `${glyph} ${result.message}`));
	} else {
		lines.push(theme.fg("muted", "↑↓ select · enter run · esc close"));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Model picker (type-to-filter)
// ---------------------------------------------------------------------------

export type PickerItem = { id: string; name: string };

export type PickerState = {
	items: PickerItem[];
	query: string;
	selected: number;
	visible: PickerItem[];
	currentId?: string;
};

export function filterPickerItems(items: PickerItem[], query: string): PickerItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

export function recomputePicker(state: PickerState): PickerState {
	const visible = filterPickerItems(state.items, state.query);
	const selected = visible.length > 0 ? Math.min(state.selected, visible.length - 1) : 0;
	return { ...state, visible, selected };
}

export function createPickerState(items: PickerItem[], currentId?: string): PickerState {
	return recomputePicker({ items, query: "", selected: 0, visible: [], currentId });
}

function printableChar(data: string): string | undefined {
	if (data.length !== 1) return undefined;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code < 0x7f ? data : undefined;
}

export function applyPickerKey(
	state: PickerState,
	keyData: string,
): { state: PickerState; action: "none" | "confirm" | "cancel" } {
	if (matchesKey(keyData, "up")) {
		return {
			state: recomputePicker({ ...state, selected: moveSelection(state.selected, state.visible.length, -1) }),
			action: "none",
		};
	}
	if (matchesKey(keyData, "down")) {
		return {
			state: recomputePicker({ ...state, selected: moveSelection(state.selected, state.visible.length, 1) }),
			action: "none",
		};
	}
	if (matchesKey(keyData, "backspace") || keyData === "\x7f") {
		if (!state.query) return { state, action: "none" };
		return { state: recomputePicker({ ...state, query: state.query.slice(0, -1), selected: 0 }), action: "none" };
	}
	if (matchesKey(keyData, "enter")) {
		return { state, action: state.visible.length > 0 ? "confirm" : "none" };
	}
	if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
		return { state, action: "cancel" };
	}
	const ch = printableChar(keyData);
	if (ch) {
		return { state: recomputePicker({ ...state, query: state.query + ch, selected: 0 }), action: "none" };
	}
	return { state, action: "none" };
}

const PICKER_MAX_VISIBLE = 10;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

class NewApiPanel implements Component {
	private state: PanelState;
	private info: NewApiStatusInfo;
	private busy?: { label: string; frame: number };
	private result?: PanelActionResult;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly actions: {
		getInfo: () => Promise<NewApiStatusInfo>;
		runAction: (id: PanelActionId) => Promise<PanelActionResult>;
	};
	private readonly done: (result?: PanelActionId) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		info: NewApiStatusInfo,
		actions: { getInfo: () => Promise<NewApiStatusInfo>; runAction: (id: PanelActionId) => Promise<PanelActionResult> },
		done: (result?: PanelActionId) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.info = info;
		this.actions = actions;
		this.done = done;
		this.state = { items: buildMenuItems(info), selectedIndex: 0 };
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const { state, action } = applyPanelKey(this.state, data);
		this.state = state;
		if (action === "confirm") {
			const id = this.state.items[this.state.selectedIndex];
			if (!id) return;
			if (id === "close") {
				this.done();
				return;
			}
			if (id === "model" || id === "login") {
				this.done(id);
				return;
			}
			void this.runBusy(id);
			return;
		}
		if (action === "cancel") {
			this.done();
			return;
		}
		this.tui.requestRender();
	}

	private async runBusy(id: PanelActionId): Promise<void> {
		const label = PANEL_BUSY_LABELS[id];
		if (!label) return;
		this.busy = { label, frame: 0 };
		this.result = undefined;
		const timer = setInterval(() => {
			if (!this.busy) return;
			this.busy.frame += 1;
			this.tui.requestRender();
		}, 150);
		try {
			this.result = await this.actions.runAction(id);
			if (this.result.ok) {
				this.info = await this.actions.getInfo();
				const items = buildMenuItems(this.info);
				this.state = {
					items,
					selectedIndex: Math.min(this.state.selectedIndex, Math.max(0, items.length - 1)),
				};
			}
		} catch (error) {
			this.result = { ok: false, message: error instanceof Error ? error.message : String(error) };
		} finally {
			clearInterval(timer);
			this.busy = undefined;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		return renderPanelLines(this.state, this.info, this.theme, width, this.busy, this.result);
	}

	invalidate(): void {
		// Stateless render — lines rebuilt on input/tick.
	}
}

class NewApiModelPicker implements Component {
	private state: PickerState;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onConfirm: (id: string) => void;
	private readonly onCancel: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		items: PickerItem[],
		currentId: string | undefined,
		onConfirm: (id: string) => void,
		onCancel: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.state = createPickerState(items, currentId);
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		const { state, action } = applyPickerKey(this.state, data);
		this.state = state;
		if (action === "confirm") {
			const item = this.state.visible[this.state.selected];
			if (item) this.onConfirm(item.id);
			return;
		}
		if (action === "cancel") {
			this.onCancel();
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderPickerList(this.state, this.theme, width);
	}

	invalidate(): void {
		// Stateless render — lines rebuilt on input.
	}
}

// ---------------------------------------------------------------------------
// Full renderers (list sections)
// ---------------------------------------------------------------------------

export function renderPickerList(state: PickerState, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	lines.push(ruleWithLabel(theme, width, "Switch model"));
	const filterLine = state.query
		? `${theme.fg("accent", state.query)}${theme.fg("muted", "▏")}`
		: theme.fg("muted", "type to filter");
	lines.push(`${theme.fg("accent", POINTER)}${filterLine}`);
	lines.push("");

	const len = state.visible.length;
	if (len === 0) {
		lines.push(`${POINTER_INACTIVE}${theme.fg("muted", "no models match")}`);
	} else {
		const start = Math.max(
			0,
			Math.min(state.selected - Math.floor(PICKER_MAX_VISIBLE / 2), len - PICKER_MAX_VISIBLE),
		);
		const end = Math.min(start + PICKER_MAX_VISIBLE, len);
		for (let i = start; i < end; i++) {
			const item = state.visible[i];
			const selected = i === state.selected;
			const isCurrent = item.id === state.currentId;
			const check = isCurrent ? theme.fg("success", ` ${GLYPH_SUCCESS}`) : "";
			const id = selected ? theme.fg("accent", item.id) : item.id;
			lines.push(`${selected ? theme.fg("accent", POINTER) : POINTER_INACTIVE}${id}${check}`);
		}
		if (start > 0 || end < len) {
			lines.push(theme.fg("muted", `  ${state.selected + 1}/${len}`));
		}
	}

	lines.push("");
	lines.push(theme.fg("muted", "type to filter · ↑↓ move · enter switch · esc back"));
	return lines;
}

// ---------------------------------------------------------------------------
// Overlay entry points
// ---------------------------------------------------------------------------

export function requireTui(ctx: ExtensionContext): boolean {
	return Boolean(ctx.hasUI && ctx.mode === "tui");
}

/** Open the control panel. Resolves with the action that requested a follow-up. */
export async function openNewApiPanel(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	actions: {
		getInfo: () => Promise<NewApiStatusInfo>;
		runAction: (id: PanelActionId) => Promise<PanelActionResult>;
	},
): Promise<PanelActionId | undefined> {
	if (!requireTui(ctx)) {
		ctx.ui.notify("The New API panel requires interactive TUI mode.", "warning");
		return undefined;
	}
	const info = await actions.getInfo();
	return ctx.ui.custom<PanelActionId | undefined>(
		(tui, theme, _keybindings: KeybindingsManager, done) =>
			new NewApiPanel(tui, theme, info, actions, done),
	);
}

/** Open the type-to-filter model picker; resolves with the chosen model id. */
export async function openNewApiModelPicker(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	items: PickerItem[],
): Promise<string | undefined> {
	if (!requireTui(ctx)) {
		ctx.ui.notify("The model picker requires interactive TUI mode.", "warning");
		return undefined;
	}
	if (items.length === 0) {
		ctx.ui.notify(`New API: no models available — run /newapi login or /newapi refresh.`, "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings: KeybindingsManager, done) =>
			new NewApiModelPicker(tui, theme, items, ctx.model?.id, done, () => done(undefined)),
	);
}
