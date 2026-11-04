import { describe, expect, test } from "vitest";
import { GoalController } from "../src/controller.js";
import {
	createGoalDocument,
	GOAL_CONTINUATION_MESSAGE_TYPE,
	GOAL_ENTRY_TYPE,
	GOAL_RECOVERY_HINT,
	type GoalDocument,
} from "../src/document.js";
import { SESSION_NOT_DURABLE_NOTE } from "../src/format.js";
import {
	boundaryEvent,
	createGoalHost,
	customStartEvent,
	FakeOwnership,
	fakeToolContext,
} from "./fixtures/fake-goal.js";

function pausedGoal(overrides: Partial<GoalDocument> = {}): GoalDocument {
	return {
		...createGoalDocument({
			objective: "Restore me",
			reviewMode: "off",
			budgets: { continuations: 3, reviews: 1 },
			now: new Date("2026-01-01T00:00:00.000Z"),
		}),
		...overrides,
	};
}

function branchOf(...entries: GoalDocument[]): readonly unknown[] {
	return entries.map((data) => ({ type: "custom", customType: GOAL_ENTRY_TYPE, data }));
}

function setup(options: Parameters<typeof createGoalHost>[0] = {}) {
	const recorder = createGoalHost(options);
	const controller = new GoalController(recorder.host);
	return { controller, ...recorder };
}

/** The kickoff identity the delivery channel would put on the message for the live run. */
function kickoffOf(controller: GoalController): Record<string, unknown> {
	const run = controller.runView();
	if (run === undefined) throw new Error("no live run");
	return {
		kind: "kickoff",
		runId: run.runId,
		goalId: run.goalId,
		definitionRevision: run.definitionRevision,
	};
}

