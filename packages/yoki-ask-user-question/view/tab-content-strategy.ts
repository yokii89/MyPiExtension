import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionData } from "../tool/types.ts";
import type { PreviewPane, PreviewPaneProps } from "./components/preview/preview-pane.ts";
import {
	ARMED_CANCEL_WARNING,
	type DialogState,
	HINT_PART_CANCEL,
	HINT_PART_COLLAPSE,
	HINT_PART_ENTER,
	HINT_PART_NAV,
	HINT_PART_NOTES,
	HINT_PART_TAB,
	HINT_PART_TOGGLE,
	INCOMPLETE_WARNING_PREFIX,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-builder.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";

const NOTES_HEADER = "Notes:";
const UNANSWERED_MARKER = "→ not answered";

/**
 * Single-row, width-clipped chrome cell. The footer row count is invariant
 * (`QuestionTabStrategy.footerRowCount = 2`) — pi-tui's `Text` word-wraps when
 * the styled hint exceeds `width`, inflating that row count and desyncing the
 * `bodyHeight + footerRowCount` math in `DialogView.render`. Clipping with
 * `truncateToWidth` (ANSI-aware, matches `multi-select-view.ts` usage) keeps
 * the hint on one line; the collapse affordance falls off the right edge with
 * `…` on terminals too narrow to advertise it.
 */
class OneLineClippedText implements Component {
	constructor(
		private readonly text: string,
		private readonly paddingLeft: number = 0,
	) {}

	render(width: number): string[] {
		const pad = " ".repeat(this.paddingLeft);
		const avail = Math.max(0, width - this.paddingLeft);
		return [pad + truncateToWidth(this.text, avail, "…", false)];
	}

	invalidate(): void {}

	handleInput(_data: string): void {}
}

/**
 * Per-tab content provider. Pure functional — closes over construction-time
 * config; per-tick state threads through method args. The chrome wrapper
 * enforces height equality across tabs via `bodyHeight + footerRowCount`.
 */
export interface TabContentStrategy {
	/** Total RENDERED footer rows — MUST equal what `footerRows()` actually emits. Drives residual math. */
	readonly footerRowCount: number;

	/** Variable rows above the body, after top chrome (border + tabBar + Spacer). */
	headingRows(state: DialogState): Component[];

	/** Body Component placed at the body slot. */
	bodyComponent(state: DialogState): Component;

	/** Natural rendered height of `bodyComponent(state)` at given width. */
	bodyHeight(width: number, state: DialogState): number;

	/** Optional rows between body's trailing Spacer and the bottom border. */
	midRows(state: DialogState): Component[];

	/** Footer rows below the bottom border. Rendered row count MUST equal `footerRowCount`. */
	footerRows(state: DialogState): Component[];

	/** Row range of the focused item within the body's rendered output, or undefined if no interactive focus. */
	focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined;
}

export interface QuestionTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	getPreviewPane: () => StatefulView<PreviewPaneProps>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	notesInput: Input;
	isMulti: boolean;
	getCurrentBodyHeight: (width: number) => number;
}

export class QuestionTabStrategy implements TabContentStrategy {
	/** Spacer(1) + OneLineClippedText(hint, 1) = 2 rendered rows. */
	readonly footerRowCount = 2;

	constructor(private readonly config: QuestionTabStrategyConfig) {}

	headingRows(state: DialogState): Component[] {
		const out: Component[] = [];
		const question = this.config.questions[state.currentTab];
		// In multi-question mode the tab bar already shows the header; suppress the inline badge.
		if (!this.config.isMulti && question?.header && question.header.length > 0) {
			out.push(new Text(this.config.theme.bg("selectedBg", ` ${question.header} `), 1, 0));
			out.push(new Spacer(1));
		}
		if (question) {
			out.push(new Text(this.config.theme.bold(question.question), 1, 0));
			out.push(new Spacer(1));
		}
		return out;
	}

	bodyComponent(state: DialogState): Component {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso;
		return this.config.getPreviewPane();
	}

	bodyHeight(width: number, _state: DialogState): number {
		return this.config.getCurrentBodyHeight(width);
	}

	midRows(state: DialogState): Component[] {
		if (!state.notesVisible) return [];
		return [new Text(this.config.theme.fg("muted", NOTES_HEADER), 1, 0), this.config.notesInput, new Spacer(1)];
	}

