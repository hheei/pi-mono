import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { createSubagentOwnership, type OwnedScope, ownerLockPath } from "../src/ownership.js";
import { holdProcessLock } from "../src/process-lock.js";
import { insertOwnedChild, listOwnedChildren, openStateDb } from "../src/state-db.js";
import { withTempDir } from "./helpers/tmp-dir.js";

type ToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
type DispatchResult = "accepted" | "failed" | "uncertain" | "error" | "no-identity";

interface Dispatch {
	readonly args: Readonly<Record<string, unknown>>;
	readonly childId: string;
}

function outcome(details: unknown, isError = false): ToolOutcome {
	return {
		toolCall: { type: "toolCall", id: "call/1", name: "agents_delegate", arguments: {} },
		result: {
			content: [
				{
					type: "text",
					text: details === undefined ? "the agent is unavailable" : JSON.stringify(details),
				},
			],
			details,
		},
		isError,
	};
}

function view(childId: string, status: DispatchResult): unknown {
	return {
		id: childId,
		revision: 1,
		status,
		task: "review it",
		hasOutput: false,
		...(status === "accepted"
			? {}
			: {
					error: {
						reason: `the dispatch ended as ${status}`,
						safeToRetry: false,
						sideEffects: ["child launched"],
					},
				}),
	};
}

function temporaryStatePath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-subagents-owned-unit-")), "state.sqlite");
}

/**
 * The provider seam as the owned scope sees it: `agents_delegate` reserves the child through the
 * ownership guard before it exists, then answers with the delegation view the real tool returns.
 */
function harness(
	options: {
		readonly statePath?: string;
		/** A native `tool_call` hook: it runs between the caller and the tool and may rewrite args. */
		readonly hook?: (args: Record<string, unknown>) => void;
	} = {},
) {
	const dispatched: Dispatch[] = [];
	const stopped: string[] = [];
	let sequence = 0;
	let result: DispatchResult = "accepted";
	let stopFailure: string | undefined;
	let gate: Promise<void> | undefined;
	let openGate: () => void = () => {};
	let reached: () => void = () => {};
	let reachedGate: Promise<void> = Promise.resolve();

	const instance = createSubagentOwnership({
		parentSessionId: "session-1",
		statePath: options.statePath ?? temporaryStatePath(),
		async stop(childId, token) {
			stopped.push(`${token}:${childId}`);
			return stopFailure;
		},
	});

	const ctx = {
		async executeTool(name: string, rawArgs: unknown, signalOptions?: { signal?: AbortSignal }) {
			expect(name).toBe("agents_delegate");
			expect(signalOptions?.signal?.aborted).not.toBe(true);
			const args = { ...isArguments(rawArgs) };
			options.hook?.(args);
			// The manager takes ownership from the call's signal, not from these mutable arguments.
			const bound = instance.guard.boundOwner(signalOptions?.signal);
			const claimed = typeof args.owner === "string" ? args.owner : undefined;
			if (claimed !== undefined && claimed !== bound) {
				return outcome(
					{ id: "", revision: 0, status: "failed", error: { reason: "owner token mismatch" } },
					true,
				);
			}
			const owner = bound ?? "";
			sequence += 1;
			const childId = `child_${sequence}`;
			try {
				await instance.guard.reserve(childId, owner, String(args.agent));
			} catch (error) {
				return outcome(
					{ id: childId, revision: 1, status: "failed", error: { reason: reason(error) } },
					true,
				);
			}
			dispatched.push({ args, childId });
			if (gate !== undefined) {
				reached();
				await gate;
			}
			if (result === "error") return outcome(undefined, true);
			if (result === "no-identity") return outcome({ accepted: true });
			return outcome(view(childId, result));
		},
	} as unknown as ExtensionToolContext;

	return {
		ownership: instance,
		ctx,
		dispatched,
		stopped,
		scope(ownerId = "run_1"): OwnedScope {
			return instance.service.openScope(ownerId);
		},
		setResult(next: DispatchResult): void {
			result = next;
		},
		failStop(reason: string | undefined): void {
			stopFailure = reason;
		},
		holdDispatch(): void {
			reachedGate = new Promise<void>((resolve) => {
				reached = resolve;
			});
			gate = new Promise<void>((resolve) => {
				openGate = resolve;
			});
		},
		async dispatchReached(): Promise<void> {
			await reachedGate;
		},
		releaseDispatch(): void {
			const open = openGate;
			gate = undefined;
			open();
		},
	};
}

