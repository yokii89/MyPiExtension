/**
 * Global shared prompt history for Up/Down navigation across pi instances.
 * Stored at ~/.pi/agent/input-history.json (newest first).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SHARED_INPUT_HISTORY_LIMIT = 100;
export const SHARED_INPUT_HISTORY_VERSION = 1;

export type SharedInputHistoryFile = {
	version: number;
	/** Newest entry first. */
	entries: string[];
};

/** Runtime shape of pi-tui Editor history fields (private at type level, public at runtime). */
export type HistoryEditorFields = {
	history?: string[];
	historyIndex?: number;
};

export function defaultSharedInputHistoryPath(): string {
	return join(homedir(), ".pi", "agent", "input-history.json");
}

function normalizeEntries(entries: unknown, limit: number): string[] {
	if (!Array.isArray(entries)) return [];
	const result: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		// Newest-first list: the first occurrence of a duplicate is the newest,
		// so older copies further down are dropped.
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
		if (result.length >= limit) break;
	}
	return result;
}

function serializeHistory(entries: string[]): string {
	const data: SharedInputHistoryFile = {
		version: SHARED_INPUT_HISTORY_VERSION,
		entries,
	};
	return `${JSON.stringify(data, null, "\t")}\n`;
}

function prependEntry(entries: string[], text: string, limit: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return entries;
	// Move-to-front dedup: drop older copies so a resubmitted entry lands at
	// the top instead of piling up at several positions.
	return [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, limit);
}

export class SharedInputHistoryStore {
	private readonly historyPath: string;
	private readonly limit: number;

	constructor(historyPath: string = defaultSharedInputHistoryPath(), limit: number = SHARED_INPUT_HISTORY_LIMIT) {
		this.historyPath = historyPath;
		this.limit = limit;
	}

	load(): string[] {
		return this.readEntries();
	}

	/**
	 * Prepend text, re-read disk, write back. Returns newest-first list.
	 * Best-effort under concurrent writers: writes are atomic (temp file +
	 * rename), but a true write-write race still ends last-writer-wins.
	 */
	add(text: string): string[] {
		const trimmed = text.trim();
		if (!trimmed) return this.load();

		try {
			const dir = dirname(this.historyPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

			const entries = prependEntry(this.readEntries(), trimmed, this.limit);
			if (this.writeEntriesAtomic(entries)) return entries;
		} catch {
			/* fall through to in-memory prepend */
		}
		return prependEntry(this.load(), trimmed, this.limit);
	}

	private readEntries(): string[] {
		try {
			if (!existsSync(this.historyPath)) return [];
			const content = readFileSync(this.historyPath, "utf-8");
			if (!content.trim()) return [];
			try {
				const parsed = JSON.parse(content) as Partial<SharedInputHistoryFile> | string[];
				if (Array.isArray(parsed)) return normalizeEntries(parsed, this.limit);
				return normalizeEntries(parsed.entries, this.limit);
			} catch {
				// Corrupt file: move it aside (once) instead of silently overwriting
				// it on the next write, so the old history is recoverable.
				this.backupCorruptFile();
				return [];
			}
		} catch {
			return [];
		}
	}

	private backupCorruptFile(): void {
		try {
			if (!existsSync(this.historyPath)) return;
			renameSync(this.historyPath, `${this.historyPath}.corrupt-${Date.now()}.bak`);
		} catch {
			/* best-effort */
		}
	}

	/** Write via temp file + rename so a crash mid-write cannot corrupt the file. */
	private writeEntriesAtomic(entries: string[]): boolean {
		const tmp = `${this.historyPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		try {
			writeFileSync(tmp, serializeHistory(entries), "utf-8");
			renameSync(tmp, this.historyPath);
			return true;
		} catch {
			try {
				if (existsSync(tmp)) renameSync(tmp, `${tmp}.bak`);
			} catch {
				/* best-effort cleanup */
			}
			return false;
		}
	}
}

/** Replace the editor's in-memory history array (newest first). */
export function applySharedHistory(editor: object, entries: string[]): void {
	const target = editor as HistoryEditorFields;
	target.history = entries.slice(0, SHARED_INPUT_HISTORY_LIMIT);
	if (typeof target.historyIndex === "number" && target.historyIndex >= target.history.length) {
		target.historyIndex = target.history.length > 0 ? target.history.length - 1 : -1;
	}
}

/** True when the editor is not currently browsing history. */
export function isNotBrowsingHistory(editor: object): boolean {
	const index = (editor as HistoryEditorFields).historyIndex;
	return index === undefined || index === -1;
}
