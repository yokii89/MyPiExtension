import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";
import type { QuestionData } from "../tool/types.ts";
import {
	type BoundGlobalBinding,
	type BoundPerTabBinding,
	globalBinding,
	perTabBinding,
} from "../view/component-binding.ts";
import { MultiSelectView } from "../view/components/multi-select-view.ts";
import { OptionListView } from "../view/components/option-list-view.ts";
import { SubmitPicker } from "../view/components/submit-picker.ts";
import { TabBar } from "../view/components/tab-bar.ts";
import type { WrappingSelectItem, WrappingSelectTheme } from "../view/components/wrapping-select.ts";
import { DialogView } from "../view/dialog-builder.ts";
import { QuestionnairePropsAdapter } from "../view/props-adapter.ts";
import type { TabBodyHeights, TabComponents } from "../view/tab-components.ts";
import type { PerTabSelector } from "./selectors/contract.ts";
import { selectActiveTabIndex } from "./selectors/derivations.ts";
import {
	selectDialogProps,
	selectMultiSelectProps,
	selectOptionListProps,
	selectSubmitPickerProps,
	selectTabBarProps,
} from "./selectors/projections.ts";
import type { QuestionnaireState } from "./state.ts";

export interface QuestionnaireBuildConfig {
	tui: { terminal: { columns: number; rows: number }; requestRender(): void };
	theme: Theme;
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	isMulti: boolean;
	initialState: QuestionnaireState;
	getCurrentTab: () => number;
}

export interface QuestionnaireBuilt {
	adapter: QuestionnairePropsAdapter;
	inlineInput: Input;
	render: (width: number) => string[];
	invalidate: () => void;
}

interface HeightComputers {
	global: (width: number) => number;
	current: (width: number) => number;
}

/**
 * Both single- and multi-select bodies are now a single view (option list resp.
 * checkbox list) whose row count does not depend on which row is focused, so
 * `current` and `max` coincide — mirroring MultiSelectView's
 * `naturalHeight === render.length` invariant.
 */
function viewBodyHeights(view: { naturalHeight(width: number): number }): (width: number) => TabBodyHeights {
	return (width) => {
		const h = view.naturalHeight(width);
		return { current: h, max: h };
	};
}

const isActiveTab: PerTabSelector<boolean> = (s, ctx) =>
	ctx.i === selectActiveTabIndex(s.currentTab, ctx.totalQuestions);

/**
 * Pure factory: assembles every TUI component, the props adapter, and a
 * lifecycle handle. Session-state dependencies arrive via `getCurrentTab` and
 * the `inputBuffer` cell. Initial paint is delegated to
 * `adapter.apply(initialState)` (called by the session at construction-end);
 * no selector is invoked here.
 */
export function buildQuestionnaire(config: QuestionnaireBuildConfig): QuestionnaireBuilt {
	return new QuestionnaireBuilder(config).build();
}

/**
 * Programming-by-intention assembly: each private method names one
 * construction step from `build()`. Read top-down; the class is build-only and
 * discarded once the handle is returned.
 */
class QuestionnaireBuilder {
	private readonly tui: QuestionnaireBuildConfig["tui"];
	private readonly theme: Theme;
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly isMulti: boolean;
	private readonly initialState: QuestionnaireState;
	private readonly getCurrentTab: () => number;

	private readonly selectTheme: WrappingSelectTheme;
	private readonly inlineInput = new Input();
	private readonly getTerminalRows = () => this.tui.terminal.rows;

	constructor(config: QuestionnaireBuildConfig) {
		this.tui = config.tui;
		this.theme = config.theme;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.isMulti = config.isMulti;
		this.initialState = config.initialState;
		this.getCurrentTab = config.getCurrentTab;

		this.selectTheme = this.makeSelectTheme();
	}

	build(): QuestionnaireBuilt {
		const tabs = this.buildTabComponents();
		const submitPicker = this.buildSubmitPicker();
		const tabBar = this.buildTabBar();
		const heights = this.buildHeightComputers(tabs);
		const dialog = this.buildDialog(tabs, submitPicker, tabBar, heights);
		const globalBindings = this.buildGlobalBindings(dialog, submitPicker, tabBar);
		const perTabBindings = this.buildPerTabBindings();
		const adapter = this.buildAdapter(tabs, globalBindings, perTabBindings);
		return this.handle(adapter, dialog);
	}

