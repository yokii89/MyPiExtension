/**
 * Regression tests for the Telegram desktop panel
 * Covers projection (node budget, empty states, lane grouping, event bounds),
 * the frame budget as driven by the SDK scheduler, and the resident lifecycle
 * (docs/design/19 §8.1).
 *
 * The scheduler itself is not unit-tested here: `createViewFrameScheduler` moved
 * into `@pidesk/view-sdk` (docs/design/20 O4) and its merge/backpressure/stop
 * semantics are pinned by that package's 13 tests. What this suite owns is the
 * wiring — the panel gets one frame per window, flushes at action boundaries, and
 * never resurrects a stopped scheduler.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createViewFrameScheduler, measureViewTree, VIEW_LIMITS } from "@pidesk/view-sdk";
import { createTelegramPanelRuntime, type TelegramPanelSdk, type TelegramPanelSession } from "../lib/desktop-panel.ts";
import {
	formatRuntimeEvent,
	isTelegramPanelAction,
	PANEL_MAX_EVENTS,
	PANEL_MAX_QUEUE_ROWS,
	PANEL_MAX_THREAD_ROWS,
	projectTelegramPanel,
	TELEGRAM_PANEL_ACTIONS,
	TELEGRAM_PANEL_ID,
	type TelegramPanelProjection,
	type TelegramPanelSource,
} from "../lib/desktop-view.ts";
import type { TelegramBridgeStatusLineState } from "../lib/status.ts";
import type { TelegramTopicTargetRecord } from "../lib/threads.ts";

// --- helpers ---

/** Structural view of a ViewNode for assertions. */
type AnyNode = {
	type: string;
	id?: string;
	children?: AnyNode[];
	title?: string;
	content?: string;
	variant?: string;
	tabs?: Array<{ children: AnyNode[] }>;
	columns?: Array<{ key: string; label: string; width?: number; align?: string }>;
	rows?: Array<{ id: string; cells: Record<string, unknown> }>;
	emptyText?: string;
	maxRows?: number;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `check()` holds, so assertions don't race the scheduler. */
async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await delay(5);
	}
	throw new Error("condition not reached before timeout");
}

function baseState(overrides: Partial<TelegramBridgeStatusLineState> = {}): TelegramBridgeStatusLineState {
	return {
		hasBotToken: true,
		botUsername: "yoki_bot",
		activeProfileName: "default",
		pollingActive: true,
		pendingDispatch: false,
		compactionInProgress: false,
		activeToolExecutions: 0,
		pendingModelSwitch: false,
		queuedItems: [],
		recentRuntimeEvents: [],
		...overrides,
	};
}

function source(
	state: TelegramBridgeStatusLineState,
	threads: TelegramTopicTargetRecord[] = [],
	queue: Array<{ queueLane: "control" | "priority" | "default"; summary: string }> = [],
): TelegramPanelSource {
	return {
		getStatusState: () => state,
		listThreads: () => threads,
		listQueuedItems: () => queue,
	};
}

function cardByTitle(root: AnyNode, title: string): AnyNode {
	const card = (root.children ?? []).find((child) => child.type === "card" && child.title === title);
	assert.ok(card, `card "${title}" missing`);
	return card;
}

function allText(node: AnyNode): string[] {
	const out: string[] = [];
	if (typeof node.content === "string") out.push(node.content);
	for (const child of node.children ?? []) out.push(...allText(child));
	for (const tab of node.tabs ?? []) {
		for (const child of tab.children) out.push(...allText(child));
	}
	return out;
}

function project(
	state: TelegramBridgeStatusLineState,
	threads: TelegramTopicTargetRecord[] = [],
	queue: Array<{ queueLane: "control" | "priority" | "default"; summary: string }> = [],
	tableCapable = false,
): TelegramPanelProjection {
	return projectTelegramPanel(source(state, threads, queue), 1_700_000_000_000, tableCapable);
}

/** Structural view of a table node, or undefined when the card used row composition. */
function tableInChildren(node: AnyNode): AnyNode | undefined {
	return (node.children ?? []).find((child) => child.type === "table");
}

