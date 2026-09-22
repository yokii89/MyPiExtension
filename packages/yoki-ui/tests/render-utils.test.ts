import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	applyRoundedEditorBorders,
	CURSOR_MARKER,
	cursorOpenFromFgAnsi,
	findBottomBorderIndex,
	formatCwd,
	formatModelLabel,
	formatThinkingLabel,
	headerColumnWidths,
	isEditorBorderLine,
	pickSlashCommandTips,
	collectPiCommandNames,
	restyleEditorCursor,
	roundedBorderLine,
	stripAnsi,
	PI_BUILTIN_SLASH_COMMAND_NAMES,
} from "../yoki_ui/render-utils.ts";

describe("formatCwd", () => {
	it("replaces HOME prefix with ~", () => {
		assert.equal(formatCwd("/Users/me/Workspace/mypi", "/Users/me"), "~/Workspace/mypi");
	});

	it("leaves paths outside home unchanged", () => {
		assert.equal(formatCwd("/tmp/project", "/Users/me"), "/tmp/project");
	});
});

describe("formatModelLabel", () => {
	it("formats provider/id when both exist", () => {
		assert.equal(formatModelLabel({ provider: "openai-codex", id: "gpt-5.5" }), "openai-codex/gpt-5.5");
	});

	it("falls back to id or default", () => {
		assert.equal(formatModelLabel({ id: "gpt-5.5" }), "gpt-5.5");
		assert.equal(formatModelLabel(undefined), "Default model");
	});
});

describe("formatThinkingLabel", () => {
	it("keeps off explicit", () => {
		assert.equal(formatThinkingLabel("off"), "off");
		assert.equal(formatThinkingLabel("high"), "high");
	});
});

describe("pickSlashCommandTips", () => {
	it("always leads with fixed commands then random picks", () => {
		const tips = pickSlashCommandTips(["model", "compact", "new", "reload"], {
			fixed: ["use-default-tui"],
			count: 3,
			random: () => 0, // deterministic shuffle direction
		});
		assert.equal(tips[0], "/use-default-tui");
		assert.equal(tips.length, 4);
		assert.ok(tips.every((t) => t.startsWith("/")));
		assert.ok(!tips.includes("/use-claude-code-tui"));
	});

	it("excludes fixed and package self-command from the random pool", () => {
		const tips = pickSlashCommandTips(
			["use-default-tui", "use-claude-code-tui", "model", "compact", "hotkeys"],
			{
				fixed: ["use-default-tui"],
				count: 3,
				random: () => 0,
			},
		);
		assert.equal(tips[0], "/use-default-tui");
		assert.equal(tips.length, 4);
		assert.ok(!tips.includes("/use-claude-code-tui"));
		assert.deepEqual(new Set(tips.slice(1)), new Set(["/model", "/compact", "/hotkeys"]));
	});

	it("handles a small pool without padding", () => {
		const tips = pickSlashCommandTips(["model"], {
			fixed: ["use-default-tui"],
			count: 3,
		});
		assert.deepEqual(tips, ["/use-default-tui", "/model"]);
	});
});

describe("collectPiCommandNames", () => {
	it("merges builtins with session commands", () => {
		const names = collectPiCommandNames([{ name: "use-default-tui" }, { name: "my-cmd" }]);
		assert.ok(names.includes("model"));
		assert.ok(names.includes(PI_BUILTIN_SLASH_COMMAND_NAMES[0]!));
		assert.ok(names.includes("my-cmd"));
		assert.ok(names.includes("use-default-tui"));
	});
});

