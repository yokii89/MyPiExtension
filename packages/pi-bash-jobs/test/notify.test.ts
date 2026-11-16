import { describe, expect, it } from "vitest";
import { createJobRegistry } from "../core/jobs.ts";
import { cursorSeq, decideExitWake, isTerminalStatus } from "../core/notify.ts";
import { createRingBuffer } from "../infra/ring.ts";
import type { JobRecord } from "../types.ts";

const job: JobRecord = {
	id: "J-27",
	command: "curl -sS -o /dev/null https://example.com/ --max-time 15",
	mode: "long",
	status: "exited",
	reason: "curl probe",
	startedAt: 1_000,
	lastOutputAt: 2_000,
	exitedAt: 2_000,
	exitCode: 0,
	detached: true,
	outputBytes: 40,
	outputLines: 2,
};

describe("cursorSeq", () => {
	it("treats a missing or nonsense cursor as 'nothing read'", () => {
		expect(cursorSeq(undefined)).toBe(0);
		expect(cursorSeq("")).toBe(0);
		expect(cursorSeq("abc")).toBe(0);
		expect(cursorSeq("-3")).toBe(0);
		expect(cursorSeq("41")).toBe(41);
	});
});

describe("isTerminalStatus", () => {
	it("only `running` is non-terminal", () => {
		expect(isTerminalStatus("running")).toBe(false);
		expect(isTerminalStatus("exited")).toBe(true);
		expect(isTerminalStatus("killed")).toBe(true);
		expect(isTerminalStatus("orphaned")).toBe(true);
	});
});

describe("decideExitWake", () => {
	it("always tells a model that never looked", () => {
		const decision = decideExitWake({ job, finalCursor: "2", redundantWindowMs: 15_000 });
		expect(decision.deliver).toBe(true);
		expect(decision.reason).toContain("never read");
	});

	it("stays silent when the last read already reported the terminal state (the reported J-27 echo)", () => {
		// The field report: `inspect_output` returned `J-27 — exited` with all 4 lines, and the next
		// turn still got `Bash job J-27 finished: exit 0 after 2s.` — a full LLM turn for an echo.
		const decision = decideExitWake({
			job,
			finalCursor: "2",
			consumed: { cursor: "2", pending: "", at: 2_500, terminal: true },
			redundantWindowMs: 15_000,
		});
		expect(decision.deliver).toBe(false);
		expect(decision.reason).toContain("already read");
		expect(decision.newLines).toBe(0);
	});

	it("still delivers when the job wrote something after the read", () => {
		const decision = decideExitWake({
			job,
			finalCursor: "9",
			consumed: { cursor: "2", pending: "", at: 2_500, terminal: false },
			redundantWindowMs: 15_000,
		});
		expect(decision.deliver).toBe(true);
		expect(decision.newLines).toBe(7);
		expect(decision.reason).toContain("7 new line(s)");
	});

	it("delivers a silent exit even immediately after a running read", () => {
		// A progress read did not report an exit code. Completion is still news even inside the
		// former redundant window, including failures that produce no additional output.
		const decision = decideExitWake({
			job: { ...job, exitedAt: 4_600 },
			finalCursor: "2",
			consumed: { cursor: "2", pending: "", at: 4_000, terminal: false },
			redundantWindowMs: 15_000,
		});
		expect(decision.deliver).toBe(true);
		expect(decision.reason).toContain("only saw a running job");
	});

	it("delivers an exit that came long after a running read", () => {
		// Twenty minutes later the exit *is* news, even though nothing was written.
		const decision = decideExitWake({
			job: { ...job, exitedAt: 20 * 60_000 },
			finalCursor: "2",
			consumed: { cursor: "2", pending: "", at: 4_000, terminal: false },
			redundantWindowMs: 15_000,
		});
		expect(decision.deliver).toBe(true);
		expect(decision.reason).toContain("only saw a running job");
	});

	it("delivers when only the uncommitted trailing line changed", () => {
		// `printf one` then `printf two`: the command's entire output is one line that never ends in
		// `\n`, so the cursor stays at 0 the whole time. Comparing cursors alone would call the second
		// half of the output "nothing new" and swallow the notice that carries it.
		const decision = decideExitWake({
			job,
			finalCursor: "0",
			finalPending: "onetwo",
			consumed: { cursor: "0", pending: "one", at: 2_500, terminal: false },
			redundantWindowMs: 15_000,
		});
		expect(decision.deliver).toBe(true);
		expect(decision.reason).toContain("trailing output changed");
	});

	it("stays silent when the trailing line is the one the model already saw", () => {
		const decision = decideExitWake({
			job,
			finalCursor: "0",
			finalPending: "one",
			consumed: { cursor: "0", pending: "one", at: 2_500, terminal: true },
			redundantWindowMs: 15_000,
		});
		expect(decision.deliver).toBe(false);
	});
});

/**
 * The read state lives on the job, not in the wake path: two notification paths with two ideas of
 * "read" is exactly what produced the echo. These tests pin the shared-state contract.
 */
describe("job.consumed (shared read state)", () => {
	function setup() {
		const registry = createJobRegistry({ now: () => 0 });
		const ring = createRingBuffer({ maxBytes: 4_096, maxLines: 100 });
		const record = registry.create({
			command: "curl -o a",
			mode: "long",
			reason: "curl download",
			ring,
			kill: () => {},
		});
		return { registry, ring, record };
	}

	it("is undefined until an inspect answers", () => {
		const { record } = setup();
		expect(record.consumed).toBeUndefined();
	});

	it("remembers the cursor, the pending line, when, and whether that answer was terminal", () => {
		const { record } = setup();
		record.markConsumed({ cursor: "4", pending: "Password:", at: 100, terminal: false });
		expect(record.consumed).toEqual({ cursor: "4", pending: "Password:", at: 100, terminal: false });
	});

	it("never moves backwards — a stale long-poll answer must not re-arm a suppressed notice", () => {
		const { record } = setup();
		record.markConsumed({ cursor: "10", pending: "", at: 500, terminal: true });
		// A waitMs poll that started before the settlement answers afterwards with older numbers.
		record.markConsumed({ cursor: "7", pending: "", at: 900, terminal: false });
		expect(record.consumed).toEqual({ cursor: "10", pending: "", at: 500, terminal: true });
	});

	it("cannot downgrade a terminal read at the same cursor, even with a later timestamp", () => {
		const { record } = setup();
		record.markConsumed({ cursor: "10", pending: "done", at: 500, terminal: true });
		record.markConsumed({ cursor: "10", pending: "done", at: 900, terminal: false });
		expect(record.consumed).toMatchObject({ terminal: true, at: 500 });
	});

	it("records completion even if the wall clock moved backwards after a running read", () => {
		const { record } = setup();
		record.markConsumed({ cursor: "10", pending: "", at: 900, terminal: false });
		record.markConsumed({ cursor: "10", pending: "", at: 500, terminal: true });
		expect(record.consumed).toMatchObject({ terminal: true });
	});

	it("advances on a newer read even when the cursor did not move (status changed to terminal)", () => {
		const { record } = setup();
		record.markConsumed({ cursor: "10", pending: "", at: 500, terminal: false });
		record.markConsumed({ cursor: "10", pending: "", at: 600, terminal: true });
		expect(record.consumed).toEqual({ cursor: "10", pending: "", at: 600, terminal: true });
	});
});
