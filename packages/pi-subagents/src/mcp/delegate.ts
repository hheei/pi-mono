import { Type } from "typebox";
import { Value } from "typebox/value";
import type { DelegateSubagentInput } from "../domain.js";
import { stripHindsightContent } from "../launch-spec.js";

export interface DelegateMcpInput extends DelegateSubagentInput {
	/** Return immediately with a recoverable delegation ID instead of waiting for settlement. */
	readonly wait?: boolean;
}

/**
 * MCP-facing input contract. A non-blank id is authoritative; a blank id means create.
 * Do not express the target as an exclusive union in the advertised tool schema.
 */
export const delegateInputSchema = Type.Object(
	{
		task: Type.String({
			minLength: 1,
			description: "Work to perform in the selected child session.",
		}),
		wait: Type.Optional(
			Type.Boolean({
				description:
					"Wait for the final result (default true). False returns a recoverable delegation ID immediately.",
			}),
		),
		id: Type.Optional(
			Type.String({
				description:
					'Existing child ID. For a new child, omit id or pass "". A non-blank id takes precedence over agent and reuses its session.',
			}),
		),
		agent: Type.Optional(
			Type.String({
				description:
					"Agent definition for a new child. Ignored whenever a non-blank id is supplied.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for a new child; ignored with a non-blank id.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const delegateToolMetadata = {
	name: "delegate",
	description:
		'Delegate work to a new or existing Pi agent. New: supply agent and omit id or pass id: ""; never invent an id. Continue: supply an existing non-blank id; agent/cwd are ignored. Unknown non-blank ids fail. Returns id, revision, status and hasOutput, and by default waits for the result.',
	inputSchema: delegateInputSchema,
} as const;

/** Validate untrusted MCP arguments before submitting them to the manager. */
export function parseDelegateInput(input: unknown): DelegateMcpInput {
	if (!Value.Check(delegateInputSchema, input)) {
		throw new Error("Invalid delegate parameters");
	}
	if (stripHindsightContent(input.task) === "") throw new Error("Task must not be empty");
	if (!input.id?.trim() && (input.agent === undefined || input.agent.trim() === "")) {
		throw new Error("Agent is required without an id");
	}
	return input;
}