/** Any table anywhere in the tree — used to assert the Host never receives one. */
function findTable(node: AnyNode): AnyNode | undefined {
	if (node.type === "table") return node;
	for (const child of node.children ?? []) {
		const found = findTable(child);
		if (found) return found;
	}
	for (const tab of node.tabs ?? []) {
		for (const child of tab.children) {
			const found = findTable(child);
			if (found) return found;
		}
	}
	return undefined;
}

// --- projection: structure & budget ---

test("Panel renders all four cards and stays well inside maxNodes=512", () => {
	const projection = project(baseState());
	const root = projection.root as unknown as AnyNode;
	assert.equal(root.type, "column");
	assert.equal(root.children?.length, 4);
	assert.deepEqual(
		root.children?.map((child) => child.title),
		["连接", "队列", "Threads", "事件"],
	);
	// 预算口径来自 SDK（与 Host `sanitizeTree` 锁步），不是扩展自己的计数
	const budget = measureViewTree(projection.root, VIEW_LIMITS);
	assert.ok(budget.nodes < 100, `expected a light tree, got ${budget.nodes}`);
});

test("Worst-case tree stays inside the node and depth budgets", () => {
	// 设计 §4.1 的预算上限：50 队列行 + 20 threads + 20 events
	const queue = Array.from({ length: 50 }, (_, index) => ({
		queueLane: "default" as const,
		summary: `job-${index}`,
	}));
	const threads = Array.from({ length: 20 }, (_, index) => ({
		profileKey: "default",
		target: { chatId: 1, threadId: index },
		status: "active",
		createdAtMs: 0,
		updatedAtMs: 0,
		threadName: `T${index}`,
		slot: `S${index}`,
		syncStatus: "open",
	})) as unknown as TelegramTopicTargetRecord[];
	const events = Array.from({ length: 20 }, (_, index) => ({
		at: 1_700_000_000_000 + index * 1000,
		category: "poll",
		message: `e-${index}`,
	}));

	const projection = project(
		baseState({
			queuedItems: queue.map((item) => ({ queueLane: item.queueLane })),
			recentRuntimeEvents: events,
			busRole: "leader",
			busLifecyclePhase: "electing",
			instanceSlot: "A",
			instanceThreadName: "Axial",
			lockState: "active-here",
		}),
		threads,
		queue,
	);

	// 实测上界：远低于 VIEW_LIMITS.maxNodes = 512，深度也仍是 4 层以内的扁树
	const budget = measureViewTree(projection.root, VIEW_LIMITS);
	assert.ok(budget.nodes < 512, `node budget exceeded: ${budget.nodes}`);
	assert.ok(budget.depth <= 4, `expected a shallow tree, got depth ${budget.depth}`);
	assert.equal(budget.hitNodeBudget, false, "no child was dropped by the node budget");
});

// --- projection: connection card ---

test("Connection card surfaces identity, polling, and bus role", () => {
	const lines = allText(
		cardByTitle(
			project(
				baseState({
					busRole: "leader",
					busLifecyclePhase: "electing",
					instanceSlot: "A",
					instanceThreadName: "Axial",
					lockState: "active-here",
				}),
			).root as unknown as AnyNode,
			"连接",
		),
	);
	const joined = lines.join(" | ");
	assert.match(joined, /@yoki_bot/);
	assert.match(joined, /已配置/);
	assert.match(joined, /活跃/);
	assert.match(joined, /leader \(electing\)/);
	assert.match(joined, /Axial/);
	assert.match(joined, /active-here/);
});

test("Connection card degrades to placeholders when unconfigured", () => {
	const lines = allText(
		cardByTitle(
			project(
				baseState({
					hasBotToken: false,
					botUsername: undefined,
					activeProfileName: undefined,
					pollingActive: false,
				}),
			).root as unknown as AnyNode,
			"连接",
		),
	);
	assert.ok(lines.includes("未配置"), "missing unconfigured bot label");
	assert.ok(lines.includes("缺失"), "missing missing-credential label");
	assert.ok(lines.includes("停止"), "missing stopped polling label");
});

// --- projection: queue card ---

