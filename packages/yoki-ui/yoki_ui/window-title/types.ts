/**
 * Shared types and config defaults for yoki_ui window-title.
 * Spec: docs/setWindowTitleUI.md
 */

export type Phase = "idle" | "busy" | "attention";
export type AttentionReason = "complete" | "intervention";
export type SpinnerFramesKind = "braille" | "ascii";
export type SoundLevel = "bel" | "system" | "file";

export interface WindowTitleAnimationConfig {
	readonly animation: boolean;
	readonly frames: SpinnerFramesKind;
	readonly intervalMs: number;
}

export interface InterventionConfig {
	readonly enabled: boolean;
	readonly blinkMs: number;
	readonly frameOn: string;
	readonly frameOff: string;
	readonly includeBase: boolean;
	readonly notify: boolean;
	readonly sound: boolean;
}

export interface CompleteConfig {
	readonly notify: boolean;
	readonly sound: boolean;
	readonly soundLevel: SoundLevel;
	readonly titleFlash: boolean;
	readonly minBusyMs: number;
	readonly minAlertGapMs: number;
	readonly completeSoundGraceMs: number;
	readonly ackOnFocus: boolean;
	readonly ackOnKey: boolean;
}

export interface WindowTitleConfig {
	readonly windowTitle: WindowTitleAnimationConfig;
	readonly intervention: InterventionConfig;
	readonly complete: CompleteConfig;
	/** Tool names that enter intervention on tool_call / leave on tool_execution_end. */
	readonly blockingTools: readonly string[];
}

export const BRAILLE_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const ASCII_FRAMES: readonly string[] = ["|", "/", "-", "\\"];

export const DEFAULT_CONFIG: WindowTitleConfig = {
	windowTitle: {
		animation: true,
		frames: "braille",
		intervalMs: 80,
	},
	intervention: {
		enabled: true,
		blinkMs: 500,
		frameOn: "[!] Action Required",
		frameOff: "[.] Action Required",
		includeBase: false,
		notify: true,
		sound: true,
	},
	complete: {
		notify: true,
		sound: true,
		soundLevel: "bel",
		titleFlash: false,
		minBusyMs: 3000,
		minAlertGapMs: 2000,
		completeSoundGraceMs: 5000,
		ackOnFocus: true,
		ackOnKey: true,
	},
	blockingTools: ["ask_user_question"],
};

/** Cross-package bus: other extensions may emit to enter/exit intervention. */
export const NEED_USER_EVENT = "yoki:window-title:need-user" as const;
export const USER_DONE_EVENT = "yoki:window-title:user-done" as const;

/** ask-user-question already ships this; we listen without reverse dep. */
export const ASK_USER_PROMPT_EVENT = "yoki:ask-user:prompt" as const;
