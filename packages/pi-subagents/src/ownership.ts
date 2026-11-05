import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createServiceKey, errorMessage, isRecord } from "@hheei/pi-ext-core";
import { holdProcessLock, type ProcessLock, processLockHeld } from "./process-lock.js";
import {
	deleteOwnedChild,
	insertOwnedChild,
	listOwnedChildren,
	openStateDb,
	readOwnedChild,
} from "./state-db.js";

/**
 * An owned delegation is one turn a consumer starts and must be able to end. The provider keeps
 * three facts about it: the child is claimed durably before it is created, the consumer waits on a
 * settlement that never reaches the parent conversation, and the claim is dropped only after a
 * confirmed stop. A provider that dies first leaves the claim behind, so the next incarnation stops
 * that child instead of adopting it as an ordinary one.
 */
export type OwnedChildStatus = "completed" | "blocked" | "failed" | "stopped";

export interface OwnedChildSettlement {
	readonly childId: string;
	readonly agent: string;
	readonly status: OwnedChildStatus;
	readonly message: string;
}

export interface OwnedDelegationRequest {
	/** Agent definition name; an owned scope always creates a new child. */
	readonly agent: string;
	readonly task: string;
}

export interface OwnedChildHandle {
	readonly childId: string;
	/** Delegation revision this scope reserved for the child; it identifies this dispatch. */
	readonly revision: number;
	/** Resolves once, with the child's own report or with `stopped` after a confirmed stop. */
	readonly settlement: Promise<OwnedChildSettlement>;
}

export interface OwnedScopeClose {
	/** True only when every child of this scope was confirmed stopped or already settled and gone. */
	readonly closed: boolean;
	readonly failures: readonly string[];
}

export interface OwnedScope {
	readonly ownerId: string;
	/**
	 * Runs one owned turn through the `agents_delegate` tool, so validation, hooks and permissions
	 * apply exactly as they do to a model-issued call. `ctx` is the calling tool's context; it is
	 * used for that dispatch and never retained. An owned turn always creates a new child: it never
	 * claims one that already exists.
	 */
	delegate(
		request: OwnedDelegationRequest,
		ctx: ExtensionToolContext,
		signal?: AbortSignal,
	): Promise<OwnedChildHandle>;
	/**
	 * Idempotent and retryable: sets the scope closed synchronously, stops every child it owns, and
	 * keeps whatever it could not confirm. A retried close tries those again; a close that already
	 * succeeded is final.
	 */
	close(reason: string): Promise<OwnedScopeClose>;
}

export interface SubagentOwnershipService {
	/**
	 * The scope of this owner. An owner whose children are still live or not yet cleaned gets that
	 * same scope back, so opening it again cannot start a second scope under one identity.
	 */
	openScope(ownerId: string): OwnedScope;
}

/** Immediate capability lookup for consumers; it never waits for the provider to appear. */
export const SUBAGENT_OWNERSHIP_SERVICE = createServiceKey<SubagentOwnershipService>(
	"@hheei/pi-subagents:ownership",
);

/** The report shape the manager routes to its parent channel. */
export interface OwnershipReport {
	readonly childId: string;
	readonly agent: string;
	readonly reason: string;
	readonly message: string;
}

/**
 * Manager-side ownership seam. Reservation is durable and happens before a child is created;
 * release happens only after its runtime is confirmed gone.
 */
export interface OwnershipGuard {
	/** Claims the child for `token`; refuses an unknown, closed, or foreign scope. */
	reserve(childId: string, token: string, agent: string): Promise<void>;
	/** A dispatch by someone other than the owner ends what a released claim still suppresses. */
	dispatched(childId: string): void;
	/** A stop this provider confirmed: the owner's wait ends and the claim stops blocking reuse. */
	retire(childId: string): Promise<void>;
	/** Refusal text for a delegation or steer that would reuse an owned child. */
	blockReason(childId: string, token: string | undefined): string | undefined;
	/** True when another live provider incarnation owns this child; this one must not take it over. */
	foreignOwner(childId: string): boolean;
	/**
	 * The owned scope bound to a delegation call, read from the call's signal. Ownership is bound to
	 * the dispatch itself, so a `tool_call` hook that rewrites the tool arguments can neither drop
	 * an owner nor invent one.
	 */
	boundOwner(signal: AbortSignal | undefined): string | undefined;
	/** Consumes an owned child's report; false means it belongs to the parent conversation. */
	deliver(report: OwnershipReport): boolean;
	/** Claims left by earlier provider incarnations, which this one must not adopt as ordinary. */
	beginRecovery(): Promise<ReadonlySet<string>>;
	/** Stops the orphaned children of those claims; keeps every child it cannot confirm. */
	reapOrphans(): Promise<readonly string[]>;
}

