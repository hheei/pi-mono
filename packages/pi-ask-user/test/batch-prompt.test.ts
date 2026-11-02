import { expect, onTestFinished, test, vi } from "vitest";
import { editorState } from "./fixtures/fake-host";
import {
	customUI,
	emittedEvents,
	isolateAgentDir,
	mountBatchPrompt,
	press,
	rejectedError,
	setupTool,
	stubEnv,
} from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

type Ui = Record<string, (...args: any[]) => Promise<unknown>>;

function countingUi(calls: { count: number }): Ui {
	const open = async () => {
		calls.count++;
		return undefined;
	};
	return { custom: open, select: open, input: open };
}

const validationCases: Array<{
	name: string;
	params: Record<string, unknown>;
	expected: string[];
	noUI?: boolean;
}> = [
	{ name: "neither question nor questions", params: {}, expected: ["needs question"] },
	{
		name: "five entries",
		params: { questions: ["A?", "B?", "C?", "D?", "E?"].map((question) => ({ question })) },
		expected: ["at most 4"],
	},
	{
		name: "a non-array questions value",
		params: { questions: "First?" },
		expected: ["must be an array"],
	},
	{
		name: "a blank question",
		params: { questions: [{ question: "  " }, { question: "Second?" }] },
		expected: ["questions[0].question must be a non-empty string"],
	},
	{
		name: "a duplicate question",
		params: { questions: [{ question: "Same?" }, { question: "same?" }] },
		expected: ["questions[1] repeats the question"],
	},
	{
		name: "an entry whose options are all malformed",
		params: { questions: [{ question: "First?" }, { question: "Second?", options: [{}, "  "] }] },
		expected: ["in questions[1] were malformed", '{ "title": "Short label"'],
	},
	{
		name: "no interactive UI",
		params: {
			questions: [
				{ question: "First?", context: "Why it matters", options: ["Yes", "No"] },
				{ question: "Second?" },
			],
		},
		expected: [
			"requires interactive mode",
			"1. First?",
			"Context: Why it matters",
			"   1. Yes",
			"   2. No",
			"2. Second?",
		],
		noUI: true,
	},
];

for (const { name, params, expected, noUI } of validationCases) {
	test(`throws before any UI or event for ${name}`, async () => {
		const tool = await setupTool();
		const calls = { count: 0 };
		const error = await rejectedError(
			tool.execute(
				"id",
				params,
				undefined,
				undefined,
				noUI ? { hasUI: false } : { hasUI: true, mode: "tui", ui: countingUi(calls) },
			),
		);
		for (const fragment of expected) expect(error.message).toContain(fragment);
		expect(calls.count).toBe(0);
		expect(emittedEvents).toEqual([]);
	});
}

test("a one-entry batch asks that question as a single question", async () => {
	const tool = await setupTool();
	const titles: string[] = [];
	const result = await tool.execute(
		"id",
		{ questions: [{ question: "Only?", options: ["Yes", "No"] }] },
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "rpc",
			ui: {
				custom: customUI(async () => undefined),
				select: async (title: string) => {
					titles.push(title);
					return "Yes";
				},
				input: async () => undefined,
			},
		},
	);
	// No review page and no batch details: the wrapper is unwrapped before the prompt opens.
	expect(titles).toEqual(["Only?"]);
	expect(result.details).toMatchObject({ response: { kind: "selection", selections: ["Yes"] } });
	expect("kind" in result.details).toBe(false);
	expect(emittedEvents.filter((event) => event.name.startsWith("ask:"))).toEqual([
		{ name: "ask:answered", payload: { question: "Only?", response: { kind: "selection" } } },
	]);
});

