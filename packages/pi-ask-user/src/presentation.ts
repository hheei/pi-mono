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
import { formatBatchAnswers, formatOptionMarkers } from "./format";
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
		const context = typeof args.context === "string" ? args.context.trim() : "";
		const sections: ToolPresentationSection[] = [];
		if (context) {
			sections.push({ railToken: "dim", content: [theme.fg("dim", context)] });
		}
		const options = coerceOptions(Array.isArray(args.options) ? args.options : []);
		if (options.length > 0) {
			const lines = options.map((opt, i) => {
				const desc = opt.description ? ` \u2014 ${opt.description}` : "";
				return `${theme.fg("dim", `${i + 1}.`)} ${theme.fg("muted", opt.title)}${theme.fg("dim", desc)}`;
			});
			sections.push({ railToken: "dim", content: lines });
		}
		return {
			summary: question,
			sections,
		};
	}

	const heading = typeof args.question === "string" ? args.question.trim() : "";
	const lines = questions.map((entry, index) => {
		const record = (entry ?? {}) as { question?: unknown; options?: unknown };
		const question = typeof record.question === "string" ? record.question : "";
		const optionCount = Array.isArray(record.options) ? record.options.length : 0;
		const notes = optionCount > 0 ? ` (${optionCount} option(s))` : "";
		return `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("text", String(question))}${theme.fg("dim", notes)}`;
	});
	return {
		summary: `${questions.length} questions${heading ? ` · ${heading}` : ""}`,
		sections: lines.length === 0 ? [] : [{ railToken: "muted", content: lines }],
	};
}

function singleResult(details: AskToolDetails, theme: Theme): ToolPresentation {
	const response = details.response;
	const question = details.question.trim();
	if (details.cancelled || response === null) {
		const summary = question ? `${question} \u2192 cancelled` : "cancelled";
		return {
			summary,
			status: "warn",
			sections: [
				{
					railToken: "dim",
					content: [
						theme.fg("text", question),
						...(details.context ? [theme.fg("dim", details.context)] : []),
						theme.fg("warning", "Cancelled by user"),
					],
				},
			],
			output: "Cancelled",
			copy: { primary: "Cancelled" },
		};
	}

	const answerSummary = formatResponseSummary(response);
	const prefix = response.kind === "freeform" ? "(wrote) " : "";
	const summary = question
		? `${question} \u2192 ${prefix}${answerSummary}`
		: `${prefix}${answerSummary}`;

	const sections: ToolPresentationSection[] = [];
	const plain = [`Q: ${question}`];
	if (details.context) plain.push(`Context: ${details.context}`);
	plain.push(`A: ${prefix}${answerSummary}`);

	const qLines: string[] = [theme.fg("text", question)];
	if (details.context) qLines.push(theme.fg("dim", details.context));
	sections.push({ railToken: "dim", content: qLines });

	if (isSelectionResponse(response) && details.options.length > 0) {
		sections.push({
			railToken: "accent",
			content: formatOptionMarkers(theme, details.options, response).split("\n"),
		});
	} else if (response.kind === "freeform") {
		sections.push({
			railToken: "accent",
			content: [`${theme.fg("dim", "(wrote)")} ${theme.fg("accent", theme.bold(response.text))}`],
		});
	}

	return {
		summary,
		status: "ok",
		sections,
		output: stripTerminalSequences(plain.join("\n")),
		copy: { primary: answerSummary, full: plain.join("\n") },
	};
}

function batchResult(details: AskBatchDetails, theme: Theme): ToolPresentation {
	const heading = details.heading?.trim() ?? "";
	const answered = details.answers.filter((answer) => answer.status === "answered").length;
	const total = details.questions.length;
	const isCancelled = details.cancelled;
	const status = isCancelled ? "warn" : "ok";

	const summarySuffix = isCancelled
		? answered > 0
			? `${answered} of ${total} answered (cancelled)`
			: "cancelled"
		: `${answered} of ${total} answered`;
	const summary = heading ? `${heading} · ${summarySuffix}` : summarySuffix;

	const statusRow = isCancelled
		? theme.fg("warning", "Cancelled")
		: `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answered} of ${total} answered`)}`;
	const collapsedRows: string[] = [
		statusRow,
		...details.questions.map((q, i) => {
			const ans = details.answers[i];
			const ansText =
				ans === undefined || ans.status === "skipped"
					? theme.fg("warning", "(skipped)")
					: `${ans.response.kind === "freeform" ? theme.fg("dim", "(wrote) ") : ""}${theme.fg("accent", formatResponseSummary(ans.response))}`;
			return `${theme.fg("dim", `${i + 1}.`)} ${theme.fg("muted", q.question)} ${theme.fg("dim", "→")} ${ansText}`;
		}),
	];

	const sections: ToolPresentationSection[] = [];
	if (heading) {
		sections.push({
			railToken: "dim",
			content: [theme.fg("text", theme.bold(heading))],
		});
	}

	details.questions.forEach((q, i) => {
		const ans = details.answers[i];
		const qLines: string[] = [`${theme.fg("dim", `${i + 1}.`)} ${theme.fg("text", q.question)}`];
		if (q.context) {
			qLines.push(`   ${theme.fg("dim", q.context)}`);
		}
		if (ans === undefined || ans.status === "skipped") {
			qLines.push(`   ${theme.fg("warning", "(skipped)")}`);
			sections.push({ railToken: "dim", content: qLines });
			return;
		}
		const resp = ans.response;
		if (isSelectionResponse(resp) && q.options.length > 0) {
			qLines.push(...formatOptionMarkers(theme, q.options, resp, "   ").split("\n"));
		} else if (resp.kind === "freeform") {
			qLines.push(`   ${theme.fg("dim", "(wrote)")} ${theme.fg("accent", theme.bold(resp.text))}`);
		} else {
			qLines.push(`   ${theme.fg("accent", theme.bold(formatResponseSummary(resp)))}`);
		}
		sections.push({ railToken: isCancelled ? "dim" : "accent", content: qLines });
	});

	const plain = formatBatchAnswers(details);
	return {
		summary,
		status,
		collapsedRows,
		sections,
		output: stripTerminalSequences(plain),
		copy: { primary: stripTerminalSequences(plain) },
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
		const call = callSections(
			typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
			theme,
		);
		return {
			summary: call.summary,
			status: "running",
			replaceCallOnPartial: true,
			collapsedRows: [theme.fg("muted", "Waiting for user input...")],
			sections: call.sections,
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
