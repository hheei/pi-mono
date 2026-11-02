import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AskComponent } from "./ask-prompt";
import { BatchAskComponent } from "./batch-prompt";
import { type CustomPromptRequest, runCustomPrompt } from "./custom-prompt";
import { askBatchViaDialogs, askText, askViaDialogs } from "./dialogs";
import { type AskEventSubject, createAskEventEmitter } from "./events";
import { formatBatchAnswers, formatBatchForMessage, formatSingleForMessage } from "./format";
import {
	type AskBatchDetails,
	type AskResponse,
	type AskToolDetails,
	type BatchAnswer,
	createFreeformResponse,
	formatResponseSummary,
} from "./response";
import {
	type AskParams,
	type BatchQuestion,
	batchHeading,
	coerceOptions,
	malformedOptionsError,
	normalizeBatchQuestions,
} from "./schema";

/** Host text dialog for a prompt without options; shares the caller's deadline and abort. */
async function askForText(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	signal: AbortSignal,
	deadline: number | undefined,
): Promise<AskResponse | null> {
	const prompt = context ? `${question}\n\nContext:\n${context}` : question;
	const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
	const answer = await askText(ctx.ui, prompt, "Type your answer...", {
		signal,
		...(timeout === undefined ? {} : { timeout }),
	});
	// A host dialog that ignores the signal can still resolve after cancellation.
	return signal.aborted ? null : createFreeformResponse(answer);
}

interface InteractivePrompt<T> {
	signal: AbortSignal | undefined;
	timeout: number | undefined;
	/** Absent when the host's own dialog answers instead of a custom surface. */
	createComponent: CustomPromptRequest<T>["createComponent"];
	fallback: CustomPromptRequest<T>["fallback"];
}

/** One prompt run: the surface, its deadline, the abort forwarding, and the dialog fallback. */
async function runInteractive<T>(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: InteractivePrompt<T>,
): Promise<T | null> {
	const { createComponent } = request;
	return await runCustomPrompt<T>(pi, ctx, {
		signal: request.signal,
		timeout: request.timeout,
		...(createComponent === undefined ? {} : { createComponent }),
		fallback: request.fallback,
	});
}

export async function executeSingle(
	pi: ExtensionAPI,
	params: AskParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AskToolDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<AskToolDetails>> {
	const question = params.question;
	if (typeof question !== "string") {
		throw new Error(
			"ask_user needs question (one focused question) or questions (2-4 independent questions).",
		);
	}

	if (signal?.aborted) {
		return {
			content: [{ type: "text", text: "Cancelled" }],
			details: { question, context: params.context, options: [], response: null, cancelled: true },
		};
	}

	const context = params.context?.trim() || undefined;
	const rawOptions = params.options ?? [];
	const options = coerceOptions(rawOptions);
	if (rawOptions.length > 0 && options.length === 0) {
		throw malformedOptionsError(rawOptions.length);
	}
	const prompt: BatchQuestion = {
		question,
		context,
		options,
		allowMultiple: params.allowMultiple ?? false,
		allowFreeform: params.allowFreeform ?? true,
	};
	const base: AskToolDetails = { question, context, options, response: null, cancelled: false };

	if (!ctx.hasUI || !ctx.ui) {
		throw new Error(
			formatSingleForMessage({
				question,
				context,
				options,
				allowFreeform: prompt.allowFreeform,
			}),
		);
	}

	const events = createAskEventEmitter(pi);
	const subject: AskEventSubject = { question, context, options };
	if (options.length > 0) {
		onUpdate?.({
			content: [{ type: "text", text: "Waiting for user input..." }],
			details: base,
		});
	}

	const response = await runInteractive<AskResponse>(pi, ctx, {
		signal,
		timeout: params.timeout_ms,
		createComponent:
			options.length === 0
				? undefined
				: (tui, theme, keybindings, complete) =>
						new AskComponent(prompt, tui, theme, keybindings, complete),
		fallback: (fallbackSignal, deadline) =>
			options.length === 0
				? askForText(ctx, question, context, fallbackSignal, deadline)
				: askViaDialogs(
						ctx.ui,
						question,
						context,
						options,
						prompt.allowMultiple,
						prompt.allowFreeform,
						{ signal: fallbackSignal },
						deadline,
					),
	});

	// A caller abort that lands while the prompt resolves still cancels the answer.
	if (response === null || signal?.aborted) {
		events.cancelled(subject);
		return {
			content: [{ type: "text", text: "User cancelled the question" }],
			details: { ...base, cancelled: true },
		};
	}

	events.answered(subject, response);
	return {
		content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
		details: { ...base, response },
	};
}

export async function executeBatch(
	pi: ExtensionAPI,
	params: AskParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AskBatchDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<AskBatchDetails>> {
	const questions = normalizeBatchQuestions(params);
	const heading = batchHeading(params);
	const subjects: AskEventSubject[] = questions.map(({ question, context, options }) => ({
		question,
		context,
		options,
	}));
	const details = (answers: BatchAnswer[], cancelled: boolean): AskBatchDetails => ({
		kind: "batch",
		...(heading ? { heading } : {}),
		questions: subjects,
		answers,
		cancelled,
	});

	if (signal?.aborted) {
		return {
			content: [{ type: "text", text: "Cancelled" }],
			details: details([], true),
		};
	}

	const events = createAskEventEmitter(pi);

	if (!ctx.hasUI || !ctx.ui) {
		throw new Error(formatBatchForMessage(questions, heading));
	}

	onUpdate?.({
		content: [{ type: "text", text: "Waiting for user input..." }],
		details: details([], false),
	});

	const answers = await runInteractive<BatchAnswer[]>(pi, ctx, {
		signal,
		timeout: params.timeout_ms,
		createComponent: (tui, theme, keybindings, complete) =>
			new BatchAskComponent(questions, tui, theme, keybindings, complete, heading),
		fallback: (fallbackSignal, deadline) =>
			askBatchViaDialogs(ctx.ui, questions, fallbackSignal, deadline, heading),
	});

	if (answers === null || signal?.aborted) {
		subjects.forEach((subject, index) => {
			events.cancelled(subject, { index, total: subjects.length });
		});
		return {
			content: [{ type: "text", text: "User cancelled the questions" }],
			details: details([], true),
		};
	}

	// Skipped questions emit nothing; each answered one emits its usual event.
	answers.forEach((answer, index) => {
		const subject = subjects[index];
		if (answer.status === "answered" && subject) {
			events.answered(subject, answer.response, { index, total: subjects.length });
		}
	});
	const result = details(answers, false);
	return {
		content: [{ type: "text", text: formatBatchAnswers(result) }],
		details: result,
	};
}
