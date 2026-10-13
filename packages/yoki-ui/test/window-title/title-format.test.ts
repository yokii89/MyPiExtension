import { describe, expect, it } from "vitest";
import { baseTitle, busyTitle, cwdBasename, interventionFrames, spinnerFrames } from "../../yoki_ui/window-title/title-format.ts";
import { BRAILLE_FRAMES, DEFAULT_CONFIG } from "../../yoki_ui/window-title/types.ts";

describe("cwdBasename", () => {
	it("returns the last path segment", () => {
		expect(cwdBasename("/tmp/demo")).toBe("demo");
		expect(cwdBasename("D:\\Code\\yoki-mono")).toBe("yoki-mono");
	});
});

describe("baseTitle", () => {
	it("includes session when set", () => {
		const pi = { getSessionName: () => "sprint" } as never;
		expect(baseTitle(pi, "/tmp/demo")).toBe("π - sprint - demo");
	});
	it("omits session when unset", () => {
		const pi = { getSessionName: () => undefined } as never;
		expect(baseTitle(pi, "/tmp/demo")).toBe("π - demo");
	});
});

describe("busyTitle", () => {
	it("prefixes rotating frame + space + base", () => {
		expect(busyTitle(0, "π - demo", BRAILLE_FRAMES)).toBe(`${BRAILLE_FRAMES[0]} π - demo`);
		expect(busyTitle(BRAILLE_FRAMES.length, "π - demo", BRAILLE_FRAMES)).toBe(`${BRAILLE_FRAMES[0]} π - demo`);
	});
	it("never embeds alarm emoji", () => {
		const title = busyTitle(3, "π - demo", BRAILLE_FRAMES);
		expect(title).not.toMatch(/[⏰🔔]/u);
	});
});

describe("interventionFrames", () => {
	it("defaults to short Action Required pair", () => {
		const [a, b] = interventionFrames(DEFAULT_CONFIG.intervention, "demo");
		expect(a).toBe("[!] Action Required");
		expect(b).toBe("[.] Action Required");
	});
	it("can include cwd base", () => {
		const [a, b] = interventionFrames({ ...DEFAULT_CONFIG.intervention, includeBase: true }, "demo");
		expect(a).toBe("[!] Action Required · demo");
		expect(b).toBe("[.] Action Required · demo");
	});
});

describe("spinnerFrames", () => {
	it("selects braille or ascii", () => {
		expect(spinnerFrames("braille")).toEqual(BRAILLE_FRAMES);
		expect(spinnerFrames("ascii")).toEqual(["|", "/", "-", "\\"]);
	});
});
