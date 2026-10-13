import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSkillsPanel, type PanelResult } from "../extensions/pi-codex-skills/skills-panel.ts";
import { createPlanPanel } from "../extensions/pi-codex-skills/skills-plan-panel.ts";
import type { DoctorDiagnostic, ManagedSkill, SkillCommand } from "../extensions/pi-codex-skills/types.ts";
import { BUNDLED_SKILLS } from "../extensions/pi-codex-skills/catalog.ts";

const keybindings = {
	matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean {
		return data === this.getKeys(binding)[0];
	},
	getKeys(binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string[] {
		return [{ "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "escape" }[binding]];
	},
};

const theme = {
	fg(_color: string, text: string): string { return text; },
	bg(_color: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

const commands: SkillCommand[] = [{
	name: "skill:plugin-creator",
	description: "审查包含 CJK 的变更，并报告足够长的描述以验证换行。",
	path: "C:/a-very-long-managed-path/codex-managed/plugin-creator/SKILL.md",
	sourceInfo: { source: "skill", scope: "user", origin: "top-level" },
}];

const diagnostics: DoctorDiagnostic[] = [{
	category: "collision",
	severity: "warning",
	message: "A deliberately long collision diagnostic checks width handling.",
	nextStep: "Rename the conflicting skill and reload Pi.",
	path: "C:/another/very-long/path/to/a/colliding/SKILL.md",
}];

const managedSkills: ManagedSkill[] = [{
	name: "plugin-creator",
	source: "bundle",
	compatibility: "ready",
	canonicalTarget: "C:/managed/plugin-creator",
	files: [],
	installedAt: "now",
	lastLoaderResult: "loaded",
	state: "installed",
}];

function createPanel(signal?: AbortSignal): { panel: ReturnType<typeof createSkillsPanel>; results: PanelResult[]; renders: () => number } {
	const results: PanelResult[] = [];
	let renderRequests = 0;
	const panel = createSkillsPanel({ requestRender() { renderRequests += 1; } }, theme, keybindings, commands, diagnostics, managedSkills, BUNDLED_SKILLS, (result) => results.push(result), signal);
	return { panel, results, renders: () => renderRequests };
}

test("panel remains width-safe for narrow, CJK, and long-path content", () => {
	const { panel } = createPanel();
	for (const width of [40, 60, 80]) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${width}-column overflow: ${line}`);
	}
	panel.handleInput("enter");
	for (const width of [40, 60, 80]) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${width}-column browse overflow: ${line}`);
	}
	panel.handleInput("enter");
	for (const width of [40, 60, 80]) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${width}-column details overflow: ${line}`);
	}
});

test("panels share the native frame, focus marker, and key-hint footer", () => {
	const { panel } = createPanel();
	const skillsLines = panel.render(60);
	assert.equal(skillsLines[0], "─".repeat(60));
	assert.match(skillsLines.join("\n"), /❯ Browse loaded skills/);
	assert.match(skillsLines.at(-2) ?? "", /·/);

	const plan = createPlanPanel({ requestRender() {} }, theme, keybindings, {
		operation: "install",
		skill: "plugin-creator",
		target: "C:/managed/plugin-creator",
		files: [],
		diagnostics: [],
		canApply: true,
	}, () => {});
	const planLines = plan.render(60);
	assert.equal(planLines[0], "─".repeat(60));
	assert.match(planLines.at(-2) ?? "", /·/);
});

test("browse filters and prefills only Pi's loaded command", () => {
	const { panel, results, renders } = createPanel();
	panel.handleInput("enter");
	panel.handleInput("r");
	assert.ok(renders() >= 2);
	panel.handleInput("enter");
	panel.handleInput("enter");
	assert.deepEqual(results, [{ kind: "prefill", command: "/skill:plugin-creator" }]);
});

test("panel honors custom selection keybindings", () => {
	const customKeybindings = {
		matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean {
			return data === this.getKeys(binding)[0];
		},
		getKeys(binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string[] {
			return [{ "tui.select.up": "w", "tui.select.down": "s", "tui.select.confirm": "x", "tui.select.cancel": "q" }[binding]];
		},
	};
	const results: PanelResult[] = [];
	const panel = createSkillsPanel({ requestRender() {} }, theme, customKeybindings, commands, diagnostics, managedSkills, BUNDLED_SKILLS, (result) => results.push(result));
	panel.handleInput("enter");
	assert.match(panel.render(80).join("\n"), /Browse loaded skills/);
	panel.handleInput("x");
	assert.match(panel.render(80).join("\n"), /Search: all loaded skills/);
	panel.handleInput("q");
	assert.deepEqual(results, []);
	assert.match(panel.render(80).join("\n"), /Browse loaded skills/);
});

test("manage selection returns an operation without writing files", () => {
	const { panel, results } = createPanel();
	panel.handleInput("down");
	panel.handleInput("enter");
	// BUNDLED_SKILLS[0] is plugin-creator; select it and choose "update".
	panel.handleInput("enter");
	panel.handleInput("down");
	panel.handleInput("enter");
	assert.deepEqual(results, [{ kind: "manage", skill: "plugin-creator", operation: "update" }]);
});

test("abort finishes once and dispose removes the listener", () => {
	const controller = new AbortController();
	const { panel, results } = createPanel(controller.signal);
	controller.abort();
	controller.abort();
	assert.deepEqual(results, [{ kind: "cancelled" }]);
	panel.dispose();
});

test("plan panel requires a separate confirmation before applying", () => {
	const results: Array<{ kind: string }> = [];
	const panel = createPlanPanel({ requestRender() {} }, theme, keybindings, {
		operation: "install",
		skill: "plugin-creator",
		target: "C:/managed/plugin-creator",
		files: [{ relativePath: "SKILL.md", sourceHash: "source", installedHash: "installed" }],
		diagnostics: [],
		canApply: true,
	}, (result) => results.push(result));
	for (const width of [40, 60, 80]) for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width);
	panel.handleInput("enter");
	assert.deepEqual(results, []);
	panel.handleInput("enter");
	assert.deepEqual(results, [{ kind: "confirmed" }]);
});

test("unsafe plan can only be closed", () => {
	const results: Array<{ kind: string }> = [];
	const panel = createPlanPanel({ requestRender() {} }, theme, keybindings, {
		operation: "install",
		skill: "plugin-creator",
		target: "C:/managed/plugin-creator",
		files: [],
		diagnostics: [{ category: "collision", severity: "error", message: "collision", nextStep: "rename" }],
		canApply: false,
	}, (result) => results.push(result));
	panel.handleInput("enter");
	assert.deepEqual(results, []);
	panel.handleInput("escape");
	assert.deepEqual(results, [{ kind: "cancelled" }]);
});
