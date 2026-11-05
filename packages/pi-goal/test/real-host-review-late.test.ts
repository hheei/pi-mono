import { expect, test } from "vitest";
import { bootReviewHost, waitUntil } from "./fixtures/real-host-review.js";

test("a rejection that arrives after the parent turn settled pauses instead of sending stale feedback", async () => {
	const booted = await bootReviewHost({ holdSecond: false, delayRejection: true });
	try {
		await booted.invokeGoal("start Ship goal");
		await waitUntil(
			() => booted.provider.calls >= 2 && !booted.session.isStreaming,
			"the parent turn to settle with the review still pending",
		);
		expect(booted.reviewMessages()).toBe(0);
		booted.settleRejection();
		await waitUntil(() => {
			void booted.invokeGoal("status");
			const status = booted.notices[booted.notices.length - 1] ?? "";
			return status.includes("after the parent turn settled");
		}, "the late rejection to pause the goal");
		expect(booted.reviewMessages()).toBe(0);
		expect(booted.provider.calls).toBe(2);
	} finally {
		await booted.dispose();
	}
});