describe("headerColumnWidths", () => {
	it("gives the logo half most of the width on wide terminals", () => {
		const layout = headerColumnWidths(100);
		assert.equal(layout.useTips, true);
		assert.ok(layout.leftWidth > layout.rightWidth);
		assert.ok(layout.rightWidth <= 28);
		assert.equal(layout.leftWidth + layout.rightWidth + 3, 100);
	});

	it("keeps a wide centered logo half on medium split-pane widths", () => {
		// ~76-col herdr pane → inner ~74
		const layout = headerColumnWidths(74);
		assert.equal(layout.useTips, true);
		assert.ok(layout.leftWidth > layout.rightWidth);
		assert.ok(layout.leftWidth >= 45, `left should be hero-width, got ${layout.leftWidth}`);
		assert.ok(layout.rightWidth <= 28);
	});

	it("uses full inner width when tips cannot fit", () => {
		const layout = headerColumnWidths(40);
		assert.equal(layout.useTips, false);
		assert.equal(layout.leftWidth, 40);
		assert.equal(layout.rightWidth, 0);
	});

	it("enables tips when logo + sidebar minimums fit", () => {
		// min left 28 + gap 3 + min tips 16 = 47
		const layout = headerColumnWidths(47);
		assert.equal(layout.useTips, true);
		assert.ok(layout.leftWidth >= 28);
		assert.ok(layout.rightWidth >= 16);
	});
});

describe("editor border detection", () => {
	it("recognizes plain and scroll indicator borders", () => {
		assert.equal(isEditorBorderLine("─".repeat(40)), true);
		assert.equal(isEditorBorderLine("\x1b[38;2;1;2;3m" + "─".repeat(40) + "\x1b[39m"), true);
		assert.equal(isEditorBorderLine("─── ↑ 2 more ──────────"), true);
		assert.equal(isEditorBorderLine("─── ↓ 5 more ──────────"), true);
	});

	it("rejects content and autocomplete-style rows", () => {
		assert.equal(isEditorBorderLine(" hello world"), false);
		assert.equal(isEditorBorderLine(" \x1b[7mselected item\x1b[0m"), false);
		assert.equal(isEditorBorderLine(""), false);
	});

	it("finds the bottom border before autocomplete rows", () => {
		const lines = [
			"─".repeat(20),
			" content line",
			"─── ↓ 1 more ───────",
			" /model",
			" /compact",
		];
		assert.equal(findBottomBorderIndex(lines), 2);
	});

	it("falls back to the last line when no border is found", () => {
		assert.equal(findBottomBorderIndex(["only", "content"]), 1);
	});
});

describe("roundedBorderLine", () => {
	it("wraps plain borders with rounded corners at the requested width", () => {
		const width = 20;
		const top = roundedBorderLine("─".repeat(width), width, "top", (s) => s);
		const bottom = roundedBorderLine("─".repeat(width), width, "bottom", (s) => s);
		assert.equal(visibleWidth(top), width);
		assert.equal(visibleWidth(bottom), width);
		assert.equal(stripAnsi(top).startsWith("╭"), true);
		assert.equal(stripAnsi(top).endsWith("╮"), true);
		assert.equal(stripAnsi(bottom).startsWith("╰"), true);
		assert.equal(stripAnsi(bottom).endsWith("╯"), true);
	});

	it("preserves scroll indicators inside rounded borders", () => {
		const width = 30;
		const line = roundedBorderLine("─── ↓ 3 more ──────────────", width, "bottom", (s) => s);
		assert.match(stripAnsi(line), /↓ 3 more/);
		assert.equal(visibleWidth(line), width);
	});
});

describe("cursorOpenFromFgAnsi", () => {
	it("keeps truecolor fg for the text caret", () => {
		const open = cursorOpenFromFgAnsi("\x1b[38;2;215;119;87m");
		assert.equal(open, "\x1b[38;2;215;119;87m");
	});

	it("keeps 256-color fg", () => {
		const open = cursorOpenFromFgAnsi("\x1b[38;5;208m");
		assert.equal(open, "\x1b[38;5;208m");
	});
});

describe("applyRoundedEditorBorders", () => {
	it("does not turn the last autocomplete row into a bottom border", () => {
		const width = 24;
		const lines = [
			"─".repeat(width),
			" typed text",
			"─".repeat(width),
			" /use-claude-code-tui",
			" /use-default-tui",
		];
		const result = applyRoundedEditorBorders(lines, width, (s) => s);
		assert.equal(stripAnsi(result[0]!).startsWith("╭"), true);
		assert.equal(stripAnsi(result[2]!).startsWith("╰"), true);
		assert.equal(stripAnsi(result[3]!), " /use-claude-code-tui".padEnd(width));
		assert.equal(stripAnsi(result[4]!), " /use-default-tui".padEnd(width));
	});

	it("keeps content rows half-open without vertical sides", () => {
		const width = 24;
		const lines = ["─".repeat(width), " typed text", "─".repeat(width)];
		const result = applyRoundedEditorBorders(lines, width, (s) => s);
		assert.equal(stripAnsi(result[0]!), `╭${"─".repeat(width - 2)}╮`);
		assert.equal(stripAnsi(result[1]!).includes("│"), false);
		assert.equal(stripAnsi(result[2]!), `╰${"─".repeat(width - 2)}╯`);
		assert.equal(visibleWidth(result[1]!), width);
	});
});

