/**
 * PiDesk desktop panel for the Telegram bridge — projection and frame budget
 * Zones: telegram, desktop
 * Read-only projection of bridge state onto the right-hand ContextSidebar tab,
 * plus the frame budget that keeps it fresh (docs/design/19 §4).
 *
 * Deliberately **SDK-type-only**: nothing here imports runtime code from
 * `@pidesk/view-sdk`, so the module loads under `node --experimental-strip-types`
 * (the SDK ships `.js`-suffixed source imports that only a bundler can rewrite).
 * The resident lifecycle that actually opens the panel lives in the adapter
 * added by the entrypoint wiring.
 *
 * Projection is pure — it reads only state the TUI already holds (§4.2), so the
 * panel can never disagree with `/telegram-status`.
 */

import type { ViewAction, ViewHostCapability, ViewNode, ViewTableColumn } from "@pidesk/view-sdk";
import type * as Status from "./status.ts";
import type * as Threads from "./threads.ts";

// --- Identity & bounds ---

/** Stable panel slot id. Never derive this from a viewId — reconnect must replace in place. */
export const TELEGRAM_PANEL_ID = "telegram-bridge";

/** Panel title shown on the ContextSidebar tab. */
export const TELEGRAM_PANEL_TITLE = "Telegram";

/**
 * Host capability gate for the `table` node (docs/design/19 §7.1).
 * An older Host renders `unknown` placeholders, which is fine for diagnostics
 * but must not carry the queue/thread lists — so the projection keeps a
 * `row`-based fallback path instead of assuming the capability exists.
 */
export const VIEW_TABLE_CAPABILITY = "view-table" satisfies ViewHostCapability;

/** Actions the panel sends back (declared as `kind: "event"` so the view stays open). */
export const TELEGRAM_PANEL_ACTIONS = {
	connect: "tg:connect",
	disconnect: "tg:disconnect",
	refresh: "tg:refresh",
} as const;

export type TelegramPanelAction = (typeof TELEGRAM_PANEL_ACTIONS)[keyof typeof TELEGRAM_PANEL_ACTIONS];

export function isTelegramPanelAction(value: string): value is TelegramPanelAction {
	return (
		value === TELEGRAM_PANEL_ACTIONS.connect ||
		value === TELEGRAM_PANEL_ACTIONS.disconnect ||
		value === TELEGRAM_PANEL_ACTIONS.refresh
	);
}

/** Max runtime events mirrored into the panel (design §4.1). */
export const PANEL_MAX_EVENTS = 20;

/** Max queue rows rendered (design §4.1 budget: ≤50). */
export const PANEL_MAX_QUEUE_ROWS = 50;

/** Max thread rows rendered (design §4.1 budget: ≤20). */
export const PANEL_MAX_THREAD_ROWS = 20;

// --- Projection ---

/** Everything the projection reads. Callers supply live getters — nothing is cached here. */
export interface TelegramPanelSource {
	getStatusState: () => Status.TelegramBridgeStatusLineState;
	/** Thread records already filtered to the *active* profile. */
	listThreads: () => Threads.TelegramTopicTargetRecord[];
	/** Queued items with a human-readable summary. */
	listQueuedItems: () => Array<{ queueLane: Status.TelegramStatusQueueLane; summary: string }>;
}

export interface TelegramPanelProjection {
	root: ViewNode;
	actions: ViewAction[];
	/** Total ViewNode count — asserted against `VIEW_LIMITS.maxNodes` (512). */
	nodeCount: number;
}

const LANE_ORDER: Status.TelegramStatusQueueLane[] = ["control", "priority", "default"];

const LANE_LABEL: Record<Status.TelegramStatusQueueLane, string> = {
	control: "控制",
	priority: "优先",
	default: "默认",
};

function text(content: string, variant?: "body" | "caption" | "heading"): ViewNode {
	return variant === undefined ? { type: "text", content } : { type: "text", content, variant };
}

