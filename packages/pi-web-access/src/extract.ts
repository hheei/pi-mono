import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import pLimit from "p-limit";
import type TurndownService from "turndown";
import { activityMonitor } from "./activity.ts";
import { type AuthFetchProfile, assertAuthFetchUrl, authFetchRedirectGuard } from "./auth-fetch.ts";
import {
	extractWithBrightDataUnlocker,
	isBrightDataUnlockerAvailable,
} from "./brightdata-unlocker.ts";
import { getBrowserCookiesForHosts, getLastBrowserCookieDiagnostic } from "./chrome-cookies.ts";
import { extractWithCrawl4ai, isCrawl4aiAvailable } from "./crawl4ai.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";
import {
	appendDeclaredWebLinks,
	type DeclaredWebLink,
	discoverDeclaredWebLinks,
} from "./declared-web-links.ts";
import { extractWithDeepSeek, isDeepSeekAvailable } from "./deepseek.ts";
import { isImageEnabled } from "./feature-config.ts";
import { extractWithFirecrawl, isFirecrawlAvailable } from "./firecrawl.ts";
import { extractWithGeminiWeb, extractWithUrlContext } from "./gemini-url-context.ts";
import { extractGitHub, parseGitHubUrl } from "./github-extract.ts";
import { extractGitHubIssuePr, parseGitHubIssuePrUrl } from "./github-issue-pr.ts";
import { extractWithKagi, isKagiExtractAvailable } from "./kagi.ts";
import { extractWithOllama, isOllamaFetchAvailable } from "./ollama.ts";
import { extractWithParallel, isParallelAvailable } from "./parallel.ts";
import { extractWithParallelMcp } from "./parallel-mcp.ts";
import { extractPDFToMarkdown, isPDF, loadPDFConfig } from "./pdf-extract.ts";
import { extractWithQuerit, isQueritAvailable } from "./querit.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { extractWithSearch1API, isSearch1APIAvailable } from "./search1api.ts";
import {
	type DomainPolicy,
	fetchRemoteUrl,
	type Lookup,
	loadFetchContentDomainPolicy,
	loadFetchContentRedirectPolicy,
	loadFetchContentUserAgent,
	loadSsrfConfig,
	type RedirectPolicy,
	type SsrfConfig,
	validateRemoteUrl,
} from "./ssrf-protection.ts";
import { extractWithTinyFish, isTinyFishAvailable } from "./tinyfish.ts";
import {
	formatSeconds,
	getWebSearchConfigPath,
	type ProxiedRequestInit,
	readWebSearchSection,
} from "./utils.ts";
import {
	extractVideo,
	extractVideoFrame,
	getLocalVideoDuration,
	isVideoFile,
} from "./video-extract.ts";
import {
	extractYouTube,
	extractYouTubeFrame,
	extractYouTubeFrames,
	getYouTubeStreamInfo,
	isYouTubeEnabled,
	isYouTubeURL,
	type StreamInfo,
} from "./youtube-extract.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_CONFIGURED_TIMEOUT_MS = 2_147_483_647;
const CONCURRENT_LIMIT = 3;
const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

