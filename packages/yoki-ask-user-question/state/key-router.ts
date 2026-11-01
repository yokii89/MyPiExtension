import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionAnswer } from "../tool/types.ts";
import { ROW_INTENT_META } from "./row-intent.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.ts";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";

const SPACE_KEY = " ";

export type QuestionnaireAction =
	| { kind: "nav"; nextIndex: number }
	| { kind: "tab_switch"; nextTab: number }
	| { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
	| { kind: "toggle"; index: number }
	| { kind: "multi_confirm"; selected: string[]; autoAdvanceTab?: number }
	| { kind: "cancel" }
	/**
	 * Enter pressed on the focused "Type something." row (inputMode). Carries the live
	 * buffer; the reducer decides by selection state whether the text is a supplement
	 * (merges into the answer's `notes`) or a custom answer (commits), or — when empty —
	 * a clear of the saved draft.
	 */
	| { kind: "draft_commit"; text: string; autoAdvanceTab?: number }
	| { kind: "submit" }
	| { kind: "submit_nav"; nextIndex: 0 | 1 }
	/** Flip `state.collapsed`. Always available, regardless of inner mode (see top intercept in `routeKey`). */
	| { kind: "toggle_collapsed" }
	/**
	 * First Esc when the dialog holds user work. Does not mutate anything except
	 * `state.cancelArmed` — the footer swaps to the confirmation hint and a second
	 * Esc (or any other action, which disarms) resolves the pending cancel.
	 */
	| { kind: "arm_cancel" }
	| { kind: "ignore" };

export interface QuestionnaireKeybindings {
	matches(data: string, name: string): boolean;
}

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

export function allAnswered(state: QuestionnaireState, runtime: QuestionnaireRuntime): boolean {
	if (runtime.questions.length === 0) return false;
	for (let i = 0; i < runtime.questions.length; i++) {
		if (!state.answers.has(i)) return false;
	}
	return true;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
	return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(state: QuestionnaireState, runtime: QuestionnaireRuntime): number | undefined {
	if (!runtime.isMulti) return undefined;
	if (state.currentTab < runtime.questions.length - 1) return state.currentTab + 1;
	return runtime.questions.length;
}

/**
 * The non-inputMode confirm target: the focused option row. The "other" and "next"
 * sentinels return `null` (nothing to confirm outside inputMode).
 */
function buildOptionAnswer(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionAnswer | null {
	const q = runtime.questions[state.currentTab];
	if (!q) return null;

	const item = runtime.currentItem;
	if (!item) return null;
	if (item.kind === "other") {
		return null;
	}
	if (item.kind === "next") {
		return null;
	}
	return {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "option",
		answer: item.label,
	};
}

function buildMultiSelected(state: QuestionnaireState, runtime: QuestionnaireRuntime): string[] {
	const q = runtime.questions[state.currentTab];
	if (!q) return [];
	const out: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) {
			const label = q.options[i]?.label;
			if (typeof label === "string") out.push(label);
		}
	}
	return out;
}

function tabSwitchAction(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
	if (!runtime.isMulti) return null;
	const total = totalTabs(runtime);
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab + 1, total) };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab - 1, total) };
	}
	return null;
}

// DOWN at the last item wraps to the first (cycle through [option0, …, optionLast]).
function nextNavOnDown(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, runtime.items.length)) };
}

// UP at the first item wraps to the last (symmetric with nextNavOnUp).
function prevNavOnUp(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, runtime.items.length)) };
}

/**
 * Cancel guard. Esc cancels immediately while the dialog is "cheap" to lose
 * (no answers, no saved drafts, no in-flight custom text). Once any user work exists,
 * the first Esc only arms the guard (`arm_cancel` → footer shows the
 * confirmation hint) and a second Esc commits the cancel.
 */
function cancelAction(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	const hasWork =
		state.answers.size > 0 || state.draftByTab.size > 0 || (state.inputMode && runtime.inputBuffer.length > 0);
	if (!hasWork || state.cancelArmed) return { kind: "cancel" };
	return { kind: "arm_cancel" };
}

/**
 * Digit quick-jump: every option row is rendered with a visible `1.` `2.` … number,
 * so digits are an advertised affordance. Pressing `1`–`9` moves focus to that row
 * (jump-then-Enter, never auto-confirm — a mis-press must not commit an answer).
 * The `next` sentinel renders WITHOUT a number, so a digit that lands on it is
 * ignored. `inputMode` returns earlier in `routeKey`, so typed digits still reach
 * the text buffer.
 */
function digitJumpAction(data: string, runtime: QuestionnaireRuntime): QuestionnaireAction | null {
	if (data.length !== 1 || data < "1" || data > "9") return null;
	const index = data.charCodeAt(0) - "1".charCodeAt(0);
	const item = runtime.items[index];
	if (!item || item.kind === "next") return null;
	return { kind: "nav", nextIndex: index };
}

