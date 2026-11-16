import { describe, expect, it } from "vitest";
import { createWakeQueue, type WakeQueue } from "../core/wake.ts";

interface Harness {
	queue: WakeQueue;
	sent: string[];
	/** Move the clock forward; fires the queue's own timer if it is due. */
	advance(ms: number): void;
	/** Fire a queued timer regardless of the clock (models a timer that already expired). */
	fireTimer(): void;
	readonly hasTimer: boolean;
}

function harness(options: { coalesceMs?: number; maxPerHour?: number } = {}): Harness {
	const sent: string[] = [];
	let clock = 0;
	let pending: { callback: () => void; at: number } | undefined;
	const queue = createWakeQueue({
		coalesceMs: options.coalesceMs ?? 5_000,
		maxPerHour: options.maxPerHour ?? 24,
		now: () => clock,
		schedule: (callback, ms) => {
			pending = { callback, at: clock + ms };
			return 0 as unknown as ReturnType<typeof setTimeout>;
		},
		cancel: () => {
			pending = undefined;
		},
		send: (text) => sent.push(text),
	});
	const fire = () => {
		if (!pending) return;
		const { callback } = pending;
		pending = undefined;
		callback();
	};
	return {
		queue,
		sent,
		get hasTimer() {
			return pending !== undefined;
		},
		advance(ms) {
			clock += ms;
			if (pending && pending.at <= clock) fire();
		},
		fireTimer: fire,
	};
}

