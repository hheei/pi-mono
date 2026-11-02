import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	createToolPresentationRenderers,
	type ToolPresentation,
	type ToolPresentationContext,
	type ToolPresentationSection,
} from "@hheei/pi-ext-core";
import { formatBatchResult, formatOptionMarkers } from "./format";
import {
	type AskBatchDetails,
	type AskToolDetails,
	formatResponseSummary,
	isBatchDetails,
	isSelectionResponse,
} from "./response";
import { coerceOptions } from "./schema";

type AskDetails = (AskToolDetails | AskBatchDetails) & { error?: string };

function detailsOf(result: AgentToolResult<unknown> | undefined): AskDetails | undefined {
	const details = result?.details;
	return typeof details === "object" && details !== null ? (details as AskDetails) : undefined;
}

function errorText(result: AgentToolResult<unknown> | undefined, details: AskDetails | undefined) {
	return (
		details?.error ??
		result?.content
			?.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim() ??
		""
	);
}

function callSections(
	args: Record<string, unknown>,
	theme: Theme,
): { summary: string; sections: ToolPresentationSection[] } {
	const questions = Array.isArray(args.questions) ? args.questions : undefined;
	if (questions === undefined) {
		const question = typeof args.question === "string" ? args.question.trim() : "";
		const lines = coerceOptions(Array.isArray(args.options) ? args.options : []).map(
			(option, index) => theme.fg("text", `${index + 1}. ${option.title}`),
		);
		return {
			summary: question,
			sections:
				lines.length === 0
					? []
					: [{ railToken: "muted", content: [theme.fg("dim", "Options:"), ...lines] }],
		};
	}

	const heading = typeof args.question === "string" ? args.question.trim() : "";
	const lines = questions.map((entry, index) => {
		const record = (entry ?? {}) as { question?: unknown; options?: unknown };
		const question = typeof record.question === "string" ? record.question : "";
		const optionCount = Array.isArray(record.options) ? record.options.length : 0;
		const notes = optionCount > 0 ? ` (${optionCount} option(s))` : "";
		return theme.fg("text", `${index + 1}. ${question}${notes}`);
	});
	return {
		summary: `${questions.length} questions${heading ? ` · ${heading}` : ""}`,
		sections: lines.length === 0 ? [] : [{ railToken: "muted", content: lines }],
	};
}

function singleResult(details: AskToolDetails, theme: Theme): ToolPresentation {
	const response = details.response;
	if (details.cancelled || response === null) {
		return {
			summary: "cancelled",
			status: "warn",
			collapsedRows: [theme.fg("warning", "Cancelled")],
			output: "Cancelled",
			copy: { primary: "Cancelled" },
		};
	}

	const summary = formatResponseSummary(response);
	const prefix = response.kind === "freeform" ? "(wrote) " : "";
	const sections: ToolPresentationSection[] = [];
	const plain = [`✓ ${prefix}${summary}`];
	const addSection = (railToken: ToolPresentationSection["railToken"], lines: string[]): void => {
		if (lines.length === 0) return;
		sections.push({ railToken, content: lines });
		plain.push(...lines);
	};
	addSection("dim", [theme.fg("dim", `Q: ${details.question}`)]);
	if (details.context) addSection("dim", [theme.fg("dim", details.context)]);
	if (isSelectionResponse(response)) {
		addSection("accent", formatOptionMarkers(theme, details.options, response).split("\n"));
	}

	return {
		summary,
		status: "ok",
		collapsedRows: [
			`${theme.fg("success", "✓ ")}${theme.fg("muted", prefix)}${theme.fg("accent", summary)}`,
		],
		sections,
		output: stripTerminalSequences(plain.join("\n")),
		copy: { primary: summary },
	};
}

function batchResult(details: AskBatchDetails, theme: Theme): ToolPresentation {
	const collapsed = formatBatchResult(theme, details, false);
	const expanded = formatBatchResult(theme, details, true);
	const answered = details.answers.filter((answer) => answer.status === "answered").length;
	return {
		summary: details.cancelled
			? "cancelled"
			: `${answered} of ${details.questions.length} answered`,
		status: details.cancelled ? "warn" : "ok",
		collapsedRows: collapsed.split("\n"),
		sections: expanded === collapsed ? [] : [{ railToken: "dim", content: expanded.split("\n") }],
		output: stripTerminalSequences(expanded),
		copy: { primary: stripTerminalSequences(collapsed) },
	};
}

/** Presentation facts for one ask_user call or result; ext-ui frames them, the host shows them plain. */
export function presentAskUser(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
	theme: Theme,
	context: ToolPresentationContext,
): ToolPresentation {
	const details = detailsOf(result);
	const failed = result?.isError === true || details?.error !== undefined;
	if (failed) {
		const message = errorText(result, details);
		return {
			summary: message === "" ? "failed" : (message.split("\n")[0] ?? "failed"),
			status: "error",
			output: message === "" ? "ask_user failed" : message,
		};
	}

	if (result === undefined) {
		const call = callSections(
			typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
			theme,
		);
		return { summary: call.summary, status: "running", sections: call.sections };
	}

	if (context.isPartial) {
		return {
			summary: "waiting for user input",
			status: "running",
			replaceCallOnPartial: true,
			collapsedRows: [theme.fg("muted", "Waiting for user input...")],
		};
	}

	if (details === undefined) return { summary: "", status: "ok" };

	if (isBatchDetails(details)) return batchResult(details, theme);
	return singleResult(details, theme);
}

/** Native renderers plus the presentation provider ext-ui decorates when installed. */
export function createAskUserRenderers(pi: ExtensionAPI): ToolRenderers {
	return createToolPresentationRenderers(pi, "ask_user", presentAskUser);
}