function loadFetchTimeoutMs(): number {
	const raw = readWebSearchSection();

	const fetchConfig = (raw as Record<string, unknown>).fetch;
	if (fetchConfig === undefined) return DEFAULT_TIMEOUT_MS;
	if (!fetchConfig || typeof fetchConfig !== "object" || Array.isArray(fetchConfig)) {
		throw new Error(`fetch in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const value = (fetchConfig as Record<string, unknown>).timeout;
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(
			`Invalid fetch.timeout in ${WEB_SEARCH_CONFIG_PATH}: expected a positive finite number of seconds, got ${JSON.stringify(value)}`,
		);
	}
	const timeoutMs = Math.ceil(value * 1000);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CONFIGURED_TIMEOUT_MS) {
		throw new Error(
			`Invalid fetch.timeout in ${WEB_SEARCH_CONFIG_PATH}: converted timeout must be a finite safe integer from 1 through ${MAX_CONFIGURED_TIMEOUT_MS} milliseconds`,
		);
	}
	return Math.max(1, timeoutMs);
}

const NON_RECOVERABLE_ERRORS = [
	"Unsupported content type",
	"Response too large",
	"PDF extraction is disabled",
	"Image fetching is disabled",
];
const MIN_USEFUL_CONTENT = 500;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FETCH_PROVIDERS = [
	"http",
	"firecrawl",
	"crawl4ai",
	"jina",
	"tinyfish",
	"search1api",
	"querit",
	"kagi",
	"ollama",
	"parallel",
	"parallel-mcp",
	"brightdata",
	"gemini",
	"deepseek",
] as const;
type FetchProvider = (typeof FETCH_PROVIDERS)[number];
type FetchRouting = { providers: FetchProvider[]; allowRemoteHostedProviders: boolean };
const DEFAULT_FETCH_PROVIDER_ORDER: FetchProvider[] = [
	"http",
	"firecrawl",
	"crawl4ai",
	"jina",
	"tinyfish",
	"search1api",
	"querit",
	"kagi",
	"ollama",
	"parallel",
	"brightdata",
	"gemini",
];
const REMOTE_HOSTED_FETCH_PROVIDERS = new Set<FetchProvider>([
	"jina",
	"tinyfish",
	"search1api",
	"querit",
	"kagi",
	"ollama",
	"parallel",
	"parallel-mcp",
	"brightdata",
	"gemini",
	"deepseek",
]);

function isDefuddleConsoleError(args: Parameters<typeof console.error>): boolean {
	const prefix = args[0];
	return prefix === "Defuddle" || (typeof prefix === "string" && /^Defuddle(?:\s|:)/.test(prefix));
}

async function extractWithDefuddle(
	text: string,
	url: string,
): Promise<{ title: string; content: string } | null> {
	const { Defuddle } = await import("defuddle/node");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(text);
	Object.defineProperty(document, "location", {
		value: new URL(url),
		configurable: true,
	});
	let processingError: unknown;
	const originalConsoleError = console.error;
	console.error = (...args) => {
		if (isDefuddleConsoleError(args)) {
			if (args[0] === "Defuddle" && args[1] === "Error processing document:") {
				processingError = args[2];
			}
			return;
		}
		originalConsoleError(...args);
	};

	let resultPromise: ReturnType<typeof Defuddle>;
	try {
		// With useAsync:false, Defuddle parses synchronously before returning its promise.
		// Keep the console interception limited to that call so unrelated Pi output is
		// never routed through this fallback's handler.
		resultPromise = Defuddle(document as unknown as Document, url, {
			markdown: true,
			useAsync: false,
		});
	} finally {
		console.error = originalConsoleError;
	}

	const result = await resultPromise;
	if (processingError !== undefined) {
		throw new Error(`Defuddle failed to process document: ${errorMessage(processingError)}`);
	}
	return typeof result.content === "string"
		? { title: result.title, content: result.content }
		: null;
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function isAbortException(err: unknown): boolean {
	return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

function isRedirectPolicyError(message: string): boolean {
	return (
		message.startsWith("Authenticated fetch refused cross-origin redirect") ||
		message.startsWith("Refused cross-origin redirect by fetch_content redirect policy") ||
		message.startsWith("Blocked internal ") ||
		message.startsWith("Blocked hostname by fetch_content domain policy") ||
		message.startsWith("Hostname not allowed by fetch_content domain policy") ||
		message.startsWith("Too many redirects fetching ") ||
		message === "Only HTTP and HTTPS URLs can be fetched remotely" ||
		message === "URL must include a hostname" ||
		message.startsWith("Failed to resolve ")
	);
}

// Errors that end routing: no other provider may be tried after them.
function isNonRecoverableHttpError(error: string | null): boolean {
	return (
		!!error &&
		(NON_RECOVERABLE_ERRORS.some((prefix) => error.startsWith(prefix)) ||
			isRedirectPolicyError(error) ||
			isConfigParseError(error))
	);
}

function imageGateError(): string | null {
	try {
		return isImageEnabled() ? null : "Image fetching is disabled by image.enabled";
	} catch (err) {
		return errorMessage(err);
	}
}

function redirectPolicyRouteRefusal(url: string, path: string): ExtractedContent {
	return {
		url,
		title: "",
		content: "",
		error: `Extraction path ${path} is disabled by the fetch_content same-origin redirect policy because its redirect chain cannot be observed`,
	};
}

async function resolveAuthCookieHeader(
	url: string | URL,
	profile: AuthFetchProfile,
): Promise<string> {
	const parsed = assertAuthFetchUrl(profile, url.toString());
	const result = await getBrowserCookiesForHosts({
		hosts: [parsed.hostname],
		profile: profile.chromeProfile,
		requestUrl: parsed,
	});
	if (result?.cookieHeader) return result.cookieHeader;
	if (!result) {
		const diagnostic = getLastBrowserCookieDiagnostic();
		throw new Error(
			`Authenticated fetch profile ${profile.name} could not read browser cookies${diagnostic ? `: ${diagnostic}` : ""}`,
		);
	}
	throw new Error(`Authenticated fetch profile ${profile.name} could not build a cookie header`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAuthenticatedRemoteUrl(
	url: string,
	init: RequestInit,
	validationOptions: {
		ssrf: SsrfConfig;
		domainPolicy: DomainPolicy;
		lookup?: Lookup | undefined;
		proxy?: string | undefined;
		redirects?: RedirectPolicy | undefined;
	},
	profile: AuthFetchProfile,
): Promise<Response> {
	let current = await validateRemoteUrl(url, {
		allowRanges: validationOptions.ssrf.allowRanges,
		trustEnvProxy: validationOptions.ssrf.trustEnvProxy,
		domainPolicy: validationOptions.domainPolicy,
		proxy: validationOptions.proxy,
		...(validationOptions.lookup ? { lookup: validationOptions.lookup } : {}),
	});
	const originalOrigin = current.origin;
	let requestInit = init;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const cookieHeader = await resolveAuthCookieHeader(current, profile);
		const headers = { ...(requestInit.headers as Record<string, string>), cookie: cookieHeader };
		const response = await fetch(current, { ...requestInit, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === 5) throw new Error(`Too many redirects fetching ${current.toString()}`);
		const from = current;
		const next = new URL(location, current);
		if (validationOptions.redirects === "same-origin" && next.origin !== originalOrigin) {
			throw new Error(
				`Refused cross-origin redirect by fetch_content redirect policy: ${originalOrigin} -> ${next.origin}`,
			);
		}
		current = await validateRemoteUrl(next, {
			allowRanges: validationOptions.ssrf.allowRanges,
			trustEnvProxy: validationOptions.ssrf.trustEnvProxy,
			domainPolicy: validationOptions.domainPolicy,
			proxy: validationOptions.proxy,
			...(validationOptions.lookup ? { lookup: validationOptions.lookup } : {}),
		});
		authFetchRedirectGuard(profile, from, current);
		if (
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				requestInit.method?.toUpperCase() === "POST")
		) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function loadFetchRouting(): FetchRouting {
	const raw = readWebSearchSection();

	if (!Object.hasOwn(raw, "fetchRouting")) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}
	const routing = raw.fetchRouting;
	if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
		throw new Error(`fetchRouting in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const routingConfig = routing as Record<string, unknown>;
	const providersValue = routingConfig.providers;
	let providers = DEFAULT_FETCH_PROVIDER_ORDER;
	if (providersValue !== undefined) {
		if (!Array.isArray(providersValue) || providersValue.length === 0) {
			throw new Error(
				`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array`,
			);
		}

		providers = [];
		for (const provider of providersValue) {
			const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
			if (!FETCH_PROVIDERS.includes(normalized as FetchProvider)) {
				throw new Error(
					`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} contains an invalid provider: ${String(provider)}`,
				);
			}
			if (providers.includes(normalized as FetchProvider)) {
				throw new Error(
					`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: ${normalized}`,
				);
			}
			providers.push(normalized as FetchProvider);
		}
	}

	const allowRemoteHostedProvidersValue = routingConfig.allowRemoteHostedProviders;
	if (
		allowRemoteHostedProvidersValue !== undefined &&
		typeof allowRemoteHostedProvidersValue !== "boolean"
	) {
		throw new Error(
			`fetchRouting.allowRemoteHostedProviders in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`,
		);
	}

	return { providers, allowRemoteHostedProviders: allowRemoteHostedProvidersValue === true };
}

/** Names of the search/fetch tools the caller has actually registered, so
 * failure guidance never points at tools that do not exist in the session. */
export interface RegisteredToolNames {
	webSearch?: string;
	fetchContent?: string;
	getSearchContent?: string;
}

/** Guidance for definitive origin 404/410 responses: no extraction provider
 * can retrieve a page the origin says is gone, so point at the registered
 * search/fetch tools (when the caller knows them) instead of provider config. */
function notFoundGuidance(result: ExtractedContent, toolNames?: RegisteredToolNames): string {
	const lines = [
		result.error ?? `HTTP ${result.status}`,
		"",
		`The origin server says this page does not exist (HTTP ${result.status}), so extraction providers cannot retrieve it.`,
	];
	if (toolNames?.webSearch && toolNames.fetchContent) {
		lines.push(
			`The page may have moved or been renamed. Use ${toolNames.webSearch} to find the current URL, then retry ${toolNames.fetchContent} with it.`,
		);
	} else if (toolNames?.webSearch) {
		lines.push(
			`The page may have moved or been renamed. Use ${toolNames.webSearch} to find the current URL.`,
		);
	} else {
		lines.push(
			"The page may have moved or been renamed. Find the current URL, then retry the fetch with it.",
		);
	}
	return lines.join("\n");
}

/** Fallback-list hint for the keyless Jina Reader. Returns null when Jina
 * already ran for this fetch, and otherwise names only the config change still
 * missing, so users keep their existing or default provider order. */
function jinaReaderGuidance(
	routing: FetchRouting,
	providerOrder: FetchProvider[],
	needsRemoteOptIn: boolean,
): string | null {
	if (providerOrder.includes("jina")) return null;
	const privacy = "target URLs are fetched through Jina's infrastructure";
	const optInCaveat = "this also allows the other hosted providers in your fetch provider order";
	if (routing.providers.includes("jina")) {
		return `  • Enable the keyless Jina Reader fallback: set fetchRouting.allowRemoteHostedProviders to true in ${WEB_SEARCH_CONFIG_PATH} (Jina is already in your fetch provider order; ${optInCaveat}; ${privacy})`;
	}
	return needsRemoteOptIn
		? `  • Enable the keyless Jina Reader fallback: add "jina" to your existing fetchRouting.providers and set fetchRouting.allowRemoteHostedProviders to true in ${WEB_SEARCH_CONFIG_PATH} (${optInCaveat}; ${privacy})`
		: `  • Enable the keyless Jina Reader fallback: add "jina" to your existing fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} (${privacy})`;
}
function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

// Share first-use initialization without loading Turndown at extension startup.
let turndownInstance: Promise<TurndownService> | undefined;
async function loadTurndown(): Promise<TurndownService> {
	const { default: TurndownService } = await import("turndown");
	return new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});
}
function getTurndown(): Promise<TurndownService> {
	turndownInstance ??= loadTurndown();
	return turndownInstance;
}

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
	mimeType?: string;
	status?: number;
}

type HttpExtractedContent = ExtractedContent & { declaredLinks?: DeclaredWebLink[] };