export function routeKey(data: string, state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	const kb = runtime.keybindings;

	// Collapse/expand toggle is a UI-level affordance — intercepted at the top so it
	// works from every inner state (notes, inputMode, submit tab, multi-select)
	// without reaching any branch that would otherwise consume the keystroke. The
	// questionnaire overlay is fully hidden via `OverlayHandle.setHidden(true)` while
	// collapsed; pi-tui's overlay stack updates accordingly, so overlay-aware consumers
	// (e.g. `pi-station`) see no visible modal and chat scroll resumes. The toggle key is
	// also captured at the raw terminal level via `ctx.ui.onTerminalInput` so it still
	// routes here when the overlay is hidden (pi-tui does not deliver input to a hidden
	// overlay's `component.handleInput`).
	//
	// The default `ctrl+]` is free in every mainstream macOS terminal (Terminal.app,
	// iTerm2, Warp), every multiplexer (tmux, zellij, screen — none use it as a prefix),
	// and the legacy telnet/ssh escape role doesn't apply because our overlay runs
	// in-process. It is, however, awkward on keyboard layouts where `]` is on the
	// shifted layer (Latin American `es-AR`/`es-MX` require `Ctrl+Shift+}` for `Ctrl+]`)
	// — use the `collapseKey` config field to override.
	if (runtime.collapseKey !== "off" && matchesKey(data, runtime.collapseKey as Parameters<typeof matchesKey>[1])) {
		return { kind: "toggle_collapsed" };
	}

	// Collapsed-mode lockout: while collapsed, swallow every keystroke except cancel so
	// the user can read the now-uncovered transcript without accidentally mutating
	// answers or notes. The collapse toggle itself is already handled above.
	if (state.collapsed) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		return { kind: "ignore" };
	}

	if (state.inputMode) {
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// Unified free-text commit: the reducer branches on selection state
			// (supplement vs custom answer vs clear-empty-draft). See `draftCommitHandler`.
			return {
				kind: "draft_commit",
				text: runtime.inputBuffer,
				autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
			};
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return cancelAction(state, runtime);
		if (kb.matches(data, KEYBIND_UP)) {
			return prevNavOnUp(state, runtime);
		}
		if (kb.matches(data, KEYBIND_DOWN)) {
			return nextNavOnDown(state, runtime);
		}
		return { kind: "ignore" };
	}

	if (runtime.isMulti && state.currentTab === runtime.questions.length) {
		if (kb.matches(data, KEYBIND_CANCEL)) return cancelAction(state, runtime);
		const tab = tabSwitchAction(data, state, runtime);
		if (tab) return tab;
		// The picker rows are numbered 1. Submit / 2. Cancel — digits are the advertised
		// affordance, so let them move the picker focus directly.
		if (data === "1" || data === "2") return { kind: "submit_nav", nextIndex: data === "1" ? 0 : 1 };
		if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
			const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
			const next = wrapTab(state.submitChoiceIndex + delta, 2);
			return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// D1 (revised): Submit always submits; Cancel always cancels. The warning header
			// is informational only — `allAnswered(state)` no longer gates submission. Partial
			// answers flow through `orderedAnswers()` in the host.
			return state.submitChoiceIndex === 1 ? { kind: "cancel" } : { kind: "submit" };
		}
		return { kind: "ignore" };
	}

	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;

	const q = runtime.questions[state.currentTab];
	if (!q) return { kind: "ignore" };

	if (kb.matches(data, KEYBIND_UP)) {
		return prevNavOnUp(state, runtime);
	}
	if (kb.matches(data, KEYBIND_DOWN)) {
		return nextNavOnDown(state, runtime);
	}
	const jump = digitJumpAction(data, runtime);
	if (jump) return jump;

	if (q.multiSelect) {
		const focusedKind = runtime.currentItem?.kind;
		const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
		// Space toggles the focused row's checkbox. Suppressed on rows whose META declares
		// `blocksMultiToggle` (the Next sentinel) or `activatesInputMode` (the "Type
		// something." row — it is an inline input, not a checkable option).
		if (data === SPACE_KEY) {
			if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
			if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
			return { kind: "toggle", index: state.optionIndex };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// Enter on the "Type something." row is handled by the inputMode block above
			// (→ draft_commit). Defensive: never enter the toggle/multi_confirm
			// path for an inputMode-activating row.
			if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
			// Enter on a regular row toggles (matching Space) — committing the question is now
			// gated behind explicit focus on a row whose META declares `autoSubmitsInMulti`
			// (the Next sentinel), so Enter on options is a no-cost way to flip checkboxes
			// without leaving the keyboard home row.
			if (!focusedMeta?.autoSubmitsInMulti) return { kind: "toggle", index: state.optionIndex };
			// Enter on Next: carry autoAdvanceTab so the host can advance to the next tab in
			// multi-question mode, OR submit the dialog in single-question mode
			// (autoAdvanceTab === undefined when !isMulti). Without this, a single multi-select
			// question would have no way to commit at all.
			return {
				kind: "multi_confirm",
				selected: buildMultiSelected(state, runtime),
				autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
			};
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return cancelAction(state, runtime);
		return { kind: "ignore" };
	}

	if (kb.matches(data, KEYBIND_CONFIRM)) {
		const answer = buildOptionAnswer(state, runtime);
		if (!answer) return { kind: "ignore" };
		return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return cancelAction(state, runtime);
	return { kind: "ignore" };
}
