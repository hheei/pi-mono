import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { FREEFORM_SENTINEL } from "./constants";
import {
	type AskResponse,
	type AskUIResult,
	type BatchAnswer,
	createFreeformResponse,
	createSelectionResponse,
	formatOptionsForMessage,
	isCancelledInput,
} from "./response";
import type { BatchQuestion } from "./schema";
import type { QuestionOption } from "./single-select-layout";

function parseDialogSelections(input: string): string[] {
	return input
		.split(",")
		.map((selection) => selection.trim())
		.filter(Boolean);
}

type DialogOptions = { signal?: AbortSignal; timeout?: number };

/** The host's text dialog, typed so the caller only deals with the answer. */
export function askText(
	ui: DialogUI,
	prompt: string,
	placeholder: string,
	options: DialogOptions | undefined,
): Promise<string | undefined> {
	return ui.input(prompt, placeholder, options) as Promise<string | undefined>;
}

/** The host's single-choice dialog; `undefined` means the user dismissed it. */
function askSelect(
	ui: DialogUI,
	prompt: string,
	options: string[],
	dialogOptions: DialogOptions | undefined,
): Promise<string | undefined> {
	return ui.select(prompt, options, dialogOptions) as Promise<string | undefined>;
}

/** The two host dialog methods the RPC/headless fallback degrades to. */
type DialogUI = Pick<ExtensionUIContext, "select" | "input">;

/**
 * Runs one dialog stage with the time the deadline has left. `null` means the
 * prompt was already cancelled or the deadline passed, so a host that answers
 * late cannot continue the flow.
 */
async function runDialogStage<T>(
	dialogOpts: DialogOptions | undefined,
	deadline: number | undefined,
	run: (options: DialogOptions | undefined) => Promise<T>,
): Promise<{ value: T } | null> {
	if (dialogOpts?.signal?.aborted) return null;
	let options = dialogOpts;
	if (deadline !== undefined) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return null;
		options = { ...dialogOpts, timeout: remaining };
	}
	const value = await run(options);
	return dialogOpts?.signal?.aborted ? null : { value };
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
export async function askViaDialogs(
	ui: DialogUI,
	question: string,
	context: string | undefined,
	options: QuestionOption[],
	allowMultiple: boolean,
	allowFreeform: boolean,
	dialogOpts?: DialogOptions,
	deadline?: number,
): Promise<AskUIResult | null> {
	const prompt = context ? `${question}\n\nContext:\n${context}` : question;

	if (allowMultiple) {
		const optionList = formatOptionsForMessage(options);
		const selection = await runDialogStage(dialogOpts, deadline, (opts) =>
			askText(
				ui,
				`${prompt}\n\nOptions (select one or more):\n${optionList}`,
				"Type your selection(s)...",
				opts,
			),
		);
		const typed = selection?.value;
		if (typed === undefined || isCancelledInput(typed)) return null;
		const selections = parseDialogSelections(typed);
		return selections.length === 0 ? null : createSelectionResponse(selections);
	}

	const selectOptions = options.map((option) => option.title);
	if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);
	const selection = await runDialogStage(dialogOpts, deadline, (opts) =>
		askSelect(ui, prompt, selectOptions, opts),
	);
	const value = selection?.value;
	if (value === undefined || isCancelledInput(value)) return null;

	if (value === FREEFORM_SENTINEL) {
		const answer = await runDialogStage(dialogOpts, deadline, (opts) =>
			askText(ui, prompt, "Type your answer...", opts),
		);
		const text = answer?.value;
		if (text === undefined || isCancelledInput(text)) return null;
		return createFreeformResponse(text);
	}

	return createSelectionResponse([value]);
}

/**
 * RPC/headless fallback for a `questions` batch: ask each question in turn
 * with the select()/input() dialogs. There is no review step here, so
 * cancelling any question cancels the whole batch, and every dialog stage
 * shares one deadline.
 */
export async function askBatchViaDialogs(
	ui: DialogUI,
	questions: BatchQuestion[],
	signal: AbortSignal | undefined,
	deadline: number | undefined,
	heading?: string,
): Promise<BatchAnswer[] | null> {
	const dialogOpts = signal ? { signal } : undefined;
	const answers: BatchAnswer[] = [];
	for (const [index, entry] of questions.entries()) {
		const title = `${heading ? `${heading}\n` : ""}(${index + 1}/${questions.length}) ${entry.question}`;
		let response: AskResponse | null;
		if (entry.options.length === 0) {
			const prompt = entry.context ? `${title}\n\nContext:\n${entry.context}` : title;
			const answer = await runDialogStage(dialogOpts, deadline, (opts) =>
				askText(ui, prompt, "Type your answer...", opts),
			);
			if (answer === null) return null;
			response = createFreeformResponse(answer.value);
		} else {
			response = await askViaDialogs(
				ui,
				title,
				entry.context,
				entry.options,
				entry.allowMultiple,
				entry.allowFreeform,
				dialogOpts,
				deadline,
			);
		}
		if (!response) return null;
		answers.push({ status: "answered", response });
	}
	return answers;
}
