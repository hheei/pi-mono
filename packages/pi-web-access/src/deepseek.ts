import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import {
	loadFetchContentDomainPolicy,
	loadSsrfConfig,
	validateRemoteUrl,
} from "./ssrf-protection.ts";
import {
	fetchWithCredentialRedirects,
	getWebSearchConfigPath,
	readWebSearchSection,
} from "./utils.ts";

export function resolveDeepSeekApiRoot(baseUrl?: string): string {
	const base = (baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
	return base.replace(/\/(?:anthropic|v\d+)(?:\/v\d+)?$/i, "");
}

const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
// The API rejects queries over 128 Unicode characters, operators included.
const MAX_QUERY_CHARS = 128;
// `summary` is documented as 600-800 characters and written for models; keep it whole.
const MAX_SNIPPET_CHARS = 800;
const RECENCY_DAYS: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

interface WebSearchConfig {
	deepseekApiKey?: unknown;
	deepseekBaseUrl?: unknown;
}

interface DeepSeekResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	summary?: unknown;
	content?: unknown;
}

interface DeepSeekSearchOptions extends SearchOptions {
	includeContent?: boolean | undefined;
	extensionContext?: ExtensionContext | undefined;
}

function loadConfig(): WebSearchConfig {
	return readWebSearchSection() as WebSearchConfig;
}

export interface DeepSeekAuth {
	apiKey: string;
	root: string;
	headers?: Record<string, string | null>;
}

export async function resolveDeepSeekAuth(
	ctx?: ExtensionContext,
	signal?: AbortSignal,
): Promise<DeepSeekAuth | undefined> {
	const config = loadConfig();
	const configuredKey = config.deepseekApiKey;
	const configuredBaseUrl =
		typeof config.deepseekBaseUrl === "string" && config.deepseekBaseUrl.trim()
			? config.deepseekBaseUrl.trim()
			: undefined;

	if (ctx) {
		try {
			const models = ctx.modelRegistry.getAll();
			const model = models.find((m) => m.provider === "deepseek");
			if (model) {
				const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (resolved.ok && resolved.apiKey) {
					const baseUrl = configuredBaseUrl ?? resolved.baseUrl ?? model.baseUrl;
					return {
						apiKey: resolved.apiKey,
						root: resolveDeepSeekApiRoot(baseUrl),
						...(resolved.headers ? { headers: resolved.headers } : {}),
					};
				}
			}
		} catch {
			// Fall through
		}
	}

	const hasSource = hasCredentialSource({
		provider: "DeepSeek",
		configuredValue: configuredKey,
		environmentValue: process.env.DEEPSEEK_API_KEY,
	});
	if (!hasSource) return undefined;

	const apiKey = await resolveCredential({
		provider: "DeepSeek",
		configuredValue: configuredKey,
		environmentValue: process.env.DEEPSEEK_API_KEY,
		signal,
	});
	if (!apiKey) return undefined;

	const baseUrl = configuredBaseUrl ?? process.env.DEEPSEEK_BASE_URL;
	return {
		apiKey,
		root: resolveDeepSeekApiRoot(baseUrl),
	};
}

async function requireAuth(ctx?: ExtensionContext, signal?: AbortSignal): Promise<DeepSeekAuth> {
	const auth = await resolveDeepSeekAuth(ctx, signal);
	if (!auth) {
		throw new Error(
			"DeepSeek API key not found. Either:\n" +
				"  1. Run /login in pi and select DeepSeek\n" +
				`  2. Create ${CONFIG_PATH} with { "deepseekApiKey": "your-key" }\n` +
				"  3. Set DEEPSEEK_API_KEY environment variable\n" +
				"Get a key at https://platform.deepseek.com/api_keys",
		);
	}
	return auth;
}

