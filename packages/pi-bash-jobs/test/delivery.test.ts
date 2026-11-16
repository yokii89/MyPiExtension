import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bashJobsExtension from "../index.ts";
import { type ShellChild, type ShellExit, spawnShellCommand } from "../infra/shell.ts";

vi.mock("../infra/shell.ts", () => ({ spawnShellCommand: vi.fn(), isProcessAlive: () => false }));

const COALESCE_MS = 50;
const HOUR_MS = 60 * 60 * 1000;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.useRealTimers();
});

function child() {
	let resolveExit!: (exit: ShellExit) => void;
	let onData: ((chunk: Buffer) => void) | undefined;
	const handle: ShellChild = {
		pid: undefined,
		exited: new Promise((resolve) => {
			resolveExit = resolve;
		}),
		onData(listener) {
			onData = listener;
		},
		kill: () => resolveExit({ exitCode: null }),
	};
	return {
		handle,
		output: (text: string) => onData?.(Buffer.from(text)),
		async exit(exitCode = 0) {
			resolveExit({ exitCode });
			await handle.exited;
		},
	};
}

function wire(wakeOnExit: "followUp" | "steer" | "off" = "followUp", extra: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "bash-wake-boundary-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(
		join(dir, "bash-jobs.json"),
		JSON.stringify({ wakeOnExit, longGraceSec: 0, wakeCoalesceMs: COALESCE_MS, output: { tee: false }, ...extra }),
	);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolDefinition>();
	const sendMessage = vi.fn();
	let idle = false;
	const ctx = {
		cwd: process.cwd(),
		isIdle: () => idle,
		ui: { notify: vi.fn() },
		sessionManager: { getSessionId: () => "boundary", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
	bashJobsExtension({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage,
	} as unknown as ExtensionAPI);
	const emit = async (name: string, payload: unknown = {}) =>
		(await handlers.get(name)?.(payload, ctx)) as BoundaryResult | undefined;
	void emit("session_start");
	cleanups.push(async () => {
		await emit("session_shutdown");
		rmSync(dir, { recursive: true, force: true });
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	const execute = (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing ${name}`);
		return tool.execute("test-call", params, undefined, undefined, ctx);
	};
	return {
		sendMessage,
		emit,
		setIdle: (value: boolean) => {
			idle = value;
		},
		async start() {
			const process = child();
			vi.mocked(spawnShellCommand).mockReturnValueOnce(process.handle);
			const result = await execute("bash", { command: "probe", mode: "long" });
			const id = (result.structuredContent as { job_id: string }).job_id;
			return { ...process, id };
		},
		inspect: (params: Record<string, unknown>) => execute("tool_execution_inspect_output", params),
		boundary: (name = wakeOnExit === "steer" ? "turn_end" : "agent_before_settle", patch = {}) =>
			emit(name, { entries: [], continue: false, outcome: "completed", context: { canContinue: true }, ...patch }),
	};
}

function noticeText(result: BoundaryResult | undefined): string {
	return JSON.stringify(result?.entries ?? []);
}

// Exercise the real extension/registry/inspect/queue wiring. Only the OS process and Pi host
// are controlled: timers can expire while the host is still working, then inspect can finish
// before the next delivery boundary. No sendMessage call is allowed into Pi's busy queue.
describe.each(["followUp", "steer"] as const)("%s delivery boundaries", (mode) => {
	it.each([0, 1])("withdraws an expired notice after a final inspect (exit %i)", async (exitCode) => {
		const h = wire(mode);
		const job = await h.start();
		job.output("final result\n");
		await job.exit(exitCode);
		await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
		expect(h.sendMessage).not.toHaveBeenCalled();
		const result = await h.inspect({ job: job.id });
		expect(result.structuredContent).toMatchObject({
			jobs: [{ id: job.id, status: "exited", exitCode, tail: "final result" }],
		});
		expect(await h.boundary()).toBeUndefined();
		h.setIdle(true);
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("delivers an unread result once, directly as a boundary entry", async () => {
		const h = wire(mode);
		const job = await h.start();
		job.output("unread result\n");
		await job.exit(1);
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(h.sendMessage).not.toHaveBeenCalled();
		const earlier = { type: "custom" as const, customType: "another-extension", data: "keep" };
		const result = await h.boundary(undefined, { entries: [earlier] });
		expect(result?.continue).toBe(true);
		expect(result?.entries?.[0]).toEqual(earlier);
		expect(noticeText(result)).toContain(`${job.id} finished: exit 1`);
		expect(noticeText(result)).toContain("unread result");
		expect(await h.boundary()).toBeUndefined();
	});

	it("still reports a silent exit immediately after a running read", async () => {
		const h = wire(mode);
		const job = await h.start();
		const result = await h.inspect({ job: job.id });
		expect(result.structuredContent).toMatchObject({ jobs: [{ status: "running" }] });
		await job.exit(1);
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(noticeText(await h.boundary())).toContain(`${job.id} finished: exit 1`);
	});

	it("drops only the consumed job from a mixed batch", async () => {
		const h = wire(mode);
		const consumed = await h.start();
		const unread = await h.start();
		await consumed.exit(1);
		await unread.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		await h.inspect({ job: consumed.id });
		const text = noticeText(await h.boundary());
		expect(text).not.toContain(consumed.id);
		expect(text).toContain(`${unread.id} finished: exit 0`);
	});

	it("rechecks after the hourly rate limit and does not charge a cancelled notice", async () => {
		const h = wire(mode, { maxWakePerHour: 1 });
		const first = await h.start();
		await first.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(await h.boundary()).toBeDefined();
		const consumed = await h.start();
		await consumed.exit(1);
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(await h.boundary()).toBeUndefined();
		await h.inspect({ job: consumed.id });
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(await h.boundary()).toBeUndefined();
		const unread = await h.start();
		await unread.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(noticeText(await h.boundary())).toContain(unread.id);
		expect(h.sendMessage).not.toHaveBeenCalled();
	});
});

describe("delivery timing and lifecycle", () => {
	it("followUp waits through tool turns and intermediate agent_end events", async () => {
		const h = wire();
		const job = await h.start();
		await job.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(await h.boundary("turn_end")).toBeUndefined();
		await h.emit("agent_end");
		expect(h.sendMessage).not.toHaveBeenCalled();
		await h.inspect({ job: job.id });
		expect(await h.boundary()).toBeUndefined();
	});

	it("a long poll reads the final result before a zero-window wake can be delivered", async () => {
		const h = wire("followUp", { wakeCoalesceMs: 0 });
		const job = await h.start();
		const read = h.inspect({ job: job.id, waitMs: 60_000 });
		job.output("finished\n");
		await job.exit();
		expect((await read).structuredContent).toMatchObject({ jobs: [{ status: "exited" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(await h.boundary()).toBeUndefined();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("listing jobs does not consume their output", async () => {
		const h = wire();
		const job = await h.start();
		await job.exit();
		await h.inspect({});
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(noticeText(await h.boundary())).toContain(job.id);
	});

	it("honours coalescing when a boundary or settlement arrives early", async () => {
		const h = wire("steer");
		const job = await h.start();
		await job.exit();
		expect(await h.boundary()).toBeUndefined();
		h.setIdle(true);
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(COALESCE_MS - 1);
		expect(h.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});

	it("rearms an expired timer on settlement without sending inside the settled handler", async () => {
		const h = wire();
		const job = await h.start();
		await job.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		h.setIdle(true);
		await h.emit("agent_settled");
		expect(h.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});

	it("adds runnable context after a final assistant answer", async () => {
		const h = wire();
		const job = await h.start();
		await job.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		const result = await h.boundary(undefined, { context: { canContinue: false } });
		expect(result?.continue).toBe(true);
		expect(noticeText(result)).toContain(job.id);
	});

	it("keeps the notice for a later boundary when the run failed or was aborted", async () => {
		const h = wire();
		const job = await h.start();
		await job.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(await h.boundary(undefined, { outcome: "error" })).toBeUndefined();
		expect(await h.boundary(undefined, { outcome: "aborted" })).toBeUndefined();
		expect(await h.boundary()).toBeDefined();
	});

	it("drops old pending notices on shutdown and can deliver in a new session", async () => {
		const h = wire();
		const old = await h.start();
		await old.exit(1);
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		await h.emit("session_shutdown");
		await h.emit("session_start");
		const current = await h.start();
		await current.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		const text = noticeText(await h.boundary());
		expect(text).not.toContain(old.id);
		expect(text).toContain(current.id);
	});

	it("wakeOnExit=off disables idle and boundary delivery", async () => {
		const h = wire("off");
		const job = await h.start();
		await job.exit();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(await h.boundary("turn_end")).toBeUndefined();
		expect(await h.boundary("agent_before_settle")).toBeUndefined();
		h.setIdle(true);
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(h.sendMessage).not.toHaveBeenCalled();
	});
});