describe("goal facts and authorization", () => {
	test("start saves the snapshot before the run exists and delivers a kickoff", async () => {
		const { controller, appended, state, delivered } = setup();
		const message = await controller.start("Ship goal");
		expect(message).toContain("started");
		expect(appended).toHaveLength(1);
		expect(appended[0]?.disposition).toBe("open");
		expect(appended[0]?.acceptance).toBe("Ship goal");
		expect(controller.runView()?.phase).toBe("working");
		expect(state.toolActive).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.kind).toBe("kickoff");
		const delivery = delivered[0];
		expect(delivery === undefined ? undefined : controller.deliveryText(delivery)).toContain(
			"Work on the objective now",
		);
	});

	test("a kickoff for a run that was paused is delivered as nothing", async () => {
		const { controller, delivered } = setup();
		await controller.start("Ship goal");
		await controller.pause("pause");
		const delivery = delivered[0];
		expect(delivery === undefined ? "missing" : controller.deliveryText(delivery)).toBeUndefined();
	});

	test("a session without a session file reports that the goal is not yet durable", async () => {
		const { controller, delivered } = setup({ durable: false });
		const message = await controller.start("Ship goal");
		expect(message).toContain(SESSION_NOT_DURABLE_NOTE);
		expect(controller.statusText()).toContain("Durability:");
		const delivery = delivered[0];
		expect(delivery === undefined ? undefined : controller.deliveryText(delivery)).toContain(
			SESSION_NOT_DURABLE_NOTE,
		);
	});

	test("a failed snapshot write starts nothing", async () => {
		const { controller, state } = setup({ failAppend: () => true });
		await expect(controller.start("Ship goal")).rejects.toThrow("nothing was started");
		expect(controller.document).toBeUndefined();
		expect(controller.runView()).toBeUndefined();
		expect(state.toolActive).toBe(false);
	});

	test("restore rebuilds facts but never a run", async () => {
		const goal = pausedGoal();
		const { controller } = setup({ branchEntries: () => branchOf(goal) });
		await controller.restore();
		expect(controller.document?.objective).toBe("Restore me");
		expect(controller.runView()).toBeUndefined();
		await expect(controller.complete("evidence")).rejects.toThrow("not running");
	});

	test("an unreadable newest goal entry refuses overwrite and resume", async () => {
		const valid = pausedGoal();
		const branch = [
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: valid },
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { version: 9, objective: "?" } },
		];
		const { controller } = setup({ branchEntries: () => branch });
		expect(controller.document).toBeUndefined();
		expect(controller.recoveryError).toContain("not a valid version-1 goal snapshot");
		expect(controller.statusText()).toContain("cannot be used");
		await expect(controller.resume()).rejects.toThrow(GOAL_RECOVERY_HINT);
		await expect(controller.start("new goal")).rejects.toThrow(GOAL_RECOVERY_HINT);
		await expect(controller.clear()).rejects.toThrow(GOAL_RECOVERY_HINT);
	});

	test("pause revokes the run, keeps facts, and aborts the parent turn", async () => {
		const { controller, appended, state } = setup();
		await controller.start("Ship goal");
		expect(await controller.pause("user pause")).toBe(true);
		expect(controller.runView()).toBeUndefined();
		expect(state.aborts).toBe(1);
		expect(state.toolActive).toBe(false);
		expect(appended[appended.length - 1]?.lastPauseReason).toBe("user pause");
		expect(appended[appended.length - 1]?.disposition).toBe("open");
	});

	test("clear and replacement abort the old parent operation", async () => {
		const cleared = setup();
		await cleared.controller.start("Ship goal");
		await cleared.controller.clear();
		expect(cleared.state.aborts).toBe(1);

		const replaced = setup();
		await replaced.controller.start("first goal");
		await replaced.controller.start("second goal");
		expect(replaced.state.aborts).toBe(1);
		expect(replaced.controller.document?.objective).toBe("second goal");
	});

	test("resume starts a new run without refilling usage and delivers a kickoff", async () => {
		const { controller, appended, delivered } = setup();
		await controller.start("Ship goal");
		const draft = await controller.handleBoundary(boundaryEvent());
		const committed = draft?.entries?.[0];
		if (committed?.type !== "custom") throw new Error("missing continuation draft");
		appended.push(committed.data as GoalDocument);
		await controller.pause("pause");
		await controller.resume();
		expect(controller.runView()?.phase).toBe("working");
		expect(controller.document?.usage.continuations).toBe(1);
		expect(controller.document?.budgets.continuations).toBe(8);
		expect(delivered.filter((delivery) => delivery.kind === "kickoff")).toHaveLength(2);
	});

	test("completed and cleared goals cannot resume", async () => {
		const completed = setup({
			branchEntries: () => branchOf(pausedGoal({ disposition: "completed" })),
		});
		await expect(completed.controller.resume()).rejects.toThrow("start a new goal");
		const cleared = setup({
			branchEntries: () => branchOf(pausedGoal({ disposition: "cleared" })),
		});
		await expect(cleared.controller.resume()).rejects.toThrow("start a new goal");
	});

	test("clear records a cleared goal and revokes the run", async () => {
		const { controller, appended } = setup();
		await controller.start("Ship goal");
		await controller.clear();
		expect(controller.document?.disposition).toBe("cleared");
		expect(controller.runView()).toBeUndefined();
		expect(appended[appended.length - 1]?.disposition).toBe("cleared");
	});

	test("unconfirmed owned cleanup blocks new work until a retry confirms it", async () => {
		const ownership = new FakeOwnership();
		const { controller, state } = setup({ settings: { review: true }, ownership });
		await controller.start("Ship goal");
		await controller.complete("tests passed", { ctx: fakeToolContext() });
		const scope = ownership.last;
		scope.stopChildren = false;
		scope.failures = ["child-1: stop unconfirmed"];
		await controller.pause("pause");
		expect(controller.cleanupFailures).toEqual(["child-1: stop unconfirmed"]);
		await expect(controller.resume()).rejects.toThrow("cleanup is unconfirmed");
		await expect(controller.start("another goal")).rejects.toThrow("cleanup is unconfirmed");
		expect(controller.runView()).toBeUndefined();
		expect(state.toolActive).toBe(false);

		scope.stopChildren = true;
		scope.failures = [];
		expect(await controller.retryCleanup()).toBe(true);
		expect(controller.cleanupFailures).toEqual([]);
		await controller.resume();
		expect(controller.runView()?.phase).toBe("working");
	});

	test("replacement start is blocked when the old run's cleanup is unconfirmed", async () => {
		const ownership = new FakeOwnership();
		const { controller } = setup({ settings: { review: true }, ownership });
		await controller.start("first goal");
		await controller.complete("tests passed", { ctx: fakeToolContext() });
		ownership.last.stopChildren = false;
		ownership.last.failures = ["child-1: stop unconfirmed"];
		await expect(controller.start("second goal")).rejects.toThrow("cleanup is unconfirmed");
		expect(controller.document?.objective).toBe("first goal");
		expect(controller.runView()).toBeUndefined();
	});

	test("an in-flight close blocks resume until the owned child is confirmed stopped", async () => {
		const ownership = new FakeOwnership();
		const { controller } = setup({ settings: { review: true }, ownership });
		await controller.start("Ship goal");
		await controller.complete("tests passed", { ctx: fakeToolContext() });
		let release: () => void = () => {};
		ownership.last.closeGate = new Promise<void>((done) => {
			release = done;
		});
		let entered: () => void = () => {};
		const closeEntered = new Promise<void>((done) => {
			entered = done;
		});
		ownership.last.closeEntered = entered;
		const pausing = controller.pause("pause before the close is confirmed");
		await closeEntered;
		await expect(controller.resume()).rejects.toThrow("still being confirmed stopped");
		expect(controller.runView()).toBeUndefined();
		release();
		await pausing;
		await controller.resume();
		expect(controller.runView()?.phase).toBe("working");
	});

	test("a deferred replacement cannot write into a branch restored while it waited", async () => {
		const ownership = new FakeOwnership();
		const { controller } = setup({ settings: { review: true }, ownership });
		await controller.start("first goal");
		await controller.complete("tests passed", { ctx: fakeToolContext() });
		let release: () => void = () => {};
		ownership.last.closeGate = new Promise<void>((done) => {
			release = done;
		});
		let entered: () => void = () => {};
		const closeEntered = new Promise<void>((done) => {
			entered = done;
		});
		ownership.last.closeEntered = entered;
		const replacing = controller.start("second goal");
		await closeEntered;
		await controller.restore();
		release();
		await expect(replacing).rejects.toThrow("session branch changed");
		expect(controller.document?.objective).toBe("first goal");
		expect(controller.runView()).toBeUndefined();
	});

	test("a deferred clear cannot clear a goal restored while it waited", async () => {
		const ownership = new FakeOwnership();
		let destination: readonly unknown[] | undefined;
		let appendedBranch = (): readonly unknown[] => [];
		const recorder = createGoalHost({
			settings: { review: true },
			ownership,
			branchEntries: () => destination ?? appendedBranch(),
		});
		appendedBranch = () => branchOf(...recorder.appended);
		const controller = new GoalController(recorder.host);
		await controller.start("goal A");
		await controller.complete("tests passed", { ctx: fakeToolContext() });
		let release: () => void = () => {};
		ownership.last.closeGate = new Promise<void>((done) => {
			release = done;
		});
		let entered: () => void = () => {};
		const closeEntered = new Promise<void>((done) => {
			entered = done;
		});
		ownership.last.closeEntered = entered;
		const clearing = controller.clear();
		await closeEntered;
		const goalB = pausedGoal({ objective: "goal B" });
		destination = branchOf(goalB);
		await controller.restore();
		release();
		await expect(clearing).rejects.toThrow("session branch changed");
		expect(controller.document?.goalId).toBe(goalB.goalId);
		expect(controller.document?.disposition).toBe("open");
		expect(recorder.appended.some((goal) => goal.disposition === "cleared")).toBe(false);
		expect(controller.runView()).toBeUndefined();
	});

	test("restore does not hide unconfirmed cleanup", async () => {
		const ownership = new FakeOwnership();
		const recorder = createGoalHost({ settings: { review: true }, ownership });
		const controller = new GoalController(recorder.host);
		await controller.start("Ship goal");
		await controller.complete("tests passed", { ctx: fakeToolContext() });
		ownership.last.stopChildren = false;
		ownership.last.failures = ["child-1: stop unconfirmed"];
		await controller.pause("pause");
		await controller.restore();
		expect(controller.cleanupFailures).toEqual(["child-1: stop unconfirmed"]);
		await expect(controller.resume()).rejects.toThrow("cleanup is unconfirmed");
	});
});

