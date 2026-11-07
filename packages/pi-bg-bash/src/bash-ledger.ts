import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BashJobSnapshot } from "./bash-jobs.js";

/** Ledger layout version. A file written by any other version is refused, not migrated. */
const SCHEMA_VERSION = "1";
const SCHEMA_VERSION_KEY = "schema_version";
/** How long an open waits for the writer lock before it is reported as held. */
const LOCK_TIMEOUT_MS = 2_000;

/**
 * The directory one session keeps its Bash execution records and logs in.
 *
 * Records live beside the session file so a resume finds them again, and below `tasks/<sessionId>`
 * so a new or forked session never imports another session's execution ownership.
 */
export function bashExecutionDirectory(context: Pick<ExtensionContext, "sessionManager">): string {
	const sessionFile = context.sessionManager?.getSessionFile?.();
	const base = sessionFile === undefined ? join(getAgentDir(), "sessions") : dirname(sessionFile);
	return join(base, "tasks", bashSessionId(context));
}

/** The session identity Background Bash keys its records by; a missing id keeps one bucket. */
export function bashSessionId(context: Pick<ExtensionContext, "sessionManager">): string {
	return context.sessionManager?.getSessionId?.() ?? "session";
}

/** Last committed owner observation. `settled` means collection ended, not success or delivery. */
export interface BashExecutionRecord {
	readonly snapshot: BashJobSnapshot;
	readonly settled: boolean;
}

const JOB_STATUSES = [
	"running",
	"stopping",
	"completed",
	"failed",
	"cancelled",
	"timed_out",
	"unknown",
] as const;

/**
 * The persisted shape of a snapshot. Records are read back from a file, so the schema is the
 * boundary: it rejects anything this version did not write, including a newer status it cannot
 * interpret. `endedAt` stays optional: an unknown outcome has no observed end time.
 */