test("Queue card groups items by lane in dispatch order", () => {
	const queue = [
		{ queueLane: "default" as const, summary: "low" },
		{ queueLane: "control" as const, summary: "stop" },
		{ queueLane: "priority" as const, summary: "ask" },
	];
	const lines = allText(
		cardByTitle(
			project(
				baseState({
					queuedItems: [{ queueLane: "control" }, { queueLane: "priority" }, { queueLane: "default" }],
				}),
				[],
				queue,
			).root as unknown as AnyNode,
			"队列",
		),
	);
	// 控制车道必须先出现（调度顺序对用户可见）
	assert.ok(lines.indexOf("控制") < lines.indexOf("优先"));
	assert.ok(lines.indexOf("优先") < lines.indexOf("默认"));
	assert.ok(lines.includes("下一条：stop"));
	assert.ok(lines.some((line) => line.includes("控制 1 · 优先 1 · 默认 1")));
});

test("Queue card reports the active turn and an empty state", () => {
	const lines = allText(cardByTitle(project(baseState({ pendingDispatch: true })).root as unknown as AnyNode, "队列"));
	assert.ok(lines.includes("派发中"));
	assert.ok(lines.includes("队列为空"));
});

test("Queue card truncates long queues and reports the overflow count", () => {
	const queue = Array.from({ length: 60 }, (_, index) => ({
		queueLane: "default" as const,
		summary: `item-${index}`,
	}));
	const lines = allText(
		cardByTitle(
			project(baseState({ queuedItems: queue.map((item) => ({ queueLane: item.queueLane })) }), [], queue)
				.root as unknown as AnyNode,
			"队列",
		),
	);
	assert.ok(lines.includes("显示 50 / 共 60"));
});

// --- projection: threads card ---

test("Threads card renders records and an empty state", () => {
	const empty = allText(cardByTitle(project(baseState()).root as unknown as AnyNode, "Threads"));
	assert.deepEqual(empty, ["尚未创建 thread"]);

	const record = {
		profileKey: "default",
		target: { chatId: 1, threadId: 42 },
		status: "active",
		createdAtMs: 0,
		updatedAtMs: 0,
		threadName: "Axial",
		slot: "A",
		syncStatus: "open",
		lastError: "boom",
	} as unknown as TelegramTopicTargetRecord;
	const lines = allText(cardByTitle(project(baseState(), [record]).root as unknown as AnyNode, "Threads"));
	assert.ok(lines.includes("Axial"));
	assert.ok(lines.some((line) => line.includes("slot A") && line.includes("open") && line.includes("boom")));
});

// --- projection: events card ---

test("Events card is bounded, newest first", () => {
	const events = Array.from({ length: 30 }, (_, index) => ({
		at: 1_700_000_000_000 + index * 1000,
		category: "poll",
		message: `event-${index}`,
	}));
	const lines = allText(
		cardByTitle(
			projectTelegramPanel(source(baseState({ recentRuntimeEvents: events })), 1_700_000_030_000)
				.root as unknown as AnyNode,
			"事件",
		),
	);
	assert.equal(lines.length, PANEL_MAX_EVENTS);
	assert.ok(lines[0].includes("event-29"), `newest first, got ${lines[0]}`);
	assert.ok(lines[PANEL_MAX_EVENTS - 1].includes("event-10"));
});

test("Events card shows an empty state without events", () => {
	const lines = allText(cardByTitle(project(baseState()).root as unknown as AnyNode, "事件"));
	assert.deepEqual(lines, ["暂无 runtime event"]);
});

test("Runtime event line is stamped and truncated", () => {
	const line = formatRuntimeEvent(
		{ at: Date.UTC(2024, 0, 2, 3, 4, 5), category: "delivery", message: "x".repeat(300) },
		0,
	);
	assert.ok(line.startsWith("[03:04:05] [DELIVERY] "));
	assert.ok(line.length < 160);
	assert.ok(line.endsWith("…"));
});

// --- projection: actions & redaction ---

test("Actions enable connect/disconnect according to live state", () => {
	const connected = project(baseState({ pollingActive: true })).actions;
	const connect = connected.find((action) => action.id === TELEGRAM_PANEL_ACTIONS.connect);
	const disconnect = connected.find((action) => action.id === TELEGRAM_PANEL_ACTIONS.disconnect);
	assert.equal(connect?.disabled, true);
	assert.equal(disconnect?.disabled, false);
	// 非 submit：动面板不应关闭面板
	assert.equal(connect?.kind, "event");
	assert.equal(disconnect?.kind, "event");

	const stopped = project(baseState({ pollingActive: false })).actions;
	assert.equal(stopped.find((a) => a.id === TELEGRAM_PANEL_ACTIONS.connect)?.disabled, false);
	assert.equal(stopped.find((a) => a.id === TELEGRAM_PANEL_ACTIONS.disconnect)?.disabled, true);
});

