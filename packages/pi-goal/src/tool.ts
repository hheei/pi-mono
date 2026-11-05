import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createToolPresentationRenderers, isRecord, textToolResult } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { GoalController, GoalToolCall, GoalToolDetails } from "./controller.js";

export const GOAL_TOOL_NAME = "goal";

const goalAction = Type.Union(
	[
		Type.Literal("read"),
		Type.Literal("checkpoint"),
		Type.Literal("blocked"),
		Type.Literal("complete"),
	],
	{ description: "read, checkpoint, blocked, or complete." },
);

export const GOAL_PARAMETERS = Type.Object(
	{
		action: goalAction,
		text: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"checkpoint: current state and next step. blocked: the real obstacle plus the input needed. complete: the verification evidence.",
			}),
		),
	},
	{ additionalProperties: false },
);

type GoalParams = Static<typeof GOAL_PARAMETERS>;

const GOAL_DESCRIPTION = [
	"Operate the user-authorized session goal.",
	"read: objective, acceptance criteria, revision, checkpoint, evidence, and remaining autonomy budget.",
	"checkpoint: record the current state and next step; it never changes the goal definition.",
	"blocked: report a genuine obstacle that needs a human decision; autonomy stops and the tool requires /goal resume afterwards.",
	"complete: submit verified evidence. With independent review enabled, the goal stays in reviewing until the reviewer approves or rejects it.",
	"Only usable while a goal run is active. Do not invent progress; never lower the acceptance criteria.",
].join("\n");

const GOAL_SNIPPET = "Read, checkpoint, block, or complete the active session goal";
const GOAL_GUIDELINES = [
	"Use goal when a user-authorized goal run is active: checkpoint real progress, report a real blocker, or submit completion with verification evidence.",
	"Call goal complete only after the acceptance criteria are verified; never claim completion from a plan or a checkpoint.",
] as const;

export function registerGoalTool(
	pi: ExtensionAPI,
	controller: () => GoalController | undefined,
): void {
	const renderers = createToolPresentationRenderers(pi, GOAL_TOOL_NAME, (args, result) => {
		const action = isRecord(args) && typeof args.action === "string" ? args.action : "goal";
		const details = result?.details;
		const summary =
			isRecord(details) && typeof details.summary === "string"
				? `${action} · ${details.summary}`
				: action;
		return { summary };
	});
	const tool: ToolDefinition<typeof GOAL_PARAMETERS, GoalToolDetails> = {
		name: GOAL_TOOL_NAME,
		label: "Goal",
		description: GOAL_DESCRIPTION,
		promptSnippet: GOAL_SNIPPET,
		promptGuidelines: [...GOAL_GUIDELINES],
		parameters: GOAL_PARAMETERS,
		defaultActive: false,
		annotations: { openWorldHint: false },
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!Value.Check(GOAL_PARAMETERS, params)) throw new Error("Invalid goal parameters");
			const active = controller();
			if (active === undefined) throw new Error("Goal runtime is not available in this session.");
			// The native context and abort signal flow into this call only; nothing retains them.
			const outcome = await runAction(active, params, { ctx, signal });
			return textToolResult(outcome.text, outcome.details);
		},
		...renderers,
	};
	pi.registerTool(tool);
}

async function runAction(active: GoalController, params: GoalParams, call: GoalToolCall) {
	const text = params.text ?? "";
	switch (params.action) {
		case "read":
			if (text !== "") throw new Error("goal read takes no text argument");
			return await active.readTool(call);
		case "checkpoint":
			return await active.checkpoint(text, call);
		case "blocked":
			return await active.blocked(text, call);
		case "complete":
			return await active.complete(text, call);
	}
}
