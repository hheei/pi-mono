import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartEvent,
	BoundaryResult,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, isRecord } from "@hheei/pi-ext-core";
import type {
	OwnedChildHandle,
	OwnedChildSettlement,
	OwnedScope,
	SubagentOwnershipService,
} from "@hheei/pi-subagents/ownership";
import {
	createGoalDocument,
	createRunId,
	GOAL_CONTINUATION_MESSAGE_TYPE,
	GOAL_ENTRY_TYPE,
	GOAL_RECOVERY_HINT,
	GOAL_REVIEW_MESSAGE_TYPE,
	type GoalDocument,
	type GoalPhase,
	type GoalReviewRecord,
	type GoalRunView,
	parseReviewVerdict,
	readGoalState,
} from "./document.js";
import {
	continuationText,
	goalPromptText,
	goalStatusText,
	kickoffText,
	reviewFeedbackText,
	reviewTaskText,
	SESSION_NOT_DURABLE_NOTE,
} from "./format.js";
import type { GoalSettings } from "./settings.js";

export type GoalToolAction = "read" | "checkpoint" | "blocked" | "complete";

export interface GoalToolDetails {
	readonly action: GoalToolAction;
	readonly goalId: string;
	readonly definitionRevision: number;
	readonly disposition: GoalDocument["disposition"];
	/** Absent while the goal is paused or terminal. */
	readonly phase?: GoalPhase;
	readonly summary: string;
}

export interface GoalToolOutcome {
	readonly text: string;
	readonly details: GoalToolDetails;
}

/**
 * The native tool context and abort signal for one call. It is used only for the submission that
 * carries it: nothing retains a tool context for later callbacks.
 */
export interface GoalToolCall {
	readonly ctx: ExtensionToolContext;
	readonly signal?: AbortSignal | undefined;
}

/**
 * The native command context capabilities needed before a new run is authorized. It is used only
 * for this submission; nothing retains it, and every member re-reads the live command context.
 */
export interface GoalCommandCall {
	waitForIdle(): Promise<void>;
	/** Whether a model is selected right now; never a captured boolean. */
	modelReady(): boolean;
}

/** One run-bound message the delivery channel may flush after revalidating the run. */
export type GoalDelivery =
	| {
			readonly kind: "kickoff";
			readonly runId: string;
			readonly goalId: string;
			readonly definitionRevision: number;
	  }
	| {
			readonly kind: "feedback";
			readonly runId: string;
			readonly goalId: string;
			readonly definitionRevision: number;
			readonly attempt: number;
	  };

/**
 * Session-bound host. Every effect the controller needs is a closure over Pi APIs bound at
 * lifecycle start, so a late callback can never act through a retained extension context.
 */
export interface GoalHost {
	readonly sessionId: string;
	settings(): GoalSettings;
	/** Appends one goal snapshot to the current session branch; throws when Pi cannot save it. */
	append(goal: GoalDocument): void;
	/** Current branch entries, including entries that Pi has not written to disk yet. */
	branch(): readonly unknown[];
	/** Whether Pi has actually created the session file, so branch entries survive a restart. */
	durable(): boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/**
	 * Hands one run-bound message to the lifecycle-owned delivery channel. The receiver must ask
	 * {@link GoalController.deliveryText} again at flush time and drop anything no longer current.
	 */
	deliver(delivery: GoalDelivery): void;
	setGoalToolActive(active: boolean): void;
	ownership(): SubagentOwnershipService | undefined;
	/** Aborts the host operation that is running now, whichever run authorized it. */
	abort(): void;
	now(): Date;
}

interface GoalRun {
	readonly runId: string;
	readonly goalId: string;
	readonly definitionRevision: number;
	readonly controller: AbortController;
	phase: GoalPhase;
	review?:
		| { readonly attempt: number; readonly childId: string; readonly revision: number }
		| undefined;
	scope?: OwnedScope | undefined;
}

interface PendingCleanup {
	readonly scope: OwnedScope;
	readonly runId: string;
	readonly failures: string[];
	/** The close currently in flight; present from before the first await until it settles. */
	closing?: Promise<void> | undefined;
}

interface PendingFeedback {
	readonly runId: string;
	readonly goalId: string;
	readonly definitionRevision: number;
	readonly attempt: number;
}

/** Identity of the run-bound kickoff that the host is about to start a request for. */
interface StartingKickoff {
	readonly runId: string;
	readonly goalId: string;
	readonly definitionRevision: number;
}

const MAX_CLEANUP_DIAGNOSTICS = 5;

/**
 * Goal facts, one live run, and the owned review children that run started. The run is the only
 * source of autonomy: a persisted open goal without a run is paused and never resumes itself.
 *
 * Facts come from the session branch, never from an optimistic in-memory copy, so a boundary draft
 * that Pi does not commit never becomes truth and a tree navigation cannot resurrect them.
 */
export class GoalController {
	readonly #host: GoalHost;
	#run: GoalRun | undefined;
	#pendingCleanup: PendingCleanup[] = [];
	#toolActivated = false;
	#disposed = false;
	/** Bumped whenever the session branch or lifecycle changes, so awaits can detect it. */
	#generation = 0;
	/** The run whose host operation last started; used to attribute aborted settlements. */
	#operationRun: GoalRun | undefined;
	/** Rejected review feedback waiting for the native settle boundary; suppresses continuations. */
	#pendingFeedback: PendingFeedback | undefined;
	/** The run-bound kickoff the host is preparing; compared again when the operation starts. */
	#startingKickoff: StartingKickoff | undefined;

