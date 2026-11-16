/**
 * One queue owns background notices until actual delivery. While Pi is busy, notices stay here
 * with their refresh callbacks: handing them to sendMessage would freeze them in Pi's separate
 * follow-up/steering queue, where a later inspect can no longer withdraw them.
 */

import type { WakeNotice } from "../types.ts";

export interface WakeBatch {
	text: string;
	notices: WakeNotice[];
}

export interface WakeQueueOptions {
	/** How long notices are collected before one message is sent. */
	coalesceMs: number;
	/** Upper bound on wake messages per rolling hour. */
	maxPerHour: number;
	now?: () => number;
	/** Injected for tests; defaults to the real timers. */
	schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
	cancel?: (handle: ReturnType<typeof setTimeout>) => void;
	/** Only send from a timer when delivery is immediate (Pi is idle). */
	canSend?: () => boolean;
	/** Delivers one combined message. */
	send: (text: string, notices: WakeNotice[]) => void;
}

export interface WakeQueue {
	/** Queue one notice. The same key replaces both text and refresh callback. */
	enqueue(notice: WakeNotice): void;
	/** Send now, ignoring coalescing but still honouring canSend and the hourly gate. */
	flush(): void;
	/** Take a due batch at a Pi delivery boundary; honours coalescing and the hourly gate. */
	takeReady(): WakeBatch | undefined;
	/** Re-arm delivery after Pi becomes idle. Does not bypass the coalescing window. */
	resume(): void;
	/** Notices waiting for delivery. */
	pending(): number;
	/** Drops the timer and the buffer — session shutdown. */
	dispose(): void;
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_LISTED = 5;

export function createWakeQueue(options: WakeQueueOptions): WakeQueue {
	const now = options.now ?? (() => Date.now());
	const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
	const cancel = options.cancel ?? ((handle) => clearTimeout(handle));
	const buffer: WakeNotice[] = [];
	const sentAt: number[] = [];
	let readyAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const clearTimer = () => {
		if (timer !== undefined) {
			cancel(timer);
			timer = undefined;
		}
	};

	const compose = (notices: WakeNotice[]): string => {
		if (notices.length === 1) return (notices[0] as WakeNotice).text;
		const listed = notices.slice(0, MAX_LISTED).map((notice) => notice.text);
		if (notices.length > MAX_LISTED) listed.push(`…and ${notices.length - MAX_LISTED} more.`);
		return [`${notices.length} background notices:`, ...listed].join("\n\n");
	};

	const arm = (delayMs: number) => {
		if (disposed || timer !== undefined || buffer.length === 0) return;
		const handle = schedule(() => {
			timer = undefined;
			flush();
		}, delayMs);
		// A held notice must not be the reason the host stays alive.
		(handle as { unref?: () => void }).unref?.();
		timer = handle;
	};

	const take = (atBoundary: boolean): WakeBatch | undefined => {
		if (disposed || buffer.length === 0) return undefined;
		// Re-check even while rate-limited or busy. Keep the callbacks for subsequent checks:
		// coalescing, the hourly gate, and Pi's next delivery boundary can all delay delivery.
		for (let i = buffer.length - 1; i >= 0; i--) {
			const notice = buffer[i] as WakeNotice;
			if (!notice.refresh) continue;
			const current = notice.refresh();
			if (current) notice.text = current.text;
			else buffer.splice(i, 1);
		}
		if (buffer.length === 0) {
			clearTimer();
			return undefined;
		}
		if (atBoundary && now() < readyAt) return undefined;
		if (!atBoundary && options.canSend && !options.canSend()) return undefined;
		clearTimer();
		const cutoff = now() - HOUR_MS;
		while (sentAt.length > 0 && (sentAt[0] as number) <= cutoff) sentAt.shift();
		if (sentAt.length >= options.maxPerHour) {
			arm(Math.max(1_000, (sentAt[0] as number) + HOUR_MS - now() + 1));
			return undefined;
		}
		const notices = buffer.splice(0, buffer.length);
		sentAt.push(now());
		return { text: compose(notices), notices };
	};

	const flush = () => {
		const batch = take(false);
		if (batch) options.send(batch.text, batch.notices);
	};

	return {
		enqueue(notice) {
			if (disposed) return;
			if (buffer.length === 0) readyAt = now() + options.coalesceMs;
			const index = buffer.findIndex((item) => item.key === notice.key);
			if (index >= 0) buffer[index] = { ...notice };
			else buffer.push({ ...notice });
			arm(Math.max(0, readyAt - now()));
		},
		flush,
		takeReady: () => take(true),
		resume: () => arm(Math.max(0, readyAt - now())),
		pending: () => buffer.length,
		dispose() {
			disposed = true;
			clearTimer();
			buffer.length = 0;
			sentAt.length = 0;
		},
	};
}