test("Connect is disabled without a bot token even when stopped", () => {
	const actions = project(baseState({ pollingActive: false, hasBotToken: false })).actions;
	assert.equal(actions.find((a) => a.id === TELEGRAM_PANEL_ACTIONS.connect)?.disabled, true);
});

test("Projection never leaks diagnostics paths or a token", () => {
	const serialized = JSON.stringify(
		project(
			baseState({
				allowedUserId: 12345,
				diagnosticPaths: { state: "C:/secret/state.json", logs: "C:/secret/logs" },
			}),
		).root,
	);
	assert.ok(!serialized.includes("secret"), "diagnostic paths must not reach the renderer");
	assert.ok(!serialized.toLowerCase().includes("token"));
});

test("Panel action ids are recognized and the slot id is stable", () => {
	assert.equal(TELEGRAM_PANEL_ID, "telegram-bridge");
	assert.ok(isTelegramPanelAction(TELEGRAM_PANEL_ACTIONS.connect));
	assert.ok(isTelegramPanelAction(TELEGRAM_PANEL_ACTIONS.disconnect));
	assert.ok(isTelegramPanelAction(TELEGRAM_PANEL_ACTIONS.refresh));
	assert.equal(isTelegramPanelAction("tg:nope"), false);
});

// --- projection: table mode (docs/design/19 §3.2.1, §7.1) ---

function threadRecord(index: number): TelegramTopicTargetRecord {
	return {
		profileKey: "default",
		target: { chatId: 1, threadId: 40 + index },
		status: "active",
		createdAtMs: 0,
		updatedAtMs: 0,
		threadName: `Axial${index}`,
		slot: String.fromCharCode(65 + index),
		syncStatus: "open",
		lastError: index === 0 ? "boom" : undefined,
	} as unknown as TelegramTopicTargetRecord;
}

test("Queue card renders a table when the Host advertises view-table", () => {
	const queue = [
		{ queueLane: "default" as const, summary: "third" },
		{ queueLane: "control" as const, summary: "first" },
		{ queueLane: "priority" as const, summary: "second" },
	];
	const table = tableInChildren(cardByTitle(project(baseState(), [], queue, true).root as unknown as AnyNode, "队列"));
	assert.ok(table, "expected a table node");
	assert.equal(table.id, "tg-queue");
	assert.deepEqual(
		table.columns?.map((column) => column.key),
		["lane", "summary"],
	);
	// 表体按派发顺序出行，而不是按入队顺序
	assert.deepEqual(
		table.rows?.map((row) => row.cells.summary),
		["first", "second", "third"],
	);
	assert.deepEqual(
		table.rows?.map((row) => row.cells.lane),
		["控制", "优先", "默认"],
	);
	assert.equal(table.emptyText, "队列为空");
});

test("Table mode truncates on its own side so the Host never drops rows silently", () => {
	// 协议有 maxTableRows 硬上限；把整队交给宿主会让超出部分静默消失，
	// 所以扩展必须自己切到面板预算并把真实总数写进表尾。
	const queue = Array.from({ length: PANEL_MAX_QUEUE_ROWS + 7 }, (_, index) => ({
		queueLane: "default" as const,
		summary: `job-${index}`,
	}));
	const threads = Array.from({ length: PANEL_MAX_THREAD_ROWS + 3 }, (_, index) => threadRecord(index));
	const root = project(
		baseState({ queuedItems: queue.map((item) => ({ queueLane: item.queueLane })) }),
		threads,
		queue,
		true,
	).root as unknown as AnyNode;

	const queueCard = cardByTitle(root, "队列");
	const queueRows = tableInChildren(queueCard)?.rows;
	assert.equal(queueRows?.length, PANEL_MAX_QUEUE_ROWS);
	assert.ok(
		allText(queueCard).some((line) => line.includes(`显示 ${PANEL_MAX_QUEUE_ROWS} / 共 ${queue.length}`)),
		"queue truncation total is reported",
	);
	const threadsCard = cardByTitle(root, "Threads");
	assert.equal(
		allText(threadsCard).some((line) => line.includes(`显示 ${PANEL_MAX_THREAD_ROWS} / 共 ${threads.length}`)),
		true,
		"thread truncation total is reported",
	);
});

