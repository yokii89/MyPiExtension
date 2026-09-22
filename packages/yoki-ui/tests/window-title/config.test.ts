import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../../yoki_ui/window-title/config.ts";

describe("normalizeConfig", () => {
	it("fills defaults for empty input", () => {
		expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
	});
	it("merges partial nested overrides", () => {
		const cfg = normalizeConfig({
			windowTitle: { intervalMs: 100, frames: "ascii" },
			intervention: { blinkMs: 400, includeBase: true },
			complete: { minBusyMs: 0, titleFlash: true },
			blockingTools: ["confirm"],
		});
		expect(cfg.windowTitle.intervalMs).toBe(100);
		expect(cfg.windowTitle.frames).toBe("ascii");
		expect(cfg.windowTitle.animation).toBe(true);
		expect(cfg.intervention.blinkMs).toBe(400);
		expect(cfg.intervention.includeBase).toBe(true);
		expect(cfg.intervention.frameOn).toBe("[!] Action Required");
		expect(cfg.complete.minBusyMs).toBe(0);
		expect(cfg.complete.titleFlash).toBe(true);
		expect(cfg.blockingTools).toEqual(["confirm"]);
	});
	it("rejects invalid types and falls back", () => {
		const cfg = normalizeConfig({
			windowTitle: { intervalMs: -1, frames: "nope" },
			blockingTools: [1, "", "ok"],
		});
		expect(cfg.windowTitle.intervalMs).toBe(DEFAULT_CONFIG.windowTitle.intervalMs);
		expect(cfg.windowTitle.frames).toBe("braille");
		expect(cfg.blockingTools).toEqual(["ok"]);
	});
	it("collects field-level warnings for invalid values", () => {
		const warnings: string[] = [];
		normalizeConfig(
			{ windowTitle: { intervalMs: -1 }, complete: { minBusyMs: "soon" } },
			warnings,
		);
		expect(warnings.some((w) => w.includes("windowTitle.intervalMs"))).toBe(true);
		expect(warnings.some((w) => w.includes("complete.minBusyMs"))).toBe(true);
	});
	it("warns that soundLevel file is unsupported and falls back to bel", () => {
		const warnings: string[] = [];
		const cfg = normalizeConfig({ complete: { soundLevel: "file" } }, warnings);
		expect(cfg.complete.soundLevel).toBe("bel");
		expect(warnings.some((w) => w.includes("complete.soundLevel") && w.includes("not supported"))).toBe(
			true,
		);
	});
	it("emits no warnings for a valid config", () => {
		const warnings: string[] = [];
		normalizeConfig({ complete: { soundLevel: "system" }, blockingTools: ["confirm"] }, warnings);
		expect(warnings).toEqual([]);
	});
});
