import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The one durable file for child records, the mailbox, and delegation receipts. */
export function defaultStatePath(): string {
	return join(getAgentDir(), "pi-subagents", "state.sqlite");
}

/**
 * Bumped only when an existing ledger needs work. A ledger written by a newer version is refused
 * instead of being rewritten: this file is runtime state, but silently discarding another build's
 * records is worse than failing to start.
 */
const SCHEMA_VERSION = 4;

const TABLES = `
CREATE TABLE IF NOT EXISTS children (
  parent_session_id TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (parent_session_id, subagent_id)
);
CREATE TABLE IF NOT EXISTS session_meta (
  parent_session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (parent_session_id, key)
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owned_children (
  parent_session_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (parent_session_id, child_id)
);
CREATE TABLE IF NOT EXISTS delegations (
  parent_session_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  child_id TEXT,
  delegation_revision INTEGER,
  task TEXT NOT NULL,
  input_checkpoint TEXT,
  run_boundary INTEGER,
  control_id TEXT,
  status TEXT NOT NULL,
  delivery TEXT NOT NULL,
  result_text TEXT,
  safe_to_retry INTEGER,
  side_effects TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (parent_session_id, delegation_id)
);
`;

/**
 * Indexes are created after the column repair below, because a ledger that predates
 * `delegation_revision` cannot index it yet.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS commands_pending
  ON commands (parent_session_id, subagent_id, direction, status, created_at);
CREATE INDEX IF NOT EXISTS delegations_child
  ON delegations (parent_session_id, child_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS delegations_revision
  ON delegations (parent_session_id, child_id, delegation_revision);
`;

/**
 * Columns added to a table that already exists. `CREATE TABLE IF NOT EXISTS` leaves an older
 * table untouched, so an 11-column `delegations` would keep failing the indexes above.
 */
const ADDED_COLUMNS: readonly (readonly [table: string, column: string, type: string])[] = [
	["delegations", "delegation_revision", "INTEGER"],
	["delegations", "control_id", "TEXT"],
	["delegations", "safe_to_retry", "INTEGER"],
	["delegations", "side_effects", "TEXT"],
];

/** Columns dropped from a table that already exists, the mirror of {@link ADDED_COLUMNS}. */
const DROPPED_COLUMNS: readonly (readonly [table: string, column: string])[] = [
	["children", "revision"],
];

const connections = new Map<string, DatabaseSync>();

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return columns.some((existing) => existing.name === column);
}

function schemaVersion(db: DatabaseSync): number {
	return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

/** Brings any older ledger to {@link SCHEMA_VERSION} in place, keeping every row. */
function migrate(db: DatabaseSync): void {
	const version = schemaVersion(db);
	if (version > SCHEMA_VERSION) {
		throw new Error(
			`the subagent ledger was written by a newer version (schema ${version}); this version understands schema ${SCHEMA_VERSION}`,
		);
	}
	if (version === SCHEMA_VERSION) return;
	withWrite(db, () => {
		if (schemaVersion(db) === SCHEMA_VERSION) return;
		db.exec(TABLES);
		for (const [table, column, type] of ADDED_COLUMNS) {
			if (!hasColumn(db, table, column))
				db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
		for (const [table, column] of DROPPED_COLUMNS) {
			if (hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
		}
		// The bridge token had no reader once the mailbox replaced the socket handshake.
		db.exec("DROP TABLE IF EXISTS tokens");
		db.exec(INDEXES);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	});
}

export function openStateDb(filePath: string): DatabaseSync {
	const cached = connections.get(filePath);
	if (cached !== undefined) return cached;
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(filePath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA journal_mode = WAL");
		migrate(db);
		chmodSync(filePath, 0o600);
	} catch (error) {
		db.close();
		throw error;
	}
	connections.set(filePath, db);
	return db;
}

export function withWrite<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = run();
		db.exec("COMMIT");
		return value;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// The original error is the one the caller handles.
		}
		throw error;
	}
}

export interface StoredCommand {
	readonly id: string;
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly direction: "to_child" | "to_parent";
	readonly operation: string;
	readonly payload: string;
	readonly status: string;
	readonly result: string | null;
	readonly errorCode: string | null;
	readonly error: string | null;
}

interface CommandRow {
	id: string;
	parent_session_id: string;
	subagent_id: string;
	direction: string;
	operation: string;
	payload: string;
	status: string;
	result: string | null;
	error_code: string | null;
	error: string | null;
}

function commandFromRow(row: CommandRow): StoredCommand {
	return {
		id: row.id,
		parentSessionId: row.parent_session_id,
		subagentId: row.subagent_id,
		direction: row.direction === "to_parent" ? "to_parent" : "to_child",
		operation: row.operation,
		payload: row.payload,
		status: row.status,
		result: row.result,
		errorCode: row.error_code,
		error: row.error,
	};
}

