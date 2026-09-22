import { configPath, loadJsonConfigWithLegacyFallback } from "@yoki/yoki-config";
import {
	type CompleteConfig,
	DEFAULT_CONFIG,
	type InterventionConfig,
	type SoundLevel,
	type SpinnerFramesKind,
	type WindowTitleAnimationConfig,
	type WindowTitleConfig,
} from "./types.ts";

export const CONFIG_PATH = configPath("yoki-window-title");

export { DEFAULT_CONFIG, type WindowTitleConfig };

/** Collects one human-readable note per invalid/unsupported field. */
export type ConfigWarn = (path: string, value: unknown, note?: string) => void;

const fmt = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

function asBoolean(path: string, value: unknown, fallback: boolean, warn: ConfigWarn): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warn(path, value, `expected boolean; using ${fallback}`);
	return fallback;
}

function asPositiveInt(path: string, value: unknown, fallback: number, warn: ConfigWarn): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	warn(path, value, `expected positive integer; using ${fallback}`);
	return fallback;
}

function asNonNegativeInt(path: string, value: unknown, fallback: number, warn: ConfigWarn): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
	warn(path, value, `expected non-negative integer; using ${fallback}`);
	return fallback;
}

function asString(path: string, value: unknown, fallback: string, warn: ConfigWarn): string {
	if (value === undefined) return fallback;
	if (typeof value === "string" && value.length > 0) return value;
	warn(path, value, "expected non-empty string; using default");
	return fallback;
}

function asFrames(path: string, value: unknown, fallback: SpinnerFramesKind, warn: ConfigWarn): SpinnerFramesKind {
	if (value === undefined) return fallback;
	if (value === "braille" || value === "ascii") return value;
	warn(path, value, 'expected "braille" or "ascii"; using default');
	return fallback;
}

function asSoundLevel(path: string, value: unknown, fallback: SoundLevel, warn: ConfigWarn): SoundLevel {
	if (value === undefined) return fallback;
	if (value === "bel" || value === "system") return value;
	if (value === "file") {
		warn(path, value, 'not supported; using "bel"');
		return "bel";
	}
	warn(path, value, 'expected "bel" or "system"; using default');
	return fallback;
}

function asStringList(path: string, value: unknown, fallback: readonly string[], warn: ConfigWarn): readonly string[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value)) {
		warn(path, value, "expected string list; using default");
		return fallback;
	}
	const filtered = value.filter((s): s is string => typeof s === "string" && s.length > 0);
	if (filtered.length === 0) {
		warn(path, value, "no valid entries; using default");
		return fallback;
	}
	return filtered;
}

function mergeAnimation(raw: unknown, warn: ConfigWarn): WindowTitleAnimationConfig {
	const d = DEFAULT_CONFIG.windowTitle;
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		animation: asBoolean("windowTitle.animation", src.animation, d.animation, warn),
		frames: asFrames("windowTitle.frames", src.frames, d.frames, warn),
		intervalMs: asPositiveInt("windowTitle.intervalMs", src.intervalMs, d.intervalMs, warn),
	};
}

function mergeIntervention(raw: unknown, warn: ConfigWarn): InterventionConfig {
	const d = DEFAULT_CONFIG.intervention;
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		enabled: asBoolean("intervention.enabled", src.enabled, d.enabled, warn),
		blinkMs: asPositiveInt("intervention.blinkMs", src.blinkMs, d.blinkMs, warn),
		frameOn: asString("intervention.frameOn", src.frameOn, d.frameOn, warn),
		frameOff: asString("intervention.frameOff", src.frameOff, d.frameOff, warn),
		includeBase: asBoolean("intervention.includeBase", src.includeBase, d.includeBase, warn),
		notify: asBoolean("intervention.notify", src.notify, d.notify, warn),
		sound: asBoolean("intervention.sound", src.sound, d.sound, warn),
	};
}

function mergeComplete(raw: unknown, warn: ConfigWarn): CompleteConfig {
	const d = DEFAULT_CONFIG.complete;
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		notify: asBoolean("complete.notify", src.notify, d.notify, warn),
		sound: asBoolean("complete.sound", src.sound, d.sound, warn),
		soundLevel: asSoundLevel("complete.soundLevel", src.soundLevel, d.soundLevel, warn),
		titleFlash: asBoolean("complete.titleFlash", src.titleFlash, d.titleFlash, warn),
		minBusyMs: asNonNegativeInt("complete.minBusyMs", src.minBusyMs, d.minBusyMs, warn),
		minAlertGapMs: asNonNegativeInt("complete.minAlertGapMs", src.minAlertGapMs, d.minAlertGapMs, warn),
		completeSoundGraceMs: asNonNegativeInt(
			"complete.completeSoundGraceMs",
			src.completeSoundGraceMs,
			d.completeSoundGraceMs,
			warn,
		),
		ackOnFocus: asBoolean("complete.ackOnFocus", src.ackOnFocus, d.ackOnFocus, warn),
		ackOnKey: asBoolean("complete.ackOnKey", src.ackOnKey, d.ackOnKey, warn),
	};
}

/**
 * Normalize a raw config object (possibly partial) into a full config.
 * Pure — safe for unit tests without filesystem. Pass `warnings` to collect
 * per-field notes (e.g. unsupported `complete.soundLevel: "file"`).
 */
export function normalizeConfig(raw: unknown, warnings?: string[]): WindowTitleConfig {
	const prefix = (path: string, value: unknown, note?: string) =>
		warnings?.push(`yoki-window-title: ${path}: ${fmt(value)}${note ? ` — ${note}` : ""}`);
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		windowTitle: mergeAnimation(src.windowTitle, prefix),
		intervention: mergeIntervention(src.intervention, prefix),
		complete: mergeComplete(src.complete, prefix),
		blockingTools: asStringList("blockingTools", src.blockingTools, DEFAULT_CONFIG.blockingTools, prefix),
	};
}

export function loadConfig(): { config: WindowTitleConfig; warnings: string[] } {
	const warnings: string[] = [];
	const raw = loadJsonConfigWithLegacyFallback<Record<string, unknown>>("yoki-window-title");
	const config = normalizeConfig(raw, warnings);
	return { config, warnings };
}

export function getBlockingTools(config: WindowTitleConfig = loadConfig().config): ReadonlySet<string> {
	return new Set(config.blockingTools);
}
