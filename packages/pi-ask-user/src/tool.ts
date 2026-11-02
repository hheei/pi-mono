import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BATCH_MAX_QUESTIONS, BATCH_MIN_QUESTIONS } from "./constants";
import { executeBatch, executeSingle } from "./execute";
import { createAskUserRenderers } from "./presentation";
import { type AskParams, StringEnum } from "./schema";

const ASK_DESCRIPTION =
	"Ask the user a question with optional multiple-choice answers, or 2-4 independent questions in one prompt. The turn blocks until the user answers.";
const ASK_PROMPT_SNIPPET =
	"Ask the user one focused question, or 2-4 independent ones together, with optional multiple-choice answers";
const ASK_PROMPT_GUIDELINES: string[] = [
	"ask_user: gather context with tools (read/web/ref) first and put a short summary of findings in context; the user sees only what you send.",
	"ask_user: use it when intent is ambiguous, when a decision needs explicit user input, or when several valid options exist.",
	"ask_user: ask one focused question per call; never bundle numbered, multipart, or unrelated questions into one question.",
	"ask_user: use questions (2-4 entries) only for independent decisions whose prerequisites are settled; anything that depends on an earlier answer belongs in a later call.",
	"ask_user: with questions, put every question inside questions; a top-level question is only the batch heading and is never asked.",
	"ask_user: keep option titles short and put the trade-off in description; allowFreeform is on by default, so do not invent an option for every possible answer.",
];
const ASK_PARAMETER_DESCRIPTIONS = {
	question:
		"The question to ask. With questions, it is only an optional heading for the batch; put every actual question inside questions.",
	questions:
		"2-4 independent questions shown together, used instead of question. Set context, options, allowMultiple, and allowFreeform on each entry; the remaining parameters apply to the whole batch.",
	batchQuestion: "One question in the batch",
	context: "Relevant context shown before the question (summary of findings)",
	options: "Options for the user to choose from",
	allowMultiple: "Allow selecting multiple options (default: false)",
	allowFreeform: "Add a freeform text option (default: true)",
	displayMode:
		"'overlay' shows a centered modal, 'inline' renders in place (default: displayMode in the askUser section of ext_settings.json, otherwise 'overlay')",
	timeoutMs: "Auto-dismiss after N milliseconds; the result is cancelled",
} as const;

// Flat object shape: union item schemas get stripped or rejected by several
// providers/proxies (Google function calling, Codex-style backends, cmux),
// leaving the model to guess the shape and produce empty options. Plain
// strings are still accepted at runtime for older transcripts. See issue #22.
const optionSchema = Type.Object({
	title: Type.String({ description: "Short title for this option" }),
	description: Type.Optional(
		Type.String({ description: "Longer description explaining this option" }),
	),
});

const questionEntrySchema = Type.Object({
	question: Type.String({ description: ASK_PARAMETER_DESCRIPTIONS.batchQuestion }),
	context: Type.Optional(Type.String({ description: ASK_PARAMETER_DESCRIPTIONS.context })),
	options: Type.Optional(
		Type.Array(optionSchema, { description: ASK_PARAMETER_DESCRIPTIONS.options }),
	),
	allowMultiple: Type.Optional(
		Type.Boolean({ description: ASK_PARAMETER_DESCRIPTIONS.allowMultiple }),
	),
	allowFreeform: Type.Optional(
		Type.Boolean({ description: ASK_PARAMETER_DESCRIPTIONS.allowFreeform }),
	),
});

export function registerAskUserTool(pi: ExtensionAPI) {
	pi.registerTool({
		// Asks the user, so only the model may call it; codemode scripts cannot open prompts.
		exposure: "model-only",
		name: "ask_user",
		label: "ask_user",
		description: ASK_DESCRIPTION,
		promptSnippet: ASK_PROMPT_SNIPPET,
		promptGuidelines: ASK_PROMPT_GUIDELINES,
		// Block other tool calls in the same assistant turn until the user answers,
		// so the model cannot batch ask_user with bash/edit/write and let those run
		// (potentially with side effects) before the user sees the prompt.
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.Optional(Type.String({ description: ASK_PARAMETER_DESCRIPTIONS.question })),
			questions: Type.Optional(
				Type.Array(questionEntrySchema, {
					minItems: BATCH_MIN_QUESTIONS,
					maxItems: BATCH_MAX_QUESTIONS,
					description: ASK_PARAMETER_DESCRIPTIONS.questions,
				}),
			),
			context: Type.Optional(Type.String({ description: ASK_PARAMETER_DESCRIPTIONS.context })),
			options: Type.Optional(
				Type.Array(optionSchema, { description: ASK_PARAMETER_DESCRIPTIONS.options }),
			),
			allowMultiple: Type.Optional(
				Type.Boolean({ description: ASK_PARAMETER_DESCRIPTIONS.allowMultiple }),
			),
			allowFreeform: Type.Optional(
				Type.Boolean({ description: ASK_PARAMETER_DESCRIPTIONS.allowFreeform }),
			),
			displayMode: Type.Optional(
				StringEnum(["overlay", "inline"] as const, {
					description: ASK_PARAMETER_DESCRIPTIONS.displayMode,
				}),
			),
			timeout_ms: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: ASK_PARAMETER_DESCRIPTIONS.timeoutMs,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const ask = params as AskParams;
			const questions = ask.questions;
			if (questions !== undefined && questions.length > 1) {
				return executeBatch(pi, ask, signal, onUpdate, ctx);
			}
			// A one-entry batch is one question: models wrap a single question in questions often
			// enough that rejecting it would cost the whole turn.
			const only = questions?.[0];
			if (only === undefined) return executeSingle(pi, ask, signal, onUpdate, ctx);
			const single: AskParams = { ...ask, ...only };
			delete single.questions;
			return executeSingle(pi, single, signal, onUpdate, ctx);
		},

		...createAskUserRenderers(pi),
	});
}
