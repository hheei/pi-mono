import type { QuestionOption } from "./single-select-layout";

export type AskResponse =
	| { kind: "selection"; selections: string[] }
	| { kind: "freeform"; text: string };

export interface AskToolDetails {
	question: string;
	context?: string | undefined;
	options: QuestionOption[];
	response: AskResponse | null;
	cancelled: boolean;
}

export type BatchAnswer = { status: "answered"; response: AskResponse } | { status: "skipped" };

/** Result details of a `questions` batch. Single-question results keep AskToolDetails. */
export interface AskBatchDetails {
	kind: "batch";
	/** The top-level question sent alongside questions, shown as the batch heading. */
	heading?: string;
	questions: Array<{ question: string; context?: string | undefined; options: QuestionOption[] }>;
	/** Index-aligned with `questions`; empty when the batch was cancelled. */
	answers: BatchAnswer[];
	cancelled: boolean;
}

export function isBatchDetails<T extends AskToolDetails | AskBatchDetails>(
	details: T,
): details is Extract<T, AskBatchDetails> {
	return (details as AskBatchDetails).kind === "batch";
}

export type AskUIResult = AskResponse;

export function formatOptionsForMessage(options: QuestionOption[]): string {
	return options
		.map((option, index) => {
			const desc = option.description ? ` — ${option.description}` : "";
			return `${index + 1}. ${option.title}${desc}`;
		})
		.join("\n");
}

export function createFreeformResponse(text: string | null | undefined): AskResponse | null {
	const trimmed = text?.trim();
	return trimmed ? { kind: "freeform", text: trimmed } : null;
}

export function createSelectionResponse(selections: string[]): AskResponse | null {
	const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
	return normalizedSelections.length === 0
		? null
		: { kind: "selection", selections: normalizedSelections };
}

export function formatResponseSummary(response: AskResponse): string {
	return response.kind === "freeform" ? response.text : response.selections.join(", ");
}

export function isSelectionResponse(
	response: AskResponse,
): response is Extract<AskResponse, { kind: "selection" }> {
	return response.kind === "selection";
}

/** An empty dialog answer (dismissed or blank) cancels instead of recording a response. */
export function isCancelledInput(value: string | undefined): boolean {
	return value === undefined || value.trim() === "";
}
