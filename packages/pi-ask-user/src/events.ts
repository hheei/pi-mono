import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskResponse } from "./response";
import type { QuestionOption } from "./single-select-layout";

export interface AskEventSubject {
	question: string;
	context?: string | undefined;
	options: QuestionOption[];
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
	};
}