describe("restyleEditorCursor", () => {
	const open = cursorOpenFromFgAnsi("\x1b[38;2;215;119;87m");

	it("restyles reverse-video end cursor with theme color (space cell, no bar glyph)", () => {
		const line = `hello${CURSOR_MARKER}\x1b[7m \x1b[0mworld`;
		const out = restyleEditorCursor(line, open);
		assert.equal(out.includes(CURSOR_MARKER), true);
		assert.equal(out.includes("│"), false);
		assert.equal(out.includes(`${open}\x1b[7m \x1b[0m`), true);
		assert.equal(visibleWidth(out), visibleWidth(line));
	});

	it("restyles unfocused reverse-video cursor on a character in place (no inserted bar)", () => {
		const line = `ab\x1b[7mc\x1b[0mde`;
		const out = restyleEditorCursor(line, open);
		assert.equal(out, `ab${open}\x1b[7mc\x1b[0mde`);
		assert.equal(out.includes("│"), false);
		assert.equal(visibleWidth(out), visibleWidth(line));
	});

	it("restyles focused mid-line cursor in place after the focus marker", () => {
		const line = `ab${CURSOR_MARKER}\x1b[7mc\x1b[0mde`;
		const out = restyleEditorCursor(line, open);
		assert.equal(out, `ab${CURSOR_MARKER}${open}\x1b[7mc\x1b[0mde`);
		assert.equal(out.includes("│"), false);
		assert.equal(visibleWidth(out), visibleWidth(line));
	});

	it("hides the end caret during the blink off-phase (plain space)", () => {
		const line = `hello${CURSOR_MARKER}\x1b[7m \x1b[0mworld`;
		const out = restyleEditorCursor(line, open, false);
		assert.equal(out.includes("\x1b[7m"), false);
		assert.equal(out.includes("│"), false);
		assert.equal(out.includes(`hello${CURSOR_MARKER} world`), true);
	});

	it("hides mid-line caret during the blink off-phase while keeping the character", () => {
		const line = `ab\x1b[7mc\x1b[0mde`;
		const out = restyleEditorCursor(line, open, false);
		assert.equal(out, "abcde");
	});

	it("keeps mid-line visible width stable across blink phases (no padding steal)", () => {
		const line = `ab\x1b[7mc\x1b[0mde `;
		const on = restyleEditorCursor(line, open, true);
		const off = restyleEditorCursor(line, open, false);
		assert.equal(on, `ab${open}\x1b[7mc\x1b[0mde `);
		assert.equal(off, "abcde ");
		assert.equal(visibleWidth(on), visibleWidth(line));
		assert.equal(visibleWidth(off), visibleWidth(line));
		assert.equal(visibleWidth(on), visibleWidth(off));
	});

	it("does not restyle reverse video that appears before the cursor marker", () => {
		const line = `\x1b[7mselected\x1b[0m${CURSOR_MARKER}plain`;
		const out = restyleEditorCursor(line, open);
		assert.equal(out, line);
		assert.equal(out.includes("\x1b[7mselected\x1b[0m"), true);
	});
});

describe("pickSlashCommandTips yoki_ui", () => {
	it("excludes use-yoki-ui from the random pool", () => {
		const tips = pickSlashCommandTips(
			["use-default-tui", "use-yoki-ui", "use-claude-code-tui", "model", "compact", "hotkeys"],
			{
				fixed: ["use-default-tui"],
				count: 3,
				random: () => 0,
			},
		);
		assert.equal(tips[0], "/use-default-tui");
		assert.ok(!tips.includes("/use-yoki-ui"));
		assert.ok(!tips.includes("/use-claude-code-tui"));
	});
});