describe("authorization guards", () => {
	test("start refuses to authorize a run when no model is selected", async () => {
		const { controller, appended, delivered, state } = setup();
		await expect(
			controller.start("Ship goal", { waitForIdle: async () => {}, modelReady: () => false }),
		).rejects.toThrow("No model is selected");
		expect(appended).toHaveLength(0);
		expect(controller.document).toBeUndefined();
		expect(controller.runView()).toBeUndefined();
		expect(delivered).toHaveLength(0);
		expect(state.toolActive).toBe(false);
	});

	test("start rechecks the model after the host handoff", async () => {
		const { controller, appended, delivered } = setup();
		let ready = true;
		await expect(
			controller.start("Ship goal", {
				waitForIdle: async () => {
					ready = false;
				},
				modelReady: () => ready,
			}),
		).rejects.toThrow("No model is selected");
		expect(appended).toHaveLength(0);
		expect(delivered).toHaveLength(0);
		expect(controller.runView()).toBeUndefined();
	});

	test("resume refuses when no model is selected and leaves the goal paused", async () => {
		const { controller, appended } = setup();
		await controller.start("Ship goal");
		await controller.pause("paused by the user");
		const written = appended.length;
		await expect(
			controller.resume({ waitForIdle: async () => {}, modelReady: () => false }),
		).rejects.toThrow("No model is selected");
		expect(appended).toHaveLength(written);
		expect(controller.runView()).toBeUndefined();
		expect(controller.document?.lastPauseReason).toBe("paused by the user");
	});

	test("a kickoff deferred past pause, clear, or navigation is cancelled at agent_start", async () => {
		const revokers: Array<[string, (controller: GoalController) => Promise<unknown>]> = [
			["pause", (controller) => controller.pause("paused by the user")],
			["clear", (controller) => controller.clear()],
			["navigation", (controller) => controller.restore()],
		];
		for (const [name, revoke] of revokers) {
			const { controller, appended, notices, state } = setup();
			await controller.start("Ship goal");
			const stale = kickoffOf(controller);
			await revoke(controller);
			const aborts = state.aborts;
			controller.handleBeforeAgentStart(customStartEvent({ details: stale }));
			controller.handleAgentStart();
			expect(state.aborts, name).toBe(aborts + 1);
			expect(
				notices.some((notice) => notice.message.includes("already ended")),
				name,
			).toBe(true);
			await controller.handleSettled(true);
			expect(controller.runView(), name).toBeUndefined();
			expect(
				appended.some((goal) => goal.lastPauseReason?.includes("turn was aborted")),
				name,
			).toBe(false);
		}
	});

	test("a stale kickoff does not pause the replacement run it was superseded by", async () => {
		const { controller, appended, state } = setup();
		await controller.start("first goal");
		const stale = kickoffOf(controller);
		await controller.pause("paused by the user");
		await controller.resume();
		const aborts = state.aborts;
		const written = appended.length;
		controller.handleBeforeAgentStart(customStartEvent({ details: stale }));
		controller.handleAgentStart();
		expect(state.aborts).toBe(aborts + 1);
		await controller.handleSettled(true);
		expect(controller.runView()?.phase).toBe("working");
		expect(appended).toHaveLength(written);
		expect(state.toolActive).toBe(true);
	});

	test("a kickoff for the live run still binds its settlement to that run", async () => {
		const { controller, appended } = setup();
		await controller.start("Ship goal");
		controller.handleBeforeAgentStart(customStartEvent({ details: kickoffOf(controller) }));
		controller.handleAgentStart();
		await controller.handleSettled(true);
		expect(controller.runView()).toBeUndefined();
		expect(appended[appended.length - 1]?.lastPauseReason).toContain("turn was aborted");
	});
});

