import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASCII_FRAMES, BRAILLE_FRAMES, type SpinnerFramesKind, type WindowTitleConfig } from "./types.ts";

export function cwdBasename(cwd: string): string {
	const base = path.basename(cwd.replace(/[/\\]+$/, "") || cwd);
	return base.length > 0 ? base : cwd;
}

export function baseTitle(pi: ExtensionAPI, cwd: string): string {
	const base = cwdBasename(cwd);
	const session = typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;
	return session ? `π - ${session} - ${base}` : `π - ${base}`;
}

export function spinnerFrames(kind: SpinnerFramesKind): readonly string[] {
	return kind === "ascii" ? ASCII_FRAMES : BRAILLE_FRAMES;
}

export function busyTitle(frameIndex: number, base: string, frames: readonly string[]): string {
	const glyph = frames[frameIndex % frames.length] ?? frames[0] ?? "";
	return `${glyph} ${base}`;
}

export function interventionFrames(
	config: WindowTitleConfig["intervention"],
	cwdBase: string,
): readonly [string, string] {
	const suffix = config.includeBase ? ` · ${cwdBase}` : "";
	return [`${config.frameOn}${suffix}`, `${config.frameOff}${suffix}`];
}