describe("wake queue", () => {
	it("waits for the coalescing window, then sends one message", () => {
		const h = harness({ coalesceMs: 5_000 });
		h.queue.enqueue({ key: "a", text: "job J-1 finished" });
		expect(h.queue.pending()).toBe(1);
		expect(h.sent).toHaveLength(0);
		h.advance(4_000);
		expect(h.sent).toHaveLength(0);
		h.advance(1_000);
		expect(h.sent).toEqual(["job J-1 finished"]);
	});

	it("coalesces several notices into one message and counts the overflow", () => {
		const h = harness({ coalesceMs: 1_000 });
		h.queue.enqueue({ key: "a", text: "job J-1 finished" });
		h.queue.enqueue({ key: "b", text: "job J-2 finished" });
		h.advance(1_000);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain("2 background notices");
		expect(h.sent[0]).toContain("job J-1 finished");
	});

	it("collapses duplicates by key inside one window", () => {
		const h = harness({ coalesceMs: 0 });
		h.queue.enqueue({ key: "same", text: "first" });
		h.queue.enqueue({ key: "same", text: "second" });
		expect(h.queue.pending()).toBe(1);
		h.queue.flush();
		expect(h.sent).toEqual(["second"]);
	});

	it("flush sends immediately without waiting for the window", () => {
		const h = harness({ coalesceMs: 60_000 });
		h.queue.enqueue({ key: "a", text: "x" });
		h.queue.flush();
		expect(h.sent).toEqual(["x"]);
	});

	it("holds notices once the hourly gate is reached, and retries later", () => {
		const h = harness({ coalesceMs: 0, maxPerHour: 1 });
		h.queue.enqueue({ key: "a", text: "first" });
		h.queue.flush();
		expect(h.sent).toHaveLength(1);

		h.queue.enqueue({ key: "b", text: "second" });
		h.queue.flush();
		// Gate closed: buffered, not dropped.
		expect(h.sent).toHaveLength(1);
		expect(h.queue.pending()).toBe(1);
		expect(h.hasTimer).toBe(true);

		// Firing the retry before the hour is up must not send.
		h.fireTimer();
		expect(h.sent).toHaveLength(1);
		expect(h.queue.pending()).toBe(1);

		// An hour later the slot has aged out.
		h.advance(60 * 60 * 1000);
		h.queue.flush();
		expect(h.sent).toEqual(["first", "second"]);
	});

	it("unrefs its retry timer so a held notice cannot keep the host alive", () => {
		// The gate can hold a notice for an hour. That timer must not be the reason a host process
		// stays up after everything else finished.
		let unrefCalls = 0;
		const queue = createWakeQueue({
			coalesceMs: 10,
			maxPerHour: 24,
			schedule: () => ({ unref: () => (unrefCalls += 1) }) as unknown as ReturnType<typeof setTimeout>,
			cancel: () => {},
			send: () => {},
		});
		queue.enqueue({ key: "a", text: "x" });
		expect(unrefCalls).toBe(1);
		queue.dispose();
	});

	it("re-checks a notice before sending and drops it when it has become an echo", () => {
		// The coalescing window is exactly where the echo was born: the job settles, its notice is
		// buffered for `wakeCoalesceMs`, and in that window the model's long-polling inspect returns
		// `exited` with every line. Sending the notice afterwards costs a turn to answer "noted".
		const h = harness({ coalesceMs: 5_000 });
		let read = false;
		h.queue.enqueue({
			key: "job:J-14",
			text: "Bash job J-14 finished",
			refresh: () => (read ? undefined : { text: "Bash job J-14 finished" }),
		});
		read = true;
		h.advance(5_000);
		expect(h.sent).toHaveLength(0);
		expect(h.queue.pending()).toBe(0);
	});

	it("sends the refreshed text, not the text captured at enqueue time", () => {
		const h = harness({ coalesceMs: 1_000 });
		let tail = "first tail";
		h.queue.enqueue({ key: "job:J-2", text: `finished: ${tail}`, refresh: () => ({ text: `finished: ${tail}` }) });
		tail = "second tail";
		h.advance(1_000);
		expect(h.sent).toEqual(["finished: second tail"]);
	});

	it("does not spend an hourly slot on a message that was never sent", () => {
		const h = harness({ coalesceMs: 0, maxPerHour: 1 });
		h.queue.enqueue({ key: "a", text: "x", refresh: () => undefined });
		h.queue.flush();
		expect(h.sent).toHaveLength(0);
		// The single allowed send is still available for real news.
		h.queue.enqueue({ key: "b", text: "real" });
		h.queue.flush();
		expect(h.sent).toEqual(["real"]);
	});

	it("keeps notices without a refresh hook (a stop, a watch) exactly as queued", () => {
		const h = harness({ coalesceMs: 0 });
		h.queue.enqueue({ key: "stop:J-3", text: "stopped" });
		h.queue.flush();
		expect(h.sent).toEqual(["stopped"]);
	});

	it("replaces the refresh callback together with a duplicate key", () => {
		const h = harness({ coalesceMs: 0 });
		h.queue.enqueue({ key: "same", text: "old", refresh: () => ({ text: "stale" }) });
		h.queue.enqueue({ key: "same", text: "new", refresh: () => undefined });
		h.queue.flush();
		expect(h.sent).toEqual([]);
		expect(h.queue.pending()).toBe(0);
	});

	it("removes consumed notices even while the hourly gate is closed", () => {
		const h = harness({ coalesceMs: 0, maxPerHour: 1 });
		h.queue.enqueue({ key: "first", text: "first" });
		h.queue.flush();
		let consumed = false;
		h.queue.enqueue({ key: "held", text: "held", refresh: () => (consumed ? undefined : { text: "held" }) });
		h.queue.flush();
		consumed = true;
		h.queue.flush();
		expect(h.sent).toEqual(["first"]);
		expect(h.queue.pending()).toBe(0);
		expect(h.hasTimer).toBe(false);
	});

	it("dispose drops everything still buffered", () => {
		const h = harness({ coalesceMs: 1_000 });
		h.queue.enqueue({ key: "a", text: "x" });
		h.queue.dispose();
		h.queue.flush();
		expect(h.sent).toHaveLength(0);
		expect(h.queue.pending()).toBe(0);
	});
});
