import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ELLIPSIS, POINTER, rule as sharedRule } from "yoki_ui/style";

const ellipsis = ELLIPSIS;

export function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth === 1) return ellipsis;
	let result = "";
	for (const character of text) {
		if (visibleWidth(result + character) > maxWidth - 1) break;
		result += character;
	}
	return `${result}${ellipsis}`;
}

export function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number): void {
	const renderWidth = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= renderWidth) {
		lines.push(...wrapTextWithAnsi(`${prefix}${text}`, renderWidth));
		return;
	}
	const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
	const continuation = " ".repeat(prefixWidth);
	for (let index = 0; index < wrapped.length; index++) lines.push(`${index === 0 ? prefix : continuation}${wrapped[index] ?? ""}`);
}

export function panelRule(theme: Theme, width: number): string {
	return sharedRule(theme, width);
}

export function panelTitle(theme: Theme, title: string, width: number): string {
	return theme.fg("accent", theme.bold(truncateVisible(` ${title}`, Math.max(1, width))));
}

export function selectedRow(theme: Theme, selected: boolean, label: string, width: number): string {
	const prefix = selected ? theme.fg("text", POINTER) : "  ";
	const labelWidth = Math.max(1, width - visibleWidth(prefix));
	const content = truncateVisible(label, labelWidth);
	const styled = selected
		? theme.bg("selectedBg", theme.bold(theme.fg("text", content)))
		: theme.fg("muted", content);
	return `${prefix}${styled}`;
}