	public constructor(host: GoalHost) {
		this.#host = host;
	}

	public get document(): GoalDocument | undefined {
		const state = this.#state();
		return state.kind === "goal" ? state.goal : undefined;
	}

	/** Set when the newest goal entry on this branch is unreadable; no autonomy is granted then. */
	public get recoveryError(): string | undefined {
		const state = this.#state();
		return state.kind === "invalid" ? state.message : undefined;
	}

	public get cleanupFailures(): readonly string[] {
		return [...new Set(this.#pendingCleanup.flatMap((pending) => pending.failures))];
	}

	public get disposed(): boolean {
		return this.#disposed;
	}

	public runView(): GoalRunView | undefined {
		const run = this.#run;
		if (run === undefined) return undefined;
		return {
			runId: run.runId,
			goalId: run.goalId,
			definitionRevision: run.definitionRevision,
			phase: run.phase,
			...(run.review === undefined ? {} : { review: { ...run.review } }),
		};
	}

	/**
	 * Drops every in-memory authorization for a new session or tree position. Unconfirmed owned
	 * cleanup is retained: navigation must not hide children that were never confirmed stopped.
	 */
	public async restore(): Promise<void> {
		if (this.#disposed) return;
		this.#generation += 1;
		this.#setToolActive(false);
		const run = this.#revokeRun();
		if (run !== undefined) await this.#closeScope(run, "session branch changed");
	}

	/**
	 * Invalidates authorizations waiting across a tree navigation, then pauses. A deferred start or
	 * resume that waited on an owned close must not write into the branch navigation is leaving.
	 */
	public async beginBranchNavigation(reason: string): Promise<void> {
		this.#generation += 1;
		await this.suspend(reason);
	}

	public async start(objective: string, call?: GoalCommandCall): Promise<string> {
		this.#assertUsable();
		const text = objective.trim();
		if (text === "") throw new Error("A goal needs an objective.");
		this.#assertReadable();
		this.#assertCleanupConfirmed();
		this.#assertModelReady(call);
		const generation = this.#generation;
		if (this.#run !== undefined) await this.suspend("goal replaced by a new start");
		// Every await above can race a tree navigation, reload, or a deferred owned close. Revalidate
		// the whole authority before any write or authorization.
		await this.#awaitHostHandoff(call, generation);
		if (this.#run !== undefined) throw new Error("Goal is already running.");
		const settings = this.#host.settings();
		const goal = createGoalDocument({
			objective: text,
			reviewMode: settings.review ? "on" : "off",
			budgets: { continuations: settings.continuations, reviews: settings.reviews },
			now: this.#host.now(),
		});
		try {
			this.#host.append(goal);
		} catch (error) {
			throw new Error(`Goal was not saved (${errorMessage(error)}); nothing was started.`);
		}
		this.#beginRun(goal);
		return `Goal ${goal.goalId} started. ${autonomyText(goal)}${this.#durabilityNote()}`;
	}

	public async resume(call?: GoalCommandCall): Promise<string> {
		this.#assertUsable();
		this.#assertReadable();
		this.#requireGoal();
		if (this.#run !== undefined) throw new Error("Goal is already running.");
		this.#assertModelReady(call);
		const generation = this.#generation;
		await this.#awaitHostHandoff(call, generation);
		if (this.#run !== undefined) throw new Error("Goal is already running.");
		const goal = this.#requireGoal();
		if (goal.disposition === "completed" || goal.disposition === "cleared")
			throw new Error(`Goal is ${goal.disposition}; start a new goal instead.`);
		const { blockedReason: _blocked, lastPauseReason: _paused, ...rest } = goal;
		const next: GoalDocument = {
			...rest,
			disposition: "open",
			updatedAt: this.#host.now().toISOString(),
		};
		try {
			this.#host.append(next);
		} catch (error) {
			throw new Error(`Goal was not saved (${errorMessage(error)}); it was not resumed.`);
		}
		this.#beginRun(next);
		return `Goal ${next.goalId} resumed with the remaining budget. ${autonomyText(next)}${this.#durabilityNote()}`;
	}

	/** User pause: revoke and abort first, then persist, then wait for owned children to stop. */
	public async pause(reason = "paused by the user"): Promise<boolean> {
		this.#assertUsable();
		if (this.#run === undefined) return false;
		const run = this.#revokeRun();
		if (run === undefined) return false;
		this.#host.abort();
		await this.#recordPause(run, reason);
		return true;
	}

	public async clear(call?: GoalCommandCall): Promise<string> {
		this.#assertUsable();
		this.#assertReadable();
		const generation = this.#generation;
		const goalId = this.#requireGoal().goalId;
		if (this.#run !== undefined) await this.suspend("goal cleared");
		// The deferred close above may have outlived a tree navigation or restore. Clear only the
		// goal this command started with, never whatever goal the destination branch now holds.
		await this.#awaitBranchStable(call, generation);
		const goal = this.#requireGoal();
		if (goal.goalId !== goalId)
			throw new Error("The session goal changed while clear was waiting; nothing was cleared.");
		const next: GoalDocument = {
			...goal,
			disposition: "cleared",
			updatedAt: this.#host.now().toISOString(),
		};
		try {
			this.#host.append(next);
		} catch (error) {
			throw new Error(`Goal was not cleared (${errorMessage(error)}).`);
		}
		this.#host.notify(`Goal ${goal.goalId} cleared.`, "info");
		return `Goal ${goal.goalId} cleared.`;
	}

	/**
	 * Revokes the run, aborts the parent operation it authorized, records why, and closes the
	 * run's owned children. Never throws.
	 */
	public async suspend(reason: string): Promise<void> {
		const run = this.#revokeRun();
		if (run === undefined) return;
		this.#host.abort();
		await this.#recordPause(run, reason);
	}

	/** Retries cleanup that could not be confirmed earlier; returns true when nothing is pending. */
	public async retryCleanup(): Promise<boolean> {
		for (const pending of [...this.#pendingCleanup]) {
			if (pending.closing !== undefined) {
				await pending.closing;
				continue;
			}
			await this.#closeOwned(pending.scope, pending.runId, "retried owned review cleanup");
		}
		return this.#pendingCleanup.length === 0;
	}

	/**
	 * Waits for the previous host operation to hand off, then revalidates lifecycle, branch, and
	 * cleanup before this submission may write a goal or authorize a run.
	 */
	async #awaitHostHandoff(call: GoalCommandCall | undefined, generation: number): Promise<void> {
		await this.#awaitBranchStable(call, generation);
		this.#assertCleanupConfirmed();
		// The handoff can replace the session model; authorize only what is selected after it.
		this.#assertModelReady(call);
	}

	/** Waits for the host operation and revalidates that this command still sees the same branch. */
	async #awaitBranchStable(call: GoalCommandCall | undefined, generation: number): Promise<void> {
		if (call !== undefined) await call.waitForIdle();
		this.#assertUsable();
		if (this.#generation !== generation)
			throw new Error(
				"The session branch changed while the goal command was waiting; nothing was authorized.",
			);
		this.#assertReadable();
	}

	public statusText(): string {
		return goalStatusText({
			goal: this.document,
			run: this.runView(),
			cleanupFailures: this.cleanupFailures,
			recoveryError: this.recoveryError,
			durable: this.#host.durable(),
		});
	}

	public promptSection(): string | undefined {
		const goal = this.document;
		const run = this.#activeRun();
		if (goal === undefined || run === undefined) return undefined;
		return goalPromptText(goal, run.phase);
	}

	public async readTool(call?: GoalToolCall): Promise<GoalToolOutcome> {
		return await this.#withToolCall(call, () => {
			const goal = this.#requireGoal();
			const phase = this.#activeRun()?.phase;
			return {
				text: this.statusText(),
				details: this.#details("read", goal, phase, summaryForGoal(goal, phase)),
			};
		});
	}

	public async checkpoint(text: string, call?: GoalToolCall): Promise<GoalToolOutcome> {
		return await this.#withToolCall(call, () => {
			const goal = this.#requireRunGoal();
			const value = requireText(text, "checkpoint needs the current state in text");
			const next: GoalDocument = {
				...goal,
				checkpoint: value,
				updatedAt: this.#host.now().toISOString(),
			};
			this.#persist(next, "checkpoint");
			const phase = this.#activeRun()?.phase;
			return {
				text: `Checkpoint saved for goal ${goal.goalId}.`,
				details: this.#details("checkpoint", next, phase, "checkpoint saved"),
			};
		});
	}

	public async blocked(text: string, call?: GoalToolCall): Promise<GoalToolOutcome> {
		return await this.#withToolCall(call, async () => {
			const goal = this.#requireRunGoal();
			const value = requireText(text, "blocked needs the obstacle and the input required in text");
			const next: GoalDocument = {
				...goal,
				disposition: "blocked",
				blockedReason: value,
				updatedAt: this.#host.now().toISOString(),
			};
			this.#persist(next, "blocked state");
			const run = this.#revokeRun();
			await this.#closeScope(run, "goal blocked");
			this.#host.notify(`Goal ${goal.goalId} blocked: ${value}`, "warning");
			return {
				text: `Goal ${goal.goalId} is blocked and no longer runs autonomously. Resume with /goal resume when the obstacle is resolved.`,
				details: this.#details("blocked", next, undefined, "blocked"),
			};
		});
	}

	public async complete(text: string, call?: GoalToolCall): Promise<GoalToolOutcome> {
		return await this.#withToolCall(call, async () => {
			const goal = this.#requireRunGoal();
			this.#assertFeedbackDelivered();
			if (this.#requireActiveRun().phase === "reviewing")
				throw new Error(
					"A review is already running for this goal; wait for its verdict before submitting completion again.",
				);
			const evidence = requireText(text, "complete needs verification evidence in text");
			const withEvidence: GoalDocument = {
				...goal,
				evidence,
				updatedAt: this.#host.now().toISOString(),
			};
			this.#persist(withEvidence, "completion evidence");
			if (withEvidence.reviewMode === "off") {
				const completed: GoalDocument = {
					...withEvidence,
					disposition: "completed",
					updatedAt: this.#host.now().toISOString(),
				};
				this.#persist(completed, "completion");
				const run = this.#revokeRun();
				await this.#closeScope(run, "goal completed");
				this.#host.notify(`Goal ${goal.goalId} completed.`, "info");
				return {
					text: `Goal ${goal.goalId} recorded as completed with the supplied evidence.`,
					details: this.#details("complete", completed, undefined, "completed"),
				};
			}
			return await this.#startReview(withEvidence, call);
		});
	}

	/**
	 * Native settle boundary: append at most one continuation draft, never over another handler's
	 * decision. The host evaluates runnable context *after* committing drafts, so an assistant-final
	 * context is expected; requiring context.canContinue here would disable every continuation.
	 */
	public async handleBoundary(event: AgentBeforeSettleEvent): Promise<BoundaryResult | undefined> {
		if (this.#disposed) return undefined;
		const run = this.#activeRun();
		if (run === undefined) return undefined;
		const state = this.#state();
		if (state.kind === "none" || state.kind === "invalid") return undefined;
		const goal = state.goal;
		if (event.outcome === "error") {
			await this.suspend("the final request failed; the goal is paused");
			return undefined;
		}
		if (event.outcome !== "completed") return undefined;
		if (run.phase !== "working" || goal.disposition !== "open") return undefined;
		const pending = this.#pendingFeedback;
		if (pending !== undefined) {
			if (this.#feedbackDelivered(pending)) {
				this.#pendingFeedback = undefined;
			} else {
				const text = this.deliveryText({ kind: "feedback", ...pending });
				if (text === undefined) {
					this.#pendingFeedback = undefined;
					this.#host.notify(
						"The pending review feedback no longer matches the active run; it was discarded.",
						"warning",
					);
				} else {
					// Deliver through the native settle boundary: it commits the visible message and starts
					// the next request in one host operation. There is no asynchronously fallible
					// sendMessage whose success could be guessed, and no follow-up can survive a pause.
					return {
						entries: [
							...event.entries,
							{
								type: "custom_message",
								customType: GOAL_REVIEW_MESSAGE_TYPE,
								content: text,
								display: true,
								details: { kind: "feedback", ...pending },
							},
						],
						continue: true,
					};
				}
			}
		}
		if (event.continue) return undefined;
		if (event.context.pendingMessages.length > 0) return undefined;
		if (goal.usage.continuations >= goal.budgets.continuations) {
			await this.suspend("continuation budget exhausted");
			return undefined;
		}
		const next: GoalDocument = {
			...goal,
			usage: { ...goal.usage, continuations: goal.usage.continuations + 1 },
			updatedAt: this.#host.now().toISOString(),
		};
		return {
			entries: [
				...event.entries,
				{ type: "custom", customType: GOAL_ENTRY_TYPE, data: next },
				{
					type: "custom_message",
					customType: GOAL_CONTINUATION_MESSAGE_TYPE,
					content: continuationText(next),
					display: false,
				},
			],
			continue: true,
		};
	}

	/**
	 * Records the run-bound message that is about to start a host operation. Pi defers an extension
	 * `sendMessage` issued while it emits `agent_settled`, so a kickoff can reach `agent_start`
	 * only after the run that authorized it was paused, cleared, or left behind by navigation.
	 */
	public handleBeforeAgentStart(event: BeforeAgentStartEvent): void {
		this.#startingKickoff = this.#disposed ? undefined : startingKickoffOf(event);
	}

	/**
	 * Binds the host operation that is starting to the run authorized when it began. A kickoff whose
	 * run is no longer current is cancelled instead: `agent_start` is awaited before the first
	 * provider request, so aborting here stops the stale request and leaves the live run alone.
	 */
	public handleAgentStart(): void {
		if (this.#disposed) return;
		const starting = this.#startingKickoff;
		this.#startingKickoff = undefined;
		const run = this.#activeRun();
		if (
			starting === undefined ||
			(run !== undefined &&
				run.runId === starting.runId &&
				run.goalId === starting.goalId &&
				run.definitionRevision === starting.definitionRevision)
		) {
			this.#operationRun = run;
			return;
		}
		// Never attribute this operation to the replacement run: its settlement is not an abort of
		// what the user authorized now.
		this.#operationRun = undefined;
		this.#host.abort();
		this.#host.notify(
			"A goal kickoff whose run had already ended was discarded before it reached the model.",
			"warning",
		);
	}

	/**
	 * An aborted turn is an explicit withdrawal of autonomy, but only for the run whose operation
	 * started it. A settlement that arrives after a replacement run was authorized belongs to the
	 * revoked run and must not pause its successor.
	 */
	public async handleSettled(aborted: boolean): Promise<void> {
		const operation = this.#operationRun;
		this.#operationRun = undefined;
		if (this.#disposed) return;
		const pending = this.#pendingFeedback;
		if (pending !== undefined) {
			if (this.#feedbackDelivered(pending)) {
				this.#pendingFeedback = undefined;
			} else if (!aborted) {
				await this.suspend("review feedback could not be delivered; the goal is paused");
				return;
			}
		}
		if (!aborted) return;
		const run = this.#activeRun();
		if (run === undefined || operation !== run) return;
		await this.suspend("goal paused because the turn was aborted");
	}

	public async dispose(reason: string): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation += 1;
		this.#operationRun = undefined;
		this.#startingKickoff = undefined;
		const run = this.#revokeRun();
		await this.#closeScope(run, reason);
	}

	async #startReview(goal: GoalDocument, call: GoalToolCall | undefined): Promise<GoalToolOutcome> {
		const service = this.#host.ownership();
		if (service === undefined)
			throw new Error(
				"Independent review is required by this goal, but @hheei/pi-subagents provides no owned review capability. Install and enable it, or start a new goal with goal.review=false; the goal was not approved without review.",
			);
		if (call === undefined)
			throw new Error(
				"Independent review needs the native goal tool context to run through Pi validation and hooks; call goal complete from the goal tool.",
			);
		this.#assertCleanupConfirmed();
		const attempt = goal.usage.reviews + 1;
		if (attempt > goal.budgets.reviews)
			throw new Error(
				`Review budget exhausted (${goal.budgets.reviews} attempts recorded). /goal resume does not refill it; start a new goal to grant a new budget.`,
			);
		const run = this.#requireActiveRun();
		const settings = this.#host.settings();
		const counted: GoalDocument = {
			...goal,
			usage: { ...goal.usage, reviews: attempt },
			lastReview: { attempt, verdict: "pending", feedback: "Review requested." },
			updatedAt: this.#host.now().toISOString(),
		};
		this.#persist(counted, "review attempt");
		run.phase = "reviewing";
		const stillCurrent = (): boolean => this.#isCurrentReview(run, attempt);
		let handle: OwnedChildHandle;
		try {
			// One scope per attempt: the provider refuses a second scope with the same owner id, and a
			// rejected attempt closes its scope before the next attempt starts.
			const scope = service.openScope(`${run.runId}:review:${attempt}`);
			run.scope = scope;
			handle = await scope.delegate(
				{ agent: settings.reviewAgent, task: reviewTaskText(counted, attempt) },
				call.ctx,
				call.signal,
			);
		} catch (error) {
			const reason = errorMessage(error);
			if (!stillCurrent())
				throw new Error(
					`The goal run ended while its review was starting; the dispatch failure (${reason}) belongs to that run and was not recorded against the current goal.`,
				);
			try {
				this.#persist(
					{
						...this.#requireGoal(),
						lastReview: { attempt, verdict: "failed", feedback: reason },
						updatedAt: this.#host.now().toISOString(),
					},
					"failed review attempt",
				);
			} catch (persistError) {
				this.#host.notify(
					`Failed review attempt could not be saved: ${errorMessage(persistError)}`,
					"error",
				);
			}
			await this.suspend(`review could not start: ${reason}`);
			throw new Error(`Review could not start: ${reason}`);
		}
		if (!stillCurrent()) {
			// The run was revoked while dispatch was in flight; its scope close owns the child and
			// its settlement is consumed as a late result, so nothing may be written for the new goal.
			throw new Error(
				"The goal run ended while its review was starting; the review result will be ignored.",
			);
		}
		run.review = { attempt, childId: handle.childId, revision: handle.revision };
		try {
			this.#persist(
				{
					...this.#requireGoal(),
					lastReview: {
						attempt,
						childId: handle.childId,
						revision: handle.revision,
						verdict: "pending",
						feedback: "Review in progress.",
					},
					updatedAt: this.#host.now().toISOString(),
				},
				"running review",
			);
		} catch (error) {
			await this.suspend(
				`review was started but its identity could not be saved: ${errorMessage(error)}`,
			);
			throw error;
		}
		void handle.settlement
			.then(
				(settlement) => this.#onReviewSettled(run, handle, settlement),
				(error: unknown) =>
					this.#onReviewSettled(run, handle, {
						childId: handle.childId,
						agent: settings.reviewAgent,
						status: "failed",
						message: errorMessage(error),
					}),
			)
			// A persistence failure here must be visible, not an unhandled rejection.
			.catch((error: unknown) => {
				this.#host.notify(`Goal review handling failed: ${errorMessage(error)}`, "error");
			});
		return {
			text: `Completion submitted. Independent review attempt ${attempt} runs as ${handle.childId}; the goal stays in reviewing until the reviewer reports a verdict.`,
			details: this.#details("complete", counted, "reviewing", `reviewing · attempt ${attempt}`),
		};
	}

	async #onReviewSettled(
		run: GoalRun,
		handle: OwnedChildHandle,
		settlement: OwnedChildSettlement,
	): Promise<void> {
		if (this.#disposed) return;
		const attempt = run.review?.attempt;
		const current =
			attempt !== undefined &&
			this.#isCurrentReview(run, attempt) &&
			run.review?.childId === handle.childId &&
			run.review.revision === handle.revision;
		if (!current) {
			this.#host.notify(`Ignored a late review result for ${handle.childId}.`, "info");
			return;
		}
		const state = this.#state();
		if (state.kind !== "goal" || attempt === undefined) return;
		const doc = state.goal;
		const feedback = settlement.message.trim();
		const verdict =
			settlement.status === "completed" ? parseReviewVerdict(settlement.message) : undefined;
		const record = (next: GoalReviewRecord): GoalReviewRecord => ({
			...next,
			childId: handle.childId,
			revision: handle.revision,
		});

		if (verdict === "approved") {
			const completed: GoalDocument = {
				...doc,
				disposition: "completed",
				lastReview: record({ attempt, verdict: "approved", feedback }),
				updatedAt: this.#host.now().toISOString(),
			};
			this.#persist(completed, "review approval");
			const revoked = this.#revokeRun();
			await this.#closeScope(revoked, "review approved");
			this.#host.notify(
				`Goal ${doc.goalId} completed: reviewer approved attempt ${attempt}.`,
				"info",
			);
			return;
		}

		if (verdict === "rejected") {
			const rejected: GoalDocument = {
				...doc,
				disposition: "open",
				lastReview: record({ attempt, verdict: "rejected", feedback }),
				updatedAt: this.#host.now().toISOString(),
			};
			this.#persist(rejected, "review rejection");
			// Stay in reviewing until the owned close is confirmed and the feedback is installed: a
			// working run without that feedback would let a completion submitted during the close
			// start attempt two, and a settle boundary spend a continuation, for a rejection the model
			// never saw. `run.review` stays set for the same reason.
			await this.#closeScope(run, "review rejected");
			// Cleanup and persistence are awaits: the run may have been paused or replaced meanwhile.
			if (this.#run !== run || !this.#isCurrentGoal(doc, attempt)) {
				this.#host.notify(
					"Review rejection arrived after its run ended; it was not applied to the current goal.",
					"warning",
				);
				return;
			}
			const latest = this.#requireGoal();
			if (this.#pendingCleanup.length > 0) {
				await this.suspend("review rejected, but owned cleanup is still unconfirmed");
				return;
			}
			if (this.#operationRun !== run) {
				// The rejection arrived after the run's last settle boundary, so there is no native
				// boundary left that could deliver it. There is no awaitable or cancellable extension
				// send to wake the parent safely; pause instead of leaving an invisible pending wakeup.
				await this.suspend(
					"review was rejected after the parent turn settled; the findings are recorded and the goal is paused",
				);
				return;
			}
			if (latest.usage.continuations >= latest.budgets.continuations) {
				await this.suspend("review rejected and the continuation budget is exhausted");
				return;
			}
			const resumed: GoalDocument = {
				...latest,
				usage: { ...latest.usage, continuations: latest.usage.continuations + 1 },
				updatedAt: this.#host.now().toISOString(),
			};
			this.#persist(resumed, "review rejection continuation");
			// Install the feedback and leave reviewing in one synchronous segment, so no submission
			// can observe a working run whose rejection feedback is still missing.
			this.#pendingFeedback = {
				runId: run.runId,
				goalId: resumed.goalId,
				definitionRevision: resumed.definitionRevision,
				attempt,
			};
			run.phase = "working";
			run.review = undefined;
			return;
		}

		const inconclusive: GoalDocument = {
			...doc,
			lastReview: record({
				attempt,
				verdict: verdict ?? (settlement.status === "failed" ? "failed" : "inconclusive"),
				feedback: feedback === "" ? `review ended as ${settlement.status}` : feedback,
			}),
			updatedAt: this.#host.now().toISOString(),
		};
		this.#persist(inconclusive, "review outcome");
		await this.suspend(`review did not approve (${settlement.status}); the goal is paused`);
	}

	/** Revalidates a queued delivery against the live run; undefined means it must be dropped. */
	public deliveryText(delivery: GoalDelivery): string | undefined {
		if (this.#disposed) return undefined;
		const run = this.#run;
		if (run === undefined) return undefined;
		const goal = this.document;
		if (goal === undefined) return undefined;
		if (run.runId !== delivery.runId) return undefined;
		if (goal.goalId !== delivery.goalId) return undefined;
		if (goal.definitionRevision !== delivery.definitionRevision) return undefined;
		if (run.phase !== "working") return undefined;
		if (delivery.kind === "kickoff") return kickoffText(goal) + this.#durabilityNote();
		const pending = this.#pendingFeedback;
		if (
			pending === undefined ||
			pending.runId !== delivery.runId ||
			pending.goalId !== delivery.goalId ||
			pending.definitionRevision !== delivery.definitionRevision ||
			pending.attempt !== delivery.attempt
		)
			return undefined;
		const review = goal.lastReview;
		if (review === undefined) return undefined;
		if (review.attempt !== delivery.attempt || review.verdict !== "rejected") return undefined;
		return reviewFeedbackText(goal, review);
	}

	/** True while this exact rejection's feedback still awaits delivery. */
	public hasPendingFeedback(): boolean {
		return this.#pendingFeedback !== undefined;
	}

	/**
	 * A new review attempt while the last rejection's feedback is undelivered would make the missing
	 * acknowledgement look like a delivery failure and pause the new attempt. Block the submission
	 * until the feedback is on the branch; the retry stays possible afterwards.
	 */
	#assertFeedbackDelivered(): void {
		const pending = this.#pendingFeedback;
		if (pending === undefined) return;
		if (this.#feedbackDelivered(pending)) {
			this.#pendingFeedback = undefined;
			return;
		}
		throw new Error(
			`Review feedback from attempt ${pending.attempt} is still waiting for the next settle boundary. Submit completion again after it is delivered.`,
		);
	}

	/** True when the visible feedback entry this rejection produced is committed on the branch. */
	#feedbackDelivered(pending: PendingFeedback): boolean {
		return this.#host.branch().some((entry) => {
			if (!isRecord(entry)) return false;
			if (entry.type !== "custom_message" || entry.customType !== GOAL_REVIEW_MESSAGE_TYPE)
				return false;
			const details = entry.details;
			return (
				isRecord(details) &&
				details.kind === "feedback" &&
				details.runId === pending.runId &&
				details.goalId === pending.goalId &&
				details.attempt === pending.attempt
			);
		});
	}

	/** True while the branch still holds this goal revision with the same rejected review. */
	#isCurrentGoal(goal: GoalDocument, attempt: number): boolean {
		const state = this.#state();
		if (state.kind !== "goal") return false;
		const current = state.goal;
		return (
			current.goalId === goal.goalId &&
			current.definitionRevision === goal.definitionRevision &&
			current.lastReview?.attempt === attempt &&
			current.lastReview.verdict === "rejected"
		);
	}

	/** A review is current only while the same run, revision, attempt, and pending child survive. */
	#isCurrentReview(run: GoalRun, attempt: number): boolean {
		if (this.#run !== run || run.phase !== "reviewing") return false;
		const state = this.#state();
		if (state.kind !== "goal") return false;
		const goal = state.goal;
		return (
			goal.goalId === run.goalId &&
			goal.definitionRevision === run.definitionRevision &&
			goal.lastReview?.attempt === attempt &&
			goal.lastReview.verdict === "pending"
		);
	}

	async #withToolCall<T>(call: GoalToolCall | undefined, action: () => Promise<T> | T): Promise<T> {
		if (call === undefined) return await action();
		// Bind the abort to the run this call started under, so an old tool signal can never revoke a
		// replacement run that was authorized after this call began.
		const expected = this.#run;
		if (call.signal?.aborted === true) {
			await this.#abortToolRun(expected, "the goal tool call was aborted");
			throw new Error("The goal tool call was aborted; the goal is paused.");
		}
		const signal = call.signal;
		const onAbort = (): void => {
			void this.#abortToolRun(expected, "the goal tool call was aborted");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await action();
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	#abortToolRun(expected: GoalRun | undefined, reason: string): Promise<void> {
		const run = this.#revokeRun(expected);
		if (run === undefined) return Promise.resolve();
		this.#host.abort();
		return this.#recordPause(run, reason);
	}

	#state(): ReturnType<typeof readGoalState> {
		return readGoalState(this.#host.branch());
	}

	#beginRun(goal: GoalDocument): void {
		const run: GoalRun = {
			runId: createRunId(),
			goalId: goal.goalId,
			definitionRevision: goal.definitionRevision,
			controller: new AbortController(),
			phase: "working",
		};
		this.#run = run;
		this.#setToolActive(true);
		// The authorization exists, so the model gets exactly one inspectable kickoff turn. The
		// channel revalidates this run before sending, so a pause wins over a pending kickoff.
		this.#host.deliver({
			kind: "kickoff",
			runId: run.runId,
			goalId: goal.goalId,
			definitionRevision: goal.definitionRevision,
		});
	}

	/** Revokes the live run (or returns undefined unless it is still the expected one). */
	#revokeRun(expected?: GoalRun): GoalRun | undefined {
		const run = this.#run;
		if (run === undefined) return undefined;
		if (expected !== undefined && run !== expected) return undefined;
		this.#run = undefined;
		this.#pendingFeedback = undefined;
		run.phase = "closing";
		run.controller.abort();
		this.#setToolActive(false);
		return run;
	}

	#setToolActive(active: boolean): void {
		if (active === this.#toolActivated) return;
		this.#toolActivated = active;
		this.#host.setGoalToolActive(active);
	}

	/** Revokes first (already done by the caller), persists the pause, then waits for children. */
	async #recordPause(run: GoalRun, reason: string): Promise<void> {
		const state = this.#state();
		if (state.kind === "goal") {
			const next: GoalDocument = {
				...state.goal,
				lastPauseReason: reason,
				updatedAt: this.#host.now().toISOString(),
			};
			try {
				this.#host.append(next);
			} catch (error) {
				this.#host.notify(
					`Goal paused, but the pause could not be saved: ${errorMessage(error)}`,
					"error",
				);
			}
		} else if (state.kind === "invalid") {
			this.#host.notify(
				`Goal paused, but the branch goal record is unreadable: ${state.message}`,
				"error",
			);
		}
		await this.#closeScope(run, reason);
		this.#host.notify(`Goal paused: ${reason}`, "warning");
	}

	async #closeScope(run: GoalRun | undefined, reason: string): Promise<void> {
		const scope = run?.scope;
		if (run === undefined || scope === undefined) return;
		run.scope = undefined;
		await this.#closeOwned(scope, run.runId, reason);
	}

	/**
	 * Closes one owned scope and keeps it pending until a close is confirmed. A failed close keeps
	 * the scope reference so status keeps reporting it and a later retry can confirm it.
	 */
	async #closeOwned(scope: OwnedScope, runId: string, reason: string): Promise<void> {
		const existing = this.#pendingCleanup.find((pending) => pending.scope === scope);
		// A concurrent caller shares the close that is already in flight instead of closing twice.
		if (existing?.closing !== undefined) return await existing.closing;
		const pending: PendingCleanup = existing ?? { scope, runId, failures: [] };
		// Register before the first await: from this point no new run, replacement, or review may be
		// authorized while the owned child is still being confirmed stopped.
		if (existing === undefined) this.#pendingCleanup.push(pending);
		const closing = (async (): Promise<void> => {
			let failures: readonly string[];
			try {
				const result = await scope.close(reason);
				failures = result.closed ? [] : result.failures;
			} catch (error) {
				failures = [errorMessage(error)];
			}
			if (failures.length === 0) {
				this.#pendingCleanup = this.#pendingCleanup.filter((entry) => entry !== pending);
				return;
			}
			pending.failures.push(...failures);
			pending.failures.splice(0, Math.max(0, pending.failures.length - MAX_CLEANUP_DIAGNOSTICS));
			this.#host.notify(
				`Goal cleanup is unconfirmed: ${failures.join("; ")}. New goal work is blocked until the owned review child is confirmed stopped.`,
				"error",
			);
		})();
		pending.closing = closing;
		try {
			await closing;
		} finally {
			pending.closing = undefined;
		}
	}

	#persist(goal: GoalDocument, what: string): void {
		try {
			this.#host.append(goal);
		} catch (error) {
			throw new Error(`Goal ${what} was not saved: ${errorMessage(error)}`);
		}
	}

	#activeRun(): GoalRun | undefined {
		const run = this.#run;
		if (run === undefined) return undefined;
		if (run.controller.signal.aborted) return undefined;
		const state = this.#state();
		if (state.kind !== "goal") return undefined;
		if (state.goal.goalId !== run.goalId) return undefined;
		if (state.goal.definitionRevision !== run.definitionRevision) return undefined;
		return run;
	}

	#requireGoal(): GoalDocument {
		const state = this.#state();
		if (state.kind === "invalid")
			throw new Error(
				`Goal record in this session cannot be read: ${state.message}. ${GOAL_RECOVERY_HINT}`,
			);
		if (state.kind === "none")
			throw new Error(
				"No goal exists in this session. Ask the user to run /goal start <objective>.",
			);
		return state.goal;
	}

	#requireActiveRun(): GoalRun {
		const run = this.#activeRun();
		if (run === undefined)
			throw new Error("The goal is not running. Ask the user to run /goal resume first.");
		return run;
	}

	#requireRunGoal(): GoalDocument {
		this.#requireActiveRun();
		return this.#requireGoal();
	}

	#assertReadable(): void {
		if (this.recoveryError !== undefined) this.#requireGoal();
	}

	/**
	 * A goal authorized without a selected model writes its snapshot and then loses the kickoff:
	 * Pi's `sendMessage` is a void wrapper, so the failing send can never report back and the goal
	 * stays "working" with no request and no way to resume. Check before the write, and again
	 * after the handoff because the model can change while this command waits.
	 */
	#assertModelReady(call: GoalCommandCall | undefined): void {
		if (call === undefined || call.modelReady()) return;
		throw new Error(
			"No model is selected, so no goal run was authorized. Select a model and run the goal command again.",
		);
	}

	#assertCleanupConfirmed(): void {
		if (this.#pendingCleanup.length === 0) return;
		const failures = this.cleanupFailures;
		const detail =
			failures.length === 0
				? "the owned review child is still being confirmed stopped"
				: `cleanup is unconfirmed (${failures.join("; ")})`;
		throw new Error(
			`Owned review cleanup is unresolved: ${detail}. No new goal work, replacement, or review can start until Pi confirms the owned child stopped.`,
		);
	}

	#durabilityNote(): string {
		return this.#host.durable() ? "" : ` ${SESSION_NOT_DURABLE_NOTE}`;
	}

	#assertUsable(): void {
		if (this.#disposed) throw new Error("Goal runtime is not available in this session.");
	}

	#details(
		action: GoalToolAction,
		goal: GoalDocument,
		phase: GoalPhase | undefined,
		summary: string,
	): GoalToolDetails {
		return {
			action,
			goalId: goal.goalId,
			definitionRevision: goal.definitionRevision,
			disposition: goal.disposition,
			...(phase === undefined ? {} : { phase }),
			summary,
		};
	}
}

function requireText(text: string, message: string): string {
	const value = text.trim();
	if (value === "") throw new Error(message);
	return value;
}

function autonomyText(goal: GoalDocument): string {
	return `Continuations ${goal.usage.continuations}/${goal.budgets.continuations}; review ${goal.reviewMode === "on" ? `on (attempts ${goal.usage.reviews}/${goal.budgets.reviews})` : "off"}.`;
}

/** Reads the kickoff identity out of the custom message that starts a host operation. */
function startingKickoffOf(event: BeforeAgentStartEvent): StartingKickoff | undefined {
	if (event.messageType !== "custom") return undefined;
	const details = event.message.details;
	if (!isRecord(details) || details.kind !== "kickoff") return undefined;
	const { runId, goalId, definitionRevision } = details;
	if (typeof runId !== "string" || typeof goalId !== "string") return undefined;
	if (typeof definitionRevision !== "number") return undefined;
	return { runId, goalId, definitionRevision };
}

function summaryForGoal(goal: GoalDocument, phase: GoalPhase | undefined): string {
	const state = phase === undefined ? goal.disposition : `${goal.disposition} · ${phase}`;
	return `${state} · continuations ${goal.usage.continuations}/${goal.budgets.continuations}`;
}
