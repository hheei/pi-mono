import { getEventListeners } from "node:events";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
	createKeybindings,
	createTheme,
	customUI,
	emittedEvents,
	isolateAgentDir,
	setupTool,
} from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

describe("cancellation correctness", () => {
	const stages = [
		{ name: "no-options input", params: { options: [] }, stage: "input", value: "late answer" },
		{ name: "RPC select", params: {}, stage: "select", value: "A" },
		{ name: "RPC multi-input", params: { allowMultiple: true }, stage: "input", value: "A" },
		{
			name: "RPC freeform input",
			params: {},
			stage: "input",
			value: "late answer",
			freeform: true,
		},
	];

	for (const stage of stages) {
		for (const honorsSignal of [true, false]) {
			test(`${stage.name}: abort cancels ${honorsSignal ? "pending" : "late"} response without another dialog`, async () => {
				const tool = await setupTool();
				const controller = new AbortController();
				let opened!: () => void;
				const pending = new Promise<void>((resolve) => {
					opened = resolve;
				});
				let finish!: (value: string | undefined) => void;
				let dialogOpts: any;
				let dismissed = false;
				let calls = 0;
				let inputCalls = 0;
				const waitForAnswer = (opts: any) => {
					dialogOpts = opts;
					opened();
					return new Promise<string | undefined>((resolve) => {
						finish = resolve;
						if (honorsSignal)
							opts?.signal?.addEventListener(
								"abort",
								() => {
									dismissed = true;
									resolve(undefined);
								},
								{ once: true },
							);
					});
				};
				const execution = tool.execute(
					"id",
					{
						question: "Pick",
						context: "private context",
						options: ["A"],
						timeout_ms: 5000,
						...stage.params,
					},
					controller.signal,
					undefined,
					{
						hasUI: true,
						mode: "rpc",
						ui: {
							custom: customUI(async () => undefined),
							select: async (_title: string, options: string[], opts: any) => {
								calls++;
								if (stage.stage === "select") return waitForAnswer(opts);
								return stage.freeform ? options[options.length - 1] : "A";
							},
							input: async (_title: string, _placeholder: string, opts: any) => {
								calls++;
								inputCalls++;
								if (stage.stage === "comment" && inputCalls === 1) return "A";
								return waitForAnswer(opts);
							},
						},
					},
				);
				await pending;
				const callsBeforeAbort = calls;
				controller.abort();
				// Release a host which ignores the signal too, so regressions fail without hanging.
				finish(stage.value);
				const result = await execution;
				expect(dialogOpts.signal).toBeInstanceOf(AbortSignal);
				expect(dialogOpts.timeout).toBeLessThanOrEqual(5000);
				expect(dialogOpts.timeout).toBeGreaterThan(4000);
				expect(dismissed).toBe(honorsSignal);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.response).toBeNull();
				expect(calls).toBe(callsBeforeAbort);
				expect(emittedEvents.filter((event) => event.name.startsWith("ask:"))).toEqual([
					{ name: "ask:cancelled", payload: { question: "Pick" } },
				]);
			});
		}
	}

	for (const params of [{ allowFreeform: true }, { allowMultiple: true }]) {
		test(`abort after first RPC answer prevents follow-up ${JSON.stringify(params)}`, async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			let calls = 0;
			const result = await tool.execute(
				"id",
				{ question: "Pick", options: ["A"], ...params },
				controller.signal,
				undefined,
				{
					hasUI: true,
					mode: "rpc",
					ui: {
						custom: customUI(async () => undefined),
						select: async (_title: string, options: string[]) => {
							calls++;
							controller.abort();
							return params.allowFreeform ? options[options.length - 1] : "A";
						},
						input: async () => {
							calls++;
							controller.abort();
							return "A";
						},
					},
				},
			);
			expect(calls).toBe(1);
			expect(result.details.cancelled).toBe(true);
		});
	}

	test("abort while custom UI is unavailable prevents opening an RPC dialog", async () => {
		const tool = await setupTool();
		const controller = new AbortController();
		let dialogs = 0;
		const result = await tool.execute(
			"id",
			{ question: "Pick", options: ["A"] },
			controller.signal,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					custom: customUI(async () => {
						controller.abort();
						return undefined;
					}),
					select: async () => {
						dialogs++;
						return "A";
					},
				},
			},
		);
		expect(dialogs).toBe(0);
		expect(result.details.cancelled).toBe(true);
	});

	for (const answer of [undefined, null, "", "   "]) {
		test(`displayed freeform cancellation emits one redacted event: ${JSON.stringify(answer)}`, async () => {
			const tool = await setupTool();
			const result = await tool.execute(
				"id",
				{ question: "Why?", context: "private context" },
				undefined,
				undefined,
				{ hasUI: true, mode: "tui", ui: { input: async () => answer } },
			);
			expect(result.details.cancelled).toBe(true);
			expect(emittedEvents.filter((event) => event.name.startsWith("ask:"))).toEqual([
				{ name: "ask:cancelled", payload: { question: "Why?" } },
			]);
		});
	}

	test("abort between an RPC answer and its caller resuming still cancels", async () => {
		const tool = await setupTool();
		const controller = new AbortController();
		const result = await tool.execute(
			"id",
			{ question: "Pick", options: ["A"] },
			controller.signal,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async () => {
						queueMicrotask(() => queueMicrotask(() => controller.abort()));
						return "A";
					},
				},
			},
		);
		expect(result.details.cancelled).toBe(true);
		expect(result.details.response).toBeNull();
	});

	test("already-aborted calls do not display or emit an outcome", async () => {
		const tool = await setupTool();
		const controller = new AbortController();
		controller.abort();
		const result = await tool.execute("id", { question: "Pick" }, controller.signal, undefined, {
			hasUI: true,
			mode: "tui",
			ui: {},
		});
		expect(result.details.cancelled).toBe(true);
		expect(emittedEvents).toEqual([]);
	});

	for (const outcome of [
		"answer",
		"escape",
		"timeout",
		"abort",
		"construction-error",
		"host-error",
	]) {
		test(`custom ${outcome} releases owned resources and completes at most once`, async () => {
			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const tool = await setupTool();
			const controller = new AbortController();
			let completions = 0;
			const execution = tool.execute(
				"id",
				{ question: "Pick", options: ["A"], timeout_ms: 3600000 },
				controller.signal,
				undefined,
				{
					hasUI: true,
					mode: "tui",
					ui: {
						custom: customUI(async (factory: any) => {
							const component = factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								outcome === "construction-error"
									? {
											...createTheme(),
											fg() {
												throw new Error("bad theme");
											},
										}
									: createTheme(),
								createKeybindings(),
								() => {
									completions++;
								},
							);
							if (outcome === "host-error") throw new Error("host rejected custom UI");
							if (outcome === "answer" || outcome === "escape")
								component.handleInput(outcome === "answer" ? "enter" : "escape");
							if (outcome === "timeout") vi.advanceTimersByTime(3_600_000);
							if (outcome === "abort") controller.abort();
							return new Promise(() => {});
						}),
					},
				},
			);
			const isError = outcome === "construction-error" || outcome === "host-error";
			if (isError) {
				await expect(execution).rejects.toThrow(
					outcome === "construction-error" ? "bad theme" : "host rejected custom UI",
				);
			} else {
				const result = await execution;
				expect(result.details.cancelled).toBe(outcome !== "answer");
			}
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(completions).toBeLessThanOrEqual(1);
		});
	}
});
