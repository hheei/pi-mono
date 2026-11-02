import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type AskBatchDetails,
	type AskResponse,
	formatOptionsForMessage,
	formatResponseSummary,
	isSelectionResponse,
} from "./response";
import type { BatchQuestion } from "./schema";
import type { QuestionOption } from "./single-select-layout";

export function formatBatchAnswers(details: AskBatchDetails): string {
	const heading = details.heading ? [details.heading] : [];
	const lines = details.questions.map((subject, index) => {
		const answer = details.answers[index];
		const summary =
			answer?.status === "answered" ? formatResponseSummary(answer.response) : "(skipped)";
		return `${index + 1}. ${subject.question} \u2192 ${summary}`;
	});
	const answered = details.answers.filter((answer) => answer.status === "answered").length;
	return [
		...heading,
		`User answered ${answered} of ${details.questions.length} questions:`,
		...lines,
	].join("\n");
}

/** Non-interactive hosts get the whole prompt as text, so the model can still ask. */
export function formatSingleForMessage(input: {
	question: string;
	context: string | undefined;
	options: QuestionOption[];
	allowFreeform: boolean;
}): string {
	const optionText =
		input.options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(input.options)}` : "";
	const freeformHint = input.allowFreeform ? "\n\nYou can also answer freely." : "";
	const contextText = input.context ? `\n\nContext:\n${input.context}` : "";
	return `Ask requires interactive mode. Please answer:\n\n${input.question}${contextText}${optionText}${freeformHint}`;
}

export function formatBatchForMessage(questions: BatchQuestion[], heading?: string): string {
	const blocks = questions.map((entry, index) => {
		const lines = [`${index + 1}. ${entry.question}`];
		if (entry.context) lines.push(`   Context: ${entry.context.replace(/\n/g, "\n   ")}`);
		if (entry.options.length > 0) {
			lines.push(`   Options${entry.allowMultiple ? " (choose one or more)" : ""}:`);
			lines.push(
				...formatOptionsForMessage(entry.options)
					.split("\n")
					.map((line) => `   ${line}`),
			);
			if (entry.allowFreeform) lines.push("   You can also answer freely.");
		}
		return lines.join("\n");
	});
	const intro = heading ? `\n\n${heading}` : "";
	return `Ask requires interactive mode. Please answer these questions:${intro}\n\n${blocks.join("\n\n")}`;
}

/** Expanded-result block: every option with the selected ones marked. */
export function formatOptionMarkers(
	theme: Theme,
	options: QuestionOption[],
	response: Extract<AskResponse, { kind: "selection" }>,
	indent = "",
): string {
	const selectedTitles = new Set(response.selections);
	let text = `\n${indent}${theme.fg("dim", "Options:")}`;
	for (const opt of options) {
		const desc = opt.description ? ` \u2014 ${opt.description}` : "";
		const marker = selectedTitles.has(opt.title)
			? theme.fg("success", "\u25cf")
			: theme.fg("dim", "\u25cb");
		text += `\n${indent}  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
	}
	return text;
}

export function formatBatchResult(
	theme: Theme,
	details: AskBatchDetails,
	expanded: boolean,
): string {
	if (details.cancelled) return theme.fg("warning", "Cancelled");
	const answered = details.answers.filter((answer) => answer.status === "answered").length;
	let text =
		theme.fg("success", "\u2713 ") +
		theme.fg("accent", `${answered} of ${details.questions.length} answered`);
	details.questions.forEach((subject, index) => {
		const answer = details.answers[index];
		if (!answer) return;
		text += `\n${theme.fg("dim", `${index + 1}.`)} ${theme.fg("muted", subject.question)}${theme.fg("dim", " \u2192 ")}`;
		if (answer.status === "skipped") {
			text += theme.fg("warning", "(skipped)");
			return;
		}
		const response = answer.response;
		if (response.kind === "freeform") {
			text += theme.fg("muted", "(wrote) ");
		}
		text += theme.fg("accent", formatResponseSummary(response));
		if (!expanded) return;
		if (subject.context) {
			text += `\n   ${theme.fg("dim", subject.context)}`;
		}
		if (isSelectionResponse(response) && subject.options.length > 0) {
			text += formatOptionMarkers(theme, subject.options, response, "   ");
		}
	});
	return text;
}
