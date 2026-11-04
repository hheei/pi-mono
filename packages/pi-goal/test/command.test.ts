import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { registerGoalCommands } from "../src/commands.js";
import { GoalController } from "../src/controller.js";
import { GOAL_PARAMETERS, GOAL_TOOL_NAME, registerGoalTool } from "../src/tool.js";
import { createGoalHost } from "./fixtures/fake-goal.js";

interface CapturedTool {
	readonly name: string;
	readonly defaultActive?: boolean;
	readonly parameters: unknown;
	execute(
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<AgentToolResult<unknown>>;
}

interface CapturedCommand {
	readonly description: string;
	readonly getArgumentCompletions?: (prefix: string) => unknown;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function capture() {
	const tools: CapturedTool[] = [];
	const commands: CapturedCommand[] = [];
	const pi = {
		registerTool(tool: CapturedTool) {
			tools.push(tool);
		},
		registerCommand(_name: string, options: CapturedCommand) {
			commands.push(options);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, commands };
}

function fakeUi(overrides: { hasUI?: boolean; confirm?: boolean; editor?: string } = {}) {
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const value = {
		notices,
		ui: {
			notify(message: string, level?: "info" | "warning" | "error") {
				notices.push({ message, level });
			},
			async confirm() {
				return overrides.confirm ?? true;
			},
			async editor() {
				return overrides.editor ?? "typed objective";
			},
		},
	};
	return value;
}

function commandContext(
	ui: ReturnType<typeof fakeUi>["ui"],
	hasUI = true,
	model = { provider: "test", id: "fake-model" } as unknown,
): ExtensionCommandContext {
	return { ui, hasUI, model, waitForIdle: async () => {} } as unknown as ExtensionCommandContext;
}

function setup() {
	const recorder = createGoalHost();
	const controller = new GoalController(recorder.host);
	const registered = capture();
	registerGoalTool(registered.pi, () => controller);
	registerGoalCommands(registered.pi, () => controller);
	const tool = registered.tools[0];
	const command = registered.commands[0];
	if (tool === undefined || command === undefined) throw new Error("registration failed");
	return { ...recorder, ...registered, controller, tool, command };
}

describe("goal extension registration", () => {
	test("registers one inactive tool and the documented subcommands", () => {
		const { tool, command } = setup();
		expect(tool.name).toBe(GOAL_TOOL_NAME);
		expect(tool.defaultActive).toBe(false);
		expect(tool.parameters).toBe(GOAL_PARAMETERS);
		expect(command.description).toContain("goal");
		const completions = command.getArgumentCompletions?.("") as
			| Array<{ value: string }>
			| null
			| undefined;
		expect(completions?.map((item) => item.value)).toEqual([
			"start",
			"status",
			"pause",
			"resume",
			"clear",
		]);
	});

	test("the command drives start, status, pause, resume, and clear", async () => {
		const test1 = setup();
		const ui = fakeUi();
		const ctx = commandContext(ui.ui);
		await test1.command.handler("start Ship the goal", ctx);
		expect(test1.controller.document?.objective).toBe("Ship the goal");
		expect(ui.notices[0]?.level).toBe("info");

		await test1.command.handler("status", ctx);
		expect(ui.notices[ui.notices.length - 1]?.message).toContain("Ship the goal");

		await test1.command.handler("pause", ctx);
		expect(test1.controller.runView()).toBeUndefined();
		await test1.command.handler("resume", ctx);
		expect(test1.controller.runView()?.phase).toBe("working");
		await test1.command.handler("clear", ctx);
		expect(test1.controller.document?.disposition).toBe("cleared");
	});

	test("start without arguments uses the native editor and can be cancelled", async () => {
		const test1 = setup();
		const typed = fakeUi({ editor: "typed objective" });
		await test1.command.handler("start", commandContext(typed.ui));
		expect(test1.controller.document?.objective).toBe("typed objective");

		const cancelled = setup();
		const empty = fakeUi({ editor: "   " });
		await cancelled.command.handler("start", commandContext(empty.ui));
		expect(cancelled.controller.document).toBeUndefined();
	});

	test("replacing a paused goal needs confirmation", async () => {
		const test1 = setup();
		await test1.controller.start("first goal");
		await test1.controller.pause("pause");

		const refused = fakeUi({ confirm: false });
		await test1.command.handler("start second goal", commandContext(refused.ui));
		expect(test1.controller.document?.objective).toBe("first goal");
		expect(refused.notices.some((notice) => notice.message.includes("cancelled"))).toBe(true);

		const accepted = fakeUi({ confirm: true });
		await test1.command.handler("start second goal", commandContext(accepted.ui));
		expect(test1.controller.document?.objective).toBe("second goal");
	});

	test("an unknown subcommand reports usage", async () => {
		const test1 = setup();
		const ui = fakeUi();
		await test1.command.handler("nonsense", commandContext(ui.ui));
		expect(ui.notices[0]?.message).toContain("Usage");
	});

	test("the goal tool reports facts and requires evidence", async () => {
		const test1 = setup();
		await test1.controller.start("Ship the goal");
		const read = await test1.tool.execute("call-1", { action: "read" }, undefined, undefined, {});
		expect(read.content[0]?.type).toBe("text");
		if (read.content[0]?.type === "text") expect(read.content[0].text).toContain("Ship the goal");

		const checkpoint = await test1.tool.execute(
			"call-2",
			{ action: "checkpoint", text: "callers inspected" },
			undefined,
			undefined,
			{},
		);
		expect(checkpoint.content[0]?.type).toBe("text");
		expect(test1.controller.document?.checkpoint).toBe("callers inspected");

		await expect(
			test1.tool.execute("call-3", { action: "complete" }, undefined, undefined, {}),
		).rejects.toThrow("evidence");
		await test1.tool.execute(
			"call-4",
			{ action: "complete", text: "tests pass" },
			undefined,
			undefined,
			{},
		);
		expect(test1.controller.document?.disposition).toBe("completed");
	});
});