describe("native settle continuation", () => {
	test("proposes one continuation even when the assistant-final context cannot continue", async () => {
		const { controller, appended } = setup();
		await controller.start("Ship goal");
		const result = await controller.handleBoundary(boundaryEvent({ canContinue: false }));
		expect(result?.continue).toBe(true);
		expect(result?.entries).toHaveLength(2);
		const snapshot = result?.entries?.[0];
		expect(snapshot?.type).toBe("custom");
		if (snapshot?.type === "custom") {
			expect(snapshot.customType).toBe(GOAL_ENTRY_TYPE);
			const data = snapshot.data as GoalDocument;
			expect(data.usage.continuations).toBe(1);
		}
		const message = result?.entries?.[1];
		expect(message?.type).toBe("custom_message");
		if (message?.type === "custom_message") {
			expect(message.customType).toBe(GOAL_CONTINUATION_MESSAGE_TYPE);
			expect(message.display).toBe(false);
		}
		// The draft is committed by Pi, so it is not also appended as an entry and memory keeps
		// reporting committed facts only.
		expect(appended).toHaveLength(1);
		expect(controller.document?.usage.continuations).toBe(0);
	});

	test("the committed draft becomes the next continuation's budget input", async () => {
		const entries: GoalDocument[] = [];
		const { controller } = setup({
			settings: { continuations: 1 },
			branchEntries: () => branchOf(...entries),
		});
		entries.push(pausedGoal({ disposition: "open", budgets: { continuations: 1, reviews: 1 } }));
		await controller.restore();
		await expect(controller.resume()).resolves.toContain("Continuations 0/1");
		const draft = await controller.handleBoundary(boundaryEvent());
		const committed = draft?.entries?.[0];
		expect(committed?.type).toBe("custom");
		if (committed?.type === "custom") entries.push(committed.data as GoalDocument);
		expect((await controller.handleBoundary(boundaryEvent()))?.continue).toBeUndefined();
		expect(controller.runView()).toBeUndefined();
		expect(controller.document?.usage.continuations).toBe(1);
	});

	test("does not override another continuation or queued input", async () => {
		const { controller } = setup();
		await controller.start("Ship goal");
		expect(await controller.handleBoundary(boundaryEvent({ continue: true }))).toBeUndefined();
		expect(
			await controller.handleBoundary(boundaryEvent({ pendingMessage: true })),
		).toBeUndefined();
		expect(controller.document?.usage.continuations).toBe(0);
	});

	test("pauses when the budget is exhausted instead of proposing again", async () => {
		const { controller, appended } = setup({ settings: { continuations: 0 } });
		await controller.start("Ship goal");
		expect(await controller.handleBoundary(boundaryEvent())).toBeUndefined();
		expect(controller.runView()).toBeUndefined();
		expect(appended[appended.length - 1]?.lastPauseReason).toBe("continuation budget exhausted");
	});

	test("an error outcome and an aborted turn both pause", async () => {
		const first = setup();
		await first.controller.start("Ship goal");
		await first.controller.handleBoundary(boundaryEvent({ outcome: "error" }));
		expect(first.controller.runView()).toBeUndefined();

		const second = setup();
		await second.controller.start("Ship goal");
		second.controller.handleAgentStart();
		await second.controller.handleSettled(true);
		expect(second.controller.runView()).toBeUndefined();
		expect(second.appended[second.appended.length - 1]?.lastPauseReason).toContain("aborted");
	});

	test("an aborted settlement from a revoked run does not pause its replacement", async () => {
		const { controller } = setup();
		await controller.start("first goal");
		controller.handleAgentStart();
		await controller.pause("paused by the user");
		await controller.resume();
		await controller.handleSettled(true);
		expect(controller.runView()?.phase).toBe("working");
		controller.handleAgentStart();
		await controller.handleSettled(true);
		expect(controller.runView()).toBeUndefined();
	});
});

