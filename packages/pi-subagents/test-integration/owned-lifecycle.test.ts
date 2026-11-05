import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
	type EffectiveLaunchConfig,
	isOperationError,
	type SubagentRecord,
} from "../src/domain.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import { SubagentManager } from "../src/manager.js";
import { createSubagentOwnership, ownerLockPath } from "../src/ownership.js";
import { processLockHeld, processLockPath } from "../src/process-lock.js";
import { createSubagentRegistry } from "../src/registry.js";
import {
	deleteOwnedChild,
	insertOwnedChild,
	listOwnedChildren,
	openStateDb,
} from "../src/state-db.js";
import { withTempDir } from "../test/helpers/tmp-dir.js";

/**
 * These cases assert what only a real process can show: an owned child whose provider died is
 * stopped through its writer lock, a live owner's child is left running, and a restarted provider
 * does not adopt either of them as an ordinary agent. The child states its own readiness through a
 * marker file, so nothing here guesses how long a process takes to boot.
 */

const PARENT_SESSION_ID = "01J7-owned-integration";

/** A real child process that holds this child's writer lock until it is killed. */
function startLockedChild(markerPath: string, lockPath: string) {
	mkdirSync(dirname(lockPath), { recursive: true });
	const script = `
const { DatabaseSync } = require("node:sqlite");
const { writeFileSync } = require("node:fs");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN EXCLUSIVE");
writeFileSync(process.argv[2], "");
setInterval(() => {}, 1000);
`;
	const child = spawn(process.execPath, ["-e", script, lockPath, markerPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return child;
}

/** The child writes its marker only after its lock is held, so the marker is the readiness event. */
function waitForFile(filePath: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 30_000;
		const poll = (): void => {
			if (existsSync(filePath)) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`the child never wrote ${filePath}`));
				return;
			}
			setTimeout(poll, 20);
		};
		poll();
	});
}

