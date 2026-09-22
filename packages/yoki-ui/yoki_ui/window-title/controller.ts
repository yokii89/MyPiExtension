/**
 * Window title state machine: idle | busy | attention(complete|intervention).
 * Spec: docs/setWindowTitleUI.md §3–§8, §11.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WindowTitleConfig } from "./config.ts";
import { osNotify, playSound } from "./notify.ts";
import { baseTitle, busyTitle, cwdBasename, interventionFrames, spinnerFrames } from "./title-format.ts";
import type { AttentionReason, Phase } from "./types.ts";

export type SetTitleFn = (title: string) => void;
export type NowFn = () => number;

export interface ControllerDeps {
	pi: ExtensionAPI;
	config: WindowTitleConfig;
	/** Override for tests */
	setTitle?: SetTitleFn;
	now?: NowFn;
	/** Injected notify/sound for tests */
	notify?: (title: string, body: string) => void;
	sound?: () => void;
}

export interface WindowTitleController {
	readonly phase: Phase;
	readonly reason: AttentionReason | null;
	readonly pendingCompleteAck: boolean;
	enterBusy(ctx: ExtensionContext): void;
	enterAttention(ctx: ExtensionContext, reason: AttentionReason, opts?: { silent?: boolean }): void;
	exitAttentionToBusy(ctx: ExtensionContext): void;
	ackAttention(ctx: ExtensionContext): void;
	shutdown(): void;
	/** Test helper */
	__getSnapshot(): {
		phase: Phase;
		reason: AttentionReason | null;
		pendingCompleteAck: boolean;
		busyStartedAt: number;
		lastSoundAt: number;
		hasTimer: boolean;
	};
}

