import { expect, test } from "vitest";
import { registerExtensionLifecycle } from "../src/lifecycle.js";
import { createFakePiHost } from "./fixtures.js";

test("replaces an active scope before a repeated session start", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	let generation = 0;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-example",
		start: (context) => {
			generation += 1;
			const current = generation;
			calls.push(`start:${current}`);
			context.resources.add("scope", () => {
				calls.push(`shutdown:${current}`);
			});
		},
	});

	await host.emit("session_start");
	await host.emit("session_start");
	await host.emit("session_shutdown");

	expect(calls).toEqual(["start:1", "shutdown:1", "start:2", "shutdown:2"]);
});

test("cleans registered resources when start fails", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-failing",
		start: (context) => {
			context.resources.add("resource", () => {
				calls.push("cleanup");
			});
			throw new Error("start failed");
		},
	});

	await expect(host.emit("session_start")).rejects.toThrow("start failed");
	expect(calls).toEqual(["cleanup"]);
});

test("tells the scope why it ended before disposing its resources", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-carried",
		start: (context) => {
			context.resources.add("scope", () => {
				calls.push("cleanup");
			});
		},
		end: (reason) => {
			calls.push(`end:${reason}`);
		},
	});

	await host.emit("session_start");
	await host.emit("session_shutdown", { reason: "reload" });

	expect(calls).toEqual(["end:reload", "cleanup"]);
});