test("a top-level question sent with questions becomes the batch heading, not a question (#80)", async () => {
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt();
	const execution = tool.execute(
		"id",
		{
			question: "Project setup\nChoose defaults",
			questions: [
				{ question: "Which database?", options: ["Postgres", "SQLite"] },
				{ question: "Which ORM?", options: ["Drizzle", "Prisma"] },
			],
		},
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	await componentReady;
	const prompt = state.component;
	expect(prompt.render(100).join("\n")).toContain(
		"ask_user · Project setup Choose defaults [1] 2 · review",
	);
	expect(prompt.render(100).some((row: string) => row.includes("\n"))).toBe(false);
	press(prompt, "enter", "enter");
	expect(prompt.render(100).join("\n")).toContain("Project setup");
	press(prompt, "enter");
	const result = await execution;
	expect(result.details.heading).toBe("Project setup\nChoose defaults");
	expect(result.details.questions.map((entry: { question: string }) => entry.question)).toEqual([
		"Which database?",
		"Which ORM?",
	]);
	expect(result.content[0]?.text).toBe(
		"Project setup\nChoose defaults\nUser answered 2 of 2 questions:\n1. Which database? → Postgres\n2. Which ORM? → Drizzle",
	);
});

test("top-level single-question fields sent with questions are ignored (#88)", async () => {
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt();
	const execution = tool.execute(
		"id",
		{
			context: "",
			options: [],
			allowMultiple: false,
			allowFreeform: false,
			questions: [
				{ question: "Which database?", options: ["Postgres", "SQLite"] },
				{ question: "Which ORM?", options: ["Drizzle", "Prisma"] },
			],
		},
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	await componentReady;
	press(state.component, "enter", "enter", "enter");
	const result = await execution;
	expect(result.content[0]?.text).toBe(
		"User answered 2 of 2 questions:\n1. Which database? → Postgres\n2. Which ORM? → Drizzle",
	);
});

test("records each page's answer and publishes nothing until the review page submits", async () => {
	stubEnv("PI_ASK_USER_EMIT_FULL_EVENTS", "false");
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt();
	const execution = tool.execute(
		"id",
		{
			questions: [
				{
					question: "Which database?",
					context: "private context",
					options: ["Postgres", "SQLite"],
				},
				{ question: "Anything else?" },
			],
		},
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	await componentReady;
	const prompt = state.component;
	expect(prompt.render(100).join("\n")).toContain("ask_user [1] 2 · review");

	press(prompt, "enter"); // page 1 records Postgres and moves to page 2
	editorState.text = "No"; // page 2 has no options, so it opens straight in the editor
	press(prompt, "enter");
	const review = prompt.render(100).join("\n");
	expect(review).toContain("ask_user 1✓ 2✓ · [review]");
	expect(review).toContain("→ Postgres");
	expect(review).toContain("→ No");
	expect(state.settled).toBe(false);
	expect(emittedEvents.filter((event) => event.name.startsWith("ask:"))).toEqual([]);

	press(prompt, "enter");
	const result = await execution;
	expect(result.details).toEqual({
		kind: "batch",
		questions: [
			{
				question: "Which database?",
				context: "private context",
				options: [{ title: "Postgres" }, { title: "SQLite" }],
			},
			{ question: "Anything else?", options: [] },
		],
		answers: [
			{ status: "answered", response: { kind: "selection", selections: ["Postgres"] } },
			{ status: "answered", response: { kind: "freeform", text: "No" } },
		],
		cancelled: false,
	});
	expect(result.content).toEqual([
		{
			type: "text",
			text: "User answered 2 of 2 questions:\n1. Which database? → Postgres\n2. Anything else? → No",
		},
	]);
	expect(emittedEvents).toEqual([
		{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user response" } },
		{ name: "herdr:blocked", payload: { active: false } },
		{
			name: "ask:answered",
			payload: {
				question: "Which database?",
				response: { kind: "selection" },
				batch: { index: 0, total: 2 },
			},
		},
		{
			name: "ask:answered",
			payload: {
				question: "Anything else?",
				response: { kind: "freeform" },
				batch: { index: 1, total: 2 },
			},
		},
	]);
});

test("falls back to dialogs per question with each entry's own selection mode", async () => {
	const tool = await setupTool();
	const selects: Array<{ title: string; choices: string[] }> = [];
	const inputs: string[] = [];
	const result = await tool.execute(
		"id",
		{
			questions: [
				{ question: "Pick one", options: [{ label: "A" }, { label: "B" }], allowFreeform: false },
				{ question: "Pick many", options: ["X", "Y", "Z"], allowMultiple: true },
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "rpc",
			ui: {
				custom: customUI(async () => undefined),
				select: async (title: string, choices: string[]) => {
					selects.push({ title, choices });
					return "B";
				},
				input: async (title: string) => {
					inputs.push(title);
					return "X, Z";
				},
			},
		},
	);

	expect(selects).toEqual([{ title: "(1/2) Pick one", choices: ["A", "B"] }]);
	expect(inputs).toHaveLength(1);
	expect(inputs[0]).toContain("(2/2) Pick many");
	expect(inputs[0]).toContain("Options (select one or more)");
	expect(result.details.answers).toEqual([
		{ status: "answered", response: { kind: "selection", selections: ["B"] } },
		{ status: "answered", response: { kind: "selection", selections: ["X", "Z"] } },
	]);
});

test("tab moves between pages without moving the option selection, and pages keep their state", async () => {
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt();
	const execution = tool.execute(
		"id",
		{
			questions: [
				{ question: "First?", options: ["A", "B", "C"] },
				{ question: "Second?", options: ["X"] },
			],
		},
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	await componentReady;
	const prompt = state.component;
	press(prompt, "down", "tab"); // highlight B, then leave page 1 unanswered
	expect(prompt.render(100).join("\n")).toContain("ask_user 1 [2] · review");
	press(prompt, "shift+tab", "enter", "enter", "enter"); // back to page 1, answer both, submit
	const result = await execution;
	expect(result.details.answers).toEqual([
		{ status: "answered", response: { kind: "selection", selections: ["B"] } },
		{ status: "answered", response: { kind: "selection", selections: ["X"] } },
	]);
});

test("submitting with unanswered questions needs a second confirmation and reports the skips", async () => {
	stubEnv("PI_ASK_USER_EMIT_FULL_EVENTS", "false");
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt();
	const execution = tool.execute(
		"id",
		{
			questions: [
				{ question: "First?", options: ["A", "B"] },
				{ question: "Second?", options: ["X", "Y"] },
			],
		},
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	await componentReady;
	const prompt = state.component;
	press(prompt, "enter", "tab", "enter"); // answer First?, skip Second?, submit on review
	expect(prompt.render(100).join("\n")).toContain("1 unanswered — press");
	press(prompt, "enter"); // the second submit confirms the skips
	const result = await execution;

	expect(result.details.answers).toEqual([
		{ status: "answered", response: { kind: "selection", selections: ["A"] } },
		{ status: "skipped" },
	]);
});

test("re-answering a page from the review page keeps the last choice", async () => {
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt();
	const execution = tool.execute(
		"id",
		{
			questions: [
				{ question: "First?", options: ["A", "B", "C"] },
				{ question: "Second?", options: ["X"] },
			],
		},
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	// Answer A and X, jump back to question 1 from the review page, choose B, submit.
	await componentReady;
	press(state.component, "enter", "enter", "1", "down", "enter", "enter");
	const result = await execution;
	expect(result.details.answers).toEqual([
		{ status: "answered", response: { kind: "selection", selections: ["B"] } },
		{ status: "answered", response: { kind: "selection", selections: ["X"] } },
	]);
});

test("keeps every answer inside the row cap on a short overlay review", async () => {
	const tool = await setupTool();
	const { state, custom, componentReady } = mountBatchPrompt(8);
	const questions = ["First?", "Second?", "Third?", "Fourth?"];
	const _execution = tool.execute(
		"id",
		{ questions: questions.map((question) => ({ question, options: [`Answer ${question}`] })) },
		undefined,
		undefined,
		{ hasUI: true, mode: "tui", ui: { custom } },
	);
	await componentReady;
	press(state.component, "enter", "enter", "enter", "enter"); // all answered, now on review
	const frame = state.component.render(80);

	// The cap wins over completeness: the first answers and the hints survive, the
	// rest is cut instead of pushing the frame past the row budget.
	expect(frame.length).toBeLessThanOrEqual(6);
	expect(frame.join("\n")).toContain("1. First?");
	expect(frame.join("\n")).toContain("submit");
});

for (const outcome of [
	"esc on a page",
	"esc on the review page",
	"abort after the first answer",
	"timeout",
	"already aborted",
] as const) {
	test(`publishes no answers when the batch ends by ${outcome}`, async () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const tool = await setupTool();
		const controller = new AbortController();
		if (outcome === "already aborted") controller.abort();
		const { state, custom, componentReady } = mountBatchPrompt();
		let prompts = 0;
		const execution = tool.execute(
			"id",
			{
				questions: [
					{ question: "First?", options: ["A"] },
					{ question: "Second?", options: ["B"] },
				],
				timeout_ms: 1000,
			},
			controller.signal,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					custom: customUI(async (factory: any) => {
						prompts++;
						return custom(factory);
					}),
				},
			},
		);
		if (outcome !== "already aborted") {
			await componentReady;
			press(state.component, "enter"); // the first answer is recorded, then the batch ends
			if (outcome === "esc on a page") press(state.component, "escape");
			if (outcome === "esc on the review page") press(state.component, "tab", "escape");
			if (outcome === "abort after the first answer") controller.abort();
			if (outcome === "timeout") {
				// One timer owns the whole batch deadline.
				expect(vi.getTimerCount()).toBe(1);
				vi.advanceTimersByTime(1000);
			}
		}
		const result = await execution;

		expect(result.details).toMatchObject({ kind: "batch", answers: [], cancelled: true });
		expect(emittedEvents.some((event) => event.name === "ask:answered")).toBe(false);
		if (outcome === "already aborted") {
			expect(prompts).toBe(0);
			expect(emittedEvents).toEqual([]);
			return;
		}
		expect(prompts).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: "User cancelled the questions" }]);
		expect(emittedEvents.filter((event) => event.name.startsWith("ask:"))).toEqual([
			{ name: "ask:cancelled", payload: { question: "First?", batch: { index: 0, total: 2 } } },
			{ name: "ask:cancelled", payload: { question: "Second?", batch: { index: 1, total: 2 } } },
		]);
	});
}

test("an abort during the initial update cancels the batch before any prompt opens", async () => {
	const tool = await setupTool();
	const controller = new AbortController();
	let prompts = 0;
	const open = async () => {
		prompts++;
		return "answer";
	};
	const result = await tool.execute(
		"id",
		{ questions: [{ question: "First?" }, { question: "Second?" }] },
		controller.signal,
		() => controller.abort(),
		{ hasUI: true, mode: "tui", ui: { custom: open, select: open, input: open } },
	);
	expect(prompts).toBe(0);
	expect(result.details).toMatchObject({ kind: "batch", answers: [], cancelled: true });
	expect(emittedEvents.some((event) => event.name === "ask:answered")).toBe(false);
});

for (const honorsSignal of [true, false]) {
	test(`the batch deadline closes an open dialog and rejects a late answer (host ${honorsSignal ? "honors" : "ignores"} the signal)`, async () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const tool = await setupTool();
		const selectTimeouts: number[] = [];
		let answerLate!: (value: string) => void;
		let secondOpened!: () => void;
		const opened = new Promise<void>((resolve) => {
			secondOpened = resolve;
		});
		const execution = tool.execute(
			"id",
			{
				questions: [
					{ question: "First?", options: ["A"] },
					{ question: "Second?", options: ["B"] },
				],
				timeout_ms: 1000,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async (_title: string, choices: string[], opts: any) => {
						selectTimeouts.push(opts?.timeout);
						if (selectTimeouts.length === 1) {
							vi.advanceTimersByTime(600);
							return choices[0];
						}
						secondOpened();
						return new Promise((resolve) => {
							answerLate = resolve;
							if (honorsSignal)
								opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
						});
					},
				},
			},
		);
		await opened;
		// The second dialog shows the remaining 400ms, but one batch timer owns the deadline.
		expect(selectTimeouts).toEqual([1000, 400]);
		// One batch timer owns the deadline; the dialogs only see what is left of it.
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(400);
		answerLate("B"); // only reaches the batch when the host ignores the signal
		const result = await execution;

		expect(result.details).toMatchObject({ kind: "batch", answers: [], cancelled: true });
		expect(emittedEvents.some((event) => event.name === "ask:answered")).toBe(false);
	});
}
