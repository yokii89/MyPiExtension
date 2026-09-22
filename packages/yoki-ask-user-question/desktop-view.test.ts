import type { ViewNode, ViewSpec } from "@pidesk/view-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildDesktopQuestionnaireSpec, presentQuestionnaireOnDesktop } from "./desktop-view.js";
import type { QuestionParams } from "./tool/types.js";

const PARAMS: QuestionParams = {
	questions: [
		{
			question: "Which library?",
			header: "Library",
			options: [
				{ label: "A", description: "fast" },
				{ label: "B", description: "slow", preview: "```ts\nconst b = 1;\n```" },
			],
		},
		{
			question: "Which features?",
			header: "Features",
			multiSelect: true,
			options: [
				{ label: "Auth", description: "login" },
				{ label: "Billing", description: "pay" },
			],
		},
	],
};

const SINGLE: QuestionParams = {
	questions: [
		{
			question: "Which library?",
			header: "Library",
			options: [
				{ label: "A", description: "fast" },
				{ label: "B", description: "slow" },
			],
		},
	],
};

type ChangeEvent = { type: "change"; nodeId: string; value: unknown };
type ActionEvent = { type: "action"; actionId: string; values?: Record<string, unknown> };
type TestEvent = ChangeEvent | ActionEvent;

interface ClientHarness {
	updates: ViewSpec[];
	closes: Array<{ action?: string; values?: Record<string, unknown> }>;
	send(event: TestEvent): void;
	settle(result: { action?: string; values?: Record<string, unknown> }): void;
	open: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

/** Fake DesktopViewClient：记录 update 回显 / close，可手动派发 Host 事件。 */
function makeClient(): ClientHarness {
	const updates: ViewSpec[] = [];
	const closes: Array<{ action?: string; values?: Record<string, unknown> }> = [];
	let handler: ((event: TestEvent, session: unknown) => void) | null = null;
	let resolveOpen: ((result: { action?: string; values?: Record<string, unknown> }) => void) | null = null;
	const session = {
		update: (spec: ViewSpec) => updates.push(spec),
		close: (result: { action?: string; values?: Record<string, unknown> }) => {
			closes.push(result);
			resolveOpen?.(result);
		},
	};
	const open = vi.fn(async (_spec: ViewSpec, opts?: { onEvent?: (event: TestEvent, session: unknown) => void }) => {
		handler = opts?.onEvent ?? null;
		return await new Promise((resolve) => {
			resolveOpen = resolve;
		});
	});
	return {
		updates,
		closes,
		send: (event) => handler?.(event, session),
		settle: (result) => resolveOpen?.(result),
		open,
		dispose: vi.fn(),
	};
}

function lastUpdate(client: ClientHarness): ViewSpec {
	const spec = client.updates.at(-1);
	if (!spec) throw new Error("no update echoed");
	return spec;
}

function walkIds(node: ViewNode, acc: string[] = []): string[] {
	if ("id" in node && typeof node.id === "string") acc.push(node.id);
	if ("children" in node && Array.isArray(node.children)) {
		for (const c of node.children) walkIds(c, acc);
	}
	if (node.type === "tabs") {
		for (const tab of node.tabs) {
			acc.push(`tab:${tab.id}`);
			for (const child of tab.children) walkIds(child, acc);
		}
	}
	return acc;
}

function tabsOf(spec: ViewSpec): Extract<ViewNode, { type: "tabs" }> {
	if (spec.root.type !== "tabs") throw new Error(`expected tabs root, got ${spec.root.type}`);
	return spec.root;
}

describe("desktop questionnaire spec", () => {
	it("single-question dialogs keep the flat card column (no tab bar)", () => {
		const spec = buildDesktopQuestionnaireSpec(SINGLE);
		expect(spec.placement).toBe("widget");
		expect(spec.placementRequired).toBe(true);
		expect(spec.placementHint).toEqual({ side: "aboveEditor", floating: true });
		expect(spec.actions?.map((a) => a.id)).toEqual(["cancel", "submit"]);
		expect(spec.root.type).toBe("column");
		if (spec.root.type !== "column") throw new Error("root");
		expect(spec.root.children).toHaveLength(1);
		expect(spec.root.children[0].type).toBe("card");
	});

	it("multi-question dialogs build a tabs tree: one tab per question + review tab", () => {
		const spec = buildDesktopQuestionnaireSpec(PARAMS);
		const root = tabsOf(spec);
		expect(root.id).toBe("questionnaire-tabs");
		expect(root.tabs.map((t) => t.id)).toEqual(["q0", "q1", "review"]);
		expect(root.tabs.map((t) => t.label)).toEqual(["Library", "Features", "复核"]);
		// 初始：全部未答 → 题目页签无 status，复核页 attention
		expect(root.tabs[0].status).toBeUndefined();
		expect(root.tabs[2].status).toBe("attention");
		expect(root.activeTab).toBe("q0");
	});

	it("tabs mode keeps custom + notes inputs, preview row, and per-question ids", () => {
		const ids = walkIds(buildDesktopQuestionnaireSpec(PARAMS).root);
		expect(ids).toContain("tab:q0");
		expect(ids).toContain("tab:q1");
		expect(ids).toContain("tab:review");
		expect(ids).toContain("q0");
		expect(ids).toContain("q0-custom");
		expect(ids).toContain("q0-notes");
		expect(ids).toContain("q1");
	});

	it("multi-select questions get an explicit next button; review rows can jump back", () => {
		const root = tabsOf(buildDesktopQuestionnaireSpec(PARAMS));
		// 最后一题是多选：下一题按钮指向复核页
		expect(root.tabs[1].children.filter((n) => n.type === "button")).toEqual([
			{ type: "button", id: "goto:review", label: "完成，去复核 →", variant: "ghost" },
		]);
		// 单选题靠选中自动前进，无下一题按钮
		expect(root.tabs[0].children.filter((n) => n.type === "button")).toEqual([]);
		const reviewIds = walkIds({ type: "column", children: root.tabs[2].children });
		expect(reviewIds).toContain("goto:0");
		expect(reviewIds).toContain("goto:1");
	});

	it("returns null when no desktop host env", async () => {
		const result = await presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => null },
		});
		expect(result).toBeNull();
	});
});

