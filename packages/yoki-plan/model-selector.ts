/**
 * Dual-axis model + thinking selector (↑↓ model, ←→ thinking).
 * Opened via ctx.ui.custom when the plan bridge is loaded.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { GLYPH_SUCCESS, POINTER } from "yoki_ui/style";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelListItem {
	provider: string;
	id: string;
	model: Model<Api>;
}

export interface ModelSelectorState {
	models: ModelListItem[];
	selectedIndex: number;
	thinkingLevel: ThinkingLevel;
	error?: string;
}

/** Cycle thinking level among levels supported by the given model. */
export function cycleThinkingLevel(
	model: Model<Api> | undefined,
	current: ThinkingLevel,
	direction: 1 | -1,
): ThinkingLevel {
	if (!model?.reasoning) return "off";
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	if (levels.length === 0) return "off";
	const clamped = clampThinkingLevel(model, current) as ThinkingLevel;
	const idx = levels.indexOf(clamped);
	const base = idx >= 0 ? idx : 0;
	const next = (base + direction + levels.length) % levels.length;
	return levels[next] ?? "off";
}

/** Clamp thinking to what the model supports (non-reasoning → off). */
export function clampForModel(model: Model<Api> | undefined, level: ThinkingLevel): ThinkingLevel {
	if (!model) return "off";
	return clampThinkingLevel(model, level) as ThinkingLevel;
}

export function moveSelection(index: number, length: number, direction: 1 | -1): number {
	if (length <= 0) return 0;
	return (index + direction + length) % length;
}

export function createInitialSelectorState(
	models: ModelListItem[],
	currentModel: Model<Api> | undefined,
	currentThinking: ThinkingLevel,
): ModelSelectorState {
	let selectedIndex = 0;
	if (currentModel) {
		const found = models.findIndex(
			(m) => m.model.provider === currentModel.provider && m.model.id === currentModel.id,
		);
		if (found >= 0) selectedIndex = found;
	}
	const selected = models[selectedIndex]?.model;
	return {
		models,
		selectedIndex,
		thinkingLevel: clampForModel(selected ?? currentModel, currentThinking),
		error: models.length === 0 ? "No models available" : undefined,
	};
}