const SNAPSHOT_SCHEMA = Type.Object(
	{
		id: Type.String(),
		command: Type.String(),
		purpose: Type.String(),
		cwd: Type.String(),
		status: Type.Union(JOB_STATUSES.map((status) => Type.Literal(status))),
		exitCode: Type.Union([Type.Number(), Type.Null()]),
		startedAt: Type.Number(),
		endedAt: Type.Optional(Type.Number()),
		output: Type.String(),
		truncated: Type.Boolean(),
		logPath: Type.Optional(Type.String()),
		timedOut: Type.Boolean(),
		diagnostic: Type.Optional(Type.String()),
		logError: Type.Optional(Type.String()),
		anchor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const RECORD_SCHEMA = Type.Object(
	{ snapshot: SNAPSHOT_SCHEMA, settled: Type.Boolean() },
	{ additionalProperties: false },
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  settled INTEGER NOT NULL,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Durable execution records for one session, in a private SQLite file.
 *
 * Every transition commits synchronously with `synchronous = FULL`, so a record survives the parent
 * process dying at the next boundary rather than at the next checkpoint. The ledger is record-only:
 * it stores what was observed and never inspects, signals or resumes a process.
 *
 * Two writers on one session would each claim the same execution history, so the ledger holds the
 * kernel lock of a separate `<file>.lock` database for its whole lifetime. The lock is dropped by
 * the OS when this process dies, including SIGKILL, so a crash never leaves a stale owner behind.
 */
export class BashExecutionLedger {
	readonly #db: DatabaseSync;
	readonly #lock: DatabaseSync;
	#closed = false;

	constructor(filePath: string) {
		const opened = openLedger(filePath);
		this.#db = opened.db;
		this.#lock = opened.lock;
	}

	/** Every record this session persisted, in start order, including active and unsettled ones. */
	load(): readonly BashExecutionRecord[] {
		this.#assertOpen();
		const rows = this.#db
			.prepare("SELECT id, record FROM execution ORDER BY started_at, id")
			.all() as Array<{ id: string; record: string }>;
		return rows.map((row) => parseRecord(row.record, row.id));
	}

	/** One persisted record, so a record evicted from memory stays answerable. */
	get(id: string): BashExecutionRecord | undefined {
		this.#assertOpen();
		const row = this.#db.prepare("SELECT record FROM execution WHERE id = ?").get(id) as
			| { record: string }
			| undefined;
		return row === undefined ? undefined : parseRecord(row.record, id);
	}

	/** Upserts one execution fact. A failure is thrown: the caller decides how visible it must be. */
	save(snapshot: BashJobSnapshot, settled: boolean): void {
		this.#assertOpen();
		const record = { snapshot, settled };
		if (!Value.Check(RECORD_SCHEMA, record))
			throw new Error(`Execution record ${snapshot.id} does not match the ledger schema`);
		assertSettledIsTerminal(record);
		this.#db
			.prepare(
				`INSERT INTO execution (id, started_at, settled, record) VALUES (?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET settled = excluded.settled, record = excluded.record`,
			)
			.run(snapshot.id, snapshot.startedAt, settled ? 1 : 0, JSON.stringify(record));
	}

	/** Closes the file and drops the writer lock. Idempotent. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#db.close();
		} finally {
			releaseLock(this.#lock);
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Bash execution ledger is closed");
	}
}

function openLedger(filePath: string): { readonly db: DatabaseSync; readonly lock: DatabaseSync } {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const lock = holdExclusiveLock(`${filePath}.lock`);
	try {
		const db = new DatabaseSync(filePath);
		try {
			chmodSync(filePath, 0o600);
			db.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS}`);
			db.exec("PRAGMA synchronous = FULL");
			applySchema(db);
			return { db, lock };
		} catch (error) {
			db.close();
			throw error;
		}
	} catch (error) {
		// A ledger that failed to open must not keep the session's writer lock.
		releaseLock(lock);
		throw error;
	}
}

/**
 * Node has no flock(2). A dedicated SQLite database held in BEGIN EXCLUSIVE uses the kernel POSIX
 * lock, which the OS releases when the holder dies; a slow or busy open is not death, so a writer
 * that cannot take the lock within the timeout is rejected instead of sharing the file.
 */
function holdExclusiveLock(lockPath: string): DatabaseSync {
	const db = new DatabaseSync(lockPath);
	try {
		chmodSync(lockPath, 0o600);
		db.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS}`);
		db.exec("BEGIN EXCLUSIVE");
		return db;
	} catch (error) {
		db.close();
		if (isDatabaseLocked(error)) throw new BashLedgerLockedError(lockPath, error);
		throw error;
	}
}

function releaseLock(db: DatabaseSync): void {
	try {
		db.exec("ROLLBACK");
	} catch {
		// Closing the connection still drops the kernel lock.
	}
	db.close();
}

/** SQLITE_BUSY: the lock is held, which is a different failure from a broken lock file. */
function isDatabaseLocked(error: unknown): boolean {
	return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5;
}

/**
 * Another writer already holds this ledger. One session file can be mounted by two processes, so
 * this is an expected state rather than a broken file: the caller decides whether it can run on
 * without records.
 */
export class BashLedgerLockedError extends Error {
	readonly lockPath: string;

	constructor(lockPath: string, cause: unknown) {
		super(`Bash execution ledger is held by another writer: ${lockPath}`, { cause });
		this.name = "BashLedgerLockedError";
		this.lockPath = lockPath;
	}
}

function applySchema(db: DatabaseSync): void {
	const version = readSchemaVersion(db);
	if (version !== undefined && version !== SCHEMA_VERSION)
		throw new Error(
			`Bash execution ledger schema version ${version} is not supported; expected ${SCHEMA_VERSION}`,
		);
	db.exec(SCHEMA);
	if (version === undefined)
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
			SCHEMA_VERSION_KEY,
			SCHEMA_VERSION,
		);
}

function readSchemaVersion(db: DatabaseSync): string | undefined {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
		.get();
	if (table === undefined) return undefined;
	const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
		| { value: string }
		| undefined;
	return row?.value;
}

/** A stored row is untrusted file content, so it is validated before it becomes a snapshot. */
function parseRecord(text: string, id: string): BashExecutionRecord {
	let record: unknown;
	try {
		record = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`Execution record ${id} is not readable: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	// Check, never Parse: a repaired or cleaned row would hide corruption the caller must see.
	if (!Value.Check(RECORD_SCHEMA, record))
		throw new Error(`Execution record ${id} does not match the ledger schema`);
	if (record.snapshot.id !== id)
		throw new Error(`Execution record ${id} holds a snapshot for ${record.snapshot.id}`);
	assertSettledIsTerminal(record);
	return record;
}

/**
 * A settled record is evidence of a result. A snapshot that still claims to be running or stopping
 * has no process behind it after a reload, so accepting it would restore a live-looking record that
 * nothing owns and no stop could ever end.
 */
function assertSettledIsTerminal(record: BashExecutionRecord): void {
	if (!record.settled) return;
	const { status } = record.snapshot;
	if (status === "running" || status === "stopping")
		throw new Error(
			`Execution record ${record.snapshot.id} is settled but still ${status}; no result was observed`,
		);
}
