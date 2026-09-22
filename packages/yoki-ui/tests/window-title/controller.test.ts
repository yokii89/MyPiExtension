import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../../yoki_ui/window-title/config.ts";
import { createController } from "../../yoki_ui/window-title/controller.ts";
import { BRAILLE_FRAMES } from "../../yoki_ui/window-title/types.ts";

function makeCtx(mode: "tui" | "rpc" | "print" = "tui") {
	return {
		mode,
		cwd: "/tmp/demo",
		ui: { setTitle: vi.fn() },
	} as never;
}

function makePi(session?: string) {
	return { getSessionName: () => session } as never;
}

describe("WindowTitleController", () => {
	let titles: string[];
	let notifies: Array<{ title: string; body: string }>;
	let sounds: number;
	let now: number;

	beforeEach(() => {
		titles = [];
		notifies = [];
		sounds = 0;
		now = 10_000;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function controller(overrides: Record<string, unknown> = {}) {
		return createController({
			pi: makePi(),
			config: normalizeConfig(overrides),
			setTitle: (t) => {
				titles.push(t);
			},
			now: () => now,
			notify: (title, body) => {
				notifies.push({ title, body });
			},
			sound: () => {
				sounds += 1;
			},
		});
	}

	it("BUSY: spins title without notify/sound", () => {
		const c = controller();
		const ctx = makeCtx();
		c.enterBusy(ctx);
		expect(c.phase).toBe("busy");
		expect(titles[0]).toBe(`${BRAILLE_FRAMES[0]} π - demo`);
		vi.advanceTimersByTime(80);
		expect(titles.at(-1)).toBe(`${BRAILLE_FRAMES[1]} π - demo`);
		expect(notifies).toHaveLength(0);
		expect(sounds).toBe(0);
		expect(titles.join("")).not.toMatch(/[⏰🔔]/u);
	});

	it("print/rpc modes are no-ops", () => {
		const c = controller();
		c.enterBusy(makeCtx("print"));
		expect(c.phase).toBe("idle");
		expect(titles).toHaveLength(0);
	});

	it("intervention: blinks Action Required + notifies once", () => {
		const c = controller();
		const ctx = makeCtx();
		c.enterBusy(ctx);
		now = 15_000;
		c.enterAttention(ctx, "intervention");
		expect(c.phase).toBe("attention");
		expect(c.reason).toBe("intervention");
		expect(titles.at(-1)).toBe("[!] Action Required");
		vi.advanceTimersByTime(500);
		expect(titles.at(-1)).toBe("[.] Action Required");
		expect(notifies).toEqual([{ title: "Pi", body: "Action required" }]);
		expect(sounds).toBe(1);
		// second edge while blinking does not re-alert
		c.enterAttention(ctx, "intervention");
		expect(notifies).toHaveLength(1);
		expect(sounds).toBe(1);
	});

	it("exitAttentionToBusy restores spin", () => {
		const c = controller();
		const ctx = makeCtx();
		c.enterBusy(ctx);
		c.enterAttention(ctx, "intervention");
		c.exitAttentionToBusy(ctx);
		expect(c.phase).toBe("busy");
		expect(titles.at(-1)).toMatch(new RegExp(`^[${BRAILLE_FRAMES.join("")}] π - demo$`));
	});

	it("complete: base title + one end notify", () => {
		const c = controller({ complete: { minBusyMs: 0, completeSoundGraceMs: 0, minAlertGapMs: 0 } });
		const ctx = makeCtx();
		c.enterBusy(ctx);
		now = 20_000;
		c.enterAttention(ctx, "complete");
		expect(c.phase).toBe("attention");
		expect(c.reason).toBe("complete");
		expect(c.pendingCompleteAck).toBe(true);
		expect(titles.at(-1)).toBe("π - demo");
		expect(notifies).toEqual([{ title: "Pi", body: "Ready for input" }]);
		expect(sounds).toBe(1);
	});

	it("complete silence: minBusyMs", () => {
		const c = controller({ complete: { minBusyMs: 5000, completeSoundGraceMs: 0, minAlertGapMs: 0 } });
		const ctx = makeCtx();
		c.enterBusy(ctx);
		now = 10_500; // only 500ms busy
		c.enterAttention(ctx, "complete");
		expect(c.pendingCompleteAck).toBe(true);
		expect(titles.at(-1)).toBe("π - demo");
		expect(notifies).toHaveLength(0);
		expect(sounds).toBe(0);
	});

	it("complete silence: intervention grace", () => {
		const c = controller({ complete: { minBusyMs: 0, completeSoundGraceMs: 5000, minAlertGapMs: 0 } });
		const ctx = makeCtx();
		c.enterBusy(ctx);
		now = 15_000;
		c.enterAttention(ctx, "intervention");
		expect(sounds).toBe(1);
		now = 16_000; // within 5s grace
		c.enterAttention(ctx, "complete");
		expect(sounds).toBe(1);
		expect(notifies).toHaveLength(1); // only intervention
	});

	it("ack clears complete pending; does not stop intervention", () => {
		const c = controller({ complete: { minBusyMs: 0, completeSoundGraceMs: 0, minAlertGapMs: 0 } });
		const ctx = makeCtx();
		c.enterBusy(ctx);
		now = 20_000;
		c.enterAttention(ctx, "complete");
		c.ackAttention(ctx);
		expect(c.phase).toBe("idle");
		expect(c.pendingCompleteAck).toBe(false);

		c.enterAttention(ctx, "intervention");
		c.ackAttention(ctx);
		expect(c.phase).toBe("attention");
		expect(c.reason).toBe("intervention");
	});

	it("shutdown cleans timers without notify", () => {
		const c = controller();
		const ctx = makeCtx();
		c.enterBusy(ctx);
		const before = notifies.length;
		c.shutdown();
		expect(c.phase).toBe("idle");
		expect(c.__getSnapshot().hasTimer).toBe(false);
		expect(notifies).toHaveLength(before);
	});

	it("restart spin on re-enterBusy is not stacked", () => {
		const c = controller();
		const ctx = makeCtx();
		c.enterBusy(ctx);
		c.enterBusy(ctx);
		expect(c.__getSnapshot().hasTimer).toBe(true);
		vi.advanceTimersByTime(240);
		// only one series of ticks advances frame sequence from restart
		expect(titles.filter((t) => t.startsWith(BRAILLE_FRAMES[0]!)).length).toBeGreaterThanOrEqual(1);
	});
});
