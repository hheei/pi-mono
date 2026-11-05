import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { readMessageView } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import extension from "../src/extension.js";
import type { MessageView } from "../src/message-view.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as Theme;

function createHost(getSettings: () => unknown = () => ({})) {
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
		getSettings,
	} as unknown as ExtensionAPI;
	const lifecycle = async (
		event: "session_start" | "session_shutdown",
		context: unknown = {
			mode: "rpc",
			sessionManager: { getSessionId: () => "test-session" },
			ui: { notify() {} },
		},
	): Promise<void> => {
		const handler = handlers.get(event)?.[0];
		if (handler === undefined) throw new Error("lifecycle was not registered");
		await handler({ type: event }, context);
	};
	extension(pi);
	return { pi, lifecycle };
}

test("publishes the message view for one session", async () => {
	const { pi, lifecycle } = createHost();
	expect(readMessageView(pi)).toBeUndefined();

	await lifecycle("session_start");
	expect(readMessageView(pi)).toBeTypeOf("function");
	await lifecycle("session_shutdown");
	expect(readMessageView(pi)).toBeUndefined();
});

test("rows keep the pad captured at start after the ctx turns stale", async () => {
	let stale = false;
	const { pi, lifecycle } = createHost(() => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
		return { outputPad: 1 };
	});
	await lifecycle("session_start");
	const factory = readMessageView(pi);
	if (factory === undefined) throw new Error("message view was not published");

	stale = true;
	const view = factory({
		theme,
		header: { kind: "bg-bash", summary: "job" },
		body: "tail output",
	}) as MessageView;
	const row = view.bodyRows(40)[0];
	expect(row?.startsWith(" ")).toBe(true);
	expect(row).toContain("tail output");
});