export function createController(deps: ControllerDeps): WindowTitleController {
	const pi = deps.pi;
	const config = deps.config;
	const now = deps.now ?? (() => Date.now());
	const notify = deps.notify ?? osNotify;
	const defaultSound = () => playSound(config.complete.soundLevel);
	const sound = deps.sound ?? defaultSound;

	let phase: Phase = "idle";
	let reason: AttentionReason | null = null;
	let titleTimer: ReturnType<typeof setInterval> | null = null;
	let frame = 0;
	let busyStartedAt = 0;
	let lastSoundAt = 0;
	let pendingCompleteAck = false;
	let lastCtx: ExtensionContext | null = null;

	function resolveSetTitle(ctx: ExtensionContext): SetTitleFn {
		if (deps.setTitle) return deps.setTitle;
		return (title: string) => {
			try {
				ctx.ui.setTitle(title);
			} catch {
				/* swallow */
			}
		};
	}

	function clearTitleTimer(): void {
		if (titleTimer) {
			clearInterval(titleTimer);
			titleTimer = null;
		}
		frame = 0;
	}

	function cwdOf(ctx: ExtensionContext): string {
		return typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
	}

	function applyBaseTitle(ctx: ExtensionContext): void {
		resolveSetTitle(ctx)(baseTitle(pi, cwdOf(ctx)));
	}

	function canEmitAlert(): boolean {
		const gap = config.complete.minAlertGapMs;
		if (gap <= 0) return true;
		return now() - lastSoundAt >= gap;
	}

	function markSound(): void {
		lastSoundAt = now();
	}

	function emitAlert(opts: { notify: boolean; sound: boolean; title: string; body: string }): void {
		if (!opts.notify && !opts.sound) return;
		if (!canEmitAlert()) return;
		if (opts.notify) notify(opts.title, opts.body);
		if (opts.sound) sound();
		markSound();
	}

	function startSpin(ctx: ExtensionContext): void {
		clearTitleTimer();
		if (!config.windowTitle.animation) {
			applyBaseTitle(ctx);
			return;
		}
		const frames = spinnerFrames(config.windowTitle.frames);
		const setTitle = resolveSetTitle(ctx);
		const base = baseTitle(pi, cwdOf(ctx));
		setTitle(busyTitle(0, base, frames));
		frame = 1;
		titleTimer = setInterval(() => {
			setTitle(busyTitle(frame, base, frames));
			frame += 1;
		}, config.windowTitle.intervalMs);
		if (typeof titleTimer.unref === "function") titleTimer.unref();
	}

	function startBlink(ctx: ExtensionContext): void {
		clearTitleTimer();
		const frames = interventionFrames(config.intervention, cwdBasename(cwdOf(ctx)));
		const setTitle = resolveSetTitle(ctx);
		setTitle(frames[0]);
		frame = 1;
		titleTimer = setInterval(() => {
			setTitle(frames[frame % 2]!);
			frame += 1;
		}, config.intervention.blinkMs);
		if (typeof titleTimer.unref === "function") titleTimer.unref();
	}

	function enterBusy(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		clearTitleTimer();
		phase = "busy";
		reason = null;
		pendingCompleteAck = false;
		busyStartedAt = now();
		startSpin(ctx);
	}

	function enterIntervention(ctx: ExtensionContext, opts?: { silent?: boolean }): void {
		if (ctx.mode !== "tui") return;
		if (!config.intervention.enabled) return;
		lastCtx = ctx;
		const alreadyBlinking = phase === "attention" && reason === "intervention";
		clearTitleTimer();
		phase = "attention";
		reason = "intervention";
		// keep pendingCompleteAck as-is only if we were complete; clear for intervention priority
		pendingCompleteAck = false;
		startBlink(ctx);
		if (alreadyBlinking || opts?.silent) return;
		emitAlert({
			notify: config.intervention.notify,
			sound: config.intervention.sound,
			title: "Pi",
			body: "Action required",
		});
	}

	function enterComplete(ctx: ExtensionContext, opts?: { silent?: boolean }): void {
		if (ctx.mode !== "tui") return;
		lastCtx = ctx;
		clearTitleTimer();
		phase = "attention";
		reason = "complete";
		pendingCompleteAck = true;

		if (config.complete.titleFlash) {
			startBlink(ctx);
		} else {
			applyBaseTitle(ctx);
		}

		const busyMs = busyStartedAt > 0 ? now() - busyStartedAt : Number.POSITIVE_INFINITY;
		const tooShort = busyMs < config.complete.minBusyMs;
		const inGrace = now() - lastSoundAt < config.complete.completeSoundGraceMs;
		const silent = opts?.silent === true || tooShort || inGrace;

		if (silent) return;

		emitAlert({
			notify: config.complete.notify,
			sound: config.complete.sound,
			title: "Pi",
			body: "Ready for input",
		});
	}

	function enterAttention(ctx: ExtensionContext, attnReason: AttentionReason, opts?: { silent?: boolean }): void {
		if (attnReason === "intervention") {
			enterIntervention(ctx, opts);
			return;
		}
		enterComplete(ctx, opts);
	}

	function exitAttentionToBusy(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		// Dialog finished and agent continues
		enterBusy(ctx);
	}

	function ackAttention(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		// Intervention is stopped by dialog end path, not generic ack
		if (phase === "attention" && reason === "intervention") return;
		if (!pendingCompleteAck && phase !== "attention") return;
		pendingCompleteAck = false;
		phase = "idle";
		reason = null;
		clearTitleTimer();
		applyBaseTitle(ctx);
	}

	function shutdown(): void {
		clearTitleTimer();
		phase = "idle";
		reason = null;
		pendingCompleteAck = false;
		busyStartedAt = 0;
		// Intentionally no complete notification on shutdown
		if (lastCtx && lastCtx.mode === "tui") {
			try {
				applyBaseTitle(lastCtx);
			} catch {
				/* swallow */
			}
		}
		lastCtx = null;
	}

	return {
		get phase() {
			return phase;
		},
		get reason() {
			return reason;
		},
		get pendingCompleteAck() {
			return pendingCompleteAck;
		},
		enterBusy,
		enterAttention,
		exitAttentionToBusy,
		ackAttention,
		shutdown,
		__getSnapshot() {
			return {
				phase,
				reason,
				pendingCompleteAck,
				busyStartedAt,
				lastSoundAt,
				hasTimer: titleTimer !== null,
			};
		},
	};
}
