import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	fstatSync,
	openSync,
	readSync,
	type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { BashOutputSink, defaultShellPath } from "@hheei/pi-ext-core";
import type { BashExecutionLedger, BashExecutionRecord } from "./bash-ledger.js";

/** Cap on the output one running job keeps in memory; the log file holds everything. */
export const MAX_JOB_OUTPUT = 1024 * 1024;
export const BASH_IDLE_NOTICE_MS = 180_000;
export const BASH_HEARTBEAT_MS = 1_800_000;
/** Bound in UTF-8 bytes on the output of one terminal result; the log keeps the rest. */
export const MAX_BASH_TERMINAL_OUTPUT = 64 * 1024;
/** Retained terminal records whose result needs no confirmation, or was already confirmed. */
export const MAX_RETAINED_BASH_JOBS = 64;
/** Admission budget for jobs that are still running or whose result is still undelivered. */
export const MAX_PENDING_BASH_JOBS = 64;
/** Grace given to a killed tree to report its own exit before teardown stops waiting. */
const SHUTDOWN_GRACE_MS = 2_000;
/** Grace given to a shell's stdio to close after the shell itself exited. */
const STREAM_DRAIN_MS = 1_000;
/** Grace between the SIGTERM to a POSIX group and the SIGKILL to the whole tree. */
const STOP_ESCALATION_MS = 250;
/** Bounded SIGKILL attempts per stopped group, so an unkillable tree cannot hold a timer forever. */
const MAX_STOP_SWEEPS = 8;

export type BashJobStatus =
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "unknown";

export type BashTerminalStatus = Exclude<BashJobStatus, "running" | "stopping">;

export function isTerminalBashStatus(status: BashJobStatus): boolean {
	return status !== "running" && status !== "stopping";
}

export type BashJobReminderKind = "idle" | "heartbeat";

/** `recorded` proves the host appended a report, not that the model read it. */
export type BashDeliveryState = "pending" | "submitted" | "recorded";

export interface BashJobReminder {
	readonly kind: BashJobReminderKind;
	readonly job: BashJobSnapshot;
	readonly anchor?: string;
}

/**
 * Signals a whole job tree, not just its shell.
 *
 * A stopped POSIX job is a process group, so the group signal reaches every descendant. Windows has
 * no process groups: `child.kill()` terminates `cmd.exe` and orphans everything it started, which is
 * why the tree goes through `taskkill`. There is no graceful step to try first there, because
 * terminating the shell is what breaks the parent chain `taskkill` walks.
 */
function killProcessTree(pid: number): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Both the group and the shell are already gone.
			}
		}
		return;
	}
	const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
	const killer = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
		stdio: "ignore",
		detached: true,
		windowsHide: true,
	});
	// A failed spawn reports asynchronously; consume it so it cannot crash the session.
	killer.once("error", () => {});
}

/** True while any member of the shell's process group is still alive. */
function processGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// Permission errors do not prove the group disappeared; bounded cleanup must report uncertainty.
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

export interface BashJobRequest {
	/**
	 * True for background jobs: the terminal result reserves automatic delivery and the job reports
	 * idle/heartbeat reminders. Foreground calls omit it and are released when their call finishes.
	 */
	readonly background?: boolean;
	/** Branch marker captured when the command started. */
	readonly anchor?: string;
	readonly command: string;
	readonly cwd: string;
	readonly shellPath?: string;
	readonly timeoutMs?: number;
	readonly logPath?: string;
	/** Resolves this job's log file once the registry has assigned its id. */
	readonly resolveLogPath?: (id: string) => string;
	/** Real-time stream callback receiving raw output chunks. */
	readonly onData?: (data: Buffer) => void;
}

const MAX_PURPOSE_CHARS = 200;

/** One-line intent shown in terminal deliveries. */
export function bashJobPurpose(command: string): string {
	const line =
		command
			.split("\n")
			.find((candidate) => candidate.trim() !== "")
			?.trim() ?? "";
	if (line === "") return "background command";
	return line.length > MAX_PURPOSE_CHARS ? `${line.slice(0, MAX_PURPOSE_CHARS)}…` : line;
}