const COMMAND_COLUMNS =
	"id, parent_session_id, subagent_id, direction, operation, payload, status, result, error_code, error";

export function insertChild(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	record: string,
): boolean {
	const result = db
		.prepare(
			`INSERT INTO children (parent_session_id, subagent_id, record)
			 VALUES (?, ?, ?)
			 ON CONFLICT DO NOTHING`,
		)
		.run(parentSessionId, subagentId, record);
	return Number(result.changes) === 1;
}

export function readChild(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
): string | undefined {
	const row = db
		.prepare("SELECT record FROM children WHERE parent_session_id = ? AND subagent_id = ?")
		.get(parentSessionId, subagentId) as { record: string } | undefined;
	return row?.record;
}

export function listChildRecords(db: DatabaseSync, parentSessionId: string): readonly string[] {
	const rows = db
		.prepare("SELECT record FROM children WHERE parent_session_id = ? ORDER BY record")
		.all(parentSessionId) as Array<{ record: string }>;
	return rows.map((row) => row.record);
}

export function replaceChild(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	record: string,
): void {
	db.prepare(
		`UPDATE children SET record = ?
		 WHERE parent_session_id = ? AND subagent_id = ?`,
	).run(record, parentSessionId, subagentId);
}

/** One child a consumer's scope owns, and the provider incarnation that recorded it. */
export interface OwnedChildRow {
	readonly childId: string;
	readonly ownerId: string;
	readonly incarnation: string;
}

/**
 * Written before a child is created and removed only after its runtime is confirmed gone, so a
 * provider that dies in between leaves evidence instead of an ordinary child nobody owns.
 */
export function insertOwnedChild(
	db: DatabaseSync,
	parentSessionId: string,
	row: OwnedChildRow,
): void {
	db.prepare(
		`INSERT INTO owned_children (parent_session_id, child_id, owner_id, incarnation, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (parent_session_id, child_id) DO UPDATE SET
		   owner_id = excluded.owner_id, incarnation = excluded.incarnation`,
	).run(parentSessionId, row.childId, row.ownerId, row.incarnation, Date.now());
}

export function deleteOwnedChild(db: DatabaseSync, parentSessionId: string, childId: string): void {
	db.prepare("DELETE FROM owned_children WHERE parent_session_id = ? AND child_id = ?").run(
		parentSessionId,
		childId,
	);
}

/** The current claim for one child, read fresh: a claim written after this provider started. */
export function readOwnedChild(
	db: DatabaseSync,
	parentSessionId: string,
	childId: string,
): OwnedChildRow | undefined {
	const row = db
		.prepare(
			"SELECT child_id, owner_id, incarnation FROM owned_children WHERE parent_session_id = ? AND child_id = ?",
		)
		.get(parentSessionId, childId) as
		| { child_id: string; owner_id: string; incarnation: string }
		| undefined;
	if (row === undefined) return undefined;
	return { childId: row.child_id, ownerId: row.owner_id, incarnation: row.incarnation };
}

export function listOwnedChildren(
	db: DatabaseSync,
	parentSessionId: string,
): readonly OwnedChildRow[] {
	const rows = db
		.prepare(
			"SELECT child_id, owner_id, incarnation FROM owned_children WHERE parent_session_id = ? ORDER BY created_at",
		)
		.all(parentSessionId) as Array<{ child_id: string; owner_id: string; incarnation: string }>;
	return rows.map((row) => ({
		childId: row.child_id,
		ownerId: row.owner_id,
		incarnation: row.incarnation,
	}));
}

export function readMeta(
	db: DatabaseSync,
	parentSessionId: string,
	key: string,
): string | undefined {
	const row = db
		.prepare("SELECT value FROM session_meta WHERE parent_session_id = ? AND key = ?")
		.get(parentSessionId, key) as { value: string } | undefined;
	return row?.value;
}

export function writeMeta(
	db: DatabaseSync,
	parentSessionId: string,
	key: string,
	value: string,
): void {
	db.prepare(
		`INSERT INTO session_meta (parent_session_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT (parent_session_id, key) DO UPDATE SET value = excluded.value`,
	).run(parentSessionId, key, value);
}

