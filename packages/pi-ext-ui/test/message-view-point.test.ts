import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMessageView } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import extension from "../src/extension.js";

test("publishes the message view for one session", async () => {
	const handlers = new Map<string, Array<(event: unknown, context: unknown) => Promise<void>>>();
	const pi = {
		events: {},
		registerFlag() {},
		on(event: string, handler: (event: unknown, context: unknown) => Promise<void>) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;
	extension(pi);
	expect(readMessageView(pi)).toBeUndefined();

	const start = handlers.get("session_start")?.[0];
	const stop = handlers.get("session_shutdown")?.[0];
	if (start === undefined || stop === undefined) throw new Error("lifecycle was not registered");
	await start(
		{ type: "session_start" },
		{
			mode: "rpc",
			sessionManager: { getSessionId: () => "test-session" },
			ui: { notify() {} },
		},
	);
	expect(readMessageView(pi)).toBeTypeOf("function");
	await stop({ type: "session_shutdown" }, {});
	expect(readMessageView(pi)).toBeUndefined();
});