/** Count nodes recursively — the doc's budget estimate needs a real number. */
export function countNodes(node: ViewNode): number {
	switch (node.type) {
		case "column":
		case "row":
		case "card": {
			let total = 1;
			for (const child of node.children) total += countNodes(child);
			return total;
		}
		case "tabs": {
			let total = 1;
			for (const tab of node.tabs) {
				for (const child of tab.children) total += countNodes(child);
			}
			return total;
		}
		case "table":
			// Host 预算口径（docs/design/19 §3.2.1）：一行计 1 个节点，单元格不单独计
			return 1 + node.rows.length;
		default:
			return 1;
	}
}

/** `—` when unset, so rows never collapse to an empty line. */
function orDash(value: string | number | undefined | null): string {
	if (value === undefined || value === null) return "—";
	const rendered = String(value);
	return rendered.length > 0 ? rendered : "—";
}

function truncate(value: string, max = 48): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

/** `[hh:mm:ss] [level] message` — the events zone stays prose by design (docs/design/19 §4.1 「card + list」). */
export function formatRuntimeEvent(event: Status.TelegramRuntimeEvent, nowMs: number): string {
	const at = Number.isFinite(event.at) ? event.at : nowMs;
	const stamp = new Date(at).toISOString().slice(11, 19);
	const level = event.category ? event.category.toUpperCase() : "EVENT";
	return `[${stamp}] [${level}] ${truncate(event.message, 120)}`;
}

/**
 * Panel actions. Connect is offered whenever a token exists; disconnect only
 * while polling — so a button never lies about what it will do.
 */
export function buildPanelActions(state: Status.TelegramBridgeStatusLineState): ViewAction[] {
	const connected = state.pollingActive;
	return [
		{
			id: TELEGRAM_PANEL_ACTIONS.connect,
			label: connected ? "已连接" : "连接",
			variant: connected ? "ghost" : "primary",
			kind: "event",
			disabled: connected || !state.hasBotToken,
		},
		{
			id: TELEGRAM_PANEL_ACTIONS.disconnect,
			label: "断开",
			variant: "ghost",
			kind: "event",
			disabled: !connected,
		},
		{ id: TELEGRAM_PANEL_ACTIONS.refresh, label: "刷新", variant: "ghost", kind: "event" },
	];
}

/** Connection card: identity, bus role, instance slot (design §4.1). */
function buildConnectionCard(state: Status.TelegramBridgeStatusLineState): ViewNode {
	const bot = state.botUsername ? `@${state.botUsername}` : "未配置";
	const token = state.hasBotToken ? "已配置" : "缺失";
	const polling = state.pollingActive ? "活跃" : "停止";
	const role = state.busRole ? `${state.busRole}${state.busLifecyclePhase ? ` (${state.busLifecyclePhase})` : ""}` : "—";

	return {
		type: "card",
		title: "连接",
		children: [
			{ type: "row", children: [text("Bot", "caption"), text(bot)], gap: 6 },
			{ type: "row", children: [text("凭据", "caption"), text(token)], gap: 6 },
			{ type: "row", children: [text("Profile", "caption"), text(orDash(state.activeProfileName))], gap: 6 },
			{ type: "row", children: [text("轮询", "caption"), text(polling)], gap: 6 },
			{ type: "row", children: [text("Bus", "caption"), text(role)], gap: 6 },
			{ type: "row", children: [text("实例槽", "caption"), text(orDash(state.instanceSlot))], gap: 6 },
			{ type: "row", children: [text("Thread", "caption"), text(orDash(state.instanceThreadName))], gap: 6 },
			{ type: "row", children: [text("锁", "caption"), text(orDash(state.lockState))], gap: 6 },
		],
	};
}

/** Queue table columns (docs/design/19 §4.1 「车道 | 来源 | 摘要」; source is not in the queue contract, so it stays out). */
const QUEUE_COLUMNS: ViewTableColumn[] = [
	{ key: "lane", label: "车道", width: 1 },
	{ key: "summary", label: "摘要", width: 4 },
];

/** Thread table columns (docs/design/19 §4.1 「thread 名 | slot | 同步状态 | lastError」). */
const THREAD_COLUMNS: ViewTableColumn[] = [
	{ key: "thread", label: "Thread", width: 3 },
	{ key: "slot", label: "槽位", width: 1, align: "center" },
	{ key: "sync", label: "同步", width: 2 },
	{ key: "error", label: "最近错误", width: 3 },
];