describe("desktop questionnaire flow", () => {
	it("auto-advances once: unanswered→answered on single-select moves to next tab, re-answers do not", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});

		client.send({ type: "change", nodeId: "q0", value: "opt:0:0" });
		expect(tabsOf(lastUpdate(client)).activeTab).toBe("q1");
		expect(tabsOf(lastUpdate(client)).tabs[0].status).toBe("answered");

		// 回改已答题：不再前进
		client.send({ type: "change", nodeId: "q0", value: "opt:0:1" });
		expect(tabsOf(lastUpdate(client)).activeTab).toBe("q1");

		client.settle({ action: "cancel", values: {} });
		await pending;
	});

	it("multi-select toggles and custom typing mark answered without advancing", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});

		client.send({ type: "change", nodeId: "q1", value: ["opt:1:0"] });
		expect(tabsOf(lastUpdate(client)).activeTab).toBe("q0");
		expect(tabsOf(lastUpdate(client)).tabs[1].status).toBe("answered");

		client.send({ type: "change", nodeId: "q0-custom", value: "自己写的" });
		expect(tabsOf(lastUpdate(client)).activeTab).toBe("q0");
		expect(tabsOf(lastUpdate(client)).tabs[0].status).toBe("answered");

		client.settle({ action: "cancel", values: {} });
		await pending;
	});

	it("review tab reflects answers and flags unanswered ones", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});

		client.send({ type: "change", nodeId: "q0", value: "opt:0:0" });
		const review = tabsOf(lastUpdate(client)).tabs[2];
		expect(review.status).toBe("attention");
		const texts = JSON.stringify(review.children);
		expect(texts).toContain("Library：A");
		expect(texts).toContain("⚠ Features：未作答");

		client.send({ type: "change", nodeId: "q1", value: ["opt:1:1"] });
		const final = tabsOf(lastUpdate(client));
		expect(final.tabs[2].status).toBe("answered");
		expect(JSON.stringify(final.tabs[2].children)).toContain("Features：Billing");

		client.settle({ action: "cancel", values: {} });
		await pending;
	});

	it("goto actions switch tabs: review ↔ question", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});

		client.send({ type: "action", actionId: "goto:review" });
		expect(tabsOf(lastUpdate(client)).activeTab).toBe("review");
		client.send({ type: "action", actionId: "goto:0" });
		expect(tabsOf(lastUpdate(client)).activeTab).toBe("q0");

		client.settle({ action: "cancel", values: {} });
		await pending;
	});

	it("cancel without any work closes immediately", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});

		client.send({ type: "action", actionId: "cancel" });
		expect(client.closes).toHaveLength(1);
		expect(client.closes[0].action).toBe("cancel");
		await pending;
	});

	it("cancel arms on first press when work exists, disarms on change, closes on second press", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});

		client.send({ type: "change", nodeId: "q0", value: "opt:0:0" });
		client.send({ type: "action", actionId: "cancel" });
		expect(client.closes).toHaveLength(0);
		expect(lastUpdate(client).actions?.[0].label).toBe("再按一次确认取消");
		expect(lastUpdate(client).actions?.[0].variant).toBe("danger");

		client.send({ type: "change", nodeId: "q0-notes", value: "note" });
		expect(lastUpdate(client).actions?.[0].label).toBe("取消");

		client.send({ type: "action", actionId: "cancel" });
		expect(client.closes).toHaveLength(0); // 重新布防
		client.send({ type: "action", actionId: "cancel" });
		expect(client.closes).toHaveLength(1);
		expect(client.closes[0].action).toBe("cancel");

		await pending;
	});

	it("maps submit values to questionnaire answers", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});
		const values = {
			q0: "opt:0:0",
			"q0-custom": "",
			"q0-notes": "prefer A",
			q1: ["opt:1:0", "opt:1:1"],
			"q1-custom": "",
			"q1-notes": "",
		};
		client.send({ type: "action", actionId: "submit", values });
		const result = await pending;

		expect(result?.cancelled).toBe(false);
		expect(result?.answers).toHaveLength(2);
		expect(result?.answers[0]).toMatchObject({
			kind: "option",
			answer: "A",
			notes: "prefer A",
		});
		expect(result?.answers[1]).toMatchObject({
			kind: "multi",
			selected: ["Auth", "Billing"],
		});
	});

	it("allows partial submission (unanswered questions are skipped)", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});
		client.send({
			type: "action",
			actionId: "submit",
			values: { q0: "opt:0:1", "q0-custom": "", "q0-notes": "", "q1-custom": "", "q1-notes": "" },
		});
		const result = await pending;
		expect(result?.cancelled).toBe(false);
		expect(result?.answers).toHaveLength(1);
		expect(result?.answers[0]).toMatchObject({ kind: "option", answer: "B" });
	});

	it("custom text wins over option selection", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});
		client.send({
			type: "action",
			actionId: "submit",
			values: {
				q0: "opt:0:0",
				"q0-custom": "my own answer",
				"q0-notes": "",
				q1: [],
				"q1-custom": "",
				"q1-notes": "",
			},
		});
		const result = await pending;
		expect(result?.answers[0]).toMatchObject({ kind: "custom", answer: "my own answer" });
	});

	it("cancel action yields cancelled result", async () => {
		const client = makeClient();
		const pending = presentQuestionnaireOnDesktop(PARAMS, {
			deps: { connect: () => client as never },
		});
		client.send({ type: "action", actionId: "cancel" });
		const result = await pending;
		expect(result?.cancelled).toBe(true);
		expect(result?.answers).toEqual([]);
	});
});
