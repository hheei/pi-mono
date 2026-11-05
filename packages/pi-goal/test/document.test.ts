import { describe, expect, test } from "vitest";
import {
	createGoalDocument,
	GOAL_ENTRY_TYPE,
	isGoalDocument,
	parseReviewVerdict,
	readGoalState,
} from "../src/document.js";

function document(objective = "Ship the goal feature"): ReturnType<typeof createGoalDocument> {
	return createGoalDocument({
		objective,
		reviewMode: "on",
		budgets: { continuations: 2, reviews: 1 },
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
}

describe("goal snapshot", () => {
	test("round-trips the documented fields", () => {
		const goal = { ...document(), checkpoint: "inspect callers" };
		expect(isGoalDocument(goal)).toBe(true);
		expect(goal.acceptance).toBe(goal.objective);
		expect(goal.definitionRevision).toBe(1);
	});

	test("rejects illegal snapshots instead of repairing them", () => {
		const goal = document() as unknown as Record<string, unknown>;
		expect(isGoalDocument({ ...goal, version: 2 })).toBe(false);
		expect(isGoalDocument({ ...goal, disposition: "paused" })).toBe(false);
		expect(isGoalDocument({ ...goal, reviewMode: "maybe" })).toBe(false);
		expect(isGoalDocument({ ...goal, usage: { continuations: -1, reviews: 0 } })).toBe(false);
		expect(isGoalDocument({ ...goal, lastReview: { attempt: 1, verdict: "pending" } })).toBe(false);
		expect(isGoalDocument(null)).toBe(false);
	});

	test("restores only the newest snapshot on the branch", () => {
		const older = { ...document("older"), disposition: "completed" };
		const newer = { ...document("newer"), checkpoint: "latest" };
		const entries = [
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: older },
			{ type: "message", message: { role: "user" } },
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: newer },
		];
		const state = readGoalState(entries);
		expect(state.kind === "goal" ? state.goal.objective : undefined).toBe("newer");
		const olderState = readGoalState(entries.slice(0, 1));
		expect(olderState.kind === "goal" ? olderState.goal.disposition : undefined).toBe("completed");
		expect(readGoalState([{ type: "custom", customType: "other", data: newer }])).toEqual({
			kind: "none",
		});
	});

	test("an unreadable newest entry is a recovery error, never an older snapshot", () => {
		const older = { ...document("older"), disposition: "completed" };
		const entries = [
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: older },
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { version: 99 } },
		];
		const state = readGoalState(entries);
		expect(state.kind).toBe("invalid");
		expect(state.kind === "invalid" ? state.message : "").toContain("not a valid");
	});
});

describe("review verdict", () => {
	test("accepts only an exact verdict line", () => {
		expect(parseReviewVerdict("\nVERDICT: APPROVED\nlooks good")).toBe("approved");
		expect(parseReviewVerdict("verdict: rejected\nmissing test")).toBe("rejected");
		expect(parseReviewVerdict("VERDICT: APPROVED because tests pass")).toBe(undefined);
		expect(parseReviewVerdict("Looks fine to me")).toBe(undefined);
		expect(parseReviewVerdict("")).toBe(undefined);
	});
});
