import type { StatefulView } from "../stateful-view.ts";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.ts";

/**
 * Maximum number of option rows visible in the WrappingSelect window.
 */
export const MAX_VISIBLE_OPTIONS = 10;

export interface OptionListViewConfig {
	items: readonly WrappingSelectItem[];
	theme: WrappingSelectTheme;
}

/**
 * Per-tick projection of OptionListView state. After Phase 11b, `inputBuffer`
 * is part of the props bag — the session-owned `inlineInput` (a headless
 * `pi-tui` Input instance) supplies its current `getValue()` here per tick.
 * `OptionListView` is purely props-driven; the imperative buffer surface and
 * read-back getters are gone.
 */
export interface OptionListViewProps {
	selectedIndex: number;
	focused: boolean;
	inputBuffer: string;
	inputCursorOffset?: number;
	/** Optional previously-confirmed indicator. Omit when no marker should be drawn. */
	confirmed?: { index: number; labelOverride?: string };
	/** Optional saved free-text draft; rendered as a suffix on the unfocused "other" row. */
	draft?: string;
}

/**
 * Sole owner of the option list's interactive state. Wraps a single
 * `WrappingSelect`. Implements `StatefulView<OptionListViewProps>`:
 * `setProps` is the only mutator; render output reflects the last props
 * received.
 */
export class OptionListView implements StatefulView<OptionListViewProps> {
	private readonly select: WrappingSelect;

	constructor(config: OptionListViewConfig) {
		this.select = new WrappingSelect(config.items, Math.min(config.items.length, MAX_VISIBLE_OPTIONS), config.theme, {
			numberStartOffset: 0,
			totalItemsForNumbering: config.items.length,
		});
	}

	setProps(props: OptionListViewProps): void {
		this.select.setSelectedIndex(props.selectedIndex);
		this.select.setFocused(props.focused);
		this.select.setConfirmedIndex(props.confirmed?.index, props.confirmed?.labelOverride);
		this.select.setInputBuffer(props.inputBuffer);
		this.select.setInputCursorOffset(props.inputCursorOffset);
		this.select.setDraft(props.draft);
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.select.invalidate();
	}

	render(width: number): string[] {
		return this.select.render(width);
	}

	/**
	 * Row count of the body at `width`. Mirrors MultiSelectView's contract — the height
	 * computers use this for dialog sizing without a separate render pass.
	 */
	naturalHeight(width: number): number {
		return this.select.render(width).length;
	}

	focusedItemRowRange(width: number): [number, number] {
		return this.select.focusedItemRowRange(width);
	}
}