export function applySelectorKey(
	state: ModelSelectorState,
	keyData: string,
): { state: ModelSelectorState; action: "none" | "confirm" | "cancel" } {
	if (matchesKey(keyData, "up")) {
		const selectedIndex = moveSelection(state.selectedIndex, state.models.length, -1);
		const model = state.models[selectedIndex]?.model;
		return {
			state: {
				...state,
				selectedIndex,
				thinkingLevel: clampForModel(model, state.thinkingLevel),
			},
			action: "none",
		};
	}
	if (matchesKey(keyData, "down")) {
		const selectedIndex = moveSelection(state.selectedIndex, state.models.length, 1);
		const model = state.models[selectedIndex]?.model;
		return {
			state: {
				...state,
				selectedIndex,
				thinkingLevel: clampForModel(model, state.thinkingLevel),
			},
			action: "none",
		};
	}
	if (matchesKey(keyData, "left")) {
		const model = state.models[state.selectedIndex]?.model;
		return {
			state: {
				...state,
				thinkingLevel: cycleThinkingLevel(model, state.thinkingLevel, -1),
			},
			action: "none",
		};
	}
	if (matchesKey(keyData, "right")) {
		const model = state.models[state.selectedIndex]?.model;
		return {
			state: {
				...state,
				thinkingLevel: cycleThinkingLevel(model, state.thinkingLevel, 1),
			},
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

/** Thinking control for the selected model only (not per-row). */
export function formatThinkingStrip(
	model: Model<Api> | undefined,
	level: ThinkingLevel,
): { hasReasoning: boolean; current: ThinkingLevel; levels: ThinkingLevel[] } {
	if (!model?.reasoning) {
		return { hasReasoning: false, current: "off", levels: ["off"] };
	}
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	const current = clampForModel(model, level);
	return { hasReasoning: true, current, levels: levels.length > 0 ? levels : ["off"] };
}

function renderThinkingRow(model: Model<Api> | undefined, level: ThinkingLevel, theme: Theme): string {
	const strip = formatThinkingStrip(model, level);
	if (!strip.hasReasoning) {
		return `${theme.fg("muted", "thinking")}  ${theme.fg("dim", "off · no reasoning")}`;
	}
	const parts = strip.levels.map((l) => (l === strip.current ? theme.fg("accent", `[${l}]`) : theme.fg("muted", l)));
	const body = parts.join(theme.fg("muted", " · "));
	return `${theme.fg("muted", "thinking")}  ${theme.fg("accent", "◀")} ${body} ${theme.fg("accent", "▶")}`;
}

/** Pure render helper (exported for layout tests). */
export function renderLines(state: ModelSelectorState, theme: Theme, currentModel: Model<Api> | undefined): string[] {
	const lines: string[] = [];
	// Compact key chrome — dual-axis controls live outside the list rows.
	lines.push(theme.fg("muted", "↑↓ model · ←→ thinking · enter select · esc"));
	lines.push("");

	if (state.error) {
		lines.push(theme.fg("error", state.error));
		return lines;
	}

	const maxVisible = 12;
	const len = state.models.length;
	if (len === 0) {
		lines.push(theme.fg("muted", "  No models available"));
	} else {
		const start = Math.max(0, Math.min(state.selectedIndex - Math.floor(maxVisible / 2), len - maxVisible));
		const end = Math.min(start + maxVisible, len);
		for (let i = start; i < end; i++) {
			const item = state.models[i]!;
			const isSelected = i === state.selectedIndex;
			const isCurrent =
				currentModel !== undefined &&
				item.model.provider === currentModel.provider &&
				item.model.id === currentModel.id;
			// List rows: model id + current-session mark only. No provider, no thinking.
			const check = isCurrent ? theme.fg("success", ` ${GLYPH_SUCCESS}`) : "";
			if (isSelected) {
				lines.push(`${theme.fg("accent", POINTER)}${theme.fg("accent", item.id)}${check}`);
			} else {
				lines.push(`  ${item.id}${check}`);
			}
		}
		if (start > 0 || end < len) {
			lines.push(theme.fg("muted", `  ${state.selectedIndex + 1}/${len}`));
		}
	}

	// Single thinking control for the focused model.
	lines.push("");
	const selected = state.models[state.selectedIndex]?.model;
	lines.push(renderThinkingRow(selected, state.thinkingLevel, theme));

	return lines;
}

class ModelThinkingSelector implements Component {
	private state: ModelSelectorState;
	private lines: string[] = [];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly currentModel: Model<Api> | undefined;
	private readonly onConfirm: (model: Model<Api>, level: ThinkingLevel) => void;
	private readonly onCancel: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		currentModel: Model<Api> | undefined,
		initial: ModelSelectorState,
		onConfirm: (model: Model<Api>, level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.currentModel = currentModel;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
		this.state = initial;
		this.rebuild();
	}

	private rebuild(): void {
		this.lines = renderLines(this.state, this.theme, this.currentModel);
	}

	handleInput(data: string): void {
		const result = applySelectorKey(this.state, data);
		this.state = result.state;
		if (result.action === "confirm") {
			const item = this.state.models[this.state.selectedIndex];
			if (item) {
				this.onConfirm(item.model, this.state.thinkingLevel);
				return;
			}
		}
		if (result.action === "cancel") {
			this.onCancel();
			return;
		}
		this.rebuild();
		this.tui.requestRender();
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {
		// no-op — lines rebuilt on input
	}
}

/** Load available models from the registry (sync getAvailable when present). */
export async function loadModelList(ctx: ExtensionContext): Promise<ModelListItem[]> {
	const registry = ctx.modelRegistry as {
		refresh?: () => void;
		getAvailable: () => Model<Api>[] | Promise<Model<Api>[]>;
	};
	registry.refresh?.();
	const available = await Promise.resolve(registry.getAvailable());
	return available.map((model) => ({
		provider: model.provider,
		id: model.id,
		model,
	}));
}

export async function openModelSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Model selector requires interactive UI.", "warning");
		return;
	}

	// Desktop has native model+thinking in the input toolbar (PiDesk TaskInputToolbar);
	// this dual-axis picker is TUI-only.
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Model selector requires interactive TUI mode.", "warning");
		return;
	}

	const models = await loadModelList(ctx);
	const currentThinking = (pi.getThinkingLevel?.() ?? "off") as ThinkingLevel;

	const initial = createInitialSelectorState(models, ctx.model, currentThinking);

	await ctx.ui.custom<void>((tui, theme, _keybindings: KeybindingsManager, done) => {
		return new ModelThinkingSelector(
			tui,
			theme,
			ctx.model,
			initial,
			async (model, level) => {
				const ok = await pi.setModel(model);
				if (!ok) {
					ctx.ui.notify(`Failed to set model ${model.provider}/${model.id} (missing API key?)`, "error");
					done();
					return;
				}
				pi.setThinkingLevel(level);
				ctx.ui.notify(`Model: ${model.id} · thinking: ${level}`, "info");
				done();
			},
			() => done(),
		);
	});
}