function launchConfig(id: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId: id,
		invocation: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
		cwd,
		sessionId: `${id}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "reviewer",
			hidden: false,
			sourcePath: join(cwd, "reviewer.md"),
			instructions: "Review the change.",
		},
		model: { provider: "anthropic", id: "claude-sonnet-4", source: "parent" },
		thinking: { level: "medium", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: ["/pkg/dist/extension.js"] },
		skills: { discovery: true, paths: [] },
		mcp: { enabled: true },
		prompt: assembleChildPrompt("Review the change."),
		bridgeExtensionPath: "/pkg/dist/extension.js",
	};
}

function ownedRecord(id: string, cwd: string, pid: number): SubagentRecord {
	const config = launchConfig(id, cwd);
	return {
		subagentId: id,
		parentSessionId: PARENT_SESSION_ID,
		revision: 1,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		sessionId: config.sessionId,
		cwd,
		initialTask: "Review the change.",
		intent: "active",
		state: "running",
		presentation: "background",
		persistence: "never_flushed",
		launchConfig: config,
		runtime: {
			runtimeIdentity: "runtime-earlier",
			endpoint: "/tmp/earlier.sock",
			attachment: { kind: "process", pid },
		},
	};
}

function unconnectedBridge(): ConstructorParameters<typeof SubagentManager>[0]["bridge"] {
	return {
		isConnected: () => false,
		disconnect: () => {},
		request: async () => {
			throw new Error("no bridge in this integration case");
		},
		onEvent: () => () => {},
		onConnectionChange: () => () => {},
	};
}

function providerManager(
	filePath: string,
	ownership: ConstructorParameters<typeof SubagentManager>[0]["ownership"],
): SubagentManager {
	const registry = createSubagentRegistry({ parentSessionId: PARENT_SESSION_ID, filePath });
	return new SubagentManager({
		parentSessionId: PARENT_SESSION_ID,
		registry,
		bridge: unconnectedBridge(),
		...(ownership === undefined ? {} : { ownership }),
		async launch() {
			throw new Error("this provider never launches in these cases");
		},
		async connect() {
			return false;
		},
		async resolve() {
			throw new Error("this provider never resolves a launch in these cases");
		},
		async bootstrap() {
			throw new Error("this provider never spawns in these cases");
		},
		channel: {
			async deliver() {
				throw new Error("an owned child must not report to the parent conversation");
			},
		},
		deadlineMs: 5_000,
	});
}

test("a restarted provider stops the owned child its dead owner left behind", async () => {
	await withTempDir("pi-subagents-owned-restart-", async (directory) => {
		const filePath = join(directory, "state.sqlite");
		const childId = "agent-owned";
		const marker = join(directory, "ready");
		const lockPath = processLockPath(filePath, PARENT_SESSION_ID, childId);
		if (lockPath === undefined) throw new Error("lock path");
		const child = startLockedChild(marker, lockPath);
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath,
		});
		const bound: { manager?: SubagentManager } = {};
		const ownership = createSubagentOwnership({
			parentSessionId: PARENT_SESSION_ID,
			statePath: filePath,
			async stop(id) {
				const manager = bound.manager;
				if (manager === undefined) throw new Error("manager is not bound");
				const stopped = await manager.stop(id);
				return "reason" in stopped ? `${id}: ${stopped.reason}` : undefined;
			},
		});
		try {
			await waitForFile(marker);
			expect(processLockHeld(lockPath)).toBe(true);
			await registry.create(ownedRecord(childId, directory, child.pid ?? 0));
			// The claim belongs to a provider incarnation nobody holds a lock for any more.
			insertOwnedChild(openStateDb(filePath), PARENT_SESSION_ID, {
				childId,
				ownerId: "run_1",
				incarnation: "dead-incarnation",
			});

			// A stop that could not be confirmed would surface here instead of as a silent release.
			expect(await ownership.guard.beginRecovery()).toEqual(new Set([childId]));
			const manager = providerManager(filePath, ownership.guard);
			bound.manager = manager;
			// beginRecovery already ran, and the manager memoizes its own reconcile, so the reap is
			// driven through the same public entry the extension uses.
			const ready = await manager.ready();
			if (!ready.ok) throw new Error("recovery failed");
			// The orphan was reaped, so its writer lock is free and the process is gone.
			expect(ready.ownedFailures).toBeUndefined();
			expect(processLockHeld(lockPath)).toBe(false);
			expect(await registry.get(childId)).toMatchObject({ intent: "stopped", state: "done" });
			expect(listOwnedChildren(openStateDb(filePath), PARENT_SESSION_ID)).toEqual([]);

			// A second provider start finds neither a claim nor a running child to adopt.
			const restarted = createSubagentOwnership({
				parentSessionId: PARENT_SESSION_ID,
				statePath: filePath,
				stop: async () => {
					throw new Error("nothing is owned any more");
				},
			});
			const second = providerManager(filePath, restarted.guard);
			const again = await second.ready();
			if (!again.ok) throw new Error("recovery failed");
			expect(again.ownedFailures).toBeUndefined();
			expect(await registry.get(childId)).toMatchObject({ intent: "stopped" });
			await restarted.dispose("done");
		} finally {
			child.kill("SIGKILL");
			await ownership.dispose("test teardown");
		}
	});
});

test("a live owner keeps its child running while another provider starts", async () => {
	await withTempDir("pi-subagents-owned-live-", async (directory) => {
		const filePath = join(directory, "state.sqlite");
		const childId = "agent-owned-live";
		const marker = join(directory, "ready");
		const lockPath = processLockPath(filePath, PARENT_SESSION_ID, childId);
		if (lockPath === undefined) throw new Error("lock path");
		const child = startLockedChild(marker, lockPath);
		// A live provider incarnation, held exactly as a running provider holds it.
		const ownerMarker = join(directory, "owner-ready");
		const ownerIncarnation = "live-incarnation";
		const ownerLock = ownerLockPath(filePath, ownerIncarnation);
		const owner = startLockedChild(ownerMarker, ownerLock);
		const registry = createSubagentRegistry({ parentSessionId: PARENT_SESSION_ID, filePath });
		try {
			await Promise.all([waitForFile(marker), waitForFile(ownerMarker)]);
			await registry.create(ownedRecord(childId, directory, child.pid ?? 0));
			insertOwnedChild(openStateDb(filePath), PARENT_SESSION_ID, {
				childId,
				ownerId: "run_1",
				incarnation: ownerIncarnation,
			});

			const ownership = createSubagentOwnership({
				parentSessionId: PARENT_SESSION_ID,
				statePath: filePath,
				stop: async () => {
					throw new Error("a live owner's child must not be stopped by another provider");
				},
			});
			const manager = providerManager(filePath, ownership.guard);
			try {
				const ready = await manager.ready();
				if (!ready.ok) throw new Error("recovery failed");
				expect(ready.ownedFailures).toBeUndefined();
				// The child and the live owner's lock are both untouched.
				expect(processLockHeld(lockPath)).toBe(true);
				expect(child.exitCode).toBeNull();
				expect(await registry.get(childId)).toMatchObject({
					intent: "active",
					state: "running",
				});
				expect(listOwnedChildren(openStateDb(filePath), PARENT_SESSION_ID)).toHaveLength(1);
				expect(ownership.guard.foreignOwner(childId)).toBe(true);

				// The live owner stops the child, confirms it, and removes the row it claimed.
				deleteOwnedChild(openStateDb(filePath), PARENT_SESSION_ID, childId);
				owner.kill("SIGKILL");
				const released = Date.now() + 10_000;
				while (processLockHeld(ownerLock)) {
					if (Date.now() >= released) throw new Error("the dead owner's lock never freed");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				// The recovered claim was only a view of that row: without it the child is ordinary,
				// so its next report reaches the parent conversation instead of being consumed.
				expect(ownership.guard.foreignOwner(childId)).toBe(false);
				expect(ownership.guard.blockReason(childId, undefined)).toBeUndefined();
				expect(
					ownership.guard.deliver({
						childId,
						agent: "reviewer",
						reason: "success",
						message: "again",
					}),
				).toBe(false);
				// A scope that never owned it cannot end it either.
				expect(await ownership.service.openScope("run_other").close("unrelated")).toEqual({
					closed: true,
					failures: [],
				});
				expect(child.exitCode).toBeNull();
				// Ending it for real is this provider's again: the stop is confirmed and the child dies.
				expect(await manager.stop(childId)).toMatchObject({ id: childId });
				expect(await registry.get(childId)).toMatchObject({ intent: "stopped" });
			} finally {
				await ownership.dispose("done");
			}
		} finally {
			child.kill("SIGKILL");
			owner.kill("SIGKILL");
		}
	});
});

test("a recovery retry reaps a live owner's child after that owner dies", async () => {
	await withTempDir("pi-subagents-owned-owner-died-", async (directory) => {
		const filePath = join(directory, "state.sqlite");
		const childId = "agent-owned-owner-died";
		const marker = join(directory, "ready");
		const lockPath = processLockPath(filePath, PARENT_SESSION_ID, childId);
		if (lockPath === undefined) throw new Error("lock path");
		const child = startLockedChild(marker, lockPath);
		const ownerMarker = join(directory, "owner-ready");
		const ownerIncarnation = "dying-incarnation";
		const ownerLock = ownerLockPath(filePath, ownerIncarnation);
		const owner = startLockedChild(ownerMarker, ownerLock);
		const registry = createSubagentRegistry({ parentSessionId: PARENT_SESSION_ID, filePath });
		const stopped: string[] = [];
		let manager: SubagentManager | undefined;
		const ownership = createSubagentOwnership({
			parentSessionId: PARENT_SESSION_ID,
			statePath: filePath,
			async stop(id) {
				stopped.push(id);
				if (manager === undefined) throw new Error("this provider has no manager yet");
				const result = await manager.stop(id);
				return isOperationError(result) ? result.reason : undefined;
			},
		});
		try {
			await Promise.all([waitForFile(marker), waitForFile(ownerMarker)]);
			await registry.create(ownedRecord(childId, directory, child.pid ?? 0));
			insertOwnedChild(openStateDb(filePath), PARENT_SESSION_ID, {
				childId,
				ownerId: "run_1",
				incarnation: ownerIncarnation,
			});
			manager = providerManager(filePath, ownership.guard);
			const ready = await manager.ready();
			if (!ready.ok) throw new Error("recovery failed");
			expect(ready.ownedFailures).toBeUndefined();

			// While that owner is live, neither a recovery retry nor a stop is a takeover of the
			// child, even though the child holds its own writer lock the whole time.
			expect(ownership.guard.foreignOwner(childId)).toBe(true);
			expect(await ownership.guard.reapOrphans()).toEqual([]);
			expect(stopped).toEqual([]);
			expect(processLockHeld(lockPath)).toBe(true);
			expect(child.signalCode).toBeNull();
			expect(await manager.stop(childId)).toMatchObject({
				operation: "stop",
				reason: expect.stringContaining("live"),
			});

			// The owner dies without cleaning up, while its child keeps running.
			owner.kill("SIGKILL");
			const released = Date.now() + 10_000;
			while (processLockHeld(ownerLock)) {
				if (Date.now() >= released) throw new Error("the dead owner's lock never freed");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			// The child is an orphan now: still unavailable, never an ordinary delegated agent.
			expect(ownership.guard.blockReason(childId, undefined)).toContain("run_1");
			// The retry re-reads the owner lock and reaps it through the confirmed stop path.
			await ownership.guard.beginRecovery();
			expect(await ownership.guard.reapOrphans()).toEqual([]);
			expect(stopped).toEqual([childId]);
			// The confirmed stop ended the real process: its writer lock is free because it is gone.
			const ended = Date.now() + 10_000;
			while (processLockHeld(lockPath)) {
				if (Date.now() >= ended) throw new Error("the orphaned child never exited");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(child.signalCode ?? child.exitCode).not.toBeNull();
			expect(await registry.get(childId)).toMatchObject({ intent: "stopped" });
			expect(listOwnedChildren(openStateDb(filePath), PARENT_SESSION_ID)).toEqual([]);
			expect(ownership.guard.blockReason(childId, undefined)).toBeUndefined();
		} finally {
			child.kill("SIGKILL");
			owner.kill("SIGKILL");
			await ownership.dispose("done");
		}
	});
});

test("a claim written after another provider's recovery still protects its live owner", async () => {
	await withTempDir("pi-subagents-owned-late-", async (directory) => {
		const filePath = join(directory, "state.sqlite");
		const childId = "agent-owned-late";
		const marker = join(directory, "ready");
		const lockPath = processLockPath(filePath, PARENT_SESSION_ID, childId);
		if (lockPath === undefined) throw new Error("lock path");
		const child = startLockedChild(marker, lockPath);
		const ownerMarker = join(directory, "owner-ready");
		const ownerIncarnation = "late-incarnation";
		const owner = startLockedChild(ownerMarker, ownerLockPath(filePath, ownerIncarnation));
		const registry = createSubagentRegistry({ parentSessionId: PARENT_SESSION_ID, filePath });
		const stopped: string[] = [];
		const ownership = createSubagentOwnership({
			parentSessionId: PARENT_SESSION_ID,
			statePath: filePath,
			async stop(id) {
				stopped.push(id);
				return undefined;
			},
		});
		try {
			await Promise.all([waitForFile(marker), waitForFile(ownerMarker)]);
			await registry.create(ownedRecord(childId, directory, child.pid ?? 0));
			const manager = providerManager(filePath, ownership.guard);
			// This provider finishes its recovery while the ledger holds no claim at all.
			const ready = await manager.ready();
			if (!ready.ok) throw new Error("recovery failed");
			expect(await ownership.guard.beginRecovery()).toEqual(new Set());

			// The other provider claims the child afterwards, while its own lock is held.
			insertOwnedChild(openStateDb(filePath), PARENT_SESSION_ID, {
				childId,
				ownerId: "run_1",
				incarnation: ownerIncarnation,
			});

			// The ledger is the current answer: this is not a free child to stop or reuse.
			expect(ownership.guard.foreignOwner(childId)).toBe(true);
			expect(ownership.guard.blockReason(childId, undefined)).toContain("run_1");
			const refused = await manager.stop(childId);
			expect(refused).toMatchObject({ operation: "stop", reason: expect.stringContaining("live") });
			expect(stopped).toEqual([]);
			expect(processLockHeld(lockPath)).toBe(true);
			expect(child.exitCode).toBeNull();
			// Recovery already settled its own view of the record; the intent is what stop decides on.
			expect(await registry.get(childId)).toMatchObject({ intent: "active" });
			expect(listOwnedChildren(openStateDb(filePath), PARENT_SESSION_ID)).toHaveLength(1);

			// Once that owner is gone, its claim is stale evidence and cleanup applies again.
			owner.kill("SIGKILL");
			await waitForFile(ownerMarker);
			const deadline = Date.now() + 10_000;
			while (processLockHeld(ownerLockPath(filePath, ownerIncarnation))) {
				if (Date.now() >= deadline) throw new Error("the dead owner's lock never freed");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(ownership.guard.foreignOwner(childId)).toBe(false);
			const cleaned = await manager.stop(childId);
			expect(cleaned).toMatchObject({ id: childId });
			expect(await registry.get(childId)).toMatchObject({ intent: "stopped" });
			expect(stopped).toEqual([]);
			// With the owner gone, the confirmed stop drops the claim it left behind.
			expect(listOwnedChildren(openStateDb(filePath), PARENT_SESSION_ID)).toEqual([]);
		} finally {
			child.kill("SIGKILL");
			owner.kill("SIGKILL");
			await ownership.dispose("done");
		}
	});
});