/** Queue card: active turn + per-lane counts + a bounded item list (design §4.1). */
function buildQueueCard(
	state: Status.TelegramBridgeStatusLineState,
	source: TelegramPanelSource,
	tableCapable: boolean,
): ViewNode {
	const items = source.listQueuedItems();
	const counts = LANE_ORDER.map((lane) => ({
		lane,
		count: state.queuedItems.filter((item) => item.queueLane === lane).length,
	}));

	const activeTurn = state.pendingDispatch
		? "派发中"
		: state.compactionInProgress
			? "压缩中"
			: state.activeToolExecutions > 0
				? `工具 ×${state.activeToolExecutions}`
				: "空闲";

	const children: ViewNode[] = [
		{ type: "row", children: [text("活动轮次", "caption"), text(activeTurn)], gap: 6 },
		{
			type: "row",
			children: [
				text("排队", "caption"),
				text(counts.map((entry) => `${LANE_LABEL[entry.lane]} ${entry.count}`).join(" · ")),
			],
			gap: 6,
		},
	];

	if (tableCapable) {
		// 扩展侧切片而不是把整队塞给宿主：协议另有 maxTableRows 硬上限，
		// 超出的行会被静默丢掉，面板就会假装队列更短。截断必须自己报数。
		const shown = orderedByLane(items).slice(0, PANEL_MAX_QUEUE_ROWS);
		children.push({
			type: "table",
			id: "tg-queue",
			columns: QUEUE_COLUMNS,
			emptyText: "队列为空",
			rows: shown.map((item, index) => ({
				id: `queue-${index}`,
				cells: { lane: LANE_LABEL[item.queueLane], summary: truncate(item.summary, 60) },
			})),
		});
		if (items.length > shown.length) {
			children.push(text(`显示 ${shown.length} / 共 ${items.length}`, "caption"));
		}
		return { type: "card", title: "队列", children };
	}

	if (items.length === 0) {
		children.push(text("队列为空", "caption"));
	} else {
		const shown = orderedByLane(items).slice(0, PANEL_MAX_QUEUE_ROWS);
		const next = shown[0];
		// 首项提示调度顺序，避免用户在长队列里看不出优先级
		if (next) children.push(text(`下一条：${truncate(next.summary, 60)}`, "caption"));
		for (const lane of LANE_ORDER) {
			const laneItems = shown.filter((item) => item.queueLane === lane);
			if (laneItems.length === 0) continue;
			children.push(text(LANE_LABEL[lane], "caption"));
			for (const [index, item] of laneItems.entries()) {
				children.push(text(`${index + 1}. ${truncate(item.summary, 60)}`));
			}
		}
		if (items.length > shown.length) {
			children.push(text(`显示 ${shown.length} / 共 ${items.length}`, "caption"));
		}
	}

	return { type: "card", title: "队列", children };
}

/** Dispatch order: control lane first, then priority, then default. */
function orderedByLane<T extends { queueLane: Status.TelegramStatusQueueLane }>(
	items: readonly T[],
): T[] {
	return [...items].sort(
		(a, b) => LANE_ORDER.indexOf(a.queueLane) - LANE_ORDER.indexOf(b.queueLane),
	);
}