export interface ExtractOptions {
	timeoutMs?: number | undefined;
	forceClone?: boolean | undefined;
	prompt?: string | undefined;
	timestamp?: string | undefined;
	frames?: number | undefined;
	model?: string | undefined;
	mode?: ("readable" | "raw" | "answer") | undefined;
	answerModel?: string | undefined;
	authFetchProfile?: AuthFetchProfile | undefined;
	toolNames?: RegisteredToolNames | undefined;
	/** Optional HTTP(S) or SOCKS proxy URL; routed through the curl-backed transport. */
	proxy?: string | undefined;
	/** Reject direct image URLs with this error instead of decoding them with Pi's
	 * resizeImage. Hosts without the Pi runtime set it; Pi leaves it unset. */
	rejectDirectImages?: string | undefined;
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup | undefined;
	/** "same-origin" refuses cross-origin redirects and extraction paths whose redirect
	 * chain cannot be observed. fetchContent.redirects in config is a floor. */
	redirects?: RedirectPolicy | undefined;
	extensionContext?: ExtensionContext | undefined;
}

/** Resolve the direct HTTP/Jina fetch budget, with a per-call override taking precedence. */
export function resolveFetchTimeoutMs(options?: Pick<ExtractOptions, "timeoutMs">): number {
	return options?.timeoutMs ?? loadFetchTimeoutMs();
}

const JINA_READER_BASE = "https://r.jina.ai/";

async function extractWithJinaReader(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	lookup?: Lookup,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		await validateRemoteUrl(url, {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			domainPolicy,
			...(lookup ? { lookup } : {}),
		});
		const res = await fetch(jinaUrl, {
			headers: {
				Accept: "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (
			markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")
		) {
			return null;
		}

		const title =
			extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!Number.isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some((p) => Number.isNaN(p) || p < 0)) return null;
	const p0 = parts[0];
	const p1 = parts[1];
	const p2 = parts[2];
	if (parts.length === 3 && p0 !== undefined && p1 !== undefined && p2 !== undefined)
		return Math.floor(p0 * 3600 + p1 * 60 + p2);
	if (parts.length === 2 && p0 !== undefined && p1 !== undefined) return Math.floor(p0 * 60 + p1);
	return null;
}

type TimestampSpec =
	| { type: "single"; seconds: number }
	| { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(
	start: number,
	end: number,
	maxFrames: number = DEFAULT_RANGE_FRAMES,
): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string,
	label: string,
	requestedCount: number,
	frames: VideoFrame[],
	error: string | null,
	duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		...(duration !== undefined ? { duration } : {}),
	};
}