	footerRows(state: DialogState): Component[] {
		const question = this.config.questions[state.currentTab];
		// OneLineClippedText (not pi-tui `Text`) — `buildHintText` includes the collapse
		// affordance, pushing the rendered string past 80 columns; `Text` would wrap and
		// break the strategy's `footerRowCount = 2` invariant. Clipping on narrow terminals
		// drops the trailing parts (collapse hint first, then cancel) with `…`.
		// While the cancel guard is armed, the whole hint line swaps to the confirmation
		// warning (styled `warning`, not `dim`) so the pending destructive action reads at
		// a glance; the row count stays at 2 so the height math is untouched.
		return [
			new Spacer(1),
			new OneLineClippedText(
				state.cancelArmed
					? this.config.theme.fg("warning", ARMED_CANCEL_WARNING)
					: this.config.theme.fg("dim", buildHintText(question, this.config.isMulti, state)),
				1,
			),
		];
	}

	focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso.focusedItemRowRange(width);
		return (this.config.getPreviewPane() as unknown as PreviewPane).focusedItemRowRange(width);
	}
}

export interface SubmitTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	submitPicker: Component | undefined;
}

export class SubmitTabStrategy implements TabContentStrategy {
	/** Spacer(1) + Text(prompt, 1) + Spacer(1) + submitPicker(2) = 5 rendered rows. Fallback path lands at 5 via 2 trailing Spacer(1)s. */
	readonly footerRowCount = 5;

	constructor(private readonly config: SubmitTabStrategyConfig) {}

	headingRows(state: DialogState): Component[] {
		// Progress counter: "2 of 4 answered" next to the heading so the review tab answers
		// "how much is left?" without scanning the list or reading the footer warning.
		const answered = state.answers.size;
		const total = this.config.questions.length;
		const progress = this.config.theme.fg("muted", ` · ${answered} of ${total} answered`);
		return [
			new Text(this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)) + progress, 1, 0),
			new Spacer(1),
		];
	}

	bodyComponent(state: DialogState): Component {
		const c = new Container();
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			const a = state.answers.get(i);
			const label = q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
			// Compact one-line summary per question — `● header → answer` — so the review list
			// reads as a table and unanswered rows keep their place in the questionnaire shape
			// instead of vanishing (the old list silently skipped them). One line per question
			// also keeps the submit body within the tab-height budget the chrome equalizes on.
			const bullet = this.config.theme.fg("muted", ` ● ${label} `);
			if (!a) {
				c.addChild(
					new Text(
						`${bullet}${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("warning", UNANSWERED_MARKER)}`,
						1,
						0,
					),
				);
				continue;
			}
			const answerText = formatAnswerScalar(a, "summary");
			c.addChild(
				new Text(
					`${bullet}${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`,
					1,
					0,
				),
			);
			if (a.notes && a.notes.length > 0) {
				c.addChild(new Text(this.config.theme.fg("dim", `     notes: ${a.notes}`), 1, 0));
			}
		}
		return c;
	}

	bodyHeight(width: number, state: DialogState): number {
		return this.bodyComponent(state).render(width).length;
	}

	midRows(_state: DialogState): Component[] {
		return [];
	}

	footerRows(state: DialogState): Component[] {
		const missing: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			if (!state.answers.has(i)) {
				missing.push(q.header && q.header.length > 0 ? q.header : `Q${i + 1}`);
			}
		}
		const promptText =
			missing.length === 0
				? this.config.theme.fg("muted", READY_PROMPT)
				: this.config.theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`);
		const out: Component[] = [new Spacer(1), new Text(promptText, 1, 0), new Spacer(1)];
		if (this.config.submitPicker) {
			out.push(this.config.submitPicker);
		} else {
			// Padding when the picker isn't wired — keeps rendered row count at footerRowCount=5.
			out.push(new Spacer(1));
			out.push(new Spacer(1));
		}
		return out;
	}

	focusedItemRowRange(_width: number, _state: DialogState): [number, number] | undefined {
		return undefined;
	}
}

/**
 * Build the controls hint line. Order:
 *   Enter · ↑/↓ [· Space toggle] [· n notes] [· Tab switch] · Esc · Ctrl+] collapse
 *
 * `HINT_SINGLE` / `HINT_MULTI` are the CORE prefix that must always render — the
 * collapse affordance is appended last so the core stays a contiguous substring even
 * when the trailing part is clipped by `OneLineClippedText` on terminals < ~95 cols.
 * This is the trade we picked over wrapping (which would inflate `footerRowCount`
 * and desync the height math in `DialogView.render`).
 */
export function buildHintText(question: QuestionData | undefined, isMulti: boolean, state: DialogState): string {
	const parts: string[] = [HINT_PART_ENTER, HINT_PART_NAV];
	if (question?.multiSelect === true) parts.push(HINT_PART_TOGGLE);
	if (question && question.multiSelect !== true && state.focusedOptionHasPreview && !state.notesVisible) {
		parts.push(HINT_PART_NOTES);
	}
	if (isMulti) parts.push(HINT_PART_TAB);
	parts.push(HINT_PART_CANCEL);
	parts.push(HINT_PART_COLLAPSE);
	return parts.join(" · ");
}