	private makeSelectTheme(): WrappingSelectTheme {
		const t = this.theme;
		return {
			selectedText: (s) => t.fg("accent", t.bold(s)),
			description: (s) => t.fg("muted", s),
			scrollInfo: (s) => t.fg("dim", s),
		};
	}

	private buildTabComponents(): ReadonlyArray<TabComponents> {
		return this.questions.map((q, i) => this.buildTabFor(q, i));
	}

	private buildTabFor(question: QuestionData, index: number): TabComponents {
		const optionList = new OptionListView({
			items: this.itemsByTab[index] ?? [],
			theme: this.selectTheme,
		});
		const multiSelect = question.multiSelect ? new MultiSelectView(this.theme, question) : undefined;
		const bodyHeights = question.multiSelect ? viewBodyHeights(multiSelect!) : viewBodyHeights(optionList);
		return { optionList, multiSelect, bodyHeights };
	}

	private buildSubmitPicker(): SubmitPicker | undefined {
		return this.isMulti ? new SubmitPicker(this.theme) : undefined;
	}

	private buildTabBar(): TabBar | undefined {
		return this.isMulti ? new TabBar(this.theme) : undefined;
	}

	private buildHeightComputers(tabs: ReadonlyArray<TabComponents>): HeightComputers {
		const global = (width: number): number => {
			let max = 0;
			for (const tab of tabs) {
				const h = tab.bodyHeights(width).max;
				if (h > max) max = h;
			}
			return Math.max(1, max);
		};
		const current = (width: number): number => {
			const idx = Math.min(this.getCurrentTab(), tabs.length - 1);
			return Math.max(0, tabs[idx]?.bodyHeights(width).current ?? 0);
		};
		return { global, current };
	}

	private buildDialog(
		tabs: ReadonlyArray<TabComponents>,
		submitPicker: SubmitPicker | undefined,
		tabBar: TabBar | undefined,
		heights: HeightComputers,
	): DialogView {
		return new DialogView(
			{
				theme: this.theme,
				questions: this.questions,
				tabBar,
				isMulti: this.isMulti,
				tabsByIndex: tabs,
				submitPicker,
				getBodyHeight: heights.global,
				getCurrentBodyHeight: heights.current,
				getTerminalRows: this.getTerminalRows,
			},
			{ state: this.initialState },
		);
	}

	private buildGlobalBindings(
		dialog: DialogView,
		submitPicker: SubmitPicker | undefined,
		tabBar: TabBar | undefined,
	): ReadonlyArray<BoundGlobalBinding> {
		return [
			globalBinding({ component: dialog, select: selectDialogProps }),
			...(submitPicker ? [globalBinding({ component: submitPicker, select: selectSubmitPickerProps })] : []),
			...(tabBar ? [globalBinding({ component: tabBar, select: selectTabBarProps })] : []),
		];
	}

	private buildPerTabBindings(): ReadonlyArray<BoundPerTabBinding> {
		return [
			perTabBinding({
				resolve: (tab) => tab.optionList,
				predicate: isActiveTab,
				select: selectOptionListProps,
			}),
			perTabBinding({
				resolve: (tab) => tab.multiSelect,
				select: selectMultiSelectProps,
			}),
		];
	}

	private buildAdapter(
		tabs: ReadonlyArray<TabComponents>,
		globalBindings: ReadonlyArray<BoundGlobalBinding>,
		perTabBindings: ReadonlyArray<BoundPerTabBinding>,
	): QuestionnairePropsAdapter {
		return new QuestionnairePropsAdapter({
			tui: this.tui,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			tabsByIndex: tabs,
			inlineInput: this.inlineInput,
			globalBindings,
			perTabBindings,
		});
	}

	private handle(adapter: QuestionnairePropsAdapter, dialog: DialogView): QuestionnaireBuilt {
		return {
			adapter,
			inlineInput: this.inlineInput,
			render: (w) => dialog.render(w),
			invalidate: () => adapter.invalidate(),
		};
	}
}