async function extractLocalFrames(
	filePath: string,
	timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(
		timestamps.map(async (t) => {
			const frame = await extractVideoFrame(filePath, t);
			if ("error" in frame) return { error: frame.error };
			return { ...frame, timestamp: formatSeconds(t) };
		}),
	);
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

type LocalVideoInfoResult =
	| { status: "video"; info: NonNullable<ReturnType<typeof isVideoFile>> }
	| { status: "not-video" }
	| { status: "invalid"; error: string };

function safeVideoInfo(url: string): LocalVideoInfoResult {
	try {
		const info = isVideoFile(url);
		return info ? { status: "video", info } : { status: "not-video" };
	} catch (err) {
		return { status: "invalid", error: errorMessage(err) };
	}
}

/** A video a frame request can sample. YouTube and local files share the planning below. */
interface VideoSampler {
	/** Duration the source already reported, or null when it must be measured on demand. */
	reportedDuration: number | null;
	/** Duration in seconds for full-video sampling. Throws when it cannot be determined. */
	duration(): Promise<number>;
	sample(timestamps: number[]): Promise<{ frames: VideoFrame[]; error: string | null }>;
	frame(seconds: number): Promise<FrameResult>;
}

function youTubeSampler(videoId: string, streamInfo: StreamInfo): VideoSampler {
	return {
		reportedDuration: streamInfo.duration,
		duration: async () => {
			if (streamInfo.duration === null) {
				throw new Error("Cannot determine video duration. Use a timestamp range instead.");
			}
			return streamInfo.duration;
		},
		sample: (timestamps) => extractYouTubeFrames(videoId, timestamps, streamInfo),
		frame: (seconds) => extractYouTubeFrame(videoId, seconds, streamInfo),
	};
}

function localVideoSampler(filePath: string): VideoSampler {
	let duration: Promise<number> | undefined;
	return {
		// Probing a local duration costs an ffprobe run, so only full-video sampling pays for it.
		reportedDuration: null,
		duration: () =>
			(duration ??= (async () => {
				const result = await getLocalVideoDuration(filePath);
				if (typeof result !== "number") throw new Error(result.error);
				return result;
			})()),
		sample: (timestamps) => extractLocalFrames(filePath, timestamps),
		frame: (seconds) => extractVideoFrame(filePath, seconds),
	};
}

type VideoTarget =
	| { kind: "sampler"; sampler: VideoSampler }
	| { kind: "not-video" }
	| { kind: "error"; error: string };

async function resolveVideoTarget(url: string): Promise<VideoTarget> {
	const youtube = isYouTubeURL(url);
	if (youtube.isYouTube && youtube.videoId) {
		const streamInfo = await getYouTubeStreamInfo(youtube.videoId);
		if ("error" in streamInfo) return { kind: "error", error: streamInfo.error };
		return { kind: "sampler", sampler: youTubeSampler(youtube.videoId, streamInfo) };
	}
	const local = safeVideoInfo(url);
	if (local.status === "invalid") return { kind: "error", error: local.error };
	if (local.status === "video") {
		return { kind: "sampler", sampler: localVideoSampler(local.info.absolutePath) };
	}
	return { kind: "not-video" };
}

function frameErrorResult(url: string, title: string, error: string): ExtractedContent {
	return { url, title, content: error, error };
}

/** Title for a frame request, decided before any sampling so failures keep it. */
function frameTitle(
	timestamp: string,
	spec: TimestampSpec,
	frameCount: number | undefined,
): string {
	if (spec.type === "range") {
		return `Frames ${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
	}
	if (frameCount) {
		return `Frames ${formatSeconds(spec.seconds)}-${formatSeconds(spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL)}`;
	}
	return `Frame at ${timestamp}`;
}

/** Rejects a request past the duration the source already reported. A source that must
 * measure its duration on demand keeps sampling whatever was asked for. */
function durationOverrun(
	url: string,
	sampler: VideoSampler,
	end: number,
	title: string,
): ExtractedContent | null {
	const duration = sampler.reportedDuration;
	if (duration === null || end <= duration) return null;
	return frameErrorResult(
		url,
		title,
		`Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(duration))})`,
	);
}

async function sampleFrameWindow(
	url: string,
	sampler: VideoSampler,
	label: string,
	timestamps: number[],
): Promise<ExtractedContent> {
	const result = await sampler.sample(timestamps);
	return buildFrameResult(
		url,
		label,
		timestamps.length,
		result.frames,
		result.error,
		sampler.reportedDuration ?? undefined,
	);
}

async function sampleWholeVideo(
	url: string,
	sampler: VideoSampler,
	frameCount: number,
): Promise<ExtractedContent> {
	let duration: number;
	try {
		duration = await sampler.duration();
	} catch (err) {
		return frameErrorResult(url, "Frames", errorMessage(err));
	}
	const timestamps = computeRangeTimestamps(0, Math.floor(duration), frameCount);
	const result = await sampler.sample(timestamps);
	return buildFrameResult(
		url,
		`${formatSeconds(0)}-${formatSeconds(Math.floor(duration))}`,
		timestamps.length,
		result.frames,
		result.error,
		duration,
	);
}

async function sampleSingleFrame(
	url: string,
	sampler: VideoSampler,
	seconds: number,
	timestamp: string,
): Promise<ExtractedContent> {
	const title = `Frame at ${timestamp}`;
	const frame = await sampler.frame(seconds);
	if ("error" in frame) return frameErrorResult(url, title, frame.error);
	// mimeType marks the image as the payload (like direct-image fetches); a
	// text result with a bonus thumbnail stays without one.
	return {
		url,
		title,
		content: `Video frame at ${timestamp}`,
		error: null,
		thumbnail: frame,
		mimeType: frame.mimeType,
	};
}

/** Per-call context for one provider attempt; provider-specific arguments are built by the runners. */
interface ProviderContext {
	url: string;
	signal: AbortSignal | undefined;
	options: ExtractOptions | undefined;
	timeoutMs: number;
	/** SSRF config, loaded only by providers that validate the target themselves. */
	ssrf: () => SsrfConfig;
	lookup: Lookup | undefined;
}

type ProviderRunner = (context: ProviderContext) => Promise<ExtractedContent | null>;

/** How one provider attempt ended, so the fallback loop owns termination and diagnostics. */
type ProviderOutcome =
	| { kind: "content"; result: ExtractedContent }
	| { kind: "skip" }
	| { kind: "failed"; error: string }
	| { kind: "fatal"; error: string }
	| { kind: "aborted" };

/** Options accepted by the providers that validate the target URL themselves. */
function ssrfAwareOptions(context: ProviderContext): {
	timeoutMs: number | undefined;
	lookup?: Lookup;
	ssrf: SsrfConfig;
} {
	return {
		timeoutMs: context.options?.timeoutMs,
		...(context.lookup ? { lookup: context.lookup } : {}),
		ssrf: context.ssrf(),
	};
}

const PROVIDER_RUNNERS: Record<Exclude<FetchProvider, "http">, ProviderRunner> = {
	firecrawl: async (context) =>
		isFirecrawlAvailable()
			? extractWithFirecrawl(context.url, context.signal, ssrfAwareOptions(context))
			: null,
	crawl4ai: async (context) =>
		isCrawl4aiAvailable()
			? extractWithCrawl4ai(context.url, context.signal, ssrfAwareOptions(context))
			: null,
	jina: (context) =>
		extractWithJinaReader(context.url, context.timeoutMs, context.signal, context.lookup),
	tinyfish: async (context) =>
		isTinyFishAvailable()
			? extractWithTinyFish(context.url, context.signal, context.options)
			: null,
	search1api: async (context) =>
		isSearch1APIAvailable()
			? extractWithSearch1API(context.url, context.signal, context.options)
			: null,
	querit: async (context) =>
		isQueritAvailable() ? extractWithQuerit(context.url, context.signal, context.options) : null,
	kagi: async (context) =>
		isKagiExtractAvailable()
			? extractWithKagi(context.url, context.signal, ssrfAwareOptions(context))
			: null,
	ollama: async (context) =>
		isOllamaFetchAvailable()
			? extractWithOllama(context.url, context.signal, ssrfAwareOptions(context))
			: null,
	parallel: async (context) =>
		isParallelAvailable()
			? extractWithParallel(context.url, context.signal, context.options)
			: null,
	"parallel-mcp": (context) => extractWithParallelMcp(context.url, context.signal, context.options),
	brightdata: async (context) =>
		isBrightDataUnlockerAvailable()
			? extractWithBrightDataUnlocker(context.url, context.signal, ssrfAwareOptions(context))
			: null,
	gemini: async (context) => {
		try {
			return (
				(await extractWithUrlContext(context.url, context.signal)) ??
				(await extractWithGeminiWeb(context.url, context.signal))
			);
		} catch (err) {
			// Credential and config errors end routing. Other Gemini failures stay silent so the
			// final guidance reports provider setup rather than transient Gemini errors.
			if (
				isAbortError(err) ||
				err instanceof CredentialResolutionError ||
				isConfigParseError(err)
			) {
				throw err;
			}
			return null;
		}
	},
	deepseek: async (context) =>
		isDeepSeekAvailable(context.options?.extensionContext)
			? extractWithDeepSeek(context.url, context.signal, {
					timeoutMs: context.options?.timeoutMs,
					...(context.lookup ? { lookup: context.lookup } : {}),
					...(context.options?.extensionContext
						? { extensionContext: context.options.extensionContext }
						: {}),
				})
			: null,
};

async function runProvider(
	provider: Exclude<FetchProvider, "http">,
	context: ProviderContext,
): Promise<ProviderOutcome> {
	try {
		const result = await PROVIDER_RUNNERS[provider](context);
		return result ? { kind: "content", result } : { kind: "skip" };
	} catch (err) {
		if (context.signal?.aborted || isAbortException(err) || isAbortError(err)) {
			return { kind: "aborted" };
		}
		if (err instanceof CredentialResolutionError || isConfigParseError(err)) {
			return { kind: "fatal", error: errorMessage(err) };
		}
		return { kind: "failed", error: errorMessage(err) };
	}
}

/** Providers whose failures are reported in the final guidance, in report order. */
const PROVIDER_ERROR_LABELS: ReadonlyArray<readonly [FetchProvider, string]> = [
	["firecrawl", "Firecrawl"],
	["crawl4ai", "Crawl4AI"],
	["tinyfish", "TinyFish"],
	["search1api", "Search1API"],
	["querit", "Querit"],
	["kagi", "Kagi"],
	["ollama", "Ollama"],
	["parallel", "Parallel"],
	["parallel-mcp", "Parallel MCP"],
	["brightdata", "Bright Data"],
	["deepseek", "DeepSeek"],
];

function failure(url: string, error: string): ExtractedContent {
	return { url, title: "", content: "", error };
}

type PreparedTarget =
	| { redirectPolicy: RedirectPolicy | undefined; remoteUrl: URL | null }
	| { error: string };

/** Loads the redirect policy and validates the target before any provider runs. */
async function prepareTarget(url: string, options?: ExtractOptions): Promise<PreparedTarget> {
	let redirectPolicy: RedirectPolicy | undefined;
	try {
		redirectPolicy = options?.redirects ?? loadFetchContentRedirectPolicy();
	} catch (err) {
		return { error: errorMessage(err) };
	}

	let remoteUrl: URL | null = null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
	} catch {}
	if (!remoteUrl) return { redirectPolicy, remoteUrl };

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		// An invalid configured User-Agent fails here, before any provider fallback runs.
		loadFetchContentUserAgent();
		await validateRemoteUrl(remoteUrl, {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			domainPolicy,
			proxy: options?.proxy,
			...(options?.lookup ? { lookup: options.lookup } : {}),
		});
	} catch (err) {
		return { error: errorMessage(err) };
	}
	return { redirectPolicy, remoteUrl };
}

/** Paths whose redirect chain cannot be observed, refused under the same-origin policy. */
function redirectPolicyRefusal(url: string): ExtractedContent | null {
	if (parseGitHubIssuePrUrl(url)) return redirectPolicyRouteRefusal(url, "GitHub issue/PR");
	if (parseGitHubUrl(url)) return redirectPolicyRouteRefusal(url, "GitHub repository");
	if (isYouTubeURL(url).isYouTube) return redirectPolicyRouteRefusal(url, "YouTube");
	return null;
}

/** Frame and timestamp requests. They sample a video instead of running the provider chain. */
async function frameRequestResult(
	url: string,
	options: ExtractOptions | undefined,
): Promise<ExtractedContent | null> {
	if (!options) return null;
	const { frames: frameCount, timestamp } = options;
	if (!frameCount && !timestamp) return null;

	const disabled = imageGateError();
	if (disabled) return failure(url, disabled);

	if (frameCount && !timestamp) {
		const target = await resolveVideoTarget(url);
		if (target.kind === "error") return frameErrorResult(url, "Frames", target.error);
		if (target.kind === "not-video") {
			return failure(url, "Frame extraction only works with YouTube and local video files");
		}
		return sampleWholeVideo(url, target.sampler, frameCount);
	}

	if (!timestamp) return null;
	const spec = parseTimestampSpec(timestamp);
	if (!spec) {
		return failure(
			url,
			`Invalid timestamp format: "${timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`,
		);
	}
	const title = frameTitle(timestamp, spec, frameCount);
	const target = await resolveVideoTarget(url);
	if (target.kind === "error") return frameErrorResult(url, title, target.error);
	if (target.kind === "not-video") {
		return failure(url, "Timestamp extraction only works with YouTube and local video files");
	}
	const sampler = target.sampler;

	if (spec.type === "range") {
		const overrun = durationOverrun(url, sampler, spec.end, title);
		if (overrun) return overrun;
		const timestamps = frameCount
			? computeRangeTimestamps(spec.start, spec.end, frameCount)
			: computeRangeTimestamps(spec.start, spec.end);
		return sampleFrameWindow(
			url,
			sampler,
			`${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`,
			timestamps,
		);
	}

	if (frameCount) {
		const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
		const overrun = durationOverrun(url, sampler, end, title);
		if (overrun) return overrun;
		return sampleFrameWindow(
			url,
			sampler,
			`${formatSeconds(spec.seconds)}-${formatSeconds(end)}`,
			computeRangeTimestamps(spec.seconds, end, frameCount),
		);
	}

	const overrun = durationOverrun(url, sampler, spec.seconds, title);
	if (overrun) return overrun;
	return sampleSingleFrame(url, sampler, spec.seconds, timestamp);
}