/** Threads card: name | slot | sync | lastError (design §4.1), with empty state. */
function buildThreadsCard(source: TelegramPanelSource, tableCapable: boolean): ViewNode {
	const threads = source.listThreads();
	const shown = threads.slice(0, PANEL_MAX_THREAD_ROWS);

	if (tableCapable) {
		const children: ViewNode[] = [
			{
				type: "table",
				id: "tg-threads",
				columns: THREAD_COLUMNS,
				emptyText: "尚未创建 thread",
				rows: shown.map((record) => ({
					id: String(record.target.threadId ?? record.target.chatId),
					cells: {
						thread: record.threadName ?? `thread ${record.target.threadId}`,
						slot: orDash(record.slot),
						sync: orDash(record.syncStatus ?? record.status),
						error: truncate(record.lastError ?? record.lastSyncError ?? "", 40),
					},
				})),
			},
		];
		if (threads.length > shown.length) {
			children.push(text(`显示 ${shown.length} / 共 ${threads.length}`, "caption"));
		}
		return { type: "card", title: "Threads", children };
	}

	if (threads.length === 0) {
		return { type: "card", title: "Threads", children: [text("尚未创建 thread", "caption")] };
	}
	const children: ViewNode[] = [];
	for (const record of shown) {
		const name = record.threadName ?? `thread ${record.target.threadId}`;
		const slot = orDash(record.slot);
		const sync = orDash(record.syncStatus ?? record.status);
		const detail = record.lastError ?? record.lastSyncError;
		children.push(text(name, "caption"));
		children.push(text(`  slot ${slot} · ${sync}${detail ? ` · ${truncate(detail, 40)}` : ""}`));
	}
	if (threads.length > shown.length) {
		children.push(text(`显示 ${shown.length} / 共 ${threads.length}`, "caption"));
	}
	return { type: "card", title: "Threads", children };
}

/** Events card: bounded ring of recent runtime events (design §4.1 — 20 entries). */
function buildEventsCard(state: Status.TelegramBridgeStatusLineState, nowMs: number): ViewNode {
	const events = state.recentRuntimeEvents.slice(-PANEL_MAX_EVENTS).reverse();
	if (events.length === 0) {
		return { type: "card", title: "事件", children: [text("暂无 runtime event", "caption")] };
	}
	return {
		type: "card",
		title: "事件",
		children: events.map((event) => text(formatRuntimeEvent(event, nowMs))),
	};
}

/**
 * Build the whole panel tree.
 *
 * `tableCapable` comes from the Host `hello` advertisement (§7.1): without it the
 * queue and thread lists fall back to `row`/`text` composition, which reads worse
 * but never lands as an `unknown` placeholder.
 *
 * `nodeCount` reports the real figure so the `table` decision rests on data,
 * not guesswork (design §6 顺序理由).
 */
export function projectTelegramPanel(
	source: TelegramPanelSource,
	nowMs: number = Date.now(),
	tableCapable = false,
): TelegramPanelProjection {
	const state = source.getStatusState();
	const root: ViewNode = {
		type: "column",
		children: [
			buildConnectionCard(state),
			buildQueueCard(state, source, tableCapable),
			buildThreadsCard(source, tableCapable),
			buildEventsCard(state, nowMs),
		],
	};
	return { root, actions: buildPanelActions(state), nodeCount: countNodes(root) };
}

// --- Frame budget (design §4.3) ---

/** Steady-state ceiling: 1000 / 250 = 4 updates per second. */
export const DEFAULT_FRAME_INTERVAL_MS = 250;