export interface BashJobSnapshot {
	readonly id: string;
	readonly command: string;
	readonly purpose: string;
	readonly cwd: string;
	readonly status: BashJobStatus;
	readonly exitCode: number | null;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly output: string;
	readonly truncated: boolean;
	readonly logPath?: string;
	/** True only when this registry stopped the job after its requested timeout. */
	readonly timedOut: boolean;
	readonly diagnostic?: string;
	/** Set when the log file could not be written, so the reported path is not the whole story. */
	readonly logError?: string;
	readonly anchor?: string;
}

/** One terminal result, bounded, as the delivery channel reads it. */
export interface BashTerminalEvent {
	readonly diagnostic?: string;
	readonly id: string;
	readonly purpose: string;
	readonly status: BashTerminalStatus;
	readonly output: string;
	readonly truncated: boolean;
	readonly exitCode: number | null;
	readonly logPath?: string;
	readonly logError?: string;
	readonly anchor?: string;
}

interface Job {
	id: string;
	command: string;
	purpose: string;
	cwd: string;
	status: BashJobStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt?: number | undefined;
	timedOut: boolean;
	background: boolean;
	anchor?: string | undefined;
	diagnostic?: string | undefined;
	logPath?: string | undefined;
	logStream?: WriteStream | undefined;
	logError?: string | undefined;
	process?: ChildProcess | undefined;
	/** The exit the process itself reported; both null until it does. */
	exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
	outputSink: BashOutputSink;
	restoredTruncated?: boolean;
	cleanupUnconfirmed?: boolean;
	timeout?: NodeJS.Timeout | undefined;
	/** Escalates a stop request until the whole process group is gone. */
	escalate?: NodeJS.Timeout | undefined;
	/** Resolves once the stopped group was killed and confirmed gone; teardown awaits it. */
	sweep?: Promise<void> | undefined;
	/** Cuts a shell whose stdio is held open by a descendant. */
	streamTimer?: NodeJS.Timeout | undefined;
	idleTimer?: NodeJS.Timeout | undefined;
	heartbeatTimer?: NodeJS.Timeout | undefined;
	idleNotified: boolean;
	/** Monotonic local resource lifecycle; independent of execution outcome and report delivery. */
	phase: "collecting" | "draining" | "released";
	/** The shell could not be spawned or died at spawn time; its error is the result. */
	spawnFailed: boolean;
	/** Notification bookkeeping for a terminal result; absent while the job is still active. */
	delivery?: BashDeliveryState | undefined;
	batch?: string | undefined;
	waiters: Set<(snapshot: BashJobSnapshot | undefined) => void>;
	releasers: Set<() => void>;
}

/** Keeps the last `MAX_BASH_TERMINAL_OUTPUT` UTF-8 bytes, starting on a whole character. */
function boundedTail(output: string): { output: string; truncated: boolean } {
	const bytes = Buffer.from(output, "utf8");
	if (bytes.byteLength <= MAX_BASH_TERMINAL_OUTPUT) return { output, truncated: false };
	let start = bytes.byteLength - MAX_BASH_TERMINAL_OUTPUT;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return { output: bytes.subarray(start).toString("utf8"), truncated: true };
}

function snapshot(job: Job): BashJobSnapshot {
	const raw = job.outputSink.snapshot();
	// A terminal record is bounded where it is kept: the log file still holds everything.
	const output = isTerminalBashStatus(job.status) ? boundedTail(raw.output) : raw;
	return {
		id: job.id,
		command: job.command,
		purpose: job.purpose,
		cwd: job.cwd,
		status: job.status,
		exitCode: job.exitCode,
		startedAt: job.startedAt,
		timedOut: job.timedOut,
		...(job.diagnostic === undefined ? {} : { diagnostic: job.diagnostic }),
		...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
		output: output.output,
		truncated: raw.truncated || output.truncated || job.restoredTruncated === true,
		...(job.logPath === undefined ? {} : { logPath: job.logPath }),
		...(job.logError === undefined ? {} : { logError: job.logError }),
		...(job.anchor === undefined ? {} : { anchor: job.anchor }),
	};
}

