import { expect, test } from "vitest";
import { bootReviewHost, waitForRejection, waitUntil } from "./fixtures/real-host-review.js";

test("a failed feedback boundary commits nothing and pauses instead of silently acknowledging", async () => {
	const booted = await bootReviewHost();
	try {
		await booted.invokeGoal("start Ship goal");
		await waitForRejection(booted);
		booted.setInvalidBoundary(true);
		booted.provider.releaseSecond();
		await waitUntil(() => !booted.session.isStreaming, "the failed feedback operation to settle");
		await booted.invokeGoal("status");
		const paused = booted.notices[booted.notices.length - 1] ?? "";
		expect(paused).toContain("review feedback could not be delivered");
		expect(booted.reviewMessages()).toBe(0);
		expect(booted.provider.calls).toBe(2);
	} finally {
		await booted.dispose();
	}
});
