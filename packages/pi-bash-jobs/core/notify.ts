/**
 * "Is this exit notice news?" (doc 129 §7.3, plus the echo bug found on a real session).
 *
 * The wake path and the inspect path share one piece of state: `job.consumed`, the cursor and
 * status the model was last *shown*. Without that sharing, an inspect that already returned
 * `J-27 — exited` with every line is followed by a wake carrying the same tail and inviting the
 * model to read a job it finished reading — a full LLM turn spent on an echo. Two notifications
 * paths with two ideas of "read" is exactly how that happens.
 *
 * A completion is consumed only when an inspect returned the terminal state. A read that saw
 * `running` must never suppress an exit, even if it happened a millisecond later with no output.
 * The decision is re-evaluated at actual delivery, after any coalescing, rate limiting or busy
 * agent delay. Changed output remains news, including uncommitted trailing fragments.
 */

import type { JobRecord, JobStatus } from "../types.ts";

/** What the model was last shown for one job (the single shared read state). */
export interface ConsumedRead {
	/** Cursor returned by that inspect: every line up to here has been read. */
	cursor: string;
	/**
	 * The uncommitted trailing line (`Password:`, a progress fragment) that inspect printed.
	 *
	 * A pending line has no cursor, so it is invisible to the cursor comparison — and a command whose
	 * whole output is one unterminated line (`printf one`) would then read as "nothing new" while the
	 * model had only been shown the first half of it. Remembering the text closes that hole: same
	 * pending text on both sides is an echo, a different one is news.
	 */
	pending: string;
	/** When that inspect answered. */
	at: number;
	/** The status that inspect reported. `false` means "still running when the model looked". */
	terminal: boolean;
}

export interface WakeDecisionInput {
	job: JobRecord;
	/** Newest committed cursor at settle time. */
	finalCursor: string;
	/** Uncommitted trailing text at settle time (see `ConsumedRead.pending`). */
	finalPending?: string;
	consumed?: ConsumedRead;
	/** @deprecated Ignored. Only a terminal read consumes a completion, regardless of timing. */
	redundantWindowMs?: number;
}

export interface WakeDecision {
	deliver: boolean;
	/** Why, for tests and for a future `--debug` surface. Never sent to the model. */
	reason: string;
	/** Lines written after the model's last read; `undefined` when it never read the job. */
	newLines?: number;
}

export function cursorSeq(cursor: string | undefined): number {
	const parsed = cursor === undefined ? Number.NaN : Number.parseInt(cursor, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function decideExitWake(input: WakeDecisionInput): WakeDecision {
	const consumed = input.consumed;
	if (!consumed) return { deliver: true, reason: "the model has never read this job" };

	const newLines = Math.max(0, cursorSeq(input.finalCursor) - cursorSeq(consumed.cursor));
	// A pending line carries no cursor, so `newLines === 0` alone does not mean "nothing new": the
	// uncommitted tail may have grown since the read that reported it (or appeared at all).
	const pendingGrew = (input.finalPending ?? "") !== consumed.pending;

	if (pendingGrew) {
		return { deliver: true, reason: "the uncommitted trailing output changed since the last read", newLines };
	}
	if (newLines === 0 && consumed.terminal) {
		return { deliver: false, reason: "already read: the last inspect reported the terminal state", newLines };
	}
	return {
		deliver: true,
		reason: newLines > 0 ? `${newLines} new line(s) since the last read` : "the last inspect only saw a running job",
		newLines,
	};
}

/** True when a status means "the model was told how this ended". */
export function isTerminalStatus(status: JobStatus): boolean {
	return status !== "running";
}
