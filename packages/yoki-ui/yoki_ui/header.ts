import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	center,
	collectPiCommandNames,
	formatCwd,
	formatModelLabel,
	formatThinkingLabel,
	headerColumnWidths,
	padRight,
	pickSlashCommandTips,
} from "./render-utils.ts";

const LOGO_CELL = "███";

type LogoColor = "panel" | "brand";

function hasCell(y: number, x: number, cells: string): boolean {
	return cells.split(" ").includes(`${y},${x}`);
}

function logoCellColor(y: number, x: number): LogoColor {
	// Static final Pi mark (former animation phase 6).
	return hasCell(y, x, "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5") ? "brand" : "panel";
}

function colorCell(color: LogoColor, paintBrand: (text: string) => string): string {
	if (color === "brand") return paintBrand(LOGO_CELL);
	return " ".repeat(LOGO_CELL.length);
}

function piLogo(paintBrand: (text: string) => string): string[] {
	// Crop the installer's 9-row canvas vertically for a compact header, then
	// tight-crop empty columns so the mark centers cleanly in the logo half
	// (same idea as Claude Code's centered mascot).
	const grid: LogoColor[][] = [];
	for (let y = 1; y <= 7; y++) {
		const row: LogoColor[] = [];
		for (let x = 1; x <= 8; x++) row.push(logoCellColor(y, x));
		grid.push(row);
	}

	let minX = 7;
	let maxX = 0;
	for (const row of grid) {
		row.forEach((cell, x) => {
			if (cell !== "panel") {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
		});
	}
	if (maxX < minX) {
		minX = 0;
		maxX = 7;
	}

	return grid.map((row) => {
		let line = "";
		for (let x = minX; x <= maxX; x++) line += colorCell(row[x]!, paintBrand);
		return line;
	});
}

function borderLine(
	left: string,
	label: string,
	right: string,
	width: number,
	paint: (text: string) => string,
): string {
	if (width <= 1) return "";
	if (width < 8 || label.length === 0) {
		return paint(truncateToWidth(left + "─".repeat(Math.max(0, width - 2)) + right, width, ""));
	}

	const before = "─── ";
	const after = " ─────";
	const fixedWidth = visibleWidth(before) + visibleWidth(label) + visibleWidth(after);
	const fill = Math.max(0, width - 2 - fixedWidth);
	return `${paint(left)}${paint(before)}${label}${paint(after)}${paint("─".repeat(fill))}${paint(right)}`;
}

function boxedLine(content: string, width: number, paint: (text: string) => string): string {
	if (width <= 2) return truncateToWidth(content, width, "");
	return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
}

function twoColumn(
	left: string,
	right: string,
	leftWidth: number,
	rightWidth: number,
	paint: (text: string) => string,
): string {
	// Tips sidebar truncates with an ellipsis (Claude Code style); logo half does not.
	return `${padRight(left, leftWidth)} ${paint("│")} ${padRight(right, rightWidth, "…")}`;
}

class PiStartupHeader implements Component {
	private readonly tipCommands: string[];
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	/** Avoid rebuilding the logo grid on every keystroke-driven TUI render. */
	private renderCache: { key: string; lines: string[] } | undefined;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, _tui: TUI) {
		this.pi = pi;
		this.ctx = ctx;

		const pool = collectPiCommandNames(this.pi.getCommands());
		this.tipCommands = pickSlashCommandTips(pool, {
			fixed: ["use-default-tui"],
			count: 3,
		});
	}

	render(width: number): string[] {
		const model = formatModelLabel(this.ctx.model);
		const effort = formatThinkingLabel(this.pi.getThinkingLevel());
		const cwd = formatCwd(this.ctx.cwd);
		const key = `${width}\0${model}\0${effort}\0${cwd}`;
		if (this.renderCache?.key === key) return this.renderCache.lines;

		const theme = this.ctx.ui.theme;
		const paint = (s: string) => theme.fg("accent", s);
		const muted = (s: string) => theme.fg("muted", s);
		const dim = (s: string) => theme.fg("dim", s);
		const bold = (s: string) => theme.bold(s);

		if (width < 24) {
			const lines = [paint(`Pi v${VERSION}`)];
			this.renderCache = { key, lines };
			return lines;
		}

		const innerWidth = width - 2;
		const { leftWidth, rightWidth, useTips } = headerColumnWidths(innerWidth);

		const leftLines = [
			...piLogo(paint).map((line) => center(line, leftWidth)),
			center(bold("Let's build something great"), leftWidth),
			center(muted(`${model} · ${effort} effort`), leftWidth),
			center(dim(cwd), leftWidth),
		];

		// /use-default-tui + 3 random real pi commands (picked once in constructor).
		const tipDivider = paint("─".repeat(Math.max(8, Math.min(rightWidth, 22))));
		const [cmd0 = "", cmd1 = "", cmd2 = "", cmd3 = ""] = this.tipCommands;
		const tipLines = [
			"",
			paint(bold("Getting started")),
			muted("Ask Pi to build it"),
			tipDivider,
			paint(bold("Commands")),
			muted(cmd0),
			muted(cmd1),
			muted(cmd2),
			muted(cmd3),
			"",
		];

		const lines = [borderLine("╭", `${paint("Pi")} v${VERSION}`, "╮", width, paint)];
		for (let i = 0; i < leftLines.length; i++) {
			const content = useTips
				? twoColumn(leftLines[i] ?? "", tipLines[i] ?? "", leftWidth, rightWidth, paint)
				: padRight(leftLines[i] ?? "", leftWidth);
			lines.push(boxedLine(content, width, paint));
		}
		lines.push(borderLine("╰", "", "╯", width, paint));
		const result = lines.map((line) => truncateToWidth(line, width, ""));
		this.renderCache = { key, lines: result };
		return result;
	}

	invalidate(): void {
		this.renderCache = undefined;
	}

	dispose(): void {
		this.renderCache = undefined;
	}
}


let activePiStartupHeader: PiStartupHeader | undefined;

export function disposeActiveHeader(): void {
	activePiStartupHeader?.dispose();
	activePiStartupHeader = undefined;
}

export function applyHeader(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setHeader((tui) => {
		disposeActiveHeader();
		activePiStartupHeader = new PiStartupHeader(pi, ctx, tui);
		return activePiStartupHeader;
	});
	ctx.ui.setWorkingIndicator(undefined);
}