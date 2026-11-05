import { expect, test } from "vitest";
import { bootReviewHost, waitForRejection, waitUntil } from "./fixtures/real-host-review.js";

test("a rejection held during a streaming turn is delivered once before the budget pauses", async () => {
	const booted = await bootReviewHost();
	try {
		await booted.invokeGoal("start Ship goal");
		await waitForRejection(booted);
		expect(booted.reviewMessages()).toBe(0);
		expect(booted.continuationMessages()).toBe(0);

		booted.setPauseOnSettled(true);
		booted.provider.releaseSecond();
		await waitUntil(
			() => booted.provider.calls >= 3 && booted.reviewMessages() === 1,
			"the boundary feedback wakeup",
		);
		await waitUntil(() => !booted.session.isStreaming, "the feedback turn to settle");
		await booted.invokeGoal("status");
		const paused = booted.notices[booted.notices.length - 1] ?? "";
		expect(paused).toContain("continuations 1/1");
		expect(paused).toContain("continuation budget exhausted");
		expect(booted.reviewMessages()).toBe(1);
		expect(booted.continuationMessages()).toBe(0);
		// No sendMessage follow-up survives; the settled pause starts no fourth request.
		expect(booted.provider.calls).toBe(3);
	} finally {
		await booted.dispose();
	}
});
