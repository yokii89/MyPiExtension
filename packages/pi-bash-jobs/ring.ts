/**
 * Output ring buffer (doc 129 §5.4): bytes **and** lines are both capped, `\r` also ends a
 * line (curl/wget/pip redraw the same line), and a cursor lets the model read only what is
 * new since the last inspect.
 *
 * A partial trailing line is kept out of the committed set but still shown: `Password:` with
 * no newline is exactly the state a user needs to see. Showing it twice on two inspects is
 * correct — it is a live line, not a duplicated entry.
 */

import { StringDecoder } from "node:string_decoder";

export interface RingLimits {
	maxBytes: number;
	maxLines: number;
}

interface Entry {
	seq: number;
	text: string;
	bytes: number;
}

export interface RingSnapshot {
	/** Lines after `cursor`, oldest first. */
	lines: string[];
	/** Cursor to pass to the next call. Always the highest committed seq. */
	cursor: string;
	/** True when the requested cursor was already trimmed away — the tail is lossy. */
	lost: boolean;
}

export interface RingStats {
	bytes: number;
	lines: number;
	/** Highest committed seq, `0` when nothing has been committed yet. */
	nextSeq: number;
	/**
	 * True when anything is no longer fully here: a dropped line, or a line/pending fragment that
	 * the byte cap shortened. Without it a capped single line would look like complete output.
	 */
	truncated: boolean;
}

export interface RingBuffer {
	append(chunk: Buffer | string): void;
	/** Full retained text, including the pending partial line. */
	text(): string;
	/** Last `n` lines (default all), including the pending partial line. */
	tail(n?: number): string;
	since(cursor?: string, limit?: number): RingSnapshot;
	stats(): RingStats;
	/** Subscribe to committed lines (doc 132's job watch hangs here). */
	onCommit(listener: (line: string) => void): () => void;
	/** Cursor for the newest committed line. */
	cursor(): string;
}

/**
 * Longest suffix of `text` that fits in `maxBytes` of UTF-8, never splitting a code point.
 *
 * Byte caps must be measured in bytes: slicing by characters lets a CJK line keep three times the
 * budget, and slicing blind can cut a surrogate pair into a lone half that renders as `\uFFFD`.
 */
export function tailWithinBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0 || text.length === 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const buffer = Buffer.from(text, "utf8");
	let start = buffer.length - maxBytes;
	// A continuation byte means the cut landed inside a sequence: walk to the next lead byte.
	while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

export function createRingBuffer(limits: RingLimits): RingBuffer {
	const maxBytes = Math.max(1, limits.maxBytes);
	const maxLines = Math.max(1, limits.maxLines);
	const decoder = new StringDecoder("utf8");
	const entries: Entry[] = [];
	let pending = "";
	let bytes = 0;
	let nextSeq = 1;
	let droppedThrough = 0;
	const listeners = new Set<(line: string) => void>();
	/** Set when a chunk ended on `\r`; the `\n` of a split `\r\n` must not become a blank line. */
	let swallowLeadingLf = false;
	let truncated = false;

	const trim = () => {
		while (entries.length > maxLines || (bytes > maxBytes && entries.length > 1)) {
			const dropped = entries.shift();
			if (!dropped) break;
			bytes -= dropped.bytes;
			droppedThrough = dropped.seq;
			truncated = true;
		}
	};

	const commit = (text: string) => {
		// One absurdly long line (a minified bundle piped into the log) must not defeat the byte
		// cap: keep its tail, which is where the error message usually is.
		const bounded = tailWithinBytes(text, maxBytes);
		if (bounded !== text) truncated = true;
		const entry: Entry = { seq: nextSeq++, text: bounded, bytes: Buffer.byteLength(bounded, "utf8") };
		entries.push(entry);
		bytes += entry.bytes;
		trim();
		for (const listener of listeners) listener(bounded);
	};

	// `\r\n` is one break; a lone `\r` is a progress redraw, which is also a break.
	const consume = (chunk: string) => {
		if (!chunk) return;
		let text = pending + chunk;
		pending = "";
		// Pipe reads split wherever the buffer ends, including between `\r` and `\n`. That pair is
		// still one break, so the leading `\n` of this chunk must not commit an empty line.
		if (swallowLeadingLf && text.startsWith("\n")) text = text.slice(1);
		swallowLeadingLf = false;
		// A trailing `\r` may be the first half of that pair: end the line it terminates now (as one
		// break) but hold the decision about a possible `\n` until the next chunk arrives.
		if (text.endsWith("\r")) {
			text = `${text.slice(0, -1)}\n`;
			swallowLeadingLf = true;
		}
		const parts = text.split(/\r\n|\r|\n/);
		// A partial line is bounded too: `progress` without a newline would otherwise grow forever.
		const partial = parts.pop() ?? "";
		pending = tailWithinBytes(partial, maxBytes);
		if (pending !== partial) truncated = true;
		for (const part of parts) commit(part);
	};

	const snapshotLines = (from: number, limit?: number): RingSnapshot => {
		const cursorSeq = from;
		const lost = cursorSeq > 0 && cursorSeq < droppedThrough;
		const kept = entries.filter((entry) => entry.seq > cursorSeq);
		const lines = kept.map((entry) => entry.text);
		if (pending.length > 0) lines.push(pending);
		const limited = limit !== undefined && limit >= 0 && lines.length > limit ? lines.slice(-limit) : lines;
		return { lines: limited, cursor: String(nextSeq - 1), lost };
	};

	return {
		append(chunk) {
			consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
		},
		text() {
			const all = entries.map((entry) => entry.text);
			if (pending.length > 0) all.push(pending);
			return all.join("\n");
		},
		tail(n) {
			const all = entries.map((entry) => entry.text);
			if (pending.length > 0) all.push(pending);
			if (n === undefined || n < 0 || n >= all.length) return all.join("\n");
			return all.slice(all.length - n).join("\n");
		},
		since(cursor, limit) {
			const parsed = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
			return snapshotLines(Number.isFinite(parsed) && parsed > 0 ? parsed : 0, limit);
		},
		stats() {
			return { bytes, lines: entries.length, nextSeq, truncated };
		},
		onCommit(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		cursor() {
			return String(nextSeq - 1);
		},
	};
}