export interface SubagentOwnershipDeps {
	readonly parentSessionId: string;
	/** The ledger file of this provider session; claims and owner locks live beside it. */
	readonly statePath: string;
	/** Stops one owned child: a reason means it is not confirmed gone, `undefined` means it is. */
	readonly stop: (childId: string, token: string) => Promise<string | undefined>;
}

/**
 * The liveness of one provider incarnation: a lock in the owner namespace that the incarnation
 * holds for its whole life. A child's own writer lock cannot answer this question, and a recorded
 * incarnation whose lock is free is evidence of a provider that will never clean up again.
 */
export function ownerLockPath(statePath: string, incarnation: string): string {
	return join(dirname(statePath), "locks", "owners", `${incarnation}.lock`);
}

/** What a tool call returns across the nested-call seam, read as untrusted data. */
type ToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

type ClaimState = "owned" | "released" | "foreign";

/**
 * Owner tokens bound to the signal of one dispatched tool call. The signal crosses the native
 * pipeline unchanged, while the arguments do not: a hook may rewrite them.
 */
const dispatchOwners = new WeakMap<AbortSignal, string>();

interface Claim {
	readonly childId: string;
	readonly ownerId: string;
	readonly token: string;
	readonly agent: string;
	state: ClaimState;
	settled: boolean;
	readonly settlement: Promise<OwnedChildSettlement>;
	resolve(settlement: OwnedChildSettlement): void;
}

interface ScopeState {
	readonly ownerId: string;
	readonly token: string;
	readonly scope: OwnedScope;
	/** Children this scope claimed, in dispatch order. */
	readonly children: Set<string>;
	/** Owned turns run one at a time, so a failed dispatch knows exactly which child it created. */
	queue: Promise<void>;
	closed: boolean;
	closing: Promise<OwnedScopeClose> | undefined;
}

function settlementStatus(reason: string): OwnedChildStatus {
	return reason === "success" ? "completed" : reason === "blocked" ? "blocked" : "failed";
}

function createClaim(
	childId: string,
	ownerId: string,
	token: string,
	agent: string,
	state: ClaimState,
): Claim {
	let resolve: (settlement: OwnedChildSettlement) => void = () => {};
	const settlement = new Promise<OwnedChildSettlement>((done) => {
		resolve = done;
	});
	return { childId, ownerId, token, agent, state, settled: false, settlement, resolve };
}

function settle(claim: Claim, status: OwnedChildStatus, message: string): void {
	if (claim.settled) return;
	claim.settled = true;
	claim.resolve({ childId: claim.childId, agent: claim.agent, status, message });
}

/** The accepted delegation a tool result carries, read as untrusted data because it crosses a seam. */
interface OwnedView {
	readonly id: string;
	readonly revision: number;
	readonly status: string;
	readonly reason?: string;
}

function ownedView(outcome: ToolOutcome): OwnedView | undefined {
	const details: unknown = outcome.result.details;
	if (!isRecord(details)) return undefined;
	const { id, revision, status, error } = details;
	if (
		typeof id !== "string" ||
		id === "" ||
		typeof revision !== "number" ||
		typeof status !== "string"
	) {
		return undefined;
	}
	const reason = isRecord(error) && typeof error.reason === "string" ? error.reason : undefined;
	return { id, revision, status, ...(reason === undefined ? {} : { reason }) };
}

function resultText(outcome: ToolOutcome): string {
	const content: unknown = outcome.result.content;
	if (!Array.isArray(content)) return "the delegation tool failed";
	const text = content
		.filter((part): part is { type: "text"; text: string } => {
			return isRecord(part) && part.type === "text" && typeof part.text === "string";
		})
		.map((part) => part.text)
		.join(" ");
	return text === "" ? "the delegation tool failed" : text;
}

const DELEGATE_TOOL = "agents_delegate";

/**
 * One provider-session ownership registry. Scopes and claims are in memory; the durable rows are
 * what let the next incarnation find and stop work whose owner died without cleaning up.
 */
