/**
 * Job registry (doc 129 §4/§7.1). Process-free on purpose: it owns identity, status, TTL and
 * the event stream, while `runBash.ts` owns the actual child process. That split is what lets
 * the state machine be tested without spawning anything.
 *
 * Two rules the registry enforces so callers cannot get them wrong:
 *  - a settled job never returns to `running`;
 *  - `orphaned` is terminal for exit observation — restored jobs can be read, not awaited.
 */

import type { RingBuffer } from "../infra/ring.ts";
import type { JobEvent, JobMode, JobRecord, JobStatus, KillReason, SettleInfo } from "../types.ts";
import { type ConsumedRead, cursorSeq } from "./notify.ts";

export interface CreateJobInput {
	command: string;
	label?: string;
	mode: JobMode;
	reason: string;
	pid?: number;
	/** Kills the underlying process; supplied by the process layer. */
	kill: (reason: KillReason) => void;
	ring: RingBuffer;
}

export interface Job extends JobRecord {
	readonly ring: RingBuffer;
	/** Resolves once the job settles (exit, kill, or restore-as-orphan). Never rejects. */
	readonly exited: Promise<SettleInfo>;
	/** Called by runBash when `execute()` returns while the process is still alive. */
	markDetached(): void;
	snapshot(): JobRecord;
	/**
	 * What the model was last *shown* — shared by the inspect tool and the wake path, so a notice
	 * can tell "news" from "echo of what this session already read" (see `core/notify.ts`).
	 */
	consumed?: ConsumedRead;
	/** Remember what an inspect answer contained for this job. */
	markConsumed(read: ConsumedRead): void;
}

export interface JobRegistryOptions {
	now?: () => number;
}

export interface JobRegistry {
	create(input: CreateJobInput): Job;
	/** Restore persisted records; a record that was `running` becomes `orphaned` (doc 129 §7.4). */
	restore(entries: { record: JobRecord; ring: RingBuffer }[]): Job[];
	get(id: string): Job | undefined;
	list(): Job[];
	settle(id: string, info: SettleInfo): void;
	/** Ask the process layer to kill; the status flips when the child actually reports back. */
	kill(id: string, reason: KillReason): boolean;
	remove(id: string): boolean;
	/** Drop settled jobs older than `ttlMs`. Returns how many were dropped. */
	prune(ttlMs: number): number;
	onEvent(listener: (event: JobEvent) => void): () => void;
	clear(): void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function createJobRegistry(options: JobRegistryOptions = {}): JobRegistry {
	const now = options.now ?? (() => Date.now());
	const jobs = new Map<string, Job>();
	const listeners = new Set<(event: JobEvent) => void>();
	const killers = new Map<string, (reason: KillReason) => void>();
	const settlers = new Map<string, (info: SettleInfo) => void>();
	let nextId = 1;

	const emit = (event: JobEvent) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// A subscriber must never break the registry: the job outlives doc 132's watches.
			}
		}
	};

	const build = (record: JobRecord, ring: RingBuffer, kill: (reason: KillReason) => void): Job => {
		const settle = deferred<SettleInfo>();
		const job: Job = {
			...record,
			ring,
			exited: settle.promise,
			markDetached() {
				job.detached = true;
			},
			consumed: undefined,
			markConsumed(read) {
				// Monotonic in both directions: a stale answer (a long poll that started earlier) must
				// not move the shared read state backwards and re-arm a notice that was suppressed.
				const previous = job.consumed;
				if (previous?.terminal && !read.terminal) return;
				if (previous && cursorSeq(read.cursor) < cursorSeq(previous.cursor)) return;
				// A final result takes precedence over a progress read even if the wall clock moved back.
				if (previous && read.at < previous.at && (previous.terminal || !read.terminal)) return;
				job.consumed = { ...read };
			},
			snapshot() {
				return {
					id: job.id,
					command: job.command,
					label: job.label,
					mode: job.mode,
					status: job.status,
					reason: job.reason,
					pid: job.pid,
					startedAt: job.startedAt,
					lastOutputAt: job.lastOutputAt,
					exitedAt: job.exitedAt,
					exitCode: job.exitCode,
					killedBy: job.killedBy,
					detached: job.detached,
					outputBytes: job.outputBytes,
					outputLines: job.outputLines,
				};
			},
		};
		killers.set(job.id, kill);
		settlers.set(job.id, settle.resolve);
		ring.onCommit(() => {
			job.lastOutputAt = now();
			const stats = ring.stats();
			job.outputBytes = stats.bytes;
			job.outputLines = stats.lines;
		});
		return job;
	};

	const transition = (job: Job, status: JobStatus) => {
		job.status = status;
		job.outputBytes = job.ring.stats().bytes;
		job.outputLines = job.ring.stats().lines;
	};

	const registry: JobRegistry = {
		create(input) {
			const id = `J-${nextId++}`;
			const createdAt = now();
			const job = build(
				{
					id,
					command: input.command,
					label: input.label,
					mode: input.mode,
					status: "running",
					reason: input.reason,
					pid: input.pid,
					startedAt: createdAt,
					lastOutputAt: createdAt,
					detached: false,
					outputBytes: 0,
					outputLines: 0,
				},
				input.ring,
				input.kill,
			);
			jobs.set(id, job);
			emit({ type: "started", job: job.snapshot() });
			return job;
		},
		restore(entries) {
			const restored: Job[] = [];
			for (const { record, ring } of entries) {
				if (jobs.has(record.id)) continue;
				const status = record.status === "running" ? "orphaned" : record.status;
				const job = build({ ...record, status }, ring, () => {});
				jobs.set(record.id, job);
				// Keep the id sequence ahead of restored ids, otherwise `J-1` would be reused.
				const numeric = Number.parseInt(record.id.replace(/^J-/, ""), 10);
				if (Number.isFinite(numeric) && numeric >= nextId) nextId = numeric + 1;
				restored.push(job);
			}
			return restored;
		},
		get(id) {
			return jobs.get(id);
		},
		list() {
			return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
		},
		settle(id, info) {
			const job = jobs.get(id);
			if (job?.status !== "running") return;
			job.exitCode = info.exitCode ?? undefined;
			job.killedBy = info.killedBy;
			job.exitedAt = now();
			transition(job, info.killedBy ? "killed" : "exited");
			settlers.get(id)?.(info);
			emit({ type: "settled", job: job.snapshot() });
		},
		kill(id, reason) {
			const job = jobs.get(id);
			if (job?.status !== "running") return false;
			const killer = killers.get(id);
			if (!killer) return false;
			job.killedBy = reason;
			killer(reason);
			return true;
		},
		remove(id) {
			const job = jobs.get(id);
			if (!job || job.status === "running") return false;
			jobs.delete(id);
			killers.delete(id);
			settlers.delete(id);
			return true;
		},
		prune(ttlMs) {
			const cutoff = now() - ttlMs;
			let dropped = 0;
			for (const job of [...jobs.values()]) {
				if (job.status === "running") continue;
				const endedAt = job.exitedAt ?? job.lastOutputAt;
				if (endedAt <= cutoff && registry.remove(job.id)) dropped++;
			}
			return dropped;
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clear() {
			jobs.clear();
			killers.clear();
			settlers.clear();
		},
	};
	return registry;
}

/** Line-level output subscription — doc 132's `job` watch source hangs here (seam #1). */
export function onJobOutput(job: Job, listener: (line: string) => void): () => void {
	return job.ring.onCommit(listener);
}