function isArguments(raw: unknown): Record<string, unknown> {
	return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function report(childId: string, reasonText: string, message = "done") {
	return { childId, agent: "reviewer", reason: reasonText, message };
}

describe("owned subagent scope", () => {
	test("delegates through the agent tool, and keeps the child out of other callers", async () => {
		const test1 = harness();
		const scope = test1.scope();
		const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);

		expect(handle).toMatchObject({ childId: "child_1", revision: 1 });
		expect(test1.dispatched).toHaveLength(1);
		expect(test1.dispatched[0]?.args).toMatchObject({
			agent: "reviewer",
			task: "review it",
			wait: false,
		});
		// The token names this provider incarnation, so a stale one cannot claim future work.
		const token = test1.dispatched[0]?.args.owner;
		expect(typeof token).toBe("string");
		expect(token).not.toBe("run_1");
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toContain("run_1");
		expect(test1.ownership.guard.blockReason("child_1", String(token))).toBeUndefined();
		// A token this provider never minted is refused before a child exists.
		await expect(
			test1.ownership.guard.reserve("child_x", "forged:run_1", "reviewer"),
		).rejects.toThrow(/not open in the current provider session/);
	});

	test("routes the child's report to its owner once and never to the parent", async () => {
		const test1 = harness();
		const scope = test1.scope();
		const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);
		expect(test1.ownership.guard.deliver(report("child_1", "success", "APPROVED"))).toBe(true);
		await expect(handle.settlement).resolves.toMatchObject({ status: "completed" });
		expect(test1.ownership.guard.deliver(report("child_1", "error", "late"))).toBe(true);
		await expect(handle.settlement).resolves.toMatchObject({ status: "completed" });
		expect(test1.ownership.guard.deliver(report("agent-user", "success"))).toBe(false);
	});

	test("a settled child is still stopped before its claim is dropped", async () => {
		const test1 = harness();
		const scope = test1.scope();
		const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);
		test1.ownership.guard.deliver(report("child_1", "success", "APPROVED"));

		const closed = await scope.close("review finished");
		expect(closed).toEqual({ closed: true, failures: [] });
		// A report is not proof the runtime is gone, so the stop is what ends the claim.
		expect(test1.stopped).toHaveLength(1);
		await expect(handle.settlement).resolves.toMatchObject({ status: "completed" });
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toBeUndefined();
		// A late result after the confirmed stop is consumed instead of waking the parent.
		expect(test1.ownership.guard.deliver(report("child_1", "success"))).toBe(true);
	});

	test("a dispatch that failed is not a handle, and its child is cleaned up", async () => {
		const test1 = harness();
		test1.setResult("failed");
		const scope = test1.scope();
		await expect(
			scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx),
		).rejects.toThrow(/Owned delegation failed: the dispatch ended as failed/);
		expect(test1.stopped).toHaveLength(1);
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toBeUndefined();
	});

	test("a tool error before the child exists leaves nothing to clean up", async () => {
		const test1 = harness();
		test1.setResult("error");
		const scope = test1.scope();
		await expect(
			scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx),
		).rejects.toThrow(/the agent is unavailable/);
		expect(test1.stopped).toHaveLength(1);
	});

	test("an unconfirmed cleanup keeps the child unavailable until a retried close", async () => {
		const test1 = harness();
		test1.setResult("uncertain");
		test1.failStop("process termination is not confirmed");
		const scope = test1.scope();
		await expect(
			scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx),
		).rejects.toThrow(/close\(\) retries it/);
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toContain("owned by run_1");

		// The failure is not cached: a second close tries again and then releases the child.
		expect(await scope.close("first attempt")).toEqual({
			closed: false,
			failures: ["process termination is not confirmed"],
		});
		test1.failStop(undefined);
		expect(await scope.close("retry")).toEqual({ closed: true, failures: [] });
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toBeUndefined();
		expect(test1.stopped).toHaveLength(3);
	});

	test("a close during a dispatch refuses new work and still stops the accepted child", async () => {
		const test1 = harness();
		test1.holdDispatch();
		const scope = test1.scope();
		const pending = scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);
		await test1.dispatchReached();

		const closing = scope.close("goal paused");
		// Closing blocks new work synchronously, before any stop has been awaited.
		await expect(scope.delegate({ agent: "reviewer", task: "second" }, test1.ctx)).rejects.toThrow(
			/closed/,
		);
		test1.releaseDispatch();
		await expect(pending).rejects.toThrow(/closed while delegating/);
		expect(await closing).toEqual({ closed: true, failures: [] });
		expect(test1.stopped).toHaveLength(1);
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toBeUndefined();
	});

	test("openScope returns the live scope of an owner and a new one after a confirmed close", async () => {
		const test1 = harness();
		const first = test1.scope();
		expect(test1.scope()).toBe(first);
		await first.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);
		await first.close("done");

		const second = test1.scope();
		expect(second).not.toBe(first);
		await expect(first.delegate({ agent: "reviewer", task: "again" }, test1.ctx)).rejects.toThrow(
			/closed/,
		);
		// The closed scope never touches the child of the scope that replaced it.
		await first.close("again");
		expect(test1.stopped).toHaveLength(1);
		const handle = await second.delegate({ agent: "reviewer", task: "new run" }, test1.ctx);
		expect(handle.childId).toBe("child_2");
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toBeUndefined();
	});

	test("a reused agent reaches the parent again after the owned claim is retired", async () => {
		const test1 = harness();
		const scope = test1.scope();
		await scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);
		await scope.close("review finished");
		expect(test1.ownership.guard.deliver(report("child_1", "success"))).toBe(true);
		// The human gives that same agent new work, which is what makes it an ordinary child again.
		test1.ownership.guard.dispatched("child_1");
		expect(test1.ownership.guard.deliver(report("child_1", "success"))).toBe(false);
	});

	test("dispose closes scopes and leaves the service unusable", async () => {
		const test1 = harness();
		const scope = test1.scope();
		await scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);
		test1.failStop("refused");
		expect(await test1.ownership.dispose("provider shutdown")).toEqual(["refused"]);
		expect(() => test1.ownership.service.openScope("run_2")).toThrow(/disposed/);
		await expect(scope.delegate({ agent: "reviewer", task: "again" }, test1.ctx)).rejects.toThrow(
			/closed/,
		);
	});

	test("a child whose provider died is stopped by the next incarnation instead of adopted", async () => {
		await withTempDir("pi-subagents-owned-crash-", async (directory) => {
			const statePath = join(directory, "state.sqlite");
			const crashed = harness({ statePath });
			const scope = crashed.scope();
			const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, crashed.ctx);
			crashed.failStop("the provider stopped answering");
			// A provider that exits without confirming cleanup leaves the durable claim behind.
			expect(await crashed.ownership.dispose("provider crashed")).toHaveLength(1);

			const restarted = harness({ statePath });
			const blocked = await restarted.ownership.guard.beginRecovery();
			expect([...blocked]).toEqual([handle.childId]);
			expect(restarted.ownership.guard.blockReason(handle.childId, undefined)).toContain("run_1");
			expect(await restarted.ownership.guard.reapOrphans()).toEqual([]);
			expect(restarted.stopped).toHaveLength(1);
			expect(restarted.ownership.guard.blockReason(handle.childId, undefined)).toBeUndefined();
			// Its report cannot arrive as this conversation's agent report either.
			expect(restarted.ownership.guard.deliver(report(handle.childId, "success"))).toBe(true);
			await restarted.ownership.dispose("done");
		});
	});

	test("a hook that deletes the owner argument cannot make an owned child ordinary", async () => {
		const test1 = harness({
			hook: (args) => {
				delete args.owner;
			},
		});
		const scope = test1.scope();
		const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, test1.ctx);

		// The launch is bound to the call, so the child is owned even though its arguments lost it.
		expect(test1.ownership.guard.blockReason(handle.childId, undefined)).toContain("run_1");
		expect(test1.ownership.guard.deliver(report(handle.childId, "success"))).toBe(true);
		expect(await scope.close("done")).toEqual({ closed: true, failures: [] });
		// The confirmed stop uses the scope's own token, which came from the call and not the args.
		expect(test1.stopped).toHaveLength(1);
		expect(test1.stopped[0]).toMatch(/:child_1$/);
	});

	test("a hook that invents an owner token is refused before a child exists", async () => {
		const test1 = harness({
			hook: (args) => {
				args.owner = "forged:run_1";
			},
		});
		await expect(
			test1.scope().delegate({ agent: "reviewer", task: "review it" }, test1.ctx),
		).rejects.toThrow(/failed/);
		expect(test1.dispatched).toEqual([]);
		expect(test1.stopped).toEqual([]);
		expect(test1.ownership.guard.blockReason("child_1", undefined)).toBeUndefined();
	});

	test("a claim recorded after another provider's recovery is foreign, not ordinary", async () => {
		await withTempDir("pi-subagents-owned-late-", async (directory) => {
			const statePath = join(directory, "state.sqlite");
			const first = harness({ statePath });
			// This provider finishes its recovery while the ledger is still empty.
			expect([...(await first.ownership.guard.beginRecovery())]).toEqual([]);

			// A provider that started earlier creates an owned child afterwards.
			const owner = harness({ statePath });
			const scope = owner.scope();
			const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, owner.ctx);

			// A startup snapshot says nothing about that child: the ledger is the current answer.
			expect(first.ownership.guard.foreignOwner(handle.childId)).toBe(true);
			expect(first.ownership.guard.blockReason(handle.childId, undefined)).toContain("run_1");
			expect(first.ownership.guard.deliver(report(handle.childId, "success"))).toBe(true);
			expect(first.stopped).toEqual([]);
			// A stop that never happened must not delete the evidence the live owner left.
			await first.ownership.guard.retire(handle.childId);
			expect(listOwnedChildren(openStateDb(statePath), "session-1")).toEqual([
				{ childId: handle.childId, ownerId: "run_1", incarnation: expect.any(String) },
			]);
			// The live owner still closes its own child and drops its own claim.
			expect(await scope.close("done")).toEqual({ closed: true, failures: [] });
			expect(owner.stopped).toHaveLength(1);

			// Cleanup of a dead owner still works: the row outlives the provider that wrote it.
			const crashed = harness({ statePath });
			const orphanScope = crashed.scope();
			const orphan = await orphanScope.delegate(
				{ agent: "reviewer", task: "review it" },
				crashed.ctx,
			);
			crashed.failStop("the provider stopped answering");
			expect(await crashed.ownership.dispose("provider crashed")).toHaveLength(1);
			const blocked = await first.ownership.guard.beginRecovery();
			expect([...blocked]).toEqual([orphan.childId]);
			expect(await first.ownership.guard.reapOrphans()).toEqual([]);
			expect(first.stopped).toHaveLength(1);

			expect(await first.ownership.dispose("done")).toEqual([]);
			expect(await owner.ownership.dispose("done")).toEqual([]);
		});
	});

	test("a live owner's child is never taken over", async () => {
		await withTempDir("pi-subagents-owned-live-", async (directory) => {
			const statePath = join(directory, "state.sqlite");
			const owner = harness({ statePath });
			const scope = owner.scope();
			const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, owner.ctx);

			const other = harness({ statePath });
			const blocked = await other.ownership.guard.beginRecovery();
			expect([...blocked]).toEqual([handle.childId]);
			expect(await other.ownership.guard.reapOrphans()).toEqual([]);
			expect(other.stopped).toEqual([]);
			expect(other.ownership.guard.foreignOwner(handle.childId)).toBe(true);
			expect(other.ownership.guard.blockReason(handle.childId, undefined)).toContain(
				"owned by run_1",
			);
			expect(other.ownership.guard.deliver(report(handle.childId, "success"))).toBe(true);

			expect(await other.ownership.dispose("done")).toEqual([]);
			expect(await owner.ownership.dispose("done")).toEqual([]);
		});
	});

	test("a retained foreign claim becomes an orphan once its owner is gone", async () => {
		await withTempDir("pi-subagents-owned-owner-died-", async (directory) => {
			const statePath = join(directory, "state.sqlite");
			// A live owner incarnation, held exactly as a running provider holds it.
			const ownerLock = holdProcessLock(ownerLockPath(statePath, "dying-incarnation"));
			insertOwnedChild(openStateDb(statePath), "session-1", {
				childId: "child_foreign",
				ownerId: "run_1",
				incarnation: "dying-incarnation",
			});
			const other = harness({ statePath });
			expect([...(await other.ownership.guard.beginRecovery())]).toEqual(["child_foreign"]);
			expect(other.ownership.guard.foreignOwner("child_foreign")).toBe(true);
			// While the owner is live, a recovery retry is not a takeover.
			expect([...(await other.ownership.guard.beginRecovery())]).toEqual(["child_foreign"]);
			expect(await other.ownership.guard.reapOrphans()).toEqual([]);
			expect(other.stopped).toEqual([]);
			expect(other.ownership.guard.foreignOwner("child_foreign")).toBe(true);

			// The owner dies without cleaning up. Its lock is the only evidence of that; the child
			// keeps running and keeps its own writer lock, which says nothing about the owner.
			ownerLock.release();

			// The retry re-reads the lock, adopts the row, and stops it before the child is free.
			expect([...(await other.ownership.guard.beginRecovery())]).toEqual(["child_foreign"]);
			expect(other.ownership.guard.foreignOwner("child_foreign")).toBe(false);
			expect(other.ownership.guard.blockReason("child_foreign", undefined)).toContain(
				"owned by run_1",
			);
			expect(await other.ownership.guard.reapOrphans()).toEqual([]);
			expect(other.stopped).toEqual(["dying-incarnation:run_1:child_foreign"]);
			expect(listOwnedChildren(openStateDb(statePath), "session-1")).toEqual([]);
			expect(other.ownership.guard.blockReason("child_foreign", undefined)).toBeUndefined();
			expect(await other.ownership.dispose("done")).toEqual([]);
		});
	});

	test("an owner lock that cannot be read keeps the claim foreign", async () => {
		await withTempDir("pi-subagents-owned-uncertain-", async (directory) => {
			const statePath = join(directory, "state.sqlite");
			// Not a lock any probe can open: the question "is this owner alive" has no answer.
			mkdirSync(ownerLockPath(statePath, "unreadable-incarnation"), { recursive: true });
			insertOwnedChild(openStateDb(statePath), "session-1", {
				childId: "child_uncertain",
				ownerId: "run_1",
				incarnation: "unreadable-incarnation",
			});
			const other = harness({ statePath });
			await other.ownership.guard.beginRecovery();
			// Uncertainty is not death: the claim stays foreign and nothing is stopped.
			expect(other.ownership.guard.foreignOwner("child_uncertain")).toBe(true);
			expect(await other.ownership.guard.reapOrphans()).toEqual([]);
			expect(other.stopped).toEqual([]);
			expect(listOwnedChildren(openStateDb(statePath), "session-1")).toHaveLength(1);
			expect(await other.ownership.dispose("done")).toEqual([]);
		});
	});

	test("a recovered foreign claim is dropped when its owner closes the child", async () => {
		await withTempDir("pi-subagents-owned-stale-", async (directory) => {
			const statePath = join(directory, "state.sqlite");
			const owner = harness({ statePath });
			const scope = owner.scope();
			const handle = await scope.delegate({ agent: "reviewer", task: "review it" }, owner.ctx);

			// A second live provider recovers that claim while its owner is still running.
			const other = harness({ statePath });
			expect([...(await other.ownership.guard.beginRecovery())]).toEqual([handle.childId]);
			expect(other.ownership.guard.foreignOwner(handle.childId)).toBe(true);
			expect(other.ownership.guard.deliver(report(handle.childId, "success", "owner's"))).toBe(
				true,
			);

			// The owner confirms its close and drops the row it had claimed.
			expect(await scope.close("review finished")).toEqual({ closed: true, failures: [] });
			expect(listOwnedChildren(openStateDb(statePath), "session-1")).toEqual([]);

			// The recovered claim was only a view of that row: without it, nothing is owned here.
			expect(other.ownership.guard.foreignOwner(handle.childId)).toBe(false);
			expect(other.ownership.guard.blockReason(handle.childId, undefined)).toBeUndefined();
			// The child is free again, so its next report belongs to the parent conversation.
			expect(other.ownership.guard.deliver(report(handle.childId, "success"))).toBe(false);

			expect(await other.ownership.dispose("done")).toEqual([]);
			expect(await owner.ownership.dispose("done")).toEqual([]);
		});
	});
});
