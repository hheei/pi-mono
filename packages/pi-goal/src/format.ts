import type { CustomEntry, EntryRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type GoalDocument,
	type GoalPhase,
	type GoalReviewRecord,
	type GoalRunView,
	isGoalDocument,
} from "./document.js";

/** Pi creates the session file on the first user or assistant message; before that nothing is durable. */
export const SESSION_NOT_DURABLE_NOTE =
	"Pi creates the session file with the first user or assistant message; until then this goal exists only in memory and will not survive a restart.";

export interface GoalStatusInput {
	readonly goal: GoalDocument | undefined;
	readonly run: GoalRunView | undefined;
	readonly cleanupFailures: readonly string[];
	readonly recoveryError: string | undefined;
	readonly durable: boolean;
}

export function goalStatusText(input: GoalStatusInput): string {
	const { goal, run, cleanupFailures, recoveryError, durable } = input;
	if (recoveryError !== undefined) return `Goal record cannot be used: ${recoveryError}`;
	if (goal === undefined) return "No goal in this session. /goal start <objective> creates one.";
	const state =
		run === undefined ? `${goal.disposition} · paused` : `${goal.disposition} · ${run.phase}`;
	const lines = [
		`Goal ${goal.goalId}  ${state}`,
		`Definition revision: ${goal.definitionRevision}`,
		`Objective: ${goal.objective}`,
		`Acceptance: ${goal.acceptance}`,
		`Budget: continuations ${goal.usage.continuations}/${goal.budgets.continuations} · reviews ${goal.usage.reviews}/${goal.budgets.reviews}`,
		`Review mode: ${goal.reviewMode}`,
	];
	if (goal.checkpoint !== undefined) lines.push(`Checkpoint: ${goal.checkpoint}`);
	if (goal.blockedReason !== undefined) lines.push(`Blocked: ${goal.blockedReason}`);
	if (goal.evidence !== undefined) lines.push(`Evidence: ${goal.evidence}`);
	if (goal.lastPauseReason !== undefined) lines.push(`Last pause: ${goal.lastPauseReason}`);
	if (goal.lastReview !== undefined) {
		lines.push(
			`Last review: attempt ${goal.lastReview.attempt} ${goal.lastReview.verdict} — ${goal.lastReview.feedback}`,
		);
	}
	if (run !== undefined) {
		const owned =
			run.review === undefined
				? ""
				: ` · owned child ${run.review.childId} revision ${run.review.revision}`;
		lines.push(`Run: ${run.runId} (${run.phase})${owned}`);
	}
	for (const failure of cleanupFailures) lines.push(`Cleanup: ${failure}`);
	if (!durable) lines.push(`Durability: ${SESSION_NOT_DURABLE_NOTE}`);
	return lines.join("\n");
}

