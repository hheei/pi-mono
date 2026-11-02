import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	agentResultText,
	createOptionalToolRenderers,
	createToolPresentationRenderers,
	isRecord,
	type ToolPresentation,
	type ToolPresentationProvider,
	type ToolPresentationStatus,
} from "@hheei/pi-ext-core";
import { buildSearchErrorPlan, type SearchErrorDetails } from "./render-search-error.ts";

export function createWebToolRenderers(
	pi: ExtensionAPI,
	name: string,
	present: ToolPresentationProvider,
): ToolRenderers {
	return createOptionalToolRenderers(pi, name, createToolPresentationRenderers(pi, name, present));
}

function extractErrorOutput(
	details: Record<string, unknown> | undefined,
	fallback: string,
	expandKey: string,
): string {
	if (details) {
		const plan = buildSearchErrorPlan(details as SearchErrorDetails, expandKey);
		if (plan && plan.expanded.length > 0) {
			const planText = plan.expanded.join("\n");
			if (fallback && fallback !== planText && !planText.includes(fallback)) {
				return `${fallback}\n\n${planText}`;
			}
			return planText;
		}
	}
	return fallback;
}

export const createWebSearchPresentation: ToolPresentationProvider = (
	args,
	result,
	_theme,
	context,
): ToolPresentation => {
	const record = isRecord(args) ? args : undefined;
	const queries: string[] = [];
	if (record) {
		if (Array.isArray(record.queries)) {
			for (const q of record.queries) {
				if (typeof q === "string" && q.trim() !== "") queries.push(q.trim());
			}
		} else if (typeof record.query === "string" && record.query.trim() !== "") {
			queries.push(record.query.trim());
		}
	}
	const recency = typeof record?.recencyFilter === "string" ? record.recencyFilter : undefined;
	const provider = typeof record?.provider === "string" ? record.provider : undefined;

	let callSummary = "(no query)";
	if (queries.length === 1) {
		callSummary = `"${queries[0]}"`;
	} else if (queries.length > 1) {
		callSummary = `"${queries[0]}" (+${queries.length - 1} queries)`;
	}
	if (recency) callSummary += ` · past ${recency}`;
	if (provider) callSummary += ` · ${provider}`;

	const request =
		queries.length > 1 ? queries.map((q, idx) => `${idx + 1}. "${q}"`).join("\n") : undefined;

	if (result === undefined) {
		return {
			summary: callSummary,
			...(request ? { request } : {}),
		};
	}

	const isError = context.isError || result.isError === true;
	const details = isRecord(result.details) ? result.details : undefined;
	const resultText = agentResultText(result);

	if (isError) {
		const errorOutput = extractErrorOutput(
			details,
			resultText,
			context.keyText("app.tools.expand"),
		);
		let errorSummary = "search failed";
		if (typeof details?.error === "string") {
			errorSummary = details.error;
		} else if (details?.cancelled) {
			errorSummary = "Search cancelled";
		}
		return {
			summary: errorSummary,
			status: "error" as ToolPresentationStatus,
			...(request ? { request } : {}),
			output: errorOutput,
			copy: { primary: errorOutput },
		};
	}

	const queryCount = typeof details?.queryCount === "number" ? details.queryCount : queries.length;
	const successfulQueries =
		typeof details?.successfulQueries === "number" ? details.successfulQueries : undefined;
	const totalResults = typeof details?.totalResults === "number" ? details.totalResults : undefined;

	const parts: string[] = [];
	if (queryCount > 1 && successfulQueries !== undefined) {
		parts.push(`${successfulQueries}/${queryCount} queries`);
	}
	if (totalResults !== undefined) {
		parts.push(`${totalResults} ${totalResults === 1 ? "result" : "results"}`);
	}
	if (details?.curated === true) {
		parts.push("curated");
	}
	if (isRecord(details?.summary) && typeof details.summary.text === "string") {
		parts.push("summary");
	}

	const summary = parts.join(" · ") || callSummary;

	const status: ToolPresentationStatus | undefined = context.isPartial ? undefined : "ok";
	return {
		summary,
		...(status ? { status } : {}),
		...(request ? { request } : {}),
		output: resultText,
		copy: { primary: resultText },
	};
};

export const createFetchContentPresentation: ToolPresentationProvider = (
	args,
	result,
	_theme,
	context,
): ToolPresentation => {
	const record = isRecord(args) ? args : undefined;
	const urls: string[] = [];
	if (record) {
		if (Array.isArray(record.urls)) {
			for (const u of record.urls) {
				if (typeof u === "string" && u.trim() !== "") urls.push(u.trim());
			}
		} else if (typeof record.url === "string" && record.url.trim() !== "") {
			urls.push(record.url.trim());
		}
	}
	const mode =
		typeof record?.mode === "string" && record.mode !== "readable" ? record.mode : undefined;
	const timestamp = typeof record?.timestamp === "string" ? record.timestamp : undefined;
	const prompt = typeof record?.prompt === "string" ? record.prompt : undefined;

	let callSummary = "(no URL)";
	if (urls.length === 1) {
		callSummary = urls[0] ?? "";
	} else if (urls.length > 1) {
		callSummary = `${urls[0] ?? ""} (+${urls.length - 1} URLs)`;
	}
	if (mode) callSummary += ` · ${mode}`;
	if (timestamp) callSummary += ` · ${timestamp}`;

	const request =
		urls.length > 1
			? urls.map((u, idx) => `${idx + 1}. ${u}`).join("\n")
			: prompt
				? `prompt: ${prompt}`
				: undefined;

	if (result === undefined) {
		return {
			summary: callSummary,
			...(request ? { request } : {}),
		};
	}

	const isError = context.isError || result.isError === true;
	const details = isRecord(result.details) ? result.details : undefined;
	const resultText = agentResultText(result);

	if (isError) {
		const errorOutput = extractErrorOutput(
			details,
			resultText,
			context.keyText("app.tools.expand"),
		);
		const errorSummary = typeof details?.error === "string" ? details.error : "fetch failed";
		return {
			summary: errorSummary,
			status: "error" as ToolPresentationStatus,
			...(request ? { request } : {}),
			output: errorOutput,
			copy: { primary: errorOutput },
		};
	}

	let summary = callSummary;
	const urlCount = typeof details?.urlCount === "number" ? details.urlCount : urls.length;
	if (urlCount === 1) {
		const title =
			typeof details?.title === "string" && details.title.trim() !== ""
				? details.title.trim()
				: (urls[0] ?? "1 page");
		const chars = typeof details?.totalChars === "number" ? ` (${details.totalChars} chars)` : "";
		summary = `${title}${chars}`;
	} else if (urlCount > 1) {
		const successful = typeof details?.successful === "number" ? details.successful : 0;
		summary = `${successful}/${urlCount} URLs`;
	}

	const status: ToolPresentationStatus | undefined = context.isPartial ? undefined : "ok";
	return {
		summary,
		...(status ? { status } : {}),
		...(request ? { request } : {}),
		output: resultText,
		copy: { primary: resultText },
	};
};

