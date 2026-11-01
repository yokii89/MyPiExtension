import type { Input } from "@earendil-works/pi-tui";
import type { BindingContext, PerTabBindingContext } from "../state/selectors/contract.ts";
import { selectActiveView } from "../state/selectors/focus.ts";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import type { BoundGlobalBinding, BoundPerTabBinding } from "./component-binding.ts";
import type { WrappingSelectItem } from "./components/wrapping-select.ts";
import type { TabComponents } from "./tab-components.ts";

/**
 * Reads pi-tui Input's private `cursor` field via type escape with full runtime validation.
 * Returns `undefined` on any failure → graceful degradation to end-of-buffer cursor.
 * Follow-up: replace with Input.getCursorOffset() when pi-tui exposes a public API.
 */
function getInputCursorOffset(input: Input): number | undefined {
	const raw = (input as unknown as { cursor?: unknown }).cursor;
	if (typeof raw !== "number") return undefined;
	if (!Number.isSafeInteger(raw)) return undefined;
	const value = input.getValue();
	if (raw < 0 || raw > value.length) return undefined;
	return raw;
}

export interface QuestionnairePropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	inlineInput: Input;
	globalBindings: ReadonlyArray<BoundGlobalBinding>;
	perTabBindings: ReadonlyArray<BoundPerTabBinding>;
}

/**
 * View fan-out: drives every component setter from the canonical state via
 * two binding registries. `globalBindings` covers the cross-tab components
 * (dialog, submitPicker?, tabBar?); `perTabBindings` covers the
 * per-tab kinds (optionList, multiSelect?). The hand-coded fan-out
 * collapses to one global loop + one nested per-tab loop. The inline-Other
 * value is read from the headless `inlineInput` instance per tick into ctx so
 * `selectOptionListProps` sees the live value.
 */
export class QuestionnairePropsAdapter {
	private readonly tui: QuestionnairePropsAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly tabsByIndex: ReadonlyArray<TabComponents>;
	private readonly inlineInput: Input;
	private readonly globalBindings: ReadonlyArray<BoundGlobalBinding>;
	private readonly perTabBindings: ReadonlyArray<BoundPerTabBinding>;

	constructor(config: QuestionnairePropsAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.tabsByIndex = config.tabsByIndex;
		this.inlineInput = config.inlineInput;
		this.globalBindings = config.globalBindings;
		this.perTabBindings = config.perTabBindings;
	}

	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const activeView = selectActiveView(state, totalQuestions);

		const ctx: BindingContext = {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			totalQuestions,
			activeView,
			inputBuffer: this.inlineInput.getValue(),
			inputCursorOffset: getInputCursorOffset(this.inlineInput),
		};

		for (const binding of this.globalBindings) {
			binding.apply(state, ctx);
		}

		for (let i = 0; i < this.tabsByIndex.length; i++) {
			const tab = this.tabsByIndex[i]!;
			const tabCtx: PerTabBindingContext = { ...ctx, tab, i };
			for (const binding of this.perTabBindings) {
				binding.apply(state, tabCtx);
			}
		}

		this.tui.requestRender();
	}

	/**
	 * Invalidates every owned renderable. Called by the session in place of
	 * the old `dialog.invalidate()` forwarding chain — DialogView no longer
	 * reaches into siblings (tabBar).
	 * Iterates the same registries used by `apply()`.
	 */
	invalidate(): void {
		for (const b of this.globalBindings) b.invalidate();
		for (const tab of this.tabsByIndex) {
			tab.optionList.invalidate();
			tab.multiSelect?.invalidate();
		}
	}
}