// DeepSeek documents `site:` joined with OR, `-site:`, and `after:<date>` as query operators.
function buildQuery(query: string, options: SearchOptions): string {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of options.domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	const parts = [query.trim()];
	if (include.length > 0) parts.push(include.map((domain) => `site:${domain}`).join(" OR "));
	for (const domain of exclude) parts.push(`-site:${domain}`);
	if (options.recencyFilter) {
		const after = new Date(Date.now() - RECENCY_DAYS[options.recencyFilter] * 86_400_000)
			.toISOString()
			.slice(0, 10);
		parts.push(`after:${after}`);
	}
	const built = parts.join(" ");
	const length = [...built].length;
	if (length > MAX_QUERY_CHARS) {
		throw new Error(
			`DeepSeek invalid request: the query is ${length} characters with domain and date filters; DeepSeek accepts at most ${MAX_QUERY_CHARS}`,
		);
	}
	return built;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// DeepSeek Fetch escapes Markdown punctuation even when the content is already Markdown.
// Keep escapes that could change emphasis, code spans and links; unescape only the safe subset.
function unescapeMarkdownSegment(segment: string): string {
	return segment.replace(
		/\\([/.,:()&+#>|!_\-"'])/g,
		(match, char: string, offset: number, whole: string) => {
			if (char === "!" && whole[offset + 2] === "[") return match;
			return char;
		},
	);
}

function normalizeInlineMarkdown(line: string): string {
	return line
		.split(/(`+[^`]*`+)/g)
		.map((part, index) => (index % 2 === 0 ? unescapeMarkdownSegment(part) : part))
		.join("");
}

function normalizeDeepSeekMarkdown(markdown: string): string {
	let fence: { char: string; length: number } | null = null;
	return markdown
		.split("\n")
		.map((line) => {
			const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
			if (match) {
				const marker = match[1];
				const firstChar = marker?.[0];
				if (fence === null && marker && firstChar) {
					fence = { char: firstChar, length: marker.length };
				} else if (
					fence !== null &&
					marker !== undefined &&
					marker[0] === fence.char &&
					marker.length >= fence.length &&
					line.slice(match[0].length).trim() === ""
				) {
					fence = null;
				}
				return line;
			}
			return fence === null ? normalizeInlineMarkdown(line) : line;
		})
		.join("\n");
}

const ERROR_TITLE = /^(?:404\b|page not found\b|not found\b)/i;

function firstMarkdownHeading(content: string): string {
	let fence: { char: string; length: number } | null = null;
	for (const line of content.split("\n")) {
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const firstChar = marker?.[0];
			if (fence === null && marker && firstChar) {
				fence = { char: firstChar, length: marker.length };
			} else if (
				fence !== null &&
				marker !== undefined &&
				marker[0] === fence.char &&
				marker.length >= fence.length &&
				line.slice(fenceMatch[0].length).trim() === ""
			) {
				fence = null;
			}
			continue;
		}
		if (fence !== null) continue;
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
		const h = heading?.[1]?.trim();
		if (h) return h;
	}
	return "";
}

// A site-level 404 can still return 200 + a short navigation shell. Do not reject
// short pages generally: some valid pages are shorter than MIN_USEFUL_CONTENT.
// A title alone is not enough: "404 Not Found - HTTP" can be a real article.
function isUnusableDeepSeekPage(title: string, content: string): boolean {
	// Long pages are real content even if their title or first heading happens to be an error term.
	if (content.length >= 500) return false;
	const heading = firstMarkdownHeading(content);
	if (heading !== "" && ERROR_TITLE.test(heading)) return true;
	return (
		ERROR_TITLE.test(text(title)) &&
		/\b(?:404|page not found|not found)\b/i.test(content.slice(0, 200))
	);
}

function parseResponse(value: unknown): DeepSeekResult[] {
	const results =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>).results
			: undefined;
	if (!Array.isArray(results))
		throw new Error("DeepSeek returned invalid response: expected a results array");
	return results as DeepSeekResult[];
}

// Errors use the OpenAI shape `{ error: { message, type, param, code } }`.
function describeError(body: string): string {
	try {
		const error = (JSON.parse(body) as { error?: { message?: unknown } }).error;
		const message = text(error?.message);
		if (message) return message;
	} catch {}
	return body;
}

function formatDeepSeekHttpError(
	status: number,
	detail: string,
	label: "search" | "fetch",
): string {
	if (status === 401) {
		return "No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.";
	}
	if (status === 402) {
		return `DeepSeek ${label} failed: insufficient account balance. Top up the DeepSeek account and retry.`;
	}
	if (status === 403) {
		return `DeepSeek ${label} was rejected by security policy: ${detail}`;
	}
	if (status === 404 && label === "fetch") {
		return `DeepSeek fetch could not retrieve usable page content: ${detail}`;
	}
	if (status === 429) {
		return `DeepSeek ${label} rate limit exceeded (5 QPS per account). Wait and retry: ${detail}`;
	}
	return `DeepSeek ${label} error ${status}: ${detail}`;
}

export function isDeepSeekAvailable(ctx?: ExtensionContext): boolean {
	if (
		hasCredentialSource({
			provider: "DeepSeek",
			configuredValue: loadConfig().deepseekApiKey,
			environmentValue: process.env.DEEPSEEK_API_KEY,
		})
	) {
		return true;
	}
	if (ctx) {
		try {
			const models = ctx.modelRegistry.getAll();
			const model = models.find((m) => m.provider === "deepseek");
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
				return true;
			}
		} catch {
			// Fall through
		}
	}
	return false;
}

export async function searchWithDeepSeek(
	query: string,
	options: DeepSeekSearchOptions = {},
): Promise<SearchResponse> {
	const builtQuery = buildQuery(query, options);
	const auth = await requireAuth(options.extensionContext, options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: DeepSeekResult[];
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${auth.apiKey}`,
		};
		if (auth.headers) {
			for (const [key, value] of Object.entries(auth.headers)) {
				if (value !== null && value !== undefined) headers[key] = value;
			}
		}
		response = await fetchWithCredentialRedirects(
			`${auth.root}/v1/tools/search`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					query: builtQuery,
					count: numResults,
					...(options.includeContent ? { need_content: true } : {}),
				}),
				signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
			},
			["Authorization", ...Object.keys(auth.headers ?? {})],
		);
		if (!response.ok) {
			const errorText = redactCredential(describeError(await response.text()), auth.apiKey).slice(
				0,
				300,
			);
			throw new Error(formatDeepSeekHttpError(response.status, errorText, "search"));
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`DeepSeek returned invalid JSON: ${errorMessage(err)}`);
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const providerTimeout =
			timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`DeepSeek request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: (() => {
					const redactedMessage = redactCredential(message, auth.apiKey);
					if (redactedMessage === message && err instanceof Error) return err;
					const redactedError = new Error(redactedMessage);
					if (err instanceof Error) redactedError.name = err.name;
					return redactedError;
				})();
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), auth.apiKey));
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.url !== "string" || !entry.url) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(entry.url);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		const title = text(entry.title) || `Source ${results.length + 1}`;
		results.push({
			title,
			url: resultUrl.href,
			snippet: (text(entry.summary) || text(entry.snippet)).slice(0, MAX_SNIPPET_CHARS),
		});
		if (options.includeContent) {
			// Search content is not pre-escaped (unlike Fetch), so its backslashes are real text.
			const content = typeof entry.content === "string" ? entry.content.trim() : "";
			if (content) inlineContent.push({ url: resultUrl.href, title, content, error: null });
		}
		if (results.length >= numResults) break;
	}
	// A non-empty page with no usable entry is a broken response, not "no results", so routing can fall back.
	if (entries.length > 0 && results.length === 0)
		throw new Error("DeepSeek returned invalid response: no result had an http(s) URL");
	const searchResponse: SearchResponse = { answer: formatSearchResultsAsAnswer(results), results };
	if (inlineContent.length > 0) searchResponse.inlineContent = inlineContent;
	return searchResponse;
}

/**
 * Fetch a single page through DeepSeek's Fetch API, which returns page content
 * already converted to Markdown. Opt-in via `fetchRouting.providers`.
 */
export async function extractWithDeepSeek(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
	const auth = await requireAuth(options.extensionContext, signal);
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	try {
		const ssrf = loadSsrfConfig();
		await validateRemoteUrl(url, {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			domainPolicy: loadFetchContentDomainPolicy(),
			...(options.lookup ? { lookup: options.lookup } : {}),
		});
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${auth.apiKey}`,
		};
		if (auth.headers) {
			for (const [key, value] of Object.entries(auth.headers)) {
				if (value !== null && value !== undefined) headers[key] = value;
			}
		}
		const response = await fetchWithCredentialRedirects(
			`${auth.root}/v1/tools/fetch`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ url }),
				signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
			},
			["Authorization", ...Object.keys(auth.headers ?? {})],
		);
		if (!response.ok) {
			const errorText = redactCredential(describeError(await response.text()), auth.apiKey).slice(
				0,
				300,
			);
			throw new Error(formatDeepSeekHttpError(response.status, errorText, "fetch"));
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`DeepSeek Fetch returned invalid JSON: ${errorMessage(err)}`);
		}
		if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
			throw new Error("DeepSeek Fetch returned an unexpected response shape");
		}
		const page = rawData as { title?: unknown; content?: unknown };
		const title = typeof page.title === "string" ? page.title.trim() : "";
		const content =
			typeof page.content === "string" ? normalizeDeepSeekMarkdown(page.content).trim() : "";
		if (!content || isUnusableDeepSeekPage(title, content)) {
			activityMonitor.logComplete(activityId, response.status);
			return null;
		}
		activityMonitor.logComplete(activityId, response.status);
		return {
			url,
			title,
			content,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		activityMonitor.logError(activityId, redactCredential(message, auth.apiKey));
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error(`DeepSeek Fetch request timed out after ${Math.round(timeoutMs / 1000)}s`);
		}
		const redactedMessage = redactCredential(message, auth.apiKey);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
