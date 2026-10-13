import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getPlanBadge, createStatuslineRuntime, parseGitStatus } from "../yoki_ui/statusline.ts";
import type { StatuslineConfig } from "../yoki_ui/config.ts";

const PLAN_BRIDGE_SYMBOL = Symbol.for("@yoki/yoki-plan:bridge");

describe("parseGitStatus", () => {
	test("counts unmerged entries as conflicts", () => {
		const output = [
			"# branch.oid 1234567890abcdef1234567890abcdef12345678",
			"# branch.upstream origin/main",
			"# branch.ab +1 -2",
			"1 .M N... 000000 000000 000000 file-a",
			"u 1.1 N... 000000 000000 000000 000000 conflicted-a",
			"u 2.2 N... 000000 000000 000000 000000 conflicted-b",
			"? untracked-file",
		].join("\n");
		const status = parseGitStatus(output);
		assert.equal(status.conflicts, 2);
		assert.equal(status.modified, 1);
		assert.equal(status.untracked, 1);
		assert.equal(status.ahead, 1);
		assert.equal(status.behind, 2);
	});

	test("clean repo has zero conflicts", () => {
		assert.equal(parseGitStatus("# branch.ab +0 -0\n").conflicts, 0);
	});
});

describe("getPlanBadge", () => {
	const setBridge = (bridge: unknown) => {
		(globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL] = bridge;
	};
	const restoreBridge = (previous: unknown) => {
		if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
		else setBridge(previous);
	};

	test("empty without a bridge", () => {
		const previous = (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
		delete (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
		try {
			assert.equal(getPlanBadge(), "");
		} finally {
			restoreBridge(previous);
		}
	});

	test("shows badge only in plan mode", () => {
		const previous = (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
		const bridge = {
			isLoaded: () => true,
			getMode: () => "edit",
		};
		setBridge(bridge);
		try {
			assert.equal(getPlanBadge(), "");
			(bridge as { getMode: () => string }).getMode = () => "plan";
			assert.equal(getPlanBadge(), "◇ plan");
		} finally {
			restoreBridge(previous);
		}
	});
});

type FooterFactory = (
	tui: unknown,
	theme: unknown,
	data: unknown,
) => { render: (width: number) => string[] };

/** Minimal fakes to drive the footer render closure returned by applyFooter. */
function captureFooterRender(): (width: number) => string[] {
	const config: StatuslineConfig = {
		icon: false,
		directory: true,
		gitBranch: true,
		gitStatus: true,
		context: true,
		model: true,
		usage: true,
		extensionStatuses: false,
	};

	const theme = { fg: (_role: string, text: string) => text };
	const footerData = {
		onBranchChange: () => () => {},
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
	};
	const tui = { requestRender: () => {} };

	const pi = {
		on: () => {},
		registerCommand: () => {},
		exec: async () => ({ code: 0, stdout: "" }),
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;

	let factory: FooterFactory | undefined;
	const ctx = {
		mode: "tui",
		cwd: "/repo",
		model: { id: "test-model", reasoning: false },
		ui: {
			setFooter: (value: FooterFactory) => {
				factory = value;
			},
		},
		sessionManager: { getEntries: () => [] },
		getContextUsage: () => ({ percent: 42.5, contextWindow: 100_000 }),
	} as unknown as ExtensionContext;

	createStatuslineRuntime(pi).applyFooter(ctx, config);
	if (!factory) throw new Error("setFooter factory was not captured");
	return (width: number) => factory!(tui, theme, footerData).render(width);
}

describe("statusline footer render", () => {
	test("renders without crashing at extreme widths", async () => {
		const render = captureFooterRender();
		// Let the fire-and-forget git probes settle (mocked no-ops).
		await new Promise((resolve) => setTimeout(resolve, 10));
		for (const width of [0, 1, 2, 5, 10, 40, 120]) {
			const lines = render(width);
			assert.ok(Array.isArray(lines));
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`line wider than ${width}: "${line}" (visible ${visibleWidth(line)})`,
				);
			}
		}
	});

	test("plan badge appears in the right segment while in plan mode", async () => {
		const previous = (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
		(globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL] = {
			isLoaded: () => true,
			getMode: () => "plan",
		};
		try {
			const render = captureFooterRender();
			await new Promise((resolve) => setTimeout(resolve, 10));
			const line = render(120)[0];
			assert.ok(line.includes("◇ plan"), `expected plan badge in: ${line}`);
		} finally {
			if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL];
			else (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE_SYMBOL] = previous;
		}
	});
});
