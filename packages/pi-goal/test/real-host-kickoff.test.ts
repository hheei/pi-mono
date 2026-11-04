import { expect, test } from "vitest";
import {
	type BootedKickoffHost,
	bootKickoffHost,
	type KickoffRevocation,
	waitUntil,
} from "./fixtures/real-host-kickoff.js";

const revocations: readonly KickoffRevocation[] = ["pause", "clear", "navigation"];

function assistantTexts(booted: BootedKickoffHost): string[] {
	return booted.session.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		const text = entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		return text === "" ? [] : [text];
	});
}

function kickoffMessages(booted: BootedKickoffHost): number {
	return booted.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-kickoff")
		.length;
}

for (const how of revocations) {
	test(`a kickoff the host deferred past a ${how} starts no provider request`, async () => {
		const booted = await bootKickoffHost();
		try {
			booted.armRevocation(how);
			await booted.invokeGoal("start Ship goal");
			// The goal boundary pauses at the first settlement; the late handler resumes the goal, so
			// Pi defers that kickoff until after the same handler has revoked the run again. The stale
			// operation still starts (a second kickoff message and an aborted assistant turn exist),
			// but it must be cancelled at agent_start before the provider is called.
			await waitUntil(
				() => !booted.session.isStreaming && kickoffMessages(booted) === 2,
				"the stale kickoff operation to finish",
			);
			await booted.invokeGoal("status");
			const status = booted.notices[booted.notices.length - 1] ?? "";
			expect(booted.calls).toBe(1);
			expect(assistantTexts(booted)).toEqual(["done"]);
			expect(status).not.toContain("working");
			if (how === "clear") expect(status).toContain("cleared");
			else expect(status).toContain("paused");
		} finally {
			await booted.dispose();
		}
	});
}
