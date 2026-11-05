import { randomBytes } from "node:crypto";
import { isRecord } from "@hheei/pi-ext-core";

/** Custom entry that carries the durable goal snapshot for one branch. */
export const GOAL_ENTRY_TYPE = "pi-goal";
/** Hidden custom message used for a native settle continuation. */
export const GOAL_CONTINUATION_MESSAGE_TYPE = "pi-goal-continuation";
/** Visible custom message that returns a rejected review to the parent. */
export const GOAL_REVIEW_MESSAGE_TYPE = "pi-goal-review";
/** Visible run-bound kickoff that starts the model working on a freshly authorized goal. */
export const GOAL_KICKOFF_MESSAGE_TYPE = "pi-goal-kickoff";
/** pi-subagents marks child sessions in the environment; those sessions never own goals. */
export const SUBAGENT_CHILD_SESSION_ENV = "PI_SUBAGENTS_CHILD_ID";

export type GoalDisposition = "open" | "blocked" | "completed" | "cleared";
export type GoalReviewMode = "off" | "on";
export type GoalPhase = "working" | "reviewing" | "closing";
export type GoalReviewVerdict = "pending" | "approved" | "rejected" | "inconclusive" | "failed";

export interface GoalBudgets {
	readonly continuations: number;
	readonly reviews: number;
}

export interface GoalUsage {
	readonly continuations: number;
	readonly reviews: number;
}

export interface GoalReviewRecord {
	readonly attempt: number;
	readonly verdict: GoalReviewVerdict;
	readonly feedback: string;
	readonly childId?: string;
	readonly revision?: number;
}

/** Durable goal facts. Anything that is only valid for one dispatch stays out of this record. */
export interface GoalDocument {
	readonly version: 1;
	readonly goalId: string;
	readonly objective: string;
	/** User-owned acceptance criteria; the model has no tool that can replace them. */
	readonly acceptance: string;
	readonly definitionRevision: number;
	readonly disposition: GoalDisposition;
	readonly reviewMode: GoalReviewMode;
	readonly budgets: GoalBudgets;
	readonly usage: GoalUsage;
	readonly checkpoint?: string;
	readonly blockedReason?: string;
	readonly evidence?: string;
	readonly lastReview?: GoalReviewRecord;
	readonly lastPauseReason?: string;
	readonly updatedAt: string;
}

/** Read-only projection of the live run, used by status, prompts, and renderers. */
export interface GoalRunView {
	readonly runId: string;
	readonly goalId: string;
	readonly definitionRevision: number;
	readonly phase: GoalPhase;
	readonly review?: {
		readonly attempt: number;
		readonly childId: string;
		readonly revision: number;
	};
}

const DISPOSITIONS: readonly GoalDisposition[] = ["open", "blocked", "completed", "cleared"];
const REVIEW_MODES: readonly GoalReviewMode[] = ["off", "on"];
const VERDICTS: readonly GoalReviewVerdict[] = [
	"pending",
	"approved",
	"rejected",
	"inconclusive",
	"failed",
];