export const createGetSearchContentPresentation: ToolPresentationProvider = (
	args,
	result,
	_theme,
	context,
): ToolPresentation => {
	const record = isRecord(args) ? args : undefined;
	const findText =
		typeof record?.findText === "string"
			? record.findText
			: Array.isArray(record?.findText) && typeof record.findText[0] === "string"
				? record.findText[0]
				: undefined;
	const query = typeof record?.query === "string" ? record.query : undefined;
	const url = typeof record?.url === "string" ? record.url : undefined;
	const responseId = typeof record?.responseId === "string" ? record.responseId : undefined;
	const offset = typeof record?.offset === "number" ? record.offset : undefined;

	let callSummary = "get_content";
	if (findText) {
		callSummary = `find "${findText}"`;
	} else if (query) {
		callSummary = `query: "${query}"`;
	} else if (url) {
		callSummary = url.length > 35 ? `${url.slice(0, 32)}...` : url;
	} else if (responseId) {
		callSummary = `id: ${responseId.slice(0, 8)}`;
	}
	if (offset !== undefined && offset > 0) callSummary += ` @ ${offset}`;

	if (result === undefined) {
		return { summary: callSummary };
	}

	const isError = context.isError || result.isError === true;
	const details = isRecord(result.details) ? result.details : undefined;
	const resultText = agentResultText(result);

	if (isError) {
		const errorOutput = extractErrorOutput(
			details,
			resultText,
			context.keyText("app.tools.expand"),
		);
		const errorSummary = typeof details?.error === "string" ? details.error : "retrieval failed";
		return {
			summary: errorSummary,
			status: "error" as ToolPresentationStatus,
			output: errorOutput,
			copy: { primary: errorOutput },
		};
	}

	let summary = callSummary;
	if (typeof details?.matchCount === "number") {
		const returned =
			typeof details.returnedMatches === "number" ? details.returnedMatches : details.matchCount;
		summary = `${details.matchCount} matches (${returned} shown)`;
	} else if (typeof details?.contentLength === "number") {
		const title = typeof details.title === "string" ? details.title : "content";
		summary = `${title} (${details.contentLength} chars)`;
	} else if (typeof details?.title === "string") {
		summary = details.title;
	}

	const status: ToolPresentationStatus | undefined = context.isPartial ? undefined : "ok";
	return {
		summary,
		...(status ? { status } : {}),
		output: resultText,
		copy: { primary: resultText },
	};
};

export const createSourceCheckPresentation: ToolPresentationProvider = (
	args,
	result,
	_theme,
	context,
): ToolPresentation => {
	const record = isRecord(args) ? args : undefined;
	const claim = typeof record?.claim === "string" ? record.claim.trim() : "";
	let callSummary = "source_check";
	if (claim.length > 50) {
		callSummary = `"${claim.slice(0, 47)}..."`;
	} else if (claim.length > 0) {
		callSummary = `"${claim}"`;
	}

	if (result === undefined) {
		return {
			summary: callSummary,
			...(claim ? { request: `claim: ${claim}` } : {}),
		};
	}

	const isError = context.isError || result.isError === true;
	const details = isRecord(result.details) ? result.details : undefined;
	const resultText = agentResultText(result);

	if (isError) {
		const errorOutput = extractErrorOutput(
			details,
			resultText,
			context.keyText("app.tools.expand"),
		);
		const errorSummary = typeof details?.error === "string" ? details.error : "check failed";
		return {
			summary: errorSummary,
			status: "error" as ToolPresentationStatus,
			...(claim ? { request: `claim: ${claim}` } : {}),
			output: errorOutput,
			copy: { primary: errorOutput },
		};
	}

	const artifact = isRecord(details?.artifact) ? details.artifact : undefined;
	const citations = Array.isArray(artifact?.citations) ? artifact.citations.length : undefined;
	const sources = Array.isArray(artifact?.sources) ? artifact.sources.length : undefined;

	const parts: string[] = [];
	if (citations !== undefined) parts.push(`${citations} citations`);
	if (sources !== undefined) parts.push(`${sources} sources`);

	const status: ToolPresentationStatus | undefined = context.isPartial ? undefined : "ok";
	return {
		summary: parts.join(" · ") || callSummary,
		...(status ? { status } : {}),
		...(claim ? { request: `claim: ${claim}` } : {}),
		output: resultText,
		copy: { primary: resultText },
	};
};
