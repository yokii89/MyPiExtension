import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	applySharedHistory,
	isNotBrowsingHistory,
	SHARED_INPUT_HISTORY_LIMIT,
	SHARED_INPUT_HISTORY_VERSION,
	SharedInputHistoryStore,
} from "../yoki_ui/shared-input-history.ts";

describe("SharedInputHistoryStore", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempHistoryPath(): string {
		const dir = join(tmpdir(), `yoki-ui-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		dirs.push(dir);
		return join(dir, "input-history.json");
	}

	test("load returns empty when missing", () => {
		const store = new SharedInputHistoryStore(tempHistoryPath());
		assert.deepEqual(store.load(), []);
	});

	test("add persists newest-first and load reads back", () => {
		const path = tempHistoryPath();
		const store = new SharedInputHistoryStore(path);
		assert.deepEqual(store.add("first"), ["first"]);
		assert.deepEqual(store.add("second"), ["second", "first"]);
		assert.deepEqual(new SharedInputHistoryStore(path).load(), ["second", "first"]);

		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			version: number;
			entries: string[];
		};
		assert.equal(raw.version, SHARED_INPUT_HISTORY_VERSION);
		assert.deepEqual(raw.entries, ["second", "first"]);
	});

	test("add skips empty and consecutive duplicates", () => {
		const store = new SharedInputHistoryStore(tempHistoryPath());
		assert.deepEqual(store.add("   "), []);
		assert.deepEqual(store.add("same"), ["same"]);
		assert.deepEqual(store.add("same"), ["same"]);
		assert.deepEqual(store.add("other"), ["other", "same"]);
	});

	test("add moves older duplicates to the front", () => {
		const store = new SharedInputHistoryStore(tempHistoryPath());
		store.add("a");
		store.add("b");
		store.add("c");
		assert.deepEqual(store.add("a"), ["a", "c", "b"]);
		assert.deepEqual(store.load(), ["a", "c", "b"]);
	});

	test("load dedups non-consecutive duplicates, keeping newest position", () => {
		const path = tempHistoryPath();
		writeFileSync(
			path,
			JSON.stringify({ version: SHARED_INPUT_HISTORY_VERSION, entries: ["a", "b", "a", "c"] }),
			"utf-8",
		);
		assert.deepEqual(new SharedInputHistoryStore(path).load(), ["a", "b", "c"]);
	});

	test("add leaves no temp files behind", () => {
		const path = tempHistoryPath();
		const store = new SharedInputHistoryStore(path);
		store.add("a");
		store.add("b");
		const dir = join(path, "..");
		const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
		assert.deepEqual(leftovers, []);
	});

	test("corrupt file is backed up once and next add recovers", () => {
		const path = tempHistoryPath();
		writeFileSync(path, "{not-json", "utf-8");
		const store = new SharedInputHistoryStore(path);
		assert.deepEqual(store.load(), []);
		assert.deepEqual(store.add("fresh"), ["fresh"]);
		const dir = join(path, "..");
		const backups = readdirSync(dir).filter((name) => name.endsWith(".bak"));
		assert.equal(backups.length, 1, `expected one corrupt backup, got: ${backups.join(", ")}`);
		assert.equal(readFileSync(join(dir, backups[0]), "utf-8"), "{not-json");
		assert.deepEqual(new SharedInputHistoryStore(path).load(), ["fresh"]);
	});

	test("add enforces limit", () => {
		const store = new SharedInputHistoryStore(tempHistoryPath(), 3);
		store.add("a");
		store.add("b");
		store.add("c");
		assert.deepEqual(store.add("d"), ["d", "c", "b"]);
	});

	test("load tolerates corrupt JSON", () => {
		const path = tempHistoryPath();
		writeFileSync(path, "{not-json", "utf-8");
		assert.deepEqual(new SharedInputHistoryStore(path).load(), []);
	});

	test("default limit matches SHARED_INPUT_HISTORY_LIMIT", () => {
		const store = new SharedInputHistoryStore(tempHistoryPath());
		for (let i = 0; i < SHARED_INPUT_HISTORY_LIMIT + 5; i++) {
			store.add(`entry ${i}`);
		}
		const entries = store.load();
		assert.equal(entries.length, SHARED_INPUT_HISTORY_LIMIT);
		assert.equal(entries[0], `entry ${SHARED_INPUT_HISTORY_LIMIT + 4}`);
	});
});

describe("applySharedHistory helpers", () => {
	test("applySharedHistory sets history and clamps index", () => {
		const editor = { history: ["old"], historyIndex: 5 };
		applySharedHistory(editor, ["a", "b"]);
		assert.deepEqual(editor.history, ["a", "b"]);
		assert.equal(editor.historyIndex, 1);
	});

	test("isNotBrowsingHistory", () => {
		assert.equal(isNotBrowsingHistory({ historyIndex: -1 }), true);
		assert.equal(isNotBrowsingHistory({}), true);
		assert.equal(isNotBrowsingHistory({ historyIndex: 0 }), false);
	});
});