function nonEmptyStringAt(
	record: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function countAt(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function budgetsFrom(value: unknown): GoalBudgets | undefined {
	if (!isRecord(value)) return undefined;
	const continuations = countAt(value, "continuations");
	const reviews = countAt(value, "reviews");
	return continuations === undefined || reviews === undefined
		? undefined
		: { continuations, reviews };
}

function reviewFrom(value: unknown): GoalReviewRecord | undefined {
	if (!isRecord(value)) return undefined;
	const attempt = countAt(value, "attempt");
	const verdict = value.verdict;
	const feedback = value.feedback;
	if (attempt === undefined || !VERDICTS.includes(verdict as GoalReviewVerdict)) return undefined;
	if (typeof feedback !== "string") return undefined;
	const childId = nonEmptyStringAt(value, "childId");
	const revision = countAt(value, "revision");
	return {
		attempt,
		verdict: verdict as GoalReviewVerdict,
		feedback,
		...(childId === undefined ? {} : { childId }),
		...(revision === undefined ? {} : { revision }),
	};
}

/**
 * Validates one snapshot that came back from the session JSONL. Unknown versions and illegal
 * fields mean "no snapshot": a goal is never reconstructed from a partial record.
 */
export function isGoalDocument(value: unknown): value is GoalDocument {
	if (!isRecord(value) || value.version !== 1) return false;
	const goalId = nonEmptyStringAt(value, "goalId");
	const objective = nonEmptyStringAt(value, "objective");
	const acceptance = nonEmptyStringAt(value, "acceptance");
	const definitionRevision = countAt(value, "definitionRevision");
	const disposition = value.disposition;
	const reviewMode = value.reviewMode;
	const budgets = budgetsFrom(value.budgets);
	const usage = budgetsFrom(value.usage);
	const updatedAt = nonEmptyStringAt(value, "updatedAt");
	if (
		goalId === undefined ||
		objective === undefined ||
		acceptance === undefined ||
		definitionRevision === undefined ||
		definitionRevision < 1 ||
		budgets === undefined ||
		usage === undefined ||
		updatedAt === undefined
	)
		return false;
	if (!DISPOSITIONS.includes(disposition as GoalDisposition)) return false;
	if (!REVIEW_MODES.includes(reviewMode as GoalReviewMode)) return false;
	const checkpoint = value.checkpoint;
	const blockedReason = value.blockedReason;
	const evidence = value.evidence;
	const lastPauseReason = value.lastPauseReason;
	if (checkpoint !== undefined && typeof checkpoint !== "string") return false;
	if (blockedReason !== undefined && typeof blockedReason !== "string") return false;
	if (evidence !== undefined && typeof evidence !== "string") return false;
	if (lastPauseReason !== undefined && typeof lastPauseReason !== "string") return false;
	if (value.lastReview !== undefined && reviewFrom(value.lastReview) === undefined) return false;
	return true;
}

/**
 * Result of reading the newest goal entry on a branch. An unreadable newest entry is a distinct
 * state: falling back to an older snapshot would silently resurrect a completed or cleared goal.
 */
export type GoalBranchState =
	| { readonly kind: "none" }
	| { readonly kind: "goal"; readonly goal: GoalDocument }
	| { readonly kind: "invalid"; readonly message: string };

const INVALID_GOAL_MESSAGE =
	"the newest pi-goal entry is not a valid version-1 goal snapshot (unknown version or illegal fields)";

/** Reads the newest goal entry on the supplied branch; abandoned branches never win. */
export function readGoalState(entries: readonly unknown[]): GoalBranchState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE)
			continue;
		if (isGoalDocument(entry.data)) return { kind: "goal", goal: entry.data };
		return { kind: "invalid", message: INVALID_GOAL_MESSAGE };
	}
	return { kind: "none" };
}

export const GOAL_RECOVERY_HINT =
	"Repair the session branch or start a clean session; this session will not overwrite, resume, or continue that goal.";

export function createGoalDocument(input: {
	readonly objective: string;
	readonly reviewMode: GoalReviewMode;
	readonly budgets: GoalBudgets;
	readonly now: Date;
}): GoalDocument {
	return {
		version: 1,
		goalId: `goal_${randomBytes(4).toString("hex")}`,
		objective: input.objective,
		acceptance: input.objective,
		definitionRevision: 1,
		disposition: "open",
		reviewMode: input.reviewMode,
		budgets: input.budgets,
		usage: { continuations: 0, reviews: 0 },
		updatedAt: input.now.toISOString(),
	};
}

export function createRunId(): string {
	return `run_${randomBytes(4).toString("hex")}`;
}

/** First non-empty line decides the verdict; anything else is inconclusive, never approval. */
export function parseReviewVerdict(message: string): "approved" | "rejected" | undefined {
	const first = message
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line !== "");
	if (first === undefined) return undefined;
	const match = /^VERDICT:\s*(APPROVED|REJECTED)$/i.exec(first);
	const verdict = match?.[1]?.toUpperCase();
	return verdict === "APPROVED" ? "approved" : verdict === "REJECTED" ? "rejected" : undefined;
}
