import { expect, test } from "vitest";
import { bootReviewHost, waitForRejection, waitUntil } from "./fixtures/real-host-review.js";

test("pausing in a later boundary handler commits the visible feedback but starts no request", async () => {
	const booted = await bootReviewHost();
	try {
		await booted.invokeGoal("start Ship goal");
		await waitForRejection(booted);
		booted.setPauseOnFeedback(true);
		booted.provider.releaseSecond();
		await waitUntil(() => !booted.session.isStreaming, "the paused operation to settle");
		await booted.invokeGoal("status");
		const paused = booted.notices[booted.notices.length - 1] ?? "";
		expect(paused).toContain("paused");
		expect(booted.reviewMessages()).toBe(1);
		expect(booted.provider.calls).toBe(2);
	} finally {
		await booted.dispose();
	}
});