export function enqueueCommand(
	db: DatabaseSync,
	command: {
		readonly id: string;
		readonly parentSessionId: string;
		readonly subagentId: string;
		readonly direction: "to_child" | "to_parent";
		readonly operation: string;
		readonly payload: string;
		readonly createdAt: number;
	},
): void {
	db.prepare(
		`INSERT INTO commands (
		   id, parent_session_id, subagent_id, direction, operation, payload, status, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
	).run(
		command.id,
		command.parentSessionId,
		command.subagentId,
		command.direction,
		command.operation,
		command.payload,
		command.createdAt,
	);
}

export function hasPendingCommand(
	db: DatabaseSync,
	parentSessionId: string,
	direction: "to_child" | "to_parent",
	subagentId?: string,
): boolean {
	const row =
		subagentId === undefined
			? (db
					.prepare(
						`SELECT 1 AS hit FROM commands
						 WHERE parent_session_id = ? AND direction = ? AND status = 'pending'
						 LIMIT 1`,
					)
					.get(parentSessionId, direction) as { hit: number } | undefined)
			: (db
					.prepare(
						`SELECT 1 AS hit FROM commands
						 WHERE parent_session_id = ? AND subagent_id = ? AND direction = ? AND status = 'pending'
						 LIMIT 1`,
					)
					.get(parentSessionId, subagentId, direction) as { hit: number } | undefined);
	return row !== undefined;
}

export function claimCommand(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	direction: "to_child" | "to_parent",
): StoredCommand | undefined {
	const row = db
		.prepare(
			`UPDATE commands SET status = 'working'
			 WHERE id = (
			   SELECT id FROM commands
			   WHERE parent_session_id = ? AND subagent_id = ? AND direction = ? AND status = 'pending'
			   ORDER BY created_at
			   LIMIT 1
			 )
			 RETURNING ${COMMAND_COLUMNS}`,
		)
		.get(parentSessionId, subagentId, direction) as CommandRow | undefined;
	return row === undefined ? undefined : commandFromRow(row);
}

export function claimParentCommands(
	db: DatabaseSync,
	parentSessionId: string,
): readonly StoredCommand[] {
	const rows = db
		.prepare(
			`UPDATE commands SET status = 'working'
			 WHERE id IN (
			   SELECT id FROM commands
			   WHERE parent_session_id = ? AND direction = 'to_parent' AND status = 'pending'
			   ORDER BY created_at
			   LIMIT 20
			 )
			 RETURNING ${COMMAND_COLUMNS}`,
		)
		.all(parentSessionId) as unknown as CommandRow[];
	return rows.map(commandFromRow);
}

export function requeueAbandonedParentCommands(db: DatabaseSync, parentSessionId: string): void {
	db.prepare(
		`UPDATE commands SET status = 'pending'
		 WHERE parent_session_id = ? AND direction = 'to_parent' AND status = 'working'`,
	).run(parentSessionId);
}

export function deleteCommand(db: DatabaseSync, id: string): void {
	db.prepare("DELETE FROM commands WHERE id = ?").run(id);
}

export function readCommand(db: DatabaseSync, id: string): StoredCommand | undefined {
	const row = db.prepare(`SELECT ${COMMAND_COLUMNS} FROM commands WHERE id = ?`).get(id) as
		| CommandRow
		| undefined;
	return row === undefined ? undefined : commandFromRow(row);
}

export function finishCommand(
	db: DatabaseSync,
	id: string,
	outcome:
		| { readonly status: "done"; readonly result: string }
		| { readonly status: "failed"; readonly errorCode: string; readonly error: string },
): void {
	if (outcome.status === "done") {
		db.prepare("UPDATE commands SET status = 'done', result = ? WHERE id = ?").run(
			outcome.result,
			id,
		);
		return;
	}
	db.prepare("UPDATE commands SET status = 'failed', error_code = ?, error = ? WHERE id = ?").run(
		outcome.errorCode,
		outcome.error,
		id,
	);
}

/**
 * A settled command whose waiter died with its process has no reader left. Only a parent that is
 * taking over the mailbox may run this: a live waiter deletes its own row when it reads it.
 */
export function deleteSettledCommands(db: DatabaseSync, parentSessionId: string): void {
	db.prepare(
		`DELETE FROM commands
		 WHERE parent_session_id = ? AND status IN ('done', 'failed')`,
	).run(parentSessionId);
}

/**
 * Keeps only the newest `keep` queued events for one child. Events are advisory snapshots, so a
 * parent that stopped reading must not leave an unbounded backlog behind.
 */
export function trimEventBacklog(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	keep: number,
): void {
	db.prepare(
		`DELETE FROM commands WHERE id IN (
		   SELECT id FROM commands
		   WHERE parent_session_id = ? AND subagent_id = ? AND direction = 'to_parent'
		     AND operation = 'event' AND status = 'pending'
		   ORDER BY created_at DESC
		   LIMIT -1 OFFSET ?
		 )`,
	).run(parentSessionId, subagentId, keep);
}
