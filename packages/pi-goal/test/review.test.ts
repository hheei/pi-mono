import { describe, expect, test, vi } from "vitest";
import { GoalController } from "../src/controller.js";
import { GOAL_REVIEW_MESSAGE_TYPE } from "../src/document.js";
import {
	boundaryEvent,
	createGoalHost,
	FakeOwnership,
	fakeToolContext,
} from "./fixtures/fake-goal.js";

async function reviewingGoal(options: { readonly continuations?: number } = {}) {
	const ownership = new FakeOwnership();
	const recorder = createGoalHost({
		settings: {
			review: true,
			...(options.continuations === undefined ? {} : { continuations: options.continuations }),
		},
		ownership,
	});
	const controller = new GoalController(recorder.host);
	await controller.start("Ship goal");
	controller.handleAgentStart();
	await controller.complete("tests passed", { ctx: fakeToolContext() });
	const scope = ownership.last;
	const childId = [...scope.children.keys()][0];
	if (childId === undefined) throw new Error("review child was not dispatched");
	return { controller, recorder, ownership, scope, childId };
}

describe("owned review", () => {
	test("an approved verdict completes the goal and closes the scope", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal();
		scope.settle(childId, "completed", "VERDICT: APPROVED\nverified by tests");
		await vi.waitFor(() => {
			expect(controller.document?.disposition).toBe("completed");
		});
		expect(controller.runView()).toBeUndefined();
		expect(scope.closed).toBe(true);
		expect(recorder.state.toolActive).toBe(false);
		expect(controller.document?.lastReview?.verdict).toBe("approved");
	});

	test("a rejected verdict records pending feedback within the budget", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal();
		scope.settle(childId, "completed", "VERDICT: REJECTED\nmissing caller check");
		await vi.waitFor(() => {
			expect(controller.hasPendingFeedback()).toBe(true);
		});
		expect(controller.document?.disposition).toBe("open");
		expect(controller.document?.usage.continuations).toBe(1);
		expect(controller.runView()?.phase).toBe("working");
		expect(scope.closed).toBe(true);
		expect(recorder.state.aborts).toBe(0);
	});

	test("a completion raced against the rejection's close is refused and the feedback survives", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal();
		let release: () => void = () => {};
		scope.closeGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		const closeEntered = new Promise<void>((done) => {
			entered = done;
		});
		scope.closeEntered = entered;
		scope.settle(childId, "completed", "VERDICT: REJECTED\nmissing caller check");
		await closeEntered;
		await Promise.resolve();
		// The rejection is recorded but its cleanup and pending feedback are not installed yet, so the
		// run must still look like it is reviewing rather than authorize new work.
		expect(controller.runView()?.phase).toBe("reviewing");
		expect(controller.hasPendingFeedback()).toBe(false);
		expect(await controller.handleBoundary(boundaryEvent())).toBeUndefined();
		await expect(controller.complete("again", { ctx: fakeToolContext() })).rejects.toThrow(
			"already running",
		);
		expect(controller.document?.usage.reviews).toBe(1);
		expect(controller.document?.usage.continuations).toBe(0);

		// The close resolves into a microtask window that ends only when the rejection handler resumes;
		// a submission there must still be refused instead of charging a second review attempt.
		release();
		await expect(controller.complete("again", { ctx: fakeToolContext() })).rejects.toThrow();
		expect(controller.document?.usage.reviews).toBe(1);
		expect(recorder.state.aborts).toBe(0);

		await vi.waitFor(() => {
			expect(controller.hasPendingFeedback()).toBe(true);
		});
		expect(controller.runView()?.phase).toBe("working");
		expect(controller.runView()?.review).toBeUndefined();
		expect(scope.closed).toBe(true);
		const draft = await controller.handleBoundary(boundaryEvent());
		const message = draft?.entries?.find(
			(entry) => entry.type === "custom_message" && entry.customType === GOAL_REVIEW_MESSAGE_TYPE,
		);
		if (message?.type !== "custom_message") throw new Error("missing feedback draft");
		expect(message.content).toContain("missing caller check");
		expect(controller.document?.usage.reviews).toBe(1);
	});

	test("pending rejection feedback is delivered by the boundary without spending a continuation", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal({
			continuations: 1,
		});
		scope.settle(childId, "completed", "VERDICT: REJECTED\nmissing caller check");
		await vi.waitFor(() => {
			expect(controller.hasPendingFeedback()).toBe(true);
		});
		const draft = await controller.handleBoundary(boundaryEvent());
		const message = draft?.entries?.find(
			(entry) => entry.type === "custom_message" && entry.customType === GOAL_REVIEW_MESSAGE_TYPE,
		);
		if (message?.type !== "custom_message") throw new Error("missing feedback draft");
		expect(message.content).toContain("missing caller check");
		expect(message.display).toBe(true);
		expect(draft?.continue).toBe(true);
		expect(controller.document?.usage.continuations).toBe(1);
		// Simulate the host committing the boundary entry, then the next settlement sees it delivered.
		recorder.extraEntries.push(message);
		expect(await controller.handleBoundary(boundaryEvent())).toBeUndefined();
		expect(controller.hasPendingFeedback()).toBe(false);
		expect(controller.runView()).toBeUndefined();
		expect(controller.document?.usage.continuations).toBe(1);
		expect(recorder.state.aborts).toBe(1);
	});

	test("an explicit pause discards pending feedback without spending another continuation", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal({
			continuations: 2,
		});
		scope.settle(childId, "completed", "VERDICT: REJECTED\nfix it");
		await vi.waitFor(() => {
			expect(controller.hasPendingFeedback()).toBe(true);
		});
		await controller.pause("paused by the user");
		expect(controller.hasPendingFeedback()).toBe(false);
		expect(await controller.handleBoundary(boundaryEvent())).toBeUndefined();
		expect(controller.document?.usage.continuations).toBe(1);
		expect(recorder.state.aborts).toBe(1);
	});

	test("a settlement without a committed feedback entry pauses instead of silently dropping it", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal();
		scope.settle(childId, "completed", "VERDICT: REJECTED\nfix it");
		await vi.waitFor(() => {
			expect(controller.hasPendingFeedback()).toBe(true);
		});
		await controller.handleSettled(false);
		expect(controller.runView()).toBeUndefined();
		expect(controller.document?.lastPauseReason).toContain("could not be delivered");
		expect(recorder.state.aborts).toBe(1);
	});

	test("a rejection pauses when no continuation budget remains", async () => {
		const { controller, scope, childId } = await reviewingGoal({ continuations: 0 });
		scope.settle(childId, "completed", "VERDICT: REJECTED\nnot done");
		await vi.waitFor(() => {
			expect(controller.runView()).toBeUndefined();
		});
		expect(controller.hasPendingFeedback()).toBe(false);
		expect(controller.document?.disposition).toBe("open");
		expect(controller.document?.lastPauseReason).toContain("review rejected");
	});

	test("an unparseable or failed review never approves and pauses", async () => {
		const inconclusive = await reviewingGoal();
		inconclusive.scope.settle(inconclusive.childId, "completed", "looks fine to me");
		await vi.waitFor(() => {
			expect(inconclusive.controller.runView()).toBeUndefined();
		});
		expect(inconclusive.controller.document?.disposition).toBe("open");
		expect(inconclusive.controller.document?.lastReview?.verdict).toBe("inconclusive");

		const failed = await reviewingGoal();
		failed.scope.settle(failed.childId, "failed", "the reviewer crashed");
		await vi.waitFor(() => {
			expect(failed.controller.runView()).toBeUndefined();
		});
		expect(failed.controller.document?.lastReview?.verdict).toBe("failed");
	});

	test("a result that arrives after the run was revoked is ignored", async () => {
		const { controller, recorder, scope, childId } = await reviewingGoal();
		await controller.pause("paused by the user");
		scope.settle(childId, "completed", "VERDICT: APPROVED\nlate");
		await vi.waitFor(() => {
			expect(recorder.notices.some((notice) => notice.message.includes("late review result"))).toBe(
				true,
			);
		});
		expect(controller.document?.disposition).toBe("open");
		expect(controller.runView()).toBeUndefined();
	});

	test("a second completion is refused while a review is running", async () => {
		const { controller } = await reviewingGoal();
		await expect(controller.complete("again", { ctx: fakeToolContext() })).rejects.toThrow(
			"already running",
		);
		expect(controller.document?.usage.reviews).toBe(1);
	});

	test("completion waits for undelivered feedback, then a retry records attempt two", async () => {
		const { controller, recorder, ownership, scope, childId } = await reviewingGoal();
		scope.settle(childId, "completed", "VERDICT: REJECTED\nfix it");
		await vi.waitFor(() => {
			expect(controller.hasPendingFeedback()).toBe(true);
		});
		// Starting attempt two here would make the missing acknowledgement of attempt one look like a
		// delivery failure and pause the new attempt, so the second submission is refused instead.
		await expect(
			controller.complete("second evidence", { ctx: fakeToolContext() }),
		).rejects.toThrow("still waiting for the next settle boundary");
		expect(ownership.scopes).toHaveLength(1);
		expect(controller.document?.usage.reviews).toBe(1);
		expect(controller.runView()?.phase).toBe("working");

		const draft = await controller.handleBoundary(boundaryEvent());
		const feedback = draft?.entries?.find(
			(entry) => entry.type === "custom_message" && entry.customType === GOAL_REVIEW_MESSAGE_TYPE,
		);
		if (feedback?.type !== "custom_message") throw new Error("missing feedback draft");
		// The host committed the visible feedback before this retry; it is delivered now.
		recorder.extraEntries.push(feedback);
		await controller.complete("second evidence", { ctx: fakeToolContext() });
		expect(ownership.scopeIds).toHaveLength(2);
		expect(new Set(ownership.scopeIds).size).toBe(2);
		expect(controller.document?.usage.reviews).toBe(2);
		expect(controller.runView()?.phase).toBe("reviewing");
		expect(recorder.appended[recorder.appended.length - 1]?.lastReview?.attempt).toBe(2);
		expect(controller.hasPendingFeedback()).toBe(false);
	});

	test("a dispatch failure after the run ended does not touch the current goal", async () => {
		const ownership = new FakeOwnership();
		const recorder = createGoalHost({ settings: { review: true }, ownership });
		const controller = new GoalController(recorder.host);
		await controller.start("first goal");
		let release: () => void = () => {};
		ownership.nextGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const opening = controller.complete("evidence", { ctx: fakeToolContext() });
		await controller.pause("pause while dispatching");
		release();
		await expect(opening).rejects.toThrow("run ended while its review was starting");
		const last = recorder.appended[recorder.appended.length - 1];
		expect(last?.lastPauseReason).toBe("pause while dispatching");
		expect(last?.lastReview?.verdict).toBe("pending");
	});

	test("close failures keep the goal paused with a visible diagnostic", async () => {
		const { controller, recorder, scope } = await reviewingGoal();
		scope.failures = ["child-1: stop unconfirmed"];
		scope.stopChildren = false;
		await controller.pause("pause");
		expect(controller.cleanupFailures).toEqual(["child-1: stop unconfirmed"]);
		expect(
			recorder.notices.some(
				(notice) => notice.level === "error" && notice.message.includes("cleanup"),
			),
		).toBe(true);
		expect(controller.statusText()).toContain("Cleanup: child-1");
	});
});