describe("goal tool", () => {
	test("checkpoint and blocked require an active run", async () => {
		const { controller } = setup();
		await expect(controller.checkpoint("x")).rejects.toThrow("not running");
		await controller.start("Ship goal");
		const checkpoint = await controller.checkpoint("read callers");
		expect(checkpoint.text).toContain("Checkpoint saved");
		expect(controller.document?.checkpoint).toBe("read callers");
		expect(controller.document?.definitionRevision).toBe(1);
	});

	test("an aborted tool call revokes the run and cleans up", async () => {
		const { controller, state } = setup();
		await controller.start("Ship goal");
		const abort = new AbortController();
		const call = { ctx: fakeToolContext(), signal: abort.signal };
		abort.abort();
		await expect(controller.checkpoint("x", call)).rejects.toThrow("aborted");
		expect(controller.runView()).toBeUndefined();
		expect(state.aborts).toBe(1);
		expect(controller.document?.lastPauseReason).toContain("tool call was aborted");
	});

	test("blocked ends autonomy and records the reason", async () => {
		const { controller, notices, state } = setup();
		await controller.start("Ship goal");
		const outcome = await controller.blocked("needs a product decision");
		expect(outcome.details.disposition).toBe("blocked");
		expect(controller.runView()).toBeUndefined();
		expect(controller.document?.blockedReason).toBe("needs a product decision");
		expect(notices.some((notice) => notice.level === "warning")).toBe(true);
		expect(state.aborts).toBe(0);
	});

	test("complete requires evidence and finishes without review", async () => {
		const { controller, state, notices } = setup();
		await controller.start("Ship goal");
		await expect(controller.complete("  ")).rejects.toThrow("evidence");
		const outcome = await controller.complete("tests passed");
		expect(outcome.details.disposition).toBe("completed");
		expect(controller.document?.evidence).toBe("tests passed");
		expect(controller.runView()).toBeUndefined();
		expect(state.toolActive).toBe(false);
		expect(notices.some((notice) => notice.message.includes("completed"))).toBe(true);
	});

	test("read without a goal explains the command but does not fabricate facts", async () => {
		const { controller } = setup();
		await expect(controller.readTool()).rejects.toThrow("/goal start");
		expect(controller.statusText()).toContain("No goal");
	});

	test("a required review fails loudly when no provider owns reviews", async () => {
		const { controller } = setup({ settings: { review: true } });
		await controller.start("Ship goal");
		await expect(controller.complete("tests passed", { ctx: fakeToolContext() })).rejects.toThrow(
			"Independent review is required",
		);
		expect(controller.document?.disposition).toBe("open");
		expect(controller.runView()?.phase).toBe("working");
	});

	test("review completion passes the native tool context and records the attempt", async () => {
		const ownership = new FakeOwnership();
		const { controller, appended } = setup({ settings: { review: true }, ownership });
		await controller.start("Ship goal");
		const ctx = fakeToolContext();
		const outcome = await controller.complete("tests passed", { ctx });
		expect(outcome.details.phase).toBe("reviewing");
		const scope = ownership.last;
		expect(scope.requests).toHaveLength(1);
		expect(scope.requests[0]?.agent).toBe("reviewer");
		expect(scope.requests[0]?.ctx).toBe(ctx);
		expect(scope.requests[0]?.task).toContain("VERDICT: APPROVED");
		expect(appended[appended.length - 1]?.usage.reviews).toBe(1);
		expect(appended[appended.length - 1]?.lastReview?.verdict).toBe("pending");
		expect(controller.runView()?.review?.childId).toBe(scope.children.keys().next().value);
	});
});
