import type { ToolPresentationContext } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { presentAskUser } from "../src/presentation";
import { createTheme } from "./fixtures/harness";

const theme = createTheme();
const context = (overrides: Partial<ToolPresentationContext> = {}) =>
	({ isPartial: false, isError: false, ...overrides }) as ToolPresentationContext;

const rowsOf = (presentation: ReturnType<typeof presentAskUser>): string =>
	[
		...(presentation.collapsedRows ?? []),
		...(presentation.sections ?? []).flatMap((section) =>
			typeof section.content === "string"
				? section.content.split("\n")
				: Array.isArray(section.content)
					? [...section.content]
					: [],
		),
	].join("\n");

const singleDetails = (overrides: Record<string, unknown> = {}) => ({
	question: "Pick a color",
	options: [{ title: "Red" }, { title: "Blue" }],
	response: { kind: "selection", selections: ["Blue"] },
	cancelled: false,
	...overrides,
});

describe("presentAskUser calls", () => {
	test("summarises a single question and lists its options", () => {
		const presentation = presentAskUser(
			{ question: "Which database?", options: ["Postgres", "SQLite"] },
			undefined,
			theme,
			context(),
		);
		expect(presentation.summary).toBe("Which database?");
		expect(presentation.status).toBe("running");
		expect(rowsOf(presentation)).toContain("1. Postgres");
		expect(rowsOf(presentation)).toContain("2. SQLite");
	});

	test("counts a batch and keeps the heading out of the question list", () => {
		const presentation = presentAskUser(
			{
				question: "Two decisions",
				questions: [
					{ question: "Which database?", options: ["Postgres", "SQLite"] },
					{ question: "Anything else?" },
				],
			},
			undefined,
			theme,
			context(),
		);
		expect(presentation.summary).toBe("2 questions · Two decisions");
		expect(rowsOf(presentation)).toContain("1. Which database? (2 option(s))");
		expect(rowsOf(presentation)).toContain("2. Anything else?");
	});

	test("drops option entries it cannot read instead of crashing", () => {
		const presentation = presentAskUser(
			{ question: "Q", options: [{ nope: true }, "Readable"] },
			undefined,
			theme,
			context(),
		);
		expect(rowsOf(presentation)).toContain("1. Readable");
		expect(rowsOf(presentation)).not.toContain("<invalid>");
	});
});

describe("presentAskUser results", () => {
	test("waits for the answer while the call is partial", () => {
		const presentation = presentAskUser(
			{ question: "Q" },
			{ content: [], details: singleDetails() },
			theme,
			context({ isPartial: true }),
		);
		expect(presentation.summary).toBe("Q");
		expect(presentation.status).toBe("running");
		expect(presentation.replaceCallOnPartial).toBe(true);
		expect(rowsOf(presentation)).toContain("Waiting for user input...");
		expect(rowsOf(presentation)).not.toContain("✓");
	});

	test("reports a failure with the error text and no answer rows", () => {
		const presentation = presentAskUser(
			{ question: "Q" },
			{ content: [{ type: "text", text: "UI failed" }], details: undefined, isError: true },
			theme,
			context({ isError: true }),
		);
		expect(presentation.status).toBe("error");
		expect(presentation.summary).toBe("UI failed");
		expect(presentation.output).toBe("UI failed");
	});

	test("marks the selected options and keeps the question in the sections", () => {
		const presentation = presentAskUser(
			{ question: "Pick a color" },
			{
				content: [{ type: "text", text: "User answered: Blue" }],
				details: singleDetails({
					options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }],
				}),
			},
			theme,
			context(),
		);
		expect(presentation.summary).toBe("Pick a color → Blue");
		expect(presentation.status).toBe("ok");
		expect(rowsOf(presentation)).toContain("● Blue");
		expect(rowsOf(presentation)).toContain("○ Red");
		expect(rowsOf(presentation)).toContain("Pick a color");
		expect(presentation.copy?.primary).toBe("Blue");
	});

	test("cancelled questions say so instead of reporting an empty answer", () => {
		const presentation = presentAskUser(
			{ question: "Q" },
			{ content: [], details: singleDetails({ question: "Q", response: null, cancelled: true }) },
			theme,
			context(),
		);
		expect(presentation.status).toBe("warn");
		expect(presentation.summary).toBe("Q → cancelled");
		expect(rowsOf(presentation)).toContain("Cancelled");
	});
});

describe("presentAskUser batches", () => {
	const details = {
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
	};
	const present = (overrides: Record<string, unknown> = {}) =>
		presentAskUser(
			{ questions: details.questions },
			{ content: [{ type: "text", text: "boom" }], details: { ...details, ...overrides } },
			theme,
			context(),
		);

	test("counts answered questions and names each answer", () => {
		const presentation = present();
		expect(presentation.summary).toBe("2 of 2 answered");
		expect(presentation.status).toBe("ok");
		expect(rowsOf(presentation)).toContain("2 of 2 answered");
		expect(rowsOf(presentation)).toContain("1. Which database? → Postgres");
		expect(rowsOf(presentation)).toContain("2. Anything else? → (wrote) No");
	});

	test("keeps context and option markers in the sections only", () => {
		const presentation = present();
		expect((presentation.collapsedRows ?? []).join("\n")).not.toContain("private context");
		expect(rowsOf(presentation)).toContain("private context");
		expect(rowsOf(presentation)).toContain("● Postgres");
		expect(rowsOf(presentation)).toContain("○ SQLite");
	});

	test("counts skipped questions separately", () => {
		const presentation = present({
			answers: [details.answers[0], { status: "skipped" }],
		});
		expect(presentation.summary).toBe("1 of 2 answered");
		expect(rowsOf(presentation)).toContain("2. Anything else? → (skipped)");
	});

	test("cancelled batches report cancellation", () => {
		const presentation = present({ answers: [], cancelled: true });
		expect(presentation.summary).toBe("cancelled");
		expect(presentation.status).toBe("warn");
		expect(rowsOf(presentation)).toContain("Cancelled");
	});
});