/** Whole-video analysis for a local file; null when the target is not a local video. */
async function localVideoAnalysis(
	url: string,
	signal: AbortSignal | undefined,
	options: ExtractOptions | undefined,
): Promise<ExtractedContent | null> {
	const local = safeVideoInfo(url);
	if (local.status === "invalid") return failure(url, local.error);
	if (local.status === "not-video") return null;
	try {
		const result = await extractVideo(local.info, signal, options);
		if (signal?.aborted) return abortedResult(url);
		return (
			result ??
			failure(
				url,
				`Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ${WEB_SEARCH_CONFIG_PATH}`,
			)
		);
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
		return failure(url, errorMessage(err));
	}
}

/** Runs one special-source extractor. Aborts and config errors end the fetch; extractor
 * failures either report (YouTube) or let the HTTP path continue (GitHub). */
async function runSource(
	url: string,
	signal: AbortSignal | undefined,
	run: () => Promise<ExtractedContent | null>,
	onFailure: "ignore" | "report",
): Promise<ExtractedContent | null> {
	try {
		const result = await run();
		if (result) return result;
		return signal?.aborted ? abortedResult(url) : null;
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
		const message = errorMessage(err);
		if (onFailure === "report" || isConfigParseError(err)) return failure(url, message);
		return null;
	}
}

/** GitHub and YouTube, which are fetched by their own extractors rather than providers. */
async function specialSourceResult(
	url: string,
	signal: AbortSignal | undefined,
	options: ExtractOptions | undefined,
): Promise<ExtractedContent | null> {
	const githubIssuePr = await runSource(
		url,
		signal,
		() => extractGitHubIssuePr(url, signal, options),
		"ignore",
	);
	if (githubIssuePr) return githubIssuePr;

	const github = await runSource(
		url,
		signal,
		() => extractGitHub(url, signal, options?.forceClone),
		"ignore",
	);
	if (github) return github;

	const youtube = isYouTubeURL(url);
	let youtubeEnabled: boolean;
	try {
		youtubeEnabled = isYouTubeEnabled();
	} catch (err) {
		return failure(url, errorMessage(err));
	}
	if (!youtube.isYouTube || !youtubeEnabled) return null;

	const result = await runSource(
		url,
		signal,
		() => extractYouTube(url, signal, options?.prompt, options?.model),
		"report",
	);
	if (result) return result;
	return failure(
		url,
		"Could not extract YouTube video content. Sign into Google in a supported Chromium browser for automatic access, or set GEMINI_API_KEY.",
	);
}

type ProviderOrder = { providers: FetchProvider[] } | { refusal: ExtractedContent };

/** Providers this fetch may try, in order, honoring the redirect policy and the opt-in. */
function resolveProviderOrder(
	url: string,
	request: { redirectPolicy: RedirectPolicy | undefined; remoteUrl: URL | null },
	fetchRouting: FetchRouting,
): ProviderOrder {
	if (request.redirectPolicy) {
		if (!fetchRouting.providers.includes("http")) {
			return { refusal: redirectPolicyRouteRefusal(url, fetchRouting.providers[0] ?? "http") };
		}
		return { providers: ["http"] };
	}
	const providers =
		request.remoteUrl && !fetchRouting.allowRemoteHostedProviders
			? fetchRouting.providers.filter((provider) => !REMOTE_HOSTED_FETCH_PROVIDERS.has(provider))
			: fetchRouting.providers;
	if (providers.length === 0) {
		return {
			refusal: failure(
				url,
				"Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true",
			),
		};
	}
	return { providers };
}

interface ProviderFallbackRequest {
	url: string;
	signal: AbortSignal | undefined;
	options: ExtractOptions | undefined;
	timeoutMs: number;
	providerOrder: FetchProvider[];
	fetchRouting: FetchRouting;
	redirectPolicy: RedirectPolicy | undefined;
	remoteUrl: URL | null;
}

/** Runs the provider order, ending on the first content or on a fatal error. */
async function providerFallback(request: ProviderFallbackRequest): Promise<ExtractedContent> {
	const { url, signal, options, providerOrder, timeoutMs } = request;

	let httpResult: ExtractedContent | null = null;
	let declaredLinks: DeclaredWebLink[] = [];
	const withDeclaredLinks = (result: ExtractedContent): ExtractedContent => ({
		...result,
		content: appendDeclaredWebLinks(result.content, declaredLinks),
	});
	const parseErrorResult = (message: string): ExtractedContent =>
		httpResult ? { ...httpResult, error: message } : failure(url, message);
	const runHttpProvider = async (): Promise<ExtractedContent | null> => {
		const { declaredLinks: discoveredLinks = [], ...result } = await extractViaHttp(
			url,
			timeoutMs,
			signal,
			options,
		);
		httpResult = result;
		declaredLinks = discoveredLinks;
		if (signal?.aborted) return abortedResult(url);
		if (!httpResult.error) return httpResult;
		if (
			isNonRecoverableHttpError(httpResult.error) ||
			httpResult.error === options?.rejectDirectImages
		) {
			return httpResult;
		}
		return null;
	};

	const providerErrors = new Map<FetchProvider, string>();
	const providerContext: ProviderContext = {
		url,
		signal,
		options,
		timeoutMs,
		ssrf: loadSsrfConfig,
		lookup: options?.lookup,
	};

	// A remote provider in front of HTTP still needs the HTTP gate, because the direct
	// fetch is the only path that can observe the origin's own answer.
	if (request.remoteUrl && providerOrder[0] !== "http") {
		const gateResult = await runHttpProvider();
		if (gateResult) return gateResult;
	}

	for (const provider of providerOrder) {
		if (signal?.aborted) return abortedResult(url);

		if (provider === "http") {
			const result = await runHttpProvider();
			if (result) return result;
			continue;
		}

		const outcome = await runProvider(provider, providerContext);
		if (outcome.kind === "content") return withDeclaredLinks(outcome.result);
		if (outcome.kind === "aborted") return abortedResult(url);
		if (outcome.kind === "fatal") return parseErrorResult(outcome.error);
		if (outcome.kind === "failed") providerErrors.set(provider, outcome.error);
	}

	return fallbackDiagnostics(request, { httpResult, declaredLinks, providerErrors });
}

interface FallbackOutcome {
	httpResult: ExtractedContent | null;
	declaredLinks: DeclaredWebLink[];
	providerErrors: Map<FetchProvider, string>;
}

