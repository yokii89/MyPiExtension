import type { MultiSelectView } from "./components/multi-select-view.ts";
import type { OptionListView } from "./components/option-list-view.ts";

export interface TabBodyHeights {
	current: number;
	max: number;
}

export interface TabComponents {
	optionList: OptionListView;
	multiSelect?: MultiSelectView;
	bodyHeights: (width: number) => TabBodyHeights;
}