test("Threads card renders one table row per record with per-column cells", () => {
	const table = tableInChildren(
		cardByTitle(project(baseState(), [threadRecord(0)], [], true).root as unknown as AnyNode, "Threads"),
	);
	assert.ok(table, "expected a table node");
	assert.equal(table.id, "tg-threads");
	assert.deepEqual(
		table.columns?.map((column) => column.key),
		["thread", "slot", "sync", "error"],
	);
	assert.deepEqual(table.rows, [{ id: "40", cells: { thread: "Axial0", slot: "A", sync: "open", error: "boom" } }]);
});

test("Table mode still carries its empty states through the node contract", () => {
	const root = project(baseState(), [], [], true).root as unknown as AnyNode;
	const queueTable = tableInChildren(cardByTitle(root, "队列"));
	assert.deepEqual(queueTable?.rows, []);
	assert.equal(queueTable?.emptyText, "队列为空");
	const threadsTable = tableInChildren(cardByTitle(root, "Threads"));
	assert.deepEqual(threadsTable?.rows, []);
	assert.equal(threadsTable?.emptyText, "尚未创建 thread");
});

test("Table mode needs fewer nodes than the row fallback for the same state", () => {
	const queue = Array.from({ length: PANEL_MAX_QUEUE_ROWS }, (_, index) => ({
		queueLane: "default" as const,
		summary: `job-${index}`,
	}));
	const threads = Array.from({ length: PANEL_MAX_THREAD_ROWS }, (_, index) => threadRecord(index));
	const state = baseState({ queuedItems: queue.map((item) => ({ queueLane: item.queueLane })) });

	const rowMode = measureViewTree(project(state, threads, queue, false).root, VIEW_LIMITS).nodes;
	const tableMode = measureViewTree(project(state, threads, queue, true).root, VIEW_LIMITS).nodes;
	assert.ok(tableMode < rowMode, `expected tables to be lighter: ${tableMode} vs row composition ${rowMode}`);
	// 实测上界：远低于 VIEW_LIMITS.maxNodes = 512
	assert.ok(tableMode < 200, `unexpectedly heavy table projection: ${tableMode}`);
});

test("Row fallback stays the default so an old Host never sees an unknown placeholder", () => {
	const root = project(baseState(), [threadRecord(0)], [{ queueLane: "default", summary: "job" }])
		.root as unknown as AnyNode;
	assert.equal(tableInChildren(cardByTitle(root, "队列")), undefined);
	assert.equal(tableInChildren(cardByTitle(root, "Threads")), undefined);
});

// --- frame budget wiring (docs/design/20 O4) ---

/**
 * The coalescer's own semantics — merge window, in-flight backpressure,
 * action-boundary flush, `stop()` settling waiters — are pinned in
 * `@pidesk/view-sdk` by `frame-scheduler.test.ts` (13 cases). What this suite
 * owns is the wiring: the panel is the thing feeding it, and a torn-down panel
 * must not leave a scheduler running.
 */

test("A burst of marks inside one window reaches the host as a single frame", async () => {
	const { sdk, sessions } = fakeSdk();
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
		frameIntervalMs: 250,
	});

	await runtime.open();
	await until(() => sessions[0].updates.length === 1, 500);
	for (let i = 0; i < 20; i += 1) runtime.refresh();
	await delay(60);

	assert.equal(sessions[0].updates.length, 1, "20 marks stayed inside the merge window");
	runtime.dispose();
});

test("Sustained marks deliver at the ≤4 frames/second ceiling", async () => {
	const { sdk, sessions } = fakeSdk();
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 5,
	});

	await runtime.open();
	const start = Date.now();
	while (Date.now() - start < 1100) await delay(10);
	runtime.dispose();

	// 1.1 s at 250 ms/window + the immediate first frame
	assert.ok(sessions[0].updates.length <= 6, `expected ≤6 frames, delivered ${sessions[0].updates.length}`);
	assert.ok(sessions[0].updates.length >= 3, "the window still produced frames");
});