/** Final result when no provider returned content: the best partial answer plus setup guidance. */
function fallbackDiagnostics(
	request: ProviderFallbackRequest,
	outcome: FallbackOutcome,
): ExtractedContent {
	const { url, options, providerOrder, fetchRouting, redirectPolicy } = request;
	const { httpResult, declaredLinks, providerErrors } = outcome;

	if (httpResult && declaredLinks.length > 0) return { ...httpResult, error: null };

	// A definitive 404/410 from the origin means no extraction provider can retrieve the
	// page, so the provider-configuration checklist would send users down the wrong path.
	if (httpResult?.status === 404 || httpResult?.status === 410) {
		return { ...httpResult, error: notFoundGuidance(httpResult, options?.toolNames) };
	}
	// Under the redirect policy no other provider may run, so provider setup hints do not apply.
	if (redirectPolicy && httpResult) return httpResult;

	const searchToolName = options?.toolNames?.webSearch;
	const jinaHint = jinaReaderGuidance(
		fetchRouting,
		providerOrder,
		Boolean(request.remoteUrl) && !fetchRouting.allowRemoteHostedProviders,
	);
	const guidance = [
		httpResult?.error ?? "No fetch_content provider returned content",
		...PROVIDER_ERROR_LABELS.flatMap(([provider, label]) => {
			const error = providerErrors.get(provider);
			return error ? [`${label} fallback failed: ${error}`] : [];
		}),
		"",
		"Fallback options:",
		...(jinaHint ? [jinaHint] : []),
		`  • Set firecrawlBaseUrl in ${WEB_SEARCH_CONFIG_PATH} to a self-hosted Firecrawl instance`,
		`  • Set crawl4aiBaseUrl in ${WEB_SEARCH_CONFIG_PATH} to a self-hosted Crawl4AI instance`,
		`  • Set tinyfishApiKey in ${WEB_SEARCH_CONFIG_PATH} or TINYFISH_API_KEY`,
		`  • Set search1apiApiKey in ${WEB_SEARCH_CONFIG_PATH} or SEARCH1API_KEY`,
		`  • Set queritApiKey in ${WEB_SEARCH_CONFIG_PATH} or QUERIT_API_KEY`,
		`  • Set kagiApiKey in ${WEB_SEARCH_CONFIG_PATH} or KAGI_API_KEY`,
		`  • Set ollamaApiKey in ${WEB_SEARCH_CONFIG_PATH} or OLLAMA_API_KEY`,
		`  • Set parallelApiKey in ${WEB_SEARCH_CONFIG_PATH} or PARALLEL_API_KEY`,
		`  • Set brightdataApiKey and brightdataUnlockerZone in ${WEB_SEARCH_CONFIG_PATH} or BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE`,
		`  • Set deepseekApiKey in ${WEB_SEARCH_CONFIG_PATH} or DEEPSEEK_API_KEY and add "deepseek" to fetchRouting.providers`,
		`  • Set GEMINI_API_KEY in ${WEB_SEARCH_CONFIG_PATH}`,
		"  • Sign into gemini.google.com in Chrome",
		...(searchToolName ? [`  • Use ${searchToolName} to find content about this topic`] : []),
	].join("\n");
	return { ...(httpResult ?? failure(url, "")), error: guidance };
}

/**
 * Fetches one URL: safety and config gates, special sources (video, GitHub, YouTube),
 * the HTTP gate, the configured provider fallback, then final diagnostics.
 */
export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) return abortedResult(url);

	const target = await prepareTarget(url, options);
	if ("error" in target) return failure(url, target.error);

	if (options?.authFetchProfile || options?.mode === "raw") {
		try {
			return await extractViaHttp(url, resolveFetchTimeoutMs(options), signal, options);
		} catch (err) {
			return failure(url, errorMessage(err));
		}
	}

	const refusal = target.redirectPolicy ? redirectPolicyRefusal(url) : null;
	if (refusal) return refusal;

	const frames = await frameRequestResult(url, options);
	if (frames) return frames;

	const video = await localVideoAnalysis(url, signal, options);
	if (video) return video;

	if (!target.remoteUrl) {
		try {
			new URL(url);
		} catch (err) {
			return failure(url, errorMessage(err));
		}
	}

	const source = await specialSourceResult(url, signal, options);
	if (source) return source;

	if (signal?.aborted) return abortedResult(url);

	let timeoutMs: number;
	let fetchRouting: FetchRouting;
	try {
		timeoutMs = resolveFetchTimeoutMs(options);
		fetchRouting = loadFetchRouting();
	} catch (err) {
		return failure(url, errorMessage(err));
	}

	const order = resolveProviderOrder(url, target, fetchRouting);
	if ("refusal" in order) return order.refusal;

	return providerFallback({
		url,
		signal,
		options,
		timeoutMs,
		providerOrder: order.providers,
		fetchRouting,
		...target,
	});
}

// Cloudflare interstitials served with HTTP 200. The header is authoritative for
// any text response; the body check is HTML-only and needs both challenge-platform
// markers so a generic "Just a moment..." page never matches.
function isCloudflareChallenge(response: Response, text: string, isHTML: boolean): boolean {
	if (response.status !== 200) return false;
	if (response.headers.get("cf-mitigated") === "challenge") return true;
	return (
		isHTML &&
		/<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text) &&
		text.includes("window._cf_chl_opt") &&
		text.includes("/cdn-cgi/challenge-platform/")
	);
}

// The HTML spec's JavaScript MIME type essences; any other type (JSON-LD,
// text/template, ...) is a data block that never runs.
const JAVASCRIPT_MIME_TYPES = new Set([
	"application/ecmascript",
	"application/javascript",
	"application/x-ecmascript",
	"application/x-javascript",
	"text/ecmascript",
	"text/javascript",
	"text/javascript1.0",
	"text/javascript1.1",
	"text/javascript1.2",
	"text/javascript1.3",
	"text/javascript1.4",
	"text/javascript1.5",
	"text/jscript",
	"text/livescript",
	"text/x-ecmascript",
	"text/x-javascript",
]);

function isExecutableScriptType(type: string | null): boolean {
	const mime = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	return mime === "" || mime === "module" || JAVASCRIPT_MIME_TYPES.has(mime);
}

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch?.[1]) return false;

	const bodyHtml = bodyMatch[1];

	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	const scriptCount = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((match) => {
		const attrs = match[1];
		if (!attrs) return false;
		return isExecutableScriptType(attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? null);
	}).length;

	return textContent.length < 500 && scriptCount > 3;
}

export async function readPDFResponseBuffer(
	response: Response,
	maxSizeMB: number,
): Promise<ArrayBuffer> {
	const maxBytes = maxSizeMB * 1024 * 1024;
	return readResponseBufferWithLimit(response, maxBytes, () => pdfSizeLimitError(maxSizeMB));
}

async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
	const buffer = await readResponseBufferWithLimit(response, maxBytes, () =>
		responseSizeLimitError(maxBytes),
	);
	const charset = response.headers
		.get("content-type")
		?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml")
	);
}

async function readResponseBufferWithLimit(
	response: Response,
	maxBytes: number,
	buildError: () => Error,
): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) throw buildError();
		return buffer;
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw buildError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

function pdfSizeLimitError(maxSizeMB: number): Error {
	return new Error(`PDF exceeds configured pdf.maxSizeMB limit (${maxSizeMB} MB)`);
}