function clamp(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function stateColor(goal: GoalDocument): "accent" | "success" | "warning" | "dim" {
	if (goal.disposition === "completed") return "success";
	if (goal.disposition === "blocked") return "warning";
	if (goal.disposition === "cleared") return "dim";
	return "accent";
}

/**
 * One-line goal record in the transcript; expanding it reveals the complete facts without a
 * second dashboard. Rendering is plain text so wide objectives wrap by cell width.
 */
export function renderGoalEntry(
	entry: CustomEntry<unknown>,
	options: EntryRenderOptions,
	theme: Theme,
): Text | undefined {
	const goal = isGoalDocument(entry.data) ? entry.data : undefined;
	if (goal === undefined) return undefined;
	const head = [
		theme.fg("toolTitle", theme.bold("goal")),
		theme.fg(stateColor(goal), goal.disposition),
		theme.fg("dim", `· ${clamp(goal.objective, 72)}`),
		theme.fg("dim", `· continuations ${goal.usage.continuations}/${goal.budgets.continuations}`),
		...(goal.lastPauseReason === undefined
			? []
			: [theme.fg("dim", `· paused: ${clamp(goal.lastPauseReason, 48)}`)]),
	].join(" ");
	if (!options.expanded) return new Text(head, 0, 0);
	const details = [
		head,
		theme.fg("dim", `revision ${goal.definitionRevision} · review ${goal.reviewMode}`),
		`Objective: ${goal.objective}`,
		`Acceptance: ${goal.acceptance}`,
		...(goal.checkpoint === undefined ? [] : [`Checkpoint: ${goal.checkpoint}`]),
		...(goal.blockedReason === undefined ? [] : [`Blocked: ${goal.blockedReason}`]),
		...(goal.evidence === undefined ? [] : [`Evidence: ${goal.evidence}`]),
		...(goal.lastReview === undefined
			? []
			: [
					`Last review: attempt ${goal.lastReview.attempt} ${goal.lastReview.verdict} — ${goal.lastReview.feedback}`,
				]),
		theme.fg("dim", `updated ${goal.updatedAt}`),
	];
	return new Text(details.join("\n"), 0, 0);
}

/** The active goal projected into the system prompt; absent whenever no run is authorized. */
export function goalPromptText(goal: GoalDocument, phase: GoalPhase): string {
	const remaining = goal.budgets.continuations - goal.usage.continuations;
	return [
		"A user-authorized goal is active in this session.",
		`Goal: ${goal.goalId} (definition revision ${goal.definitionRevision}, phase ${phase})`,
		`Objective: ${goal.objective}`,
		`Acceptance criteria: ${goal.acceptance}`,
		`Checkpoint: ${goal.checkpoint ?? "(none recorded)"}`,
		`Evidence recorded: ${goal.evidence === undefined ? "no" : "yes"}`,
		`Remaining autonomous continuations: ${remaining}`,
		"Rules:",
		"- Acceptance criteria and the goal definition belong to the user; never lower, reinterpret, or bypass them.",
		"- Use the goal tool to checkpoint real progress, report a genuine blocker, or submit completion with verification evidence.",
		"- Autonomy does not authorize irreversible operations: existing permission and approval rules still apply.",
	].join("\n");
}

/** The visible, run-bound kickoff that finally prompts the model after authorization. */
export function kickoffText(goal: GoalDocument): string {
	const remaining = goal.budgets.continuations - goal.usage.continuations;
	return [
		`The user authorized goal ${goal.goalId} (definition revision ${goal.definitionRevision}).`,
		`Objective: ${goal.objective}`,
		`Acceptance criteria: ${goal.acceptance}`,
		`Checkpoint: ${goal.checkpoint ?? "(none recorded)"}`,
		`Autonomy: ${remaining} continuation(s) remaining; independent review is ${goal.reviewMode}.`,
		...(goal.lastReview?.verdict === "rejected"
			? [`Last review attempt ${goal.lastReview.attempt} was REJECTED: ${goal.lastReview.feedback}`]
			: []),
		"Work on the objective now. Use the goal tool to checkpoint real progress, report a genuine blocker, or submit completion with verification evidence. Never lower the acceptance criteria; existing permission and approval rules still apply.",
	].join("\n");
}

export function continuationText(goal: GoalDocument): string {
	const remaining = goal.budgets.continuations - goal.usage.continuations;
	return [
		`Continue the active goal ${goal.goalId} (autonomous continuation; ${remaining} remaining).`,
		`Objective: ${goal.objective}`,
		`Acceptance criteria: ${goal.acceptance}`,
		`Last checkpoint: ${goal.checkpoint ?? "(none)"}`,
		"Take the next concrete step. Use the goal tool to checkpoint progress; call goal complete only with verification evidence, or goal blocked with a real obstacle and the input needed.",
	].join("\n");
}

export function reviewFeedbackText(goal: GoalDocument, review: GoalReviewRecord): string {
	const remaining = goal.budgets.continuations - goal.usage.continuations;
	return [
		`Goal review attempt ${review.attempt} was REJECTED. The goal is still open.`,
		`Objective: ${goal.objective}`,
		`Acceptance criteria: ${goal.acceptance}`,
		"Reviewer findings:",
		review.feedback === "" ? "(no findings reported)" : review.feedback,
		`Address the findings, then call goal complete again with new verification evidence. Remaining continuations: ${remaining}.`,
	].join("\n");
}

export function reviewTaskText(goal: GoalDocument, attempt: number): string {
	return [
		"Review whether a user-authorized goal is complete. Do not edit files or change state.",
		`Goal: ${goal.goalId} (definition revision ${goal.definitionRevision}, review attempt ${attempt})`,
		`Objective: ${goal.objective}`,
		`Acceptance criteria: ${goal.acceptance}`,
		`Recorded evidence: ${goal.evidence ?? "(none)"}`,
		`Last checkpoint: ${goal.checkpoint ?? "(none)"}`,
		"Verify the evidence against the repository when needed.",
		"Your first non-empty line must be exactly one of:",
		"VERDICT: APPROVED",
		"VERDICT: REJECTED",
		"Follow it with a short justification citing path:line evidence. Approve only when the objective and acceptance criteria are actually satisfied; otherwise reject and state the smallest concrete gap.",
	].join("\n");
}