test("Re-opening after a dismiss resumes frame delivery", async () => {
	// 回归：调度器随 session 创建、随 teardown 停止。若复用已 stop 的调度器，
	// 关掉 tab 再连回来的面板会永远停在 open() 时的第一棵树。
	const { sdk, sessions } = fakeSdk();
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
		frameIntervalMs: 5,
	});

	await runtime.open();
	await until(() => sessions[0].updates.length > 0, 500);
	sessions[0].resolveClosed({ reason: "dismissed" });
	await until(() => !runtime.isOpen);

	assert.equal(await runtime.open(), true, "the panel re-opens on the same slot");
	await until(() => sessions[1].updates.length > 0, 500);
	runtime.dispose();
});

// --- resident lifecycle ---

/**
 * Fake SDK surface. The runtime takes the SDK by injection rather than importing
 * it, because `@pidesk/view-sdk` is not on a registry yet — production resolves it
 * lazily in `desktop-panel-sdk.ts` and treats a failed load as "no Host". The
 * frame scheduler handed out below is the **real** SDK one: the panel's job is
 * wiring, so that is what these tests cover.
 */
type OpenPanelOptions = {
	panelId: string;
	title?: string;
	root: unknown;
	actions: unknown;
	onEvent: (event: { type: string; actionId?: string }) => void;
};

/** A fake host-side session plus the levers a test needs to drive it. */
interface FakeSession {
	updates: Array<{ root: unknown; actions: unknown }>;
	closed: boolean;
	emit: (event: { type: string; actionId?: string }) => void;
	resolveClosed: (payload: { reason?: string } | null) => void;
	session: TelegramPanelSession;
}

function fakeSdk(tableCapable = false): {
	sdk: TelegramPanelSdk;
	opens: OpenPanelOptions[];
	sessions: FakeSession[];
	tableProbes: number;
} {
	const opens: OpenPanelOptions[] = [];
	const sessions: FakeSession[] = [];
	const probes = { table: 0 };

	const sdk: TelegramPanelSdk = {
		connect: () => ({ dispose: () => undefined }),
		async supportsTable() {
			probes.table += 1;
			return tableCapable;
		},
		async openPanel(_client, options) {
			opens.push(options);
			let resolveClosed: (payload: { reason?: string } | null) => void = () => undefined;
			// Resolve from the outside so tests can drive `closed(reason)`.
			const closedPromise = new Promise<{ reason?: string } | null>((resolve) => {
				resolveClosed = resolve;
			});
			const record: FakeSession = {
				updates: [],
				closed: false,
				resolveClosed: (payload) => resolveClosed(payload),
				emit: (event) => options.onEvent(event),
				session: {
					update: (payload: { root: unknown; actions: unknown }) => {
						record.updates.push(payload);
					},
					close: () => {
						record.closed = true;
					},
					closed: closedPromise,
					createFrameScheduler: createViewFrameScheduler,
				},
			};
			sessions.push(record);
			return record.session;
		},
	};

	return {
		sdk,
		opens,
		sessions,
		/** Read after `open()`: the gate is asked once per open, never per frame. */
		get tableProbes() {
			return probes.table;
		},
	};
}

test("Panel runtime does nothing without an SDK (TUI fallback)", async () => {
	let touched = false;
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: {
			connect: () => {
				touched = true;
			},
			disconnect: () => {
				touched = true;
			},
			refresh: () => {
				touched = true;
			},
		},
		sdk: null,
		pollIntervalMs: 0,
	});

	assert.equal(await runtime.open(), false, "open() must report failure, not throw");
	assert.equal(runtime.isOpen, false);
	runtime.dispose();
	assert.equal(touched, false);
});

