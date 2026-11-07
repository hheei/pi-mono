import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskResponse } from "./response";
import type { QuestionOption } from "./single-select-layout";

export interface AskEventSubject {
	question: string;
	context?: string | undefined;
	options: QuestionOption[];
}

export const ASK_USER_BLOCKED_EVENT = "pi-ask-user:blocked" as const;
export const ASK_USER_ANSWER_EVENT = "pi-ask-user:answer" as const;
/**
 * The open question, for a front end that wants to render the choices somewhere
 * else. `answer` is the way back: emit `{response}` and the prompt resolves with
 * it, exactly as if the terminal had answered. Last one wins -- only one prompt is
 * open at a time, so there is nothing to name.
 */
export const ASK_USER_QUESTION_EVENT = "pi-ask-user:question" as const;

/** One question as offered to a front end, with its place in the batch. */
export interface AskOpenQuestion {
	index: number;
	total: number;
	question: string;
	context?: string | undefined;
	options: QuestionOption[];
	allowMultiple: boolean;
	allowFreeform: boolean;
}

/** Position of a question inside a `questions` batch, attached to its ask:* events. */
interface BatchPosition {
	index: number;
	total: number;
}

/**
 * Every installed extension receives these events, so they carry only the
 * question and the response kind; the context and the user's actual answer
 * stay inside the tool result (#51).
 */
export function createAskEventEmitter(pi: ExtensionAPI) {
	return {
		answered(subject: AskEventSubject, response: AskResponse, batch?: BatchPosition): void {
			pi.events.emit("ask:answered", {
				question: subject.question,
				response: { kind: response.kind },
				...(batch ? { batch } : {}),
			});
		},
		cancelled(subject: AskEventSubject, batch?: BatchPosition): void {
			pi.events.emit("ask:cancelled", {
				question: subject.question,
				...(batch ? { batch } : {}),
			});
		},
		open(questions: readonly AskOpenQuestion[], heading?: string): void {
			pi.events.emit(ASK_USER_QUESTION_EVENT, {
				...(heading ? { heading } : {}),
				questions: questions.map((question) => ({ ...question })),
			});
		},
		close(): void {
			pi.events.emit(ASK_USER_QUESTION_EVENT, { questions: null });
		},
		blocked(active: boolean, details?: { question?: string }): void {
			pi.events.emit(ASK_USER_BLOCKED_EVENT, {
				active,
				...(details ? details : {}),
			});
		},
	};
}