function responseSizeLimitError(maxBytes: number): Error {
	return new Error(`Response too large (${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

const BROWSER_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
// Servers that support markdown content negotiation (Cloudflare Markdown for
// Agents, Mintlify, Vercel) return markdown directly; others see the same
// relative preferences as BROWSER_ACCEPT. Raw mode keeps BROWSER_ACCEPT so it
// returns the server's normal representation.
const MARKDOWN_FIRST_ACCEPT =
	"text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,image/avif;q=0.9,image/webp;q=0.9,image/apng;q=0.9,*/*;q=0.7";

/** One HTTP response plus the request facts its parsers need. */
interface HttpParseContext {
	url: string;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	options: ExtractOptions | undefined;
	preferMarkdown: boolean;
	/** Aborts on the request timeout or the caller's signal. */
	requestSignal: AbortSignal;
	startedAt: number;
	activityId: string;
	response: Response;
	contentType: string;
	mimeType: string;
	isPDFContent: boolean;
	pdfConfig: ReturnType<typeof loadPDFConfig> | null;
	maxResponseSize: number;
}

/** One HTTP request with the browser-like headers fetch_content sends. */
async function requestRemotePage(
	url: string,
	requestSignal: AbortSignal,
	options: ExtractOptions | undefined,
	preferMarkdown: boolean,
): Promise<Response> {
	const ssrf = loadSsrfConfig();
	const requestInit: ProxiedRequestInit = {
		signal: requestSignal,
		__proxy: options?.proxy,
		headers: {
			"User-Agent": loadFetchContentUserAgent(),
			Accept: preferMarkdown ? MARKDOWN_FIRST_ACCEPT : BROWSER_ACCEPT,
			"Accept-Language": "en-US,en;q=0.9",
			"Cache-Control": "no-cache",
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "none",
			"Sec-Fetch-User": "?1",
			"Upgrade-Insecure-Requests": "1",
		},
	};
	const validation = {
		domainPolicy: loadFetchContentDomainPolicy(),
		redirects: options?.redirects ?? loadFetchContentRedirectPolicy(),
		proxy: options?.proxy,
		...(options?.lookup ? { lookup: options.lookup } : {}),
	};
	if (options?.authFetchProfile) {
		return fetchAuthenticatedRemoteUrl(
			url,
			requestInit,
			{ ssrf, ...validation },
			options.authFetchProfile,
		);
	}
	return fetchRemoteUrl(url, requestInit, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		...validation,
	});
}

/** Raw mode returns the server's own representation of the page. */
async function parseRawBody(context: HttpParseContext): Promise<HttpExtractedContent | null> {
	const { url, options, response, contentType, mimeType, isPDFContent, maxResponseSize } = context;
	if (options?.mode !== "raw") return null;
	if (!isTextContentType(contentType)) {
		activityMonitor.logComplete(context.activityId, response.status);
		const hint = isPDFContent
			? '; retry without mode for Markdown, or with mode "answer" and a prompt'
			: "";
		return {
			url,
			title: "",
			content: "",
			error: `Unsupported content type in raw mode: ${mimeType || "missing"}${hint}`,
			mimeType,
			status: response.status,
		};
	}
	const text = await readTextResponseWithLimit(response, maxResponseSize);
	activityMonitor.logComplete(context.activityId, response.status);
	return {
		url,
		title: extractTextTitle(text, url),
		content: text,
		error: null,
		mimeType,
		status: response.status,
	};
}

/** A supported image becomes the payload, resized to the inline limits. */
async function parseImageBody(context: HttpParseContext): Promise<HttpExtractedContent | null> {
	const { url, options, response, mimeType, maxResponseSize } = context;
	if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return null;
	const disabled = imageGateError();
	if (disabled) {
		activityMonitor.logComplete(context.activityId, response.status);
		return { url, title: "", content: "", error: disabled, mimeType, status: response.status };
	}
	if (options?.rejectDirectImages) {
		activityMonitor.logComplete(context.activityId, response.status);
		return {
			url,
			title: "",
			content: "",
			error: options.rejectDirectImages,
			mimeType,
			status: response.status,
		};
	}
	try {
		const buffer = await readResponseBufferWithLimit(response, maxResponseSize, () =>
			responseSizeLimitError(maxResponseSize),
		);
		const { resizeImage } = await import("@earendil-works/pi-coding-agent");
		const resized = await resizeImage(new Uint8Array(buffer), mimeType, {
			maxWidth: 2000,
			maxHeight: 2000,
		});
		activityMonitor.logComplete(context.activityId, response.status);
		if (!resized) {
			return {
				url,
				title: "",
				content: "",
				error: `Could not decode image: ${mimeType}`,
				mimeType,
				status: response.status,
			};
		}
		return {
			url,
			title: new URL(response.url || url).pathname.split("/").pop() || url,
			content: `Image fetched (${resized.width}×${resized.height}, ${resized.mimeType})`,
			error: null,
			thumbnail: { data: resized.data, mimeType: resized.mimeType },
			mimeType: resized.mimeType,
			status: response.status,
		};
	} catch (err) {
		const message = errorMessage(err);
		activityMonitor.logError(context.activityId, message);
		return { url, title: "", content: "", error: message, mimeType, status: response.status };
	}
}

/** A PDF goes through the PDF pipeline, which saves the markdown and reports the path. */
async function parsePdfBody(context: HttpParseContext): Promise<HttpExtractedContent | null> {
	const { url, signal, options, response, pdfConfig } = context;
	if (!pdfConfig) return null;
	try {
		const buffer = await readPDFResponseBuffer(response, pdfConfig.maxSizeMB);
		if (signal?.aborted) return abortedResult(url);
		const result = await extractPDFToMarkdown(buffer, url, { signal });
		activityMonitor.logComplete(context.activityId, response.status);
		return {
			url,
			title: result.title,
			content:
				options?.mode === "answer"
					? result.content
					: `PDF extracted and saved to: ${result.outputPath}\n\n${result.pages > 0 ? `Pages: ${result.pages}\n` : ""}Characters: ${result.chars}`,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		activityMonitor.logError(context.activityId, message);
		if (message.startsWith("PDF exceeds configured pdf.maxSizeMB limit")) {
			return { url, title: "", content: "", error: message };
		}
		if (err instanceof CredentialResolutionError || isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
		return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
	}
}

const UNSUPPORTED_CONTENT_TYPES = [
	"application/octet-stream",
	"image/",
	"audio/",
	"video/",
	"application/zip",
];

function unsupportedBodyResult(context: HttpParseContext): HttpExtractedContent | null {
	const { url, response, contentType } = context;
	if (!UNSUPPORTED_CONTENT_TYPES.some((type) => contentType.includes(type))) return null;
	activityMonitor.logComplete(context.activityId, response.status);
	return {
		url,
		title: "",
		content: "",
		error: `Unsupported content type: ${contentType.split(";")[0]}`,
	};
}

/** Plain text and negotiated markdown, including the short-markdown browser retry. */
async function parseTextBody(
	context: HttpParseContext,
	text: string,
): Promise<HttpExtractedContent> {
	const { url, preferMarkdown, response, mimeType } = context;
	activityMonitor.logComplete(context.activityId, response.status);
	const title = extractTextTitle(text, url);
	if (mimeType !== "text/markdown" && mimeType !== "text/x-markdown") {
		return { url, title, content: text, error: null };
	}
	const declaredLinks = discoverDeclaredWebLinks(
		null,
		response.headers.get("link"),
		response.url || url,
	);
	const markdown = {
		url,
		title,
		content: appendDeclaredWebLinks(text, declaredLinks),
		error: null,
		declaredLinks,
	};
	if (!preferMarkdown || text.trim().length >= MIN_USEFUL_CONTENT) return markdown;
	return retryWithBrowserAccept(context, markdown);
}

/** Short negotiated markdown is re-requested with the browser Accept header, sharing the
 * remaining time budget. That response stays authoritative for policy/config rejection,
 * not-found status, cancellation, and any content it has. The markdown only fills a
 * recoverable empty response, marked incomplete with its status and error. */
async function retryWithBrowserAccept(
	context: HttpParseContext,
	markdown: HttpExtractedContent,
): Promise<HttpExtractedContent> {
	const { url, timeoutMs, startedAt, signal, options } = context;
	const normal = await extractViaHttp(
		url,
		Math.max(1, timeoutMs - (Date.now() - startedAt)),
		signal,
		options,
		false,
	);
	if (
		signal?.aborted ||
		isNonRecoverableHttpError(normal.error) ||
		normal.status === 404 ||
		normal.status === 410 ||
		isAbortError(normal.error)
	) {
		return normal;
	}
	const normalHasBody =
		normal.content.trim() !== appendDeclaredWebLinks("", normal.declaredLinks ?? []).trim();
	if (normalHasBody || !markdown.content.trim()) return normal;
	return {
		...normal,
		...markdown,
		error:
			"Extracted content appears incomplete" +
			(normal.error ? `\nBrowser retry failed: ${normal.error}` : ""),
	};
}

/** HTML that Readability could not turn into enough content: RSC payloads first, then
 * Defuddle. Returns null when neither reaches the useful-content floor. */
async function readableFallbackContent(
	context: HttpParseContext,
	text: string,
	declaredLinks: DeclaredWebLink[],
	fallbackTitle: string,
): Promise<HttpExtractedContent | null> {
	const { url, response, requestSignal } = context;
	const rsc = extractRSCContent(text);
	if (rsc && rsc.content.length >= MIN_USEFUL_CONTENT) {
		return {
			url,
			title: rsc.title,
			content: appendDeclaredWebLinks(rsc.content, declaredLinks),
			error: null,
			declaredLinks,
		};
	}
	requestSignal.throwIfAborted();
	const defuddle = await extractWithDefuddle(text, response.url || url);
	requestSignal.throwIfAborted();
	if (!defuddle || defuddle.content.length < MIN_USEFUL_CONTENT) return null;
	return {
		url,
		title: fallbackTitle || defuddle.title,
		content: appendDeclaredWebLinks(defuddle.content, declaredLinks),
		error: null,
		declaredLinks,
	};
}

/** Explains a short extraction by how much of the page's own visible text it covers. */
async function shortContentError(text: string, markdown: string): Promise<string | null> {
	if (isLikelyJSRendered(text)) {
		return "Page appears to be JavaScript-rendered (content loads dynamically)";
	}
	// Readability mutated `document`, so measure the page's own visible text from a fresh
	// parse. A static page whose whole body is under the floor is complete once something
	// was extracted from it; any executable script means the text may be a placeholder for
	// client rendering.
	const { parseHTML } = await import("linkedom");
	const { document: original } = parseHTML(text);
	const hasExecutableScript = Array.from(original.querySelectorAll("script")).some((script) =>
		isExecutableScriptType(script.getAttribute("type")),
	);
	for (const node of Array.from(original.querySelectorAll("script, style, noscript, template"))) {
		node.remove();
	}
	const visibleChars = (original.body?.textContent ?? "").replace(/\s+/g, " ").trim().length;
	const extractedChars = markdown.trim().length;
	const counts = `Extracted content appears incomplete: extracted ${extractedChars} characters from a page with ${visibleChars} characters of visible text`;
	if (visibleChars >= MIN_USEFUL_CONTENT) return counts;
	if (hasExecutableScript) {
		return `Extracted content appears incomplete: the page has only ${visibleChars} characters of visible text and runs scripts, so content may load dynamically`;
	}
	return extractedChars > 0 ? null : counts;
}

/** Readability output, with the shared RSC/Defuddle fallback for short results. */
async function parseHtmlBody(
	context: HttpParseContext,
	text: string,
): Promise<HttpExtractedContent> {
	const { url, response } = context;
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(text);
	const documentTitle = document.title?.trim() ?? "";
	const declaredLinks = discoverDeclaredWebLinks(
		document as unknown as Document,
		response.headers.get("link"),
		response.url || url,
	);
	const { Readability } = await import("@mozilla/readability");
	const article = new Readability(document as unknown as Document).parse();

	if (!article) {
		const fallback = await readableFallbackContent(context, text, declaredLinks, documentTitle);
		if (fallback) {
			activityMonitor.logComplete(context.activityId, response.status);
			return fallback;
		}
		activityMonitor.logComplete(context.activityId, response.status);
		return {
			url,
			title: documentTitle,
			content: appendDeclaredWebLinks("", declaredLinks),
			error: isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure",
			declaredLinks,
		};
	}

	if (typeof article.content !== "string") {
		throw new Error("Readability returned invalid article content");
	}
	const markdown = (await getTurndown()).turndown(article.content);
	const title = article.title || documentTitle;
	activityMonitor.logComplete(context.activityId, response.status);

	if (markdown.length < MIN_USEFUL_CONTENT) {
		const fallback = await readableFallbackContent(context, text, declaredLinks, title);
		if (fallback) return fallback;
		return {
			url,
			title,
			content: appendDeclaredWebLinks(markdown, declaredLinks),
			error: await shortContentError(text, markdown),
			declaredLinks,
		};
	}

	return {
		url,
		title,
		content: appendDeclaredWebLinks(markdown, declaredLinks),
		error: null,
		declaredLinks,
	};
}

/** Body-level gates, then dispatch by body kind: raw, image, PDF, binary, text, HTML. */
async function parseHttpResponse(context: HttpParseContext): Promise<HttpExtractedContent> {
	const { url, response, contentType, pdfConfig, maxResponseSize } = context;

	if (pdfConfig && !pdfConfig.enabled) {
		activityMonitor.logComplete(context.activityId, response.status);
		return {
			url,
			title: "",
			content: "",
			error: "PDF extraction is disabled by pdf.enabled",
			mimeType: context.mimeType,
			status: response.status,
		};
	}

	const contentLengthHeader = response.headers.get("content-length");
	if (contentLengthHeader) {
		const contentLength = Number.parseInt(contentLengthHeader, 10);
		if (Number.isFinite(contentLength) && contentLength > maxResponseSize) {
			activityMonitor.logComplete(context.activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: pdfConfig
					? pdfSizeLimitError(pdfConfig.maxSizeMB).message
					: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
			};
		}
	}

	const raw = await parseRawBody(context);
	if (raw) return raw;
	const image = await parseImageBody(context);
	if (image) return image;
	const pdf = await parsePdfBody(context);
	if (pdf) return pdf;
	const binary = unsupportedBodyResult(context);
	if (binary) return binary;

	const text = await readTextResponseWithLimit(response, maxResponseSize);
	const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
	if (isCloudflareChallenge(response, text, isHTML)) {
		activityMonitor.logComplete(context.activityId, response.status);
		return {
			url,
			title: "",
			content: "",
			error: `HTTP ${response.status}: Blocked by Cloudflare challenge page`,
			status: response.status,
		};
	}
	return isHTML ? parseHtmlBody(context, text) : parseTextBody(context, text);
}

/** One HTTP fetch: owns the request lifecycle, then hands the response to the parsers. */
async function extractViaHttp(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	options?: ExtractOptions,
	preferMarkdown = options?.mode !== "raw",
): Promise<HttpExtractedContent> {
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const controller = new AbortController();
	const startedAt = Date.now();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await requestRemotePage(url, controller.signal, options, preferMarkdown);
		if (!response.ok && options?.mode !== "raw") {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
				status: response.status,
			};
		}
		const contentType = response.headers.get("content-type") || "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const isPDFContent = isPDF(url, contentType);
		const pdfConfig = isPDFContent ? loadPDFConfig() : null;
		return await parseHttpResponse({
			url,
			timeoutMs,
			signal,
			options,
			preferMarkdown,
			requestSignal: controller.signal,
			startedAt,
			activityId,
			response,
			contentType,
			mimeType,
			isPDFContent,
			pdfConfig,
			maxResponseSize: (pdfConfig?.maxSizeMB ?? 5) * 1024 * 1024,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort") || signal?.aborted || controller.signal.aborted) {
			activityMonitor.logComplete(activityId, 0);
			if (signal?.aborted) return abortedResult(url);
			return { url, title: "", content: "", error: "The operation was aborted." };
		}
		activityMonitor.logError(activityId, message);
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match?.[1]) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const results = await Promise.all(
		urls.map((url) => fetchLimit(() => extractContent(url, signal, options))),
	);
	if (options?.mode === "raw") return results;
	// Inline data: URIs in extracted markdown would otherwise flow into tool
	// results and the fetch cache as opaque base64; typed thumbnail/frame image
	// blocks are deliberate outputs and are left untouched.
	return results.map((result, index) => {
		if (!result.content) return result;
		const sanitized = sanitizeInlineDataUris(result.content, `urls[${index}].content`);
		return sanitized.omissions.length > 0 ? { ...result, content: sanitized.text } : result;
	});
}
