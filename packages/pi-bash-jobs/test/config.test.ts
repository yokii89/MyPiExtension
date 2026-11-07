import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../config.ts";

const dirs: string[] = [];

function tempFile(content?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "bash-jobs-config-"));
	dirs.push(dir);
	const path = join(dir, "bash-jobs.json");
	if (content !== undefined) writeFileSync(path, content, "utf8");
	return path;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config defaults", () => {
	it("matches the doc's conservative numbers", () => {
		expect(DEFAULT_CONFIG).toMatchObject({
			replaceBuiltinBash: true,
			finishSoftBudgetSec: 300,
			idleWarnSec: 120,
			idleDetachSec: 180,
			explicitTimeoutKills: true,
			wakeOnExit: "followUp",
			keepOnSessionEnd: true,
			orphanTtlHours: 24,
			resultMaxBytes: 51_200,
			resultMaxLines: 2_000,
			output: { maxBytes: 262_144, maxLines: 4_000 },
		});
	});

	it("a missing file means defaults, not a failure", () => {
		expect(loadConfig(tempFile())).toEqual(DEFAULT_CONFIG);
	});

	it("a corrupt file means defaults, not a failure", () => {
		expect(loadConfig(tempFile("{oops"))).toEqual(DEFAULT_CONFIG);
	});
});

describe("normalizeConfig", () => {
	it("reads a partial override and keeps the rest", () => {
		const config = normalizeConfig({ finishSoftBudgetSec: 60, wakeOnExit: "off" });
		expect(config.finishSoftBudgetSec).toBe(60);
		expect(config.wakeOnExit).toBe("off");
		expect(config.idleDetachSec).toBe(DEFAULT_CONFIG.idleDetachSec);
	});

	it("clamps values that would make the policy spin", () => {
		const config = normalizeConfig({
			finishSoftBudgetSec: 0,
			idleWarnSec: -5,
			idleDetachSec: 0,
			orphanTtlHours: 0,
			maxWakePerHour: 0,
			inspectTailLines: 0,
			output: { maxBytes: 0, maxLines: 0 },
		});
		expect(config.finishSoftBudgetSec).toBeGreaterThanOrEqual(5);
		expect(config.idleWarnSec).toBeGreaterThanOrEqual(5);
		expect(config.idleDetachSec).toBeGreaterThanOrEqual(5);
		expect(config.orphanTtlHours).toBeGreaterThanOrEqual(1);
		expect(config.maxWakePerHour).toBeGreaterThanOrEqual(1);
		expect(config.inspectTailLines).toBeGreaterThanOrEqual(1);
		expect(config.output.maxBytes).toBeGreaterThanOrEqual(4_096);
		expect(config.output.maxLines).toBeGreaterThanOrEqual(32);
	});

	it("ignores wrong types instead of producing NaN budgets", () => {
		const config = normalizeConfig({ finishSoftBudgetSec: "600", idleWarnSec: null, wakeOnExit: "sometimes" });
		expect(config.finishSoftBudgetSec).toBe(DEFAULT_CONFIG.finishSoftBudgetSec);
		expect(config.idleWarnSec).toBe(DEFAULT_CONFIG.idleWarnSec);
		expect(config.wakeOnExit).toBe(DEFAULT_CONFIG.wakeOnExit);
	});

	it("keeps the tail cap at least as large as the default tail", () => {
		const config = normalizeConfig({ inspectTailLines: 500, inspectMaxTailLines: 100 });
		expect(config.inspectMaxTailLines).toBe(500);
	});

	it("accepts extra command patterns and drops blank ones", () => {
		const config = normalizeConfig({ extraDetachPatterns: ["^cargo watch", "  "] });
		expect(config.extraDetachPatterns).toEqual(["^cargo watch"]);
	});

	it("drops an extra pattern that does not compile instead of failing every bash call", () => {
		const config = normalizeConfig({
			extraDetachPatterns: ["[", "^mytool\\b"],
			extraLongPatterns: ["(", "  "],
		});
		expect(config.extraDetachPatterns).toEqual(["^mytool\\b"]);
		expect(config.extraLongPatterns).toEqual([]);
	});

	it("keeps the model-facing result caps at sane floors", () => {
		const tiny = normalizeConfig({ resultMaxBytes: 10, resultMaxLines: 1 });
		expect(tiny.resultMaxBytes).toBeGreaterThanOrEqual(4_096);
		expect(tiny.resultMaxLines).toBeGreaterThanOrEqual(32);
		const generous = normalizeConfig({ resultMaxBytes: 1_048_576, resultMaxLines: 50_000 });
		expect(generous.resultMaxBytes).toBe(1_048_576);
		expect(generous.resultMaxLines).toBe(50_000);
	});

	it("returns defaults for a non-object", () => {
		expect(normalizeConfig("nope")).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig([1, 2, 3])).toEqual(DEFAULT_CONFIG);
	});
});