export interface FrameSchedulerOptions {
	/** Deliver one coalesced frame. May be async; overlap is serialized. */
	send: () => Promise<void> | void;
	/** Minimum gap between two deliveries. Default 250ms (≤4/s). */
	intervalMs?: number;
	/** Timer factory (tests inject their own). */
	setTimer?: (handler: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface FrameScheduler {
	/**
	 * Mark state dirty. The first call in an idle window schedules a delivery;
	 * further calls inside the window are absorbed — the frame we send always
	 * reflects the *latest* state because `send` re-reads it.
	 */
	markDirty(): void;
	/**
	 * Deliver any pending frame immediately and await it. Call before sending an
	 * action so the host never acts on stale state (§4.3 「动作边界不得丢」).
	 * A no-op when nothing is dirty.
	 */
	flush(): Promise<void>;
	/**
	 * Deliver a frame immediately **even when nothing is dirty**, bypassing the
	 * merge window. The host keeps the tree from `open()`, so this is what makes
	 * a freshly opened panel render at once instead of waiting up to
	 * `intervalMs` for the first poll tick (§4.4).
	 */
	flushNow(): Promise<void>;
	/**
	 * Cancel timers, settle waiters, and abandon any in-flight delivery.
	 * Idempotent. A slow `send` still running when `stop()` is called has its
	 * result discarded — it is never left as a dangling promise (§9).
	 */
	stop(): void;
	/** Diagnostics: frames requested vs. actually delivered. */
	readonly stats: { requested: number; delivered: number; coalesced: number };
}

export function createFrameScheduler(options: FrameSchedulerOptions): FrameScheduler {
	const intervalMs = options.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
	const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
	const clearTimer =
		options.clearTimer ??
		((handle) => {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		});

	let stopped = false;
	/** A frame is pending but its timer has not fired yet. */
	let scheduled = false;
	/** The sender is mid-flight; we owe it another pass once it resolves. */
	let inFlight = false;
	/** State changed while a frame was in flight (or while scheduled). */
	let dirty = false;
	let timer: unknown = null;
	let waiters: Array<() => void> = [];

	/** Resolves on stop; `deliver()` races against it so a slow `send` cannot pin a promise. */
	let signalStop!: () => void;
	const stopSignal = new Promise<void>((resolve) => {
		signalStop = resolve;
	});

	const stats = { requested: 0, delivered: 0, coalesced: 0 };

	function settleWaiters(): void {
		const pending = waiters;
		waiters = [];
		for (const resolve of pending) resolve();
	}

	async function deliver(): Promise<void> {
		if (stopped) return;
		inFlight = true;
		dirty = false;
		// `send` 可能同步抛出（例如 render 阶段抛错），必须先包进 Promise 再挂 catch，
		// 否则同步异常会逃逸成 unhandled error。
		const raced = new Promise<"sent" | "failed">((resolve) => {
			try {
				resolve(
					Promise.resolve(options.send()).then(
						() => "sent" as const,
						() => "failed" as const,
					),
				);
			} catch {
				resolve("failed");
			}
		});
		const outcome = await Promise.race([raced, stopSignal.then(() => "stopped" as const)]);
		inFlight = false;

		if (outcome === "sent") {
			stats.delivered += 1;
		} else if (outcome === "failed") {
			// 渲染失败不得打断轮询；下一帧会以最新状态重试
			dirty = true;
		}

		if (stopped) {
			settleWaiters();
			return;
		}
		if (dirty) {
			// Backpressure: state changed while in flight — send one more frame so the
			// host converges on the final state. Never dropped.
			//
			// Waiters must still be released: `flush()` awaited *this* delivery and the
			// follow-up frame already carries the latest state, so the action boundary
			// is safe. Parking them here would deadlock `flush()`.
			schedule();
		}
		settleWaiters();
	}

	function fire(): void {
		timer = null;
		scheduled = false;
		void deliver();
	}

	function schedule(): void {
		if (stopped) return;
		if (inFlight || scheduled) return;
		scheduled = true;
		timer = setTimer(fire, intervalMs);
		// 不阻止进程退出（pi 会话结束时 timer 不应钉住事件循环）
		(timer as { unref?: () => void } | null)?.unref?.();
	}

	/** Cancel a pending (not yet fired) frame so the caller can deliver it now. */
	function clearPending(): void {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		scheduled = false;
	}

	return {
		markDirty() {
			if (stopped) return;
			stats.requested += 1;
			if (scheduled || inFlight) {
				// Absorbed into the pending frame — `send` re-reads state, so no data loss.
				dirty = true;
				stats.coalesced += 1;
				return;
			}
			dirty = true;
			schedule();
		},

		async flush() {
			if (stopped) return;
			clearPending();
			if (inFlight) {
				// A frame is already on the wire; wait for it, then converge.
				await new Promise<void>((resolve) => waiters.push(resolve));
				if (!dirty || stopped) return;
			}
			if (!dirty) return;
			await deliver();
		},

		async flushNow() {
			if (stopped) return;
			clearPending();
			if (inFlight) {
				// Wait out the in-flight frame, then force a fresh one regardless of
				// whether anything was marked dirty in the meantime.
				await new Promise<void>((resolve) => waiters.push(resolve));
				if (stopped) return;
			}
			dirty = true;
			await deliver();
		},

		stop() {
			if (stopped) return;
			stopped = true;
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			scheduled = false;
			// 先放行挂起的 send（若它 await 外部 gate），再结算 waiter
			signalStop();
			settleWaiters();
		},

		stats,
	};
}
