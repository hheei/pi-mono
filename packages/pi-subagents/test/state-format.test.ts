import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { openStateDb } from "../src/state-db.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const SCHEMA_VERSION = 4;

/** A ledger from before the delegation receipt gained its revision, retry and side-effect fields. */
function writeLegacyLedger(path: string): void {
	const legacy = new DatabaseSync(path);
	legacy.exec(`
		CREATE TABLE children (
			parent_session_id TEXT NOT NULL,
			subagent_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			record TEXT NOT NULL,
			PRIMARY KEY (parent_session_id, subagent_id)
		);
		INSERT INTO children VALUES ('parent-1', 'agent-1', 1, '{"state":"done"}');
		CREATE TABLE delegations (
			parent_session_id TEXT NOT NULL,
			delegation_id TEXT NOT NULL,
			child_id TEXT,
			task TEXT NOT NULL,
			input_checkpoint TEXT,
			run_boundary INTEGER,
			status TEXT NOT NULL,
			delivery TEXT NOT NULL,
			result_text TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		INSERT INTO delegations VALUES (
			'parent-1', 'dep_1', 'agent-1', 'Do the work.', NULL, 2, 'completed', 'detached', 'done', 1, 2
		);
		CREATE TABLE tokens (
			parent_session_id TEXT NOT NULL,
			runtime_identity TEXT NOT NULL,
			token TEXT NOT NULL,
			PRIMARY KEY (parent_session_id, runtime_identity)
		);
		INSERT INTO tokens VALUES ('parent-1', 'runtime-1', 'secret');
	`);
	legacy.close();
}

test("adds the columns an older ledger lacks instead of failing on its indexes", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const path = join(directory, "state.sqlite");
		writeLegacyLedger(path);

		const db = openStateDb(path);
		expect(db.prepare("PRAGMA user_version").get()).toEqual({
			user_version: SCHEMA_VERSION,
		});

		const columns = db.prepare("PRAGMA table_info(delegations)").all() as Array<{ name: string }>;
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"delegation_revision",
				"control_id",
				"safe_to_retry",
				"side_effects",
			]),
		);
		expect(
			db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'delegations_revision'").get(),
		).toBeDefined();

		// Every existing row survives the upgrade: a receipt is the record of what was dispatched.
		expect(
			db
				.prepare(
					"SELECT status, run_boundary, result_text FROM delegations WHERE delegation_id = ?",
				)
				.get("dep_1"),
		).toEqual({ status: "completed", run_boundary: 2, result_text: "done" });
		expect(
			db
				.prepare("SELECT record FROM children WHERE parent_session_id = ? AND subagent_id = ?")
				.get("parent-1", "agent-1"),
		).toEqual({ record: '{"state":"done"}' });
		// A child row no longer carries a revision column: the record itself is the whole state.
		const childColumns = db.prepare("PRAGMA table_info(children)").all() as Array<{ name: string }>;
		expect(childColumns.map((column) => column.name)).toEqual([
			"parent_session_id",
			"subagent_id",
			"record",
		]);

		// The bridge token had no reader once the mailbox replaced the socket handshake.
		expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'tokens'").get()).toBeUndefined();
		// An older ledger gains durable ownership, so a crash-window claim has somewhere to live.
		expect(
			db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'owned_children'").get(),
		).toBeDefined();

		expect(readdirSync(directory).filter((name) => name.endsWith(".previous"))).toHaveLength(0);
	});
});

test("creates a versioned state database", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const db = openStateDb(join(directory, "state.sqlite"));
		expect(db.prepare("PRAGMA user_version").get()).toEqual({
			user_version: SCHEMA_VERSION,
		});
	});
});

test("refuses a ledger written by a newer version instead of rewriting it", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const path = join(directory, "state.sqlite");
		const future = new DatabaseSync(path);
		future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		future.close();

		expect(() => openStateDb(path)).toThrow(/written by a newer version \(schema 5\)/u);
	});
});
