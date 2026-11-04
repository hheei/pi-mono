import { isRecord } from "@hheei/pi-ext-core";
import { BATCH_MAX_QUESTIONS, BATCH_MIN_QUESTIONS } from "./constants";
import type { QuestionOption } from "./single-select-layout";

type AskOptionInput = QuestionOption | string;

interface BatchQuestionInput {
	question: string;
	context?: string;
	options?: AskOptionInput[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
}

export interface AskParams {
	question?: string;
	questions?: BatchQuestionInput[];
	context?: string;
	options?: AskOptionInput[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	timeout_ms?: number;
}

/** One validated entry of a `questions` batch. */
export interface BatchQuestion {
	question: string;
	context?: string | undefined;
	options: QuestionOption[];
	allowMultiple: boolean;
	allowFreeform: boolean;
}

// Key aliases models fall back to when a schema-mangling proxy (Google
// function calling, Codex-style backends, cmux) strips the option shape and
// the model has to guess. See issue #22.
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

export const RESERVED_OPTION_TITLES = new Set(["other", "type something.", "next"]);

export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

export function coerceOption(option: unknown): QuestionOption | null {
	if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
		const title = normalizeLineTerminators(String(option)).trim();
		if (RESERVED_OPTION_TITLES.has(title.toLowerCase())) {
			throw new Error(
				`Option title "${title}" is reserved by ask_user. To allow custom user input, use allowFreeform: true instead.`,
			);
		}
		return title ? { title } : null;
	}
	if (isRecord(option)) {
		for (const key of OPTION_TITLE_KEYS) {
			const value = option[key];
			if (typeof value === "string") {
				const title = normalizeLineTerminators(value).trim();
				if (!title) continue;
				if (RESERVED_OPTION_TITLES.has(title.toLowerCase())) {
					throw new Error(
						`Option title "${title}" is reserved by ask_user. To allow custom user input, use allowFreeform: true instead.`,
					);
				}
				const description =
					typeof option.description === "string" && option.description.trim()
						? normalizeLineTerminators(option.description).trim()
						: undefined;
				return description ? { title, description } : { title };
			}
		}
	}
	return null;
}

/** Options arrive as strings, objects, or numbers when a proxy mangled the schema. */
export function coerceOptions(rawOptions: unknown[]): QuestionOption[] {
	return rawOptions.map(coerceOption).filter((option): option is QuestionOption => option !== null);
}

/** Nothing usable was left after normalization, so the prompt cannot open. */
export function malformedOptionsError(count: number, label?: string): Error {
	return new Error(
		`All ${count} option(s)${label ? ` in ${label}` : ""} were malformed, so nothing could be shown to the user. ` +
			`Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. ` +
			`Call ask_user again with corrected options.`,
	);
}

export function validateOptionUniqueness(options: QuestionOption[], label?: string): void {
	const seen = new Set<string>();
	for (const opt of options) {
		const key = opt.title.toLowerCase();
		if (seen.has(key)) {
			throw new Error(
				`Option title "${opt.title}"${label ? ` in ${label}` : ""} is duplicated. Each option must have a unique title.`,
			);
		}
		seen.add(key);
	}
}

export function prepareAskArguments(raw: unknown): Record<string, unknown> {
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Not JSON
		}
		return {};
	}
	if (!isRecord(raw)) return {};
	const copy: Record<string, unknown> = { ...raw };
	if (typeof copy.questions === "string") {
		try {
			const parsed = JSON.parse(copy.questions);
			if (Array.isArray(parsed)) copy.questions = parsed;
		} catch {}
	}
	if (typeof copy.options === "string") {
		try {
			const parsed = JSON.parse(copy.options);
			if (Array.isArray(parsed)) copy.options = parsed;
		} catch {}
	}
	return copy;
}

/** A top-level question sent with questions is the batch's heading, not another question (#80). */
export function batchHeading(params: AskParams): string | undefined {
	return typeof params.question === "string" && params.question.trim()
		? params.question.trim()
		: undefined;
}

/**
 * Validate and normalize a `questions` batch. Every problem throws before any
 * UI opens or event fires (#67), with a message that tells the model how to
 * correct the call.
 */
export function normalizeBatchQuestions(params: AskParams): BatchQuestion[] {
	// Top-level context/options/allowMultiple/allowFreeform are ignored here: entries carry their own,
	// and models that echo schema defaults would otherwise loop on a validation error (#88).
	const { questions } = params;
	if (!Array.isArray(questions)) {
		throw new Error(
			`questions must be an array of ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} question objects.`,
		);
	}
	if (questions.length < BATCH_MIN_QUESTIONS) {
		throw new Error(
			`questions needs ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. To ask one question, use question instead.`,
		);
	}
	if (questions.length > BATCH_MAX_QUESTIONS) {
		throw new Error(
			`questions accepts at most ${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. Ask the rest in a later ask_user call.`,
		);
	}

	const seen = new Set<string>();
	return questions.map((entry, index) => {
		const label = `questions[${index}]`;
		const question =
			typeof entry?.question === "string" ? normalizeLineTerminators(entry.question).trim() : "";
		if (!question) throw new Error(`${label}.question must be a non-empty string.`);
		const key = question.toLowerCase();
		if (seen.has(key)) {
			throw new Error(
				`${label} repeats the question "${question}". Each question in a batch must be distinct.`,
			);
		}
		seen.add(key);

		const rawOptions = entry.options ?? [];
		if (!Array.isArray(rawOptions)) throw new Error(`${label}.options must be an array.`);
		const options = coerceOptions(rawOptions);
		if (rawOptions.length > 0 && options.length === 0) {
			throw malformedOptionsError(rawOptions.length, label);
		}
		validateOptionUniqueness(options, label);

		return {
			question,
			context:
				typeof entry.context === "string"
					? normalizeLineTerminators(entry.context).trim() || undefined
					: undefined,
			options,
			allowMultiple: entry.allowMultiple ?? false,
			allowFreeform: entry.allowFreeform ?? true,
		};
	});
}