test("Panel runtime opens the right-side panel with a stable panelId", async () => {
	const { sdk, opens } = fakeSdk();
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
	});

	assert.equal(await runtime.open(), true);
	assert.equal(runtime.isOpen, true);
	assert.equal(opens.length, 1, "one open per open() call");
	assert.equal(opens[0].panelId, TELEGRAM_PANEL_ID, "identity must be stable across reconnects");
	assert.equal(opens[0].title, "Telegram");
	const root = opens[0].root as AnyNode;
	assert.equal(root.type, "column", "the projected tree is handed to the host");

	// 幂等：重复 open 复用同一个 panelId（同 connection 内新 open 顶替旧视图）
	assert.equal(await runtime.open(), true);
	assert.equal(opens.length, 2);
	assert.equal(opens[1].panelId, opens[0].panelId);

	runtime.dispose();
});

test("Panel runtime pushes a first frame before the merge window elapses", async () => {
	// 回归：宿主保留的是 open() 时的树。若首帧被合并窗口吸收，面板会空白
	// 直到下一个 poll tick —— 用超长窗口把「等窗口」和「立刻推」区分开。
	const { sdk, sessions } = fakeSdk();
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0, // 没有轮询兜底，首帧只能来自 open() 自身
		frameIntervalMs: 60_000,
	});

	assert.equal(await runtime.open(), true);
	await until(() => sessions[0].updates.length > 0, 500);
	assert.equal(sessions[0].updates.length, 1, "exactly one first frame, sent immediately");
	const first = sessions[0].updates[0]?.root as unknown as AnyNode;
	assert.equal(first.children?.length, 4, "the first frame carried a real projection");
	runtime.dispose();
});

test("Panel runtime routes action events to handlers and flushes first", async () => {
	const { sdk, sessions } = fakeSdk();
	const seen: string[] = [];
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: {
			connect: () => {
				seen.push("connect");
			},
			disconnect: () => {
				seen.push("disconnect");
			},
			refresh: () => {
				seen.push("refresh");
			},
		},
		sdk,
		pollIntervalMs: 0,
	});

	await runtime.open();
	sessions[0].emit({ type: "action", actionId: TELEGRAM_PANEL_ACTIONS.refresh });
	sessions[0].emit({ type: "action", actionId: TELEGRAM_PANEL_ACTIONS.disconnect });
	// 非动作事件与未知 action id 一律忽略
	sessions[0].emit({ type: "input", actionId: TELEGRAM_PANEL_ACTIONS.connect });
	sessions[0].emit({ type: "action", actionId: "tg:bogus" });
	await until(() => seen.length >= 2);

	assert.deepEqual(seen, ["refresh", "disconnect"]);
	runtime.dispose();
});

test("Panel runtime keeps the bridge alive when the tab is dismissed", async () => {
	const { sdk, sessions } = fakeSdk();
	let tornDown = false;
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
		recordRuntimeEvent: () => {
			tornDown = true;
		},
	});

	await runtime.open();
	const record = sessions[0];
	// 用户关掉 tab：reason 是普通 dismiss，不是 replaced/session → 不进 wait-rebind 分支
	record.resolveClosed({ reason: "dismissed" });
	await until(() => !runtime.isOpen);

	assert.equal(tornDown, false, "a plain dismiss is not an error worth logging");
	assert.equal(record.closed, false, "the runtime does not re-close a host-closed view");
	runtime.dispose();
});

test("Panel runtime logs closed(replaced) but never reconnects (§9)", async () => {
	const { sdk, sessions } = fakeSdk();
	const reasons: Array<Record<string, unknown> | undefined> = [];
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
		recordRuntimeEvent: (_category, _error, details) => {
			reasons.push(details);
		},
	});

	await runtime.open();
	const record = sessions[0];
	record.resolveClosed({ reason: "replaced" });
	await until(() => !runtime.isOpen);

	assert.deepEqual(reasons, [{ reason: "replaced" }]);
	assert.equal(sessions.length, 1, "replaced must not trigger an open() — that would ping-pong forever");
	runtime.dispose();
});

test("Panel runtime dispose() tears down the session and the poll timer", async () => {
	const { sdk, sessions } = fakeSdk();
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 5,
	});

	await runtime.open();
	await until(() => sessions[0].updates.length > 0, 500);
	// 计时器仍在推进时 dispose 必须干净退出，不留悬挂 timer / 悬挂 Promise
	runtime.dispose();
	await delay(30);

	assert.equal(runtime.isOpen, false);
	assert.equal(sessions[0].closed, true, "the session is closed on dispose");
	assert.equal(await runtime.open(), false, "a disposed runtime stays closed");
});