export function createSubagentOwnership(deps: SubagentOwnershipDeps): {
	readonly guard: OwnershipGuard;
	readonly service: SubagentOwnershipService;
	/** Closes every open scope with `reason`; failures are reported instead of swallowed. */
	dispose(reason: string): Promise<readonly string[]>;
} {
	const incarnation = randomBytes(8).toString("hex");
	const db = openStateDb(deps.statePath);
	/** Held for the life of this provider incarnation; a free lock is what proves it is gone. */
	const ownerLock: ProcessLock = holdProcessLock(ownerLockPath(deps.statePath, incarnation));
	const scopes = new Map<string, ScopeState>();
	const scopeByToken = new Map<string, ScopeState>();
	const claims = new Map<string, Claim>();
	/** Children of earlier incarnations, held until a reap confirms or reports them. */
	const orphans = new Map<string, string>();
	let disposed = false;

	const retire = async (childId: string, message: string): Promise<void> => {
		const claim = claims.get(childId);
		if (claim !== undefined) {
			settle(claim, "stopped", message);
			claim.state = "released";
		}
		// Only a claim this provider holds, or one whose owner is gone, is dropped: a live other
		// provider's row is its evidence that the child is owned and it is nobody else's to delete.
		const row = readOwnedChild(db, deps.parentSessionId, childId);
		if (
			row === undefined ||
			row.incarnation === incarnation ||
			!ownerLockHeld(deps.statePath, row.incarnation)
		) {
			deleteOwnedChild(db, deps.parentSessionId, childId);
		}
	};

	/** A claim this provider does not hold, read from the ledger as it stands right now. */
	const durableForeign = (childId: string): boolean => {
		const row = readOwnedChild(db, deps.parentSessionId, childId);
		if (row === undefined) return false;
		return row.incarnation !== incarnation && ownerLockHeld(deps.statePath, row.incarnation);
	};

	/**
	 * The claim as it stands now, re-read against the ledger and the owner's own lock. A foreign
	 * claim is only this provider's view of another incarnation's durable row, so:
	 *
	 * - the row is gone: the view is stale, and keeping it would refuse reuse of a child nobody
	 *   owns and swallow a report that belongs to the parent conversation again;
	 * - the row is there but its owner lock is free: that owner will never clean up again, so the
	 *   row becomes an orphan this provider adopts and stops before the child is free again;
	 * - the owner lock is held or unreadable: the owner may be live, so the claim stays foreign.
	 *   A child's own writer lock is never proof of the owner: the child keeps running after it.
	 *
	 * A claim this provider owns, adopted, or stopped is returned untouched: its cleanup and its
	 * suppression are its own, even when the row disappears underneath it.
	 */
	const currentClaim = (childId: string): Claim | undefined => {
		const claim = claims.get(childId);
		if (claim === undefined || claim.state === "released") return claim;
		const row = readOwnedChild(db, deps.parentSessionId, childId);
		if (row === undefined) {
			if (claim.state !== "foreign") return claim;
			claims.delete(childId);
			return undefined;
		}
		if (claim.state === "foreign" && !ownerLockHeld(deps.statePath, row.incarnation)) {
			claim.state = "owned";
			orphans.set(childId, claim.token);
		}
		return claim;
	};

	const stopConfirmed = async (childId: string, token: string): Promise<string | undefined> => {
		try {
			return await deps.stop(childId, token);
		} catch (error) {
			return `${childId}: ${errorMessage(error)}`;
		}
	};

	const guard: OwnershipGuard = {
		async reserve(childId, token, agent) {
			const scope = scopeByToken.get(token);
			if (scope === undefined) {
				throw new Error("This owned scope is not open in the current provider session");
			}
			if (scope.closed) throw new Error(`Owned scope ${scope.ownerId} is closed`);
			if (claims.has(childId) || readOwnedChild(db, deps.parentSessionId, childId) !== undefined) {
				throw new Error(`Agent ${childId} is already owned`);
			}
			// Durable before the child exists: a crash between here and the launch leaves a claim
			// that the next incarnation can find, stop, and never mistake for an ordinary child.
			insertOwnedChild(db, deps.parentSessionId, {
				childId,
				ownerId: scope.ownerId,
				incarnation,
			});
			const claim = createClaim(childId, scope.ownerId, token, agent, "owned");
			claims.set(childId, claim);
			scope.children.add(childId);
		},
		dispatched(childId) {
			if (claims.get(childId)?.state !== "released") return;
			claims.delete(childId);
			for (const scope of scopes.values()) scope.children.delete(childId);
		},
		retire(childId) {
			return retire(childId, "Stopped");
		},
		blockReason(childId, token) {
			const claim = currentClaim(childId);
			// The ledger is the current answer: a provider that started later can own a child this
			// one never saw at recovery, so a startup snapshot is not evidence of anything.
			const row = readOwnedChild(db, deps.parentSessionId, childId);
			if (row === undefined) {
				if (claim === undefined || claim.state === "released" || claim.token === token) {
					return undefined;
				}
				return `Agent ${childId} is owned by ${claim.ownerId}: it is not available for delegation, steering, or a second owner`;
			}
			if (row.ownerId === claim?.ownerId && claim?.token === token) return undefined;
			return `Agent ${childId} is owned by ${row.ownerId}: it is not available for delegation, steering, or a second owner`;
		},
		foreignOwner(childId) {
			if (durableForeign(childId)) return true;
			return currentClaim(childId)?.state === "foreign";
		},
		boundOwner(signal) {
			return signal === undefined ? undefined : dispatchOwners.get(signal);
		},
		deliver(report) {
			const claim = currentClaim(report.childId);
			const row = readOwnedChild(db, deps.parentSessionId, report.childId);
			if (claim === undefined && row === undefined) return false;
			// A child of another live provider incarnation is not this conversation's to report, and
			// a claim recorded after this provider started is just as foreign as one adopted at it.
			const foreign =
				row === undefined
					? claim?.state === "foreign"
					: row.incarnation !== incarnation || claim?.state === "foreign";
			if (!foreign && claim !== undefined) {
				settle(claim, settlementStatus(report.reason), report.message);
			}
			return true;
		},
		async beginRecovery() {
			// Idempotent: recovery is asked for repeatedly (a memoized barrier, a test, a retry) and
			// the same rows must classify the same way each time.
			const blocked = new Set<string>();
			for (const row of listOwnedChildren(db, deps.parentSessionId)) {
				blocked.add(row.childId);
				if (claims.has(row.childId)) {
					// A retained claim is re-read too: a foreign one whose owner has since died
					// becomes an orphan here, so this retry is what reaps it.
					currentClaim(row.childId);
					continue;
				}
				const token = `${row.incarnation}:${row.ownerId}`;
				const live =
					row.incarnation !== incarnation && ownerLockHeld(deps.statePath, row.incarnation);
				claims.set(
					row.childId,
					createClaim(row.childId, row.ownerId, token, "", live ? "foreign" : "owned"),
				);
				if (!live) orphans.set(row.childId, token);
			}
			return blocked;
		},
		async reapOrphans() {
			const failures: string[] = [];
			const pending = [...orphans];
			orphans.clear();
			for (const [childId, token] of pending) {
				if (claims.get(childId)?.state !== "owned") continue;
				const failure = await stopConfirmed(childId, token);
				if (failure !== undefined) {
					// The claim is kept, so the child stays unavailable and a later pass can retry.
					orphans.set(childId, token);
					failures.push(failure);
					continue;
				}
				await retire(
					childId,
					"The provider that owned this child is gone; its work was stopped instead of adopted.",
				);
			}
			return failures;
		},
	};

	const openScope = (ownerId: string): OwnedScope => {
		if (disposed) throw new Error("Subagent ownership is disposed");
		if (ownerId.trim() === "") throw new Error("Owned scope id must not be empty");
		const existing = scopes.get(ownerId);
		if (existing !== undefined) return existing.scope;
		const token = `${incarnation}:${ownerId}`;

		const close = (reason: string): Promise<OwnedScopeClose> => {
			// Synchronous: every dispatch that has not reserved yet is refused from here on.
			state.closed = true;
			const running = state.closing;
			if (running !== undefined) return running;
			const run = (async (): Promise<OwnedScopeClose> => {
				// A dispatch already inside the pipeline finishes or refuses; nothing new can start.
				await state.queue;
				const failures: string[] = [];
				for (const childId of [...state.children]) {
					if (claims.get(childId)?.state !== "owned") continue;
					const failure = await stopConfirmed(childId, token);
					if (failure !== undefined) {
						failures.push(failure);
						continue;
					}
					await retire(childId, reason);
				}
				const result: OwnedScopeClose =
					failures.length === 0 ? { closed: true, failures } : { closed: false, failures };
				// A cleaned scope leaves the registry, so the same owner id can start a new one later;
				// a scope with unconfirmed children stays, and its close can be retried.
				if (result.closed && scopes.get(ownerId) === state) {
					scopes.delete(ownerId);
					scopeByToken.delete(token);
				}
				return result;
			})();
			state.closing = run;
			void run.then(
				() => {
					if (state.closing === run) state.closing = undefined;
				},
				() => {
					if (state.closing === run) state.closing = undefined;
				},
			);
			return run;
		};

		/** Stops and releases whatever this failed dispatch created, and says what is still owned. */
		const discard = async (
			before: ReadonlySet<string>,
			reason: string,
			childId?: string,
		): Promise<Error> => {
			const failures: string[] = [];
			const candidates =
				childId === undefined
					? [...state.children].filter((id) => !before.has(id))
					: [childId].filter((id) => !before.has(id));
			for (const id of candidates) {
				const claim = claims.get(id);
				if (claim === undefined) continue;
				const failure = await stopConfirmed(id, claim.token);
				if (failure !== undefined) {
					failures.push(failure);
					continue;
				}
				await retire(id, reason);
			}
			return failures.length === 0
				? new Error(`Owned delegation failed: ${reason}`)
				: new Error(
						`Owned delegation failed: ${reason}; stopping ${failures.join(", ")} is not confirmed and close() retries it`,
					);
		};

		const dispatch = async (
			request: OwnedDelegationRequest,
			ctx: ExtensionToolContext,
			signal: AbortSignal | undefined,
		): Promise<OwnedChildHandle> => {
			const before = new Set(state.children);
			// Ownership is bound to the call, not to its arguments: the signal crosses the native
			// pipeline unchanged, so a `tool_call` hook that deletes or rewrites `owner` cannot turn
			// an owned dispatch into an ordinary child that nobody cleans up.
			const call = signal === undefined ? new AbortController().signal : AbortSignal.any([signal]);
			dispatchOwners.set(call, token);
			let outcome: ToolOutcome;
			try {
				outcome = await ctx.executeTool(
					DELEGATE_TOOL,
					{ agent: request.agent, task: request.task, wait: false, owner: token },
					{ signal: call },
				);
			} catch (error) {
				throw await discard(before, errorMessage(error));
			}
			if (outcome.isError) {
				throw await discard(before, resultText(outcome));
			}
			const view = ownedView(outcome);
			const claim = view === undefined ? undefined : claims.get(view.id);
			if (view === undefined || claim === undefined || claim.token !== token) {
				throw await discard(
					before,
					view === undefined
						? "the delegation returned no identity"
						: (view.reason ?? `the delegation ended as ${view.status}`),
					view?.id,
				);
			}
			if (view.status !== "accepted") {
				// The child exists but its first turn was refused: stop it instead of waiting for a
				// report that was never promised.
				throw await discard(
					before,
					view.reason ?? `the delegation ended as ${view.status}`,
					view.id,
				);
			}
			if (state.closed) throw new Error(`Owned scope ${ownerId} closed while delegating`);
			// A cancelled dispatch is not delivered as a handle; the child stays claimed so close()
			// is what ends it, exactly as for any other accepted turn.
			if (signal?.aborted === true) throw new Error("Owned delegation was cancelled");
			return { childId: view.id, revision: view.revision, settlement: claim.settlement };
		};

		const scope: OwnedScope = {
			ownerId,
			delegate(request, ctx, signal) {
				if (state.closed) return Promise.reject(new Error(`Owned scope ${ownerId} is closed`));
				if (signal?.aborted === true) {
					return Promise.reject(new Error("Owned delegation was cancelled"));
				}
				const run = state.queue.then(async (): Promise<OwnedChildHandle> => {
					if (state.closed) throw new Error(`Owned scope ${ownerId} closed while delegating`);
					return dispatch(request, ctx, signal);
				});
				state.queue = run.then(
					() => undefined,
					() => undefined,
				);
				return run;
			},
			close,
		};

		const state: ScopeState = {
			ownerId,
			token,
			scope,
			children: new Set(),
			queue: Promise.resolve(),
			closed: false,
			closing: undefined,
		};
		scopes.set(ownerId, state);
		scopeByToken.set(token, state);
		return scope;
	};

	return {
		guard,
		service: { openScope },
		async dispose(reason: string): Promise<readonly string[]> {
			disposed = true;
			const failures: string[] = [];
			for (const state of [...scopes.values()]) {
				try {
					failures.push(...(await state.scope.close(reason)).failures);
				} catch (error) {
					failures.push(errorMessage(error));
				}
			}
			ownerLock.release();
			return failures;
		},
	};
}

function ownerLockHeld(statePath: string, incarnation: string): boolean {
	try {
		return processLockHeld(ownerLockPath(statePath, incarnation));
	} catch {
		// A probe that cannot answer is not evidence of death.
		return true;
	}
}