function terminalEvent(job: Job): BashTerminalEvent {
	const current = snapshot(job);
	return {
		id: current.id,
		...(current.diagnostic === undefined ? {} : { diagnostic: current.diagnostic }),
		purpose: current.purpose,
		status: current.status as BashTerminalStatus,
		output: current.output,
		truncated: current.truncated,
		exitCode: current.exitCode,
		...(current.logPath === undefined ? {} : { logPath: current.logPath }),
		...(current.logError === undefined ? {} : { logError: current.logError }),
		...(current.anchor === undefined ? {} : { anchor: current.anchor }),
	};
}

export interface BashPersistence {
	readonly ledger: BashExecutionLedger;
	readonly onError: (message: string) => void;
}

/** Recovered execution has no trustworthy exit evidence. Never inspect or signal its old PID. */
function recoverSnapshot(record: BashExecutionRecord): BashJobSnapshot {
	const saved = record.snapshot;
	if (record.settled) return saved;
	let output = saved.output;
	let logError = saved.logError;
	if (saved.logPath !== undefined) {
		try {
			const fd = openSync(saved.logPath, "r");
			try {
				const size = fstatSync(fd).size;
				const bytes = Buffer.alloc(Math.min(size, MAX_BASH_TERMINAL_OUTPUT));
				const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
				let start = 0;
				while (start < count && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
				output = bytes.subarray(start, count).toString("utf8");
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			logError = error instanceof Error ? error.message : String(error);
		}
	}
	const { endedAt: _endedAt, ...intent } = saved;
	return {
		...intent,
		status: "unknown",
		exitCode: null,
		output,
		truncated: true,
		diagnostic:
			"No reliable terminal result was recorded. Command may have run partially or may still be running. Log may be incomplete. Execution was not resumed or rerun; inspect side effects before deciding next action.",
		...(logError === undefined ? {} : { logError }),
	};
}

/**
 * Owns Bash execution and delivery state: processes, ids, logs, output tails, stop, timeout,
 * reminders, capacity and the `pending → submitted → recorded` record of terminal results.
 *
 * This is the single source of truth for background Bash. The tools read the same record they
 * started; nothing is mirrored in a second registry. Cancellation is a request: a record only
 * becomes terminal when its process reported an exit, so "we asked it to stop" and "it is gone"
 * stay separate facts, and a stop that raced a natural completion keeps the real result. A leader
 * exiting proves nothing about its descendants, so stop escalation checks the process group.
 *
 * A terminal record is released once output collection ended and its log file is closed, which is
 * what makes the log path inside a delivery point at a complete file.
 */
export class BashJobRegistry {
	readonly #jobs = new Map<string, Job>();
	readonly #terminalListeners = new Set<() => void>();
	readonly #reminderListeners = new Set<(event: BashJobReminder) => void>();
	#closed = false;
	#disposal: Promise<void> | undefined;
	readonly #tailBytes: number | undefined;
	readonly #persistence: BashPersistence | undefined;

	constructor(tailBytes?: number, persistence?: BashPersistence) {
		this.#tailBytes = tailBytes;
		this.#persistence = persistence;
		for (const saved of persistence?.ledger.load() ?? []) this.#restore(recoverSnapshot(saved));
	}

	start(request: BashJobRequest): BashJobSnapshot {
		if (this.#closed) throw new Error("Bash job registry is disposed");
		const background = request.background === true;
		if (background && this.#reservedCount() >= MAX_PENDING_BASH_JOBS)
			throw new Error(
				`Background Bash capacity is full: ${MAX_PENDING_BASH_JOBS} running or undelivered results.`,
			);
		const id = this.#nextId();
		const logPath = request.logPath ?? request.resolveLogPath?.(id);
		const job: Job = {
			id,
			command: request.command,
			purpose: bashJobPurpose(request.command),
			cwd: request.cwd,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			timedOut: false,
			background,
			idleNotified: false,
			phase: "collecting",
			spawnFailed: false,
			exit: { code: null, signal: null },
			waiters: new Set(),
			releasers: new Set(),
			...(request.anchor === undefined ? {} : { anchor: request.anchor }),
			...(logPath === undefined ? {} : { logPath }),
			outputSink: new BashOutputSink(this.#tailBytes ?? MAX_JOB_OUTPUT),
		};
		// Persist intent before opening logs or spawning: failure must prevent external execution.
		if (background) this.#persistence?.ledger.save(snapshot(job), false);
		this.#jobs.set(id, job);
		let logStream: WriteStream | undefined;
		if (logPath !== undefined) {
			try {
				logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
				job.logStream = logStream;
			} catch (error) {
				this.#noteLogFailure(job, error instanceof Error ? error.message : String(error));
			}
		}
		if (logStream !== undefined) {
			// A log that fails later stays visible: the reported path must not silently lose output.
			logStream.on("error", (error: Error) => {
				job.logStream = undefined;
				this.#noteLogFailure(job, error.message);
			});
		}

		let child: ChildProcess;
		try {
			child = spawn(
				request.shellPath ?? defaultShellPath(),
				process.platform === "win32"
					? ["/d", "/s", "/c", request.command]
					: ["-c", request.command],
				{
					cwd: request.cwd,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (error) {
			// A spawn that throws synchronously (an argument the platform rejects) never becomes a
			// process. The caller gets the reason directly, so this is not a background result: it
			// reserves no delivery and leaves no running record behind.
			job.diagnostic = error instanceof Error ? error.message : String(error);
			job.spawnFailed = true;
			this.#terminalize(job, false);
			void this.#discard(job);
			throw error;
		}
		job.process = child;
		const collect =
			(source: NodeJS.ReadableStream) =>
			(data: Buffer): void => {
				// Late output must never reach a finished sink or a released record.
				if (this.#closed || job.phase !== "collecting") return;
				job.outputSink.push(data);
				this.#resetIdleTimer(job);
				const stream = job.logStream;
				if (stream !== undefined && !stream.write(data)) {
					// Pause the source that produced it so a slow disk cannot grow memory without bound.
					source.pause();
					stream.once("drain", () => source.resume());
				}
				request.onData?.(data);
			};
		if (child.stdout) child.stdout.on("data", collect(child.stdout));
		if (child.stderr) child.stderr.on("data", collect(child.stderr));
		child.once("error", (error) => {
			// A shell that could not be spawned never reports an exit, so the error is its result.
			if (job.phase !== "collecting") return;
			job.spawnFailed = true;
			if (!this.#closed) {
				job.diagnostic = error.message;
				const note = Buffer.from(`${error.message}\n`, "utf8");
				job.outputSink.push(note);
				request.onData?.(note);
			}
			this.#terminalize(job, !this.#closed);
		});
		child.once("exit", (code, signal) => {
			this.#clearReminders(job);
			clearTimeout(job.timeout);
			job.timeout = undefined;
			// A descendant can hold stdio open long after the shell died, so the streams are cut
			// instead of leaving the record stuck between exit and close.
			if (job.phase === "collecting") {
				job.streamTimer ??= setTimeout(() => {
					job.streamTimer = undefined;
					if (job.phase !== "collecting") return;
					child.stdout?.destroy();
					child.stderr?.destroy();
					job.exit = { code, signal };
					this.#terminalize(job, !this.#closed);
				}, STREAM_DRAIN_MS);
				job.streamTimer.unref();
			}
		});
		child.once("close", (code, signal) => {
			this.#clearTimers(job);
			if (job.phase === "collecting") job.exit = { code, signal };
			this.#terminalize(job, !this.#closed);
		});
		if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
			job.timeout = setTimeout(() => {
				job.timedOut = true;
				this.stop(id);
			}, request.timeoutMs);
		}
		// Only background Bash is reminded: a foreground call already reports its own progress.
		if (job.background) {
			this.#resetIdleTimer(job);
			job.heartbeatTimer = setInterval(() => this.#remind(job, "heartbeat"), BASH_HEARTBEAT_MS);
			job.heartbeatTimer.unref();
		}
		return snapshot(job);
	}

	get(id: string): BashJobSnapshot | undefined {
		const job = this.#jobs.get(id);
		if (job !== undefined) return snapshot(job);
		if (this.#closed) return undefined;
		const saved = this.#persistence?.ledger.get(id);
		return saved === undefined ? undefined : recoverSnapshot(saved);
	}

	/**
	 * Requests cancellation and returns the record as observed at that moment.
	 *
	 * A running job becomes `stopping`; its terminal status arrives with the process exit, so a
	 * caller that needs the result waits with `waitFor` instead of reading this snapshot as final.
	 */
	stop(id: string): BashJobSnapshot | undefined {
		const job = this.#jobs.get(id);
		if (job === undefined) return undefined;
		if (!isTerminalBashStatus(job.status)) this.#requestStop(job);
		return snapshot(job);
	}

	/** Resolves with the terminal snapshot; `undefined` only when the caller's signal aborted. */
	waitFor(id: string, signal?: AbortSignal): Promise<BashJobSnapshot | undefined> {
		const job = this.#jobs.get(id);
		if (job === undefined) return Promise.resolve(undefined);
		if (job.phase === "released") return Promise.resolve(snapshot(job));
		return new Promise<BashJobSnapshot | undefined>((resolve) => {
			const finish = (value: BashJobSnapshot | undefined): void => {
				job.waiters.delete(finish);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = (): void => {
				job.waiters.delete(finish);
				resolve(undefined);
			};
			job.waiters.add(finish);
			if (signal !== undefined) {
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}
		});
	}

	list(): readonly BashJobSnapshot[] {
		return [...this.#jobs.values()].filter((job) => job.background).map(snapshot);
	}

	/** Notifies that a record was released, so delivery should re-check what is ready. */
	onTerminal(listener: () => void): () => void {
		this.#terminalListeners.add(listener);
		return () => {
			this.#terminalListeners.delete(listener);
		};
	}

	onReminder(listener: (event: BashJobReminder) => void): () => void {
		this.#reminderListeners.add(listener);
		return () => {
			this.#reminderListeners.delete(listener);
		};
	}

	/**
	 * Terminal results the parent session has not been handed yet. A record whose log is still closing
	 * is not listed: a delivery names that file as the complete output, so it waits for the flush.
	 */
	pendingDeliveries(): readonly BashTerminalEvent[] {
		const events: BashTerminalEvent[] = [];
		for (const job of this.#jobs.values()) {
			if (job.phase === "released" && job.delivery === "pending") events.push(terminalEvent(job));
		}
		return events;
	}

	/** Moves reserved results to submitted; the host accepting a message is not proof of a read. */
	markSubmitted(ids: readonly string[], batch: string): void {
		for (const id of ids) {
			const job = this.#jobs.get(id);
			if (job === undefined || job.delivery !== "pending") continue;
			job.delivery = "submitted";
			job.batch = batch;
		}
		this.#evict();
	}

	/** Confirms the host emitted the message lifecycle for one batch, releasing its reservation. */
	markRecorded(batch: string): void {
		for (const job of this.#jobs.values()) {
			if (job.delivery !== "submitted" || job.batch !== batch) continue;
			job.delivery = "recorded";
			job.batch = undefined;
		}
		this.#evict();
	}

	/** Branch receipts are facts; on tree navigation also recover evicted results and unconfirmed submissions. */
	reconcileRecorded(ids: ReadonlySet<string>, branchChanged = false): void {
		for (const saved of branchChanged ? (this.#persistence?.ledger.load() ?? []) : []) {
			if (!this.#jobs.has(saved.snapshot.id) && !ids.has(saved.snapshot.id))
				this.#restore(recoverSnapshot(saved));
		}
		for (const job of this.#jobs.values()) {
			if (!job.background || job.phase !== "released") continue;
			if (ids.has(job.id)) {
				job.delivery = "recorded";
				job.batch = undefined;
			} else if (job.delivery === "recorded" || (branchChanged && job.delivery === "submitted")) {
				job.delivery = "pending";
				job.batch = undefined;
			}
		}
		this.#evict();
	}

	/** Reverts a synchronously rejected submission so its results stay deliverable. */
	requeue(batch: string): void {
		for (const job of this.#jobs.values()) {
			if (job.delivery !== "submitted" || job.batch !== batch) continue;
			job.delivery = "pending";
			job.batch = undefined;
		}
	}

	/**
	 * Stops every owned process, waits until each one has reported its exit and flushed its log, and
	 * only then releases the records. Idempotent: repeat calls await the same settle.
	 */
	dispose(): Promise<void> {
		if (this.#disposal !== undefined) return this.#disposal;
		this.#closed = true;
		this.#terminalListeners.clear();
		this.#reminderListeners.clear();
		const jobs = [...this.#jobs.values()];
		// Every record still open gets a settle deadline: an exit that never arrives must not hang
		// session teardown, and nothing is delivered afterwards, so the record is dropped not claimed.
		for (const job of jobs) {
			if (!isTerminalBashStatus(job.status)) this.#requestStop(job);
			if (job.phase === "collecting") this.#graceTerminalize(job);
		}
		this.#disposal = Promise.all(jobs.map((job) => this.#awaitRelease(job))).then(() => {
			this.#jobs.clear();
			this.#persistence?.ledger.close();
		});
		return this.#disposal;
	}

	/** Settles a job whose process has not reported an exit within the teardown grace period. */
	#graceTerminalize(job: Job): void {
		const grace = setTimeout(() => {
			if (job.phase !== "collecting") return;
			job.cleanupUnconfirmed = true;
			job.diagnostic = "Shutdown ended without a confirmed process exit; side effects may remain.";
			job.exit = { code: null, signal: null };
			this.#terminalize(job, false);
		}, SHUTDOWN_GRACE_MS);
		grace.unref();
	}

	#awaitRelease(job: Job): Promise<void> {
		if (job.phase === "released") return Promise.resolve();
		return new Promise<void>((resolve) => {
			job.releasers.add(() => {
				resolve();
			});
		});
	}

	#restore(saved: BashJobSnapshot): void {
		const outputSink = new BashOutputSink(MAX_BASH_TERMINAL_OUTPUT);
		outputSink.push(Buffer.from(saved.output, "utf8"));
		outputSink.finish();
		this.#jobs.set(saved.id, {
			...saved,
			background: true,
			outputSink,
			restoredTruncated: saved.truncated,
			idleNotified: true,
			phase: "released",
			spawnFailed: false,
			exit: { code: saved.exitCode, signal: null },
			waiters: new Set(),
			releasers: new Set(),
			delivery: "pending",
		});
	}

	#save(job: Job, settled: boolean): void {
		if (!job.background || this.#persistence === undefined) return;
		try {
			this.#persistence.ledger.save(snapshot(job), settled);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			job.diagnostic = `Execution ledger write failed: ${message}. Recovery may have incomplete evidence; check side effects before deciding next action.`;
			this.#persistence.onError(`${job.id}: ${job.diagnostic}`);
		}
	}

	#nextId(): string {
		// Same shape as a child id: short enough for a status line, and the log file name is the id.
		// Nothing arbitrates allocation across processes, so this checks the local registry and lets
		// the per-session task directory keep restored jobs in view.
		for (let attempt = 0; attempt < 100; attempt++) {
			const id = `bash-${randomBytes(3).toString("hex")}`;
			if (!this.#jobs.has(id)) return id;
		}
		throw new Error("Could not allocate a unique bash job id");
	}

	/** Background jobs still active or lacking a recorded report on the current branch. */
	#reservedCount(): number {
		let count = 0;
		for (const job of this.#jobs.values()) {
			if (!job.background) continue;
			if (
				!isTerminalBashStatus(job.status) ||
				job.delivery === "pending" ||
				job.delivery === "submitted"
			)
				count += 1;
		}
		return count;
	}

	#requestStop(job: Job): void {
		this.#clearReminders(job);
		clearTimeout(job.timeout);
		job.timeout = undefined;
		if (job.status === "stopping") return;
		job.status = "stopping";
		this.#save(job, false);
		const child = job.process;
		const pid = child?.pid;
		if (child === undefined) {
			this.#terminalize(job, !this.#closed);
			return;
		}
		if (process.platform === "win32") {
			if (pid === undefined) child.kill();
			else killProcessTree(pid);
			return;
		}
		if (pid === undefined) {
			child.kill();
			return;
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// The group may already be gone; the shell's own exit still decides the record.
		}
		// The leader exiting proves nothing about its descendants, and a descendant that redirected its
		// stdio lets the leader close immediately. The sweep therefore runs on its own and is not
		// cancelled when the record settles; only a dead group ends it.
		job.sweep ??= this.#sweepGroup(job, pid);
	}

	/** Kills the process group until it is gone, so a stop is never claimed before the tree is dead. */
	#sweepGroup(job: Job, pid: number): Promise<void> {
		return new Promise<void>((resolve) => {
			let attempts = 0;
			const attempt = (): void => {
				job.escalate = undefined;
				if (!processGroupAlive(pid)) {
					resolve();
					return;
				}
				killProcessTree(pid);
				attempts += 1;
				// A group that survives repeated SIGKILLs is unkillable from here; stop retrying rather
				// than leave a timer running past the session that owns it.
				if (attempts >= MAX_STOP_SWEEPS) {
					job.cleanupUnconfirmed = true;
					job.diagnostic = "Process group cleanup could not be confirmed; side effects may remain.";
					resolve();
					return;
				}
				job.escalate = setTimeout(attempt, STOP_ESCALATION_MS);
				job.escalate.unref();
			};
			job.escalate = setTimeout(attempt, STOP_ESCALATION_MS);
			job.escalate.unref();
		});
	}

	#terminalize(job: Job, notify: boolean): void {
		if (job.phase !== "collecting") return;
		this.#clearTimers(job);
		this.#clearReminders(job);
		job.phase = "draining";
		const { code, signal } = job.exit;
		if (job.status === "stopping") {
			// A shell that exited on its own during a stop keeps its real result.
			job.status =
				code !== null
					? code === 0
						? "completed"
						: "failed"
					: job.timedOut
						? "timed_out"
						: "cancelled";
		} else {
			job.status =
				signal !== null ? "cancelled" : code !== null && code !== 0 ? "failed" : "completed";
		}
		// A shell that never started has no successful exit code to report.
		if (job.spawnFailed && job.status === "completed") job.status = "failed";
		job.exitCode = code;
		job.endedAt = Date.now();
		if (code === null && signal === null && !job.spawnFailed) {
			job.status = "unknown";
			job.endedAt = undefined;
			job.diagnostic ??= "No reliable process exit was observed; side effects may remain.";
		}
		try {
			job.outputSink.finish();
		} catch {
			// A sink finished by an earlier path keeps its result.
		}
		if (job.background) job.delivery = "pending";
		// The log file is the complete output a delivery points at, so the record is released only
		// after the stream closed — or was cut short, which is recorded as a log failure — and
		// any requested process-group cleanup finished.
		void Promise.all([this.#flushLogs(job), job.sweep]).then(() => {
			this.#release(job, notify);
		});
	}

	/**
	 * Closes the log stream and resolves when it really finished. A stream that does not finish in time
	 * is destroyed and its failure recorded, so a delivery never claims a complete log it does not have.
	 */
	#flushLogs(job: Job): Promise<void> {
		const stream = job.logStream;
		if (stream === undefined) return Promise.resolve();
		job.logStream = undefined;
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				job.logError ??= "log file did not finish writing";
				stream.destroy();
				finish();
			}, STREAM_DRAIN_MS);
			timer.unref();
			stream.once("finish", finish);
			stream.once("close", finish);
			stream.once("error", (error: Error) => {
				job.logError ??= error.message;
				finish();
			});
			stream.end();
		});
	}

	/** Drops a record whose failure the caller already received, once its log stream is closed. */
	#discard(job: Job): Promise<void> {
		return this.#flushLogs(job).then(() => {
			this.#jobs.delete(job.id);
		});
	}

	#release(job: Job, notify: boolean): void {
		if (job.phase === "released") return;
		if (job.cleanupUnconfirmed) {
			job.status = "unknown";
			job.endedAt = undefined;
		}
		this.#save(job, true);
		job.phase = "released";
		// Built now, so a log failure recorded during the flush is part of what waiters receive.
		const value = snapshot(job);
		for (const waiter of [...job.waiters]) waiter(value);
		job.waiters.clear();
		for (const releaser of [...job.releasers]) releaser();
		job.releasers.clear();
		if (notify) this.#announce();
		// A foreground call reports its own result inline, so its record ends with the call.
		if (!job.background) this.#jobs.delete(job.id);
		else this.#evict();
	}

	/** A log that cannot be written must not silently reduce what the reported path claims to hold. */
	#noteLogFailure(job: Job, message: string): void {
		if (job.logError !== undefined) return;
		job.logError = message;
		if (this.#closed || job.phase !== "collecting") return;
		const note = Buffer.from(`[background bash log unavailable: ${message}]\n`, "utf8");
		job.outputSink.push(note);
	}

	#announce(): void {
		for (const listener of [...this.#terminalListeners]) {
			try {
				listener();
			} catch {
				// A failing consumer must not break releasing or other consumers.
			}
		}
	}

	#remind(job: Job, kind: BashJobReminderKind): void {
		if (this.#closed || job.status !== "running") return;
		const event = {
			kind,
			job: snapshot(job),
			...(job.anchor === undefined ? {} : { anchor: job.anchor }),
		};
		for (const listener of [...this.#reminderListeners]) listener(event);
	}

	#resetIdleTimer(job: Job): void {
		if (!job.background || job.idleNotified || job.status !== "running") return;
		if (job.idleTimer !== undefined) {
			job.idleTimer.refresh();
			return;
		}
		job.idleTimer = setTimeout(() => {
			job.idleTimer = undefined;
			job.idleNotified = true;
			this.#remind(job, "idle");
		}, BASH_IDLE_NOTICE_MS);
		job.idleTimer.unref();
	}

	#clearReminders(job: Job): void {
		clearTimeout(job.idleTimer);
		clearInterval(job.heartbeatTimer);
		job.idleTimer = undefined;
		job.heartbeatTimer = undefined;
	}

	#clearTimers(job: Job): void {
		clearTimeout(job.timeout);
		clearTimeout(job.streamTimer);
		job.timeout = undefined;
		job.streamTimer = undefined;
		// The stop sweep is deliberately not cleared here: it owns the group until it is gone.
	}

	/**
	 * Keeps the retained terminal records bounded. An active job and an unconfirmed result are never
	 * evicted: a submitted message the host never confirmed may not have reached the model.
	 */
	#evict(): void {
		const candidates = [...this.#jobs.values()].filter(
			(job) =>
				job.phase === "released" && (job.delivery === undefined || job.delivery === "recorded"),
		);
		for (const job of candidates.slice(
			0,
			Math.max(0, candidates.length - MAX_RETAINED_BASH_JOBS),
		)) {
			this.#jobs.delete(job.id);
		}
	}
}