// --- runtime: capability gating (docs/design/19 §7.1) ---

const QUEUE_AND_THREADS = source(
	baseState({ queuedItems: [{ queueLane: "default" }] }),
	[threadRecord(0)],
	[{ queueLane: "default" as const, summary: "job" }],
);

test("Panel runtime asks the Host about table support before projecting", async () => {
	const fake = fakeSdk(true);
	const { sdk, opens } = fake;
	const runtime = createTelegramPanelRuntime({
		source: QUEUE_AND_THREADS,
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
	});

	assert.equal(await runtime.open(), true);
	assert.equal(fake.tableProbes, 1, "asked once per open, and only the SDK knows what that asks");
	assert.ok(findTable(opens[0].root as AnyNode), "advertised host receives tables");
	runtime.dispose();
});

test("Panel frames keep one capability decision across open and updates", async () => {
	const fake = fakeSdk(true);
	const { sdk, opens, sessions } = fake;
	const runtime = createTelegramPanelRuntime({
		source: QUEUE_AND_THREADS,
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
		frameIntervalMs: 5,
	});

	await runtime.open();
	await until(() => sessions[0].updates.length > 0);
	for (let i = 0; i < 5; i += 1) {
		runtime.refresh();
		await delay(12);
	}

	assert.ok(sessions[0].updates.length > 1, "several frames went out, not just the first");
	assert.ok(findTable(opens[0].root as AnyNode));
	for (const frame of sessions[0].updates) {
		assert.ok(findTable(frame.root as AnyNode), "every frame keeps the table decision");
	}
	assert.equal(fake.tableProbes, 1, "an open-time decision, not a per-frame probe");
	runtime.dispose();
});

test("Panel runtime keeps row composition for a Host without the capability", async () => {
	const { sdk, opens, sessions } = fakeSdk(false);
	const runtime = createTelegramPanelRuntime({
		source: QUEUE_AND_THREADS,
		actions: { connect: () => undefined, disconnect: () => undefined, refresh: () => undefined },
		sdk,
		pollIntervalMs: 0,
		frameIntervalMs: 5,
	});

	await runtime.open();
	await until(() => sessions[0].updates.length > 0);
	assert.equal(findTable(opens[0].root as AnyNode), undefined, "initial tree");
	for (const frame of sessions[0].updates) {
		assert.equal(findTable(frame.root as AnyNode), undefined, "no frame ships a table");
	}
	runtime.dispose();
});

// --- runtime: session-bound actions (docs/design/19 §4.4) ---

test("Connect action runs against the live session context", async () => {
	const { sdk, sessions } = fakeSdk();
	const liveContext = { sessionId: "current" };
	const seen: unknown[] = [];
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		getSessionContext: () => liveContext,
		actions: {
			connect: (context) => {
				seen.push(context);
			},
			disconnect: () => undefined,
			refresh: () => undefined,
		},
		sdk,
		pollIntervalMs: 0,
	});

	await runtime.open();
	sessions[0].emit({ type: "action", actionId: TELEGRAM_PANEL_ACTIONS.connect });
	await until(() => seen.length === 1);
	assert.deepEqual(seen, [liveContext], "the click acts on the context bound right now");
	runtime.dispose();
});

test("Connect action is refused while no session context is bound", async () => {
	const { sdk, sessions } = fakeSdk();
	let touched = false;
	const failures: unknown[] = [];
	const runtime = createTelegramPanelRuntime({
		source: source(baseState()),
		actions: {
			connect: () => {
				touched = true;
			},
			disconnect: () => undefined,
			refresh: () => undefined,
		},
		sdk,
		pollIntervalMs: 0,
		recordRuntimeEvent: (_category, error) => {
			failures.push(error);
		},
	});

	await runtime.open();
	sessions[0].emit({ type: "action", actionId: TELEGRAM_PANEL_ACTIONS.connect });
	await until(() => failures.length === 1);
	assert.equal(touched, false, "must not replay connect on a synthesized or stale context");
	assert.ok(failures[0] instanceof Error);
	runtime.dispose();
});
