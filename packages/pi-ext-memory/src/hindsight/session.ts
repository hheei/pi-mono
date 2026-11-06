function getPersistedSystemSection(
	messages: readonly unknown[],
	sectionName: string,
): string | undefined {
	const sections = new Map<string, string>();
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const m = msg as { role?: unknown; sections?: Record<string, string | null | undefined> };
		if (m.role !== "system" || !m.sections) continue;
		for (const [name, value] of Object.entries(m.sections)) {
			if (value === null || value === undefined) sections.delete(name);
			else sections.set(name, value);
		}
	}
	return sections.get(sectionName);
}

import {
	type AgentEndEvent,
	type BeforeAgentStartEvent,
	buildSessionContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, isSubagentProcess, setPromptSection } from "@hheei/pi-ext-core";
import { debugLog } from "../debug-log.js";
import {
	type HindsightGateway,
	type HindsightPageHit,
	type HindsightPageSummary,
	openHindsightGateway,
} from "./client.js";
import {
	type HindsightBankSource,
	type HindsightIsolationMode,
	loadHindsightConfig,
	type ResolvedHindsight,
} from "./config.js";
import { renderHindsightPreamble, renderMemoryContainer, TRUNCATION_NOTICE } from "./prompt.js";
import { HindsightRetainQueue, type HindsightRetainStatus } from "./queue.js";
import { buildHindsightTurns } from "./transcript.js";

/** Knowledge-page hits injected before a turn when auto-recall is on. */
export const AUTO_RECALL_PAGE_LIMIT = 3;

/** What this turn actually put into the prompt, so the extension can show it to the user. */
export interface HindsightInjection {
	readonly summary: string;
	readonly pages: readonly HindsightPageHit[];
	/** True when the memory container had to be cut to the configured character budget. */
	readonly truncated: boolean;
}

/**
 * Prompt sections this extension owns. Pi diffs sections per request, so the preamble is sent
 * once and recalled facts are replaced only when they change.
 */
const PREAMBLE_SECTION = "hindsight-preamble";
const RECALL_SECTION = "hindsight-recall";

/**
 * Common short affirmation or continuation phrases that indicate the user is simply
 * continuing the conversation rather than asking a new substantive question.
 */
export const TRIVIAL_CONTINUATION_PATTERNS = new Set([
	// English affirmations & continuations
	"ok",
	"okay",
	"yes",
	"yep",
	"yeah",
	"sure",
	"go",
	"go ahead",
	"continue",
	"proceed",
	"next",
	"done",
	"carry on",
	"keep going",
	// Chinese affirmations & continuations
	"好",
	"好的",
	"行",
	"行啊",
	"可以",
	"可以的",
	"没问题",
	"没问题啊",
	"继续",
	"继续吧",
	"接着来",
	"接着说",
	"接着写",
	"下一步",
	"对",
	"对的",
	"是的",
	"恩",
	"嗯",
]);

export function isTrivialContinuation(prompt: string): boolean {
	const normalized = prompt
		.trim()
		.toLowerCase()
		.replace(/^[!?,.，。？！~\s]+|[!?,.，。？！~\s]+$/gu, "");
	return TRIVIAL_CONTINUATION_PATTERNS.has(normalized);
}

export function normalizeRecallQuery(prompt: string): string {
	return prompt.trim().toLowerCase().replace(/\s+/gu, " ");
}

interface PromptRecallResult {
	readonly text: string | undefined;
	readonly pages: readonly HindsightPageHit[];
	readonly truncated: boolean;
}

/** Local diagnostic snapshot exposed to `/om status`. */
export interface HindsightDiagnostics {
	readonly bankId: string;
	readonly bankSource: HindsightBankSource;
	readonly repo: string;
	readonly isolationMode: HindsightIsolationMode;
	readonly scopeTags: readonly string[];
	readonly retainTags: readonly string[];
	readonly apiUrl: string;
	readonly mcpUrl: string;
	readonly bankMcpUrl: string;
	readonly tokenConfigured: boolean;
	readonly autoRecall: boolean;
	readonly retainSessions: boolean;
	readonly writeback: HindsightRetainStatus;
	readonly fileConfigOverride?: string | undefined;
}

/** Result of booting the Hindsight layer for one session. */
export type HindsightStart =
	| { readonly status: "disabled" }
	| { readonly status: "ready"; readonly session: HindsightSession }
	| { readonly status: "error"; readonly error: string };

/**
 * Session-scoped Hindsight state: resolved configuration, the gateway bound to it, and the
 * ordered writeback queue.
 *
 * Owns exactly what the plan assigns to this extension: retrieving memory for the prompt
 * and writing the session's turns back. It never replaces the session's own compaction,
 * which stays owned by observational memory.
 */
export class HindsightSession {
	readonly resolved: ResolvedHindsight;
	readonly gateway: HindsightGateway;
	readonly retainQueue: HindsightRetainQueue;
	static readonly #MAX_CACHE_ENTRIES = 50;
	readonly #recallCache = new Map<string, PromptRecallResult>();
	#lastRecallResult: PromptRecallResult | undefined;
	#firstTurn = true;
	#lifecycleSignal: AbortSignal;
	readonly #preamblePromise: Promise<string>;

	constructor(
		resolved: ResolvedHindsight,
		gateway: HindsightGateway,
		signal: AbortSignal,
		preamble?: string,
	) {
		this.resolved = resolved;
		this.gateway = gateway;
		this.retainQueue = new HindsightRetainQueue(gateway);
		this.#lifecycleSignal = signal;
		this.#preamblePromise =
			preamble === undefined ? this.#renderPreamble() : Promise.resolve(preamble);
	}

	/** Snapshot of local configuration and writeback queue state. */
	diagnostics(fileConfigOverride?: string): HindsightDiagnostics {
		return {
			bankId: this.resolved.bankId,
			bankSource: this.resolved.bankSource,
			repo: this.resolved.repo,
			isolationMode: this.resolved.isolationMode,
			scopeTags: this.resolved.scopeTags,
			retainTags: this.resolved.retainTags,
			apiUrl: this.resolved.config.apiUrl,
			mcpUrl: this.resolved.config.mcpUrl,
			bankMcpUrl: this.resolved.bankMcpUrl,
			tokenConfigured: this.resolved.config.apiToken !== undefined,
			autoRecall: this.resolved.config.autoRecall,
			retainSessions: this.resolved.config.retainSessions,
			writeback: this.retainQueue.status(),
			...(fileConfigOverride ? { fileConfigOverride } : {}),
		};
	}

	invalidateRecallCache(): void {
		this.#recallCache.clear();
		this.#lastRecallResult = undefined;
	}

	/**
	 * Adds long-term memory to the prompt as two named sections.
	 *
	 * Every turn supplies the complete desired sections. Omitting a section tells Pi to
	 * delete it; supplying the same cached preamble lets Pi avoid a prompt update.
	 * Only the first turn reports the guide in the visible injection summary.
	 */
	async beforeAgentStart(event: BeforeAgentStartEvent): Promise<HindsightInjection | undefined> {
		if (this.#lifecycleSignal.aborted) return undefined;
		const sections = event.systemPromptOptions.sections;
		const firstTurn = this.#firstTurn;
		this.#firstTurn = false;

		const recallPromise =
			this.resolved.config.autoRecall &&
			event.messageType === "user" &&
			event.prompt.trim().length > 0
				? this.#recallForPrompt(event.prompt)
				: undefined;

		const [preamble, recalled] = await Promise.all([this.#preamblePromise, recallPromise]);
		if (this.#lifecycleSignal.aborted) return undefined;
		setPromptSection(sections, PREAMBLE_SECTION, preamble);

		const summary: string[] = [];
		if (firstTurn) {
			summary.push("memory guide");
		}
		let pages: HindsightPageHit[] = [];
		let truncated = false;
		if (recalled !== undefined) {
			setPromptSection(sections, RECALL_SECTION, recalled.text);
			pages = [...recalled.pages];
			truncated = recalled.truncated;
			if (pages.length > 0)
				summary.push(`recalled ${pages.length} page${pages.length === 1 ? "" : "s"}`);
		}
		return summary.length === 0 ? undefined : { summary: summary.join(" + "), pages, truncated };
	}

	async #renderPreamble(): Promise<string> {
		if (!this.resolved.config.autoRecall) {
			return renderHindsightPreamble({
				repo: this.resolved.repo,
				bankId: this.resolved.bankId,
				isolationMode: this.resolved.isolationMode,
				pagesAvailable: true,
				pages: [],
				autoRecall: false,
			});
		}
		let pages: HindsightPageSummary[] = [];
		let pagesAvailable = true;
		try {
			const listed = await this.gateway.listPages(this.#lifecycleSignal);
			pages = [...listed.pages];
			pagesAvailable = listed.pagesAvailable;
		} catch (error) {
			// A cold or unreachable server must not block the session; the preamble then
			// describes the memory without a page index, and tools report the real error.
			pagesAvailable = false;
			debugLog("hindsight.preamble_pages_unavailable", {
				error: errorMessage(error),
			});
		}
		return renderHindsightPreamble({
			repo: this.resolved.repo,
			bankId: this.resolved.bankId,
			isolationMode: this.resolved.isolationMode,
			pagesAvailable,
			pages,
			autoRecall: true,
		});
	}

	async #recallForPrompt(prompt: string): Promise<PromptRecallResult> {
		if (isTrivialContinuation(prompt)) {
			return this.#lastRecallResult ?? { text: undefined, pages: [], truncated: false };
		}

		const key = normalizeRecallQuery(prompt);
		const cached = this.#recallCache.get(key);
		if (cached !== undefined) {
			this.#lastRecallResult = cached;
			return cached;
		}

		let hits: HindsightPageHit[];
		try {
			hits = await this.gateway.searchPages(prompt, AUTO_RECALL_PAGE_LIMIT, this.#lifecycleSignal);
		} catch (error) {
			debugLog("hindsight.auto_recall_failed", {
				error: errorMessage(error),
			});
			return { text: undefined, pages: [], truncated: false };
		}
		const fragments = hits.map(
			(hit) => `---\npage: ${JSON.stringify(hit.page)}\nid: ${hit.pageId}\n---\n\n${hit.snippet}`,
		);
		const text = renderMemoryContainer(fragments, this.resolved.config.maxMemoryChars);
		const result: PromptRecallResult = {
			text,
			pages: hits,
			// The container announces its own truncation; the injection report repeats it.
			truncated: text?.includes(TRUNCATION_NOTICE) ?? false,
		};

		if (this.#recallCache.size >= HindsightSession.#MAX_CACHE_ENTRIES) {
			const oldestKey = this.#recallCache.keys().next().value;
			if (oldestKey !== undefined) this.#recallCache.delete(oldestKey);
		}
		this.#recallCache.set(key, result);
		this.#lastRecallResult = result;
		return result;
	}

	/** Queues this run's turns for writeback. */
	agentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
		if (!this.resolved.config.retainSessions) return;
		const turns = buildHindsightTurns(event.messages);
		if (turns.length === 0) return;
		this.retainQueue.enqueue(sessionIdOf(ctx), turns, this.#lifecycleSignal);
	}

	/** Flushes pending writeback within a bounded grace period, then cancels what is left. */
	async dispose(): Promise<void> {
		const drained = await this.retainQueue.drain();
		if (!drained) {
			debugLog("hindsight.retain_drain_timeout", {
				...this.retainQueue.status(),
			});
		}
	}
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "unknown";
	}
}

/**
 * Resolves configuration and opens the gateway.
 *
 * Returns `disabled` — with no client constructed, no network client loaded, and no
 * fallback config file read — unless `pi-ext-memory.hindsight.enabled` is explicitly true.
 */
export async function startHindsightSession(
	context: Pick<ExtensionContext, "cwd" | "sessionManager">,
	signal: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HindsightStart> {
	try {
		if (isSubagentProcess(env)) return { status: "disabled" };
		const resolved = await loadHindsightConfig(context.cwd, env, signal);
		if (resolved === undefined) return { status: "disabled" };
		const gateway = await openHindsightGateway(resolved);
		if ("error" in gateway) return { status: "error", error: gateway.error };
		const messages = buildSessionContext(context.sessionManager.getBranch()).messages;
		const persisted = getPersistedSystemSection(messages, PREAMBLE_SECTION);
		const opening = `<${PREAMBLE_SECTION}>\n`;
		const closing = `\n</${PREAMBLE_SECTION}>`;
		const body =
			persisted?.startsWith(opening) && persisted.endsWith(closing)
				? persisted.slice(opening.length, -closing.length)
				: undefined;
		const guide = renderHindsightPreamble({
			repo: resolved.repo,
			bankId: resolved.bankId,
			isolationMode: resolved.isolationMode,
			pagesAvailable: true,
			pages: [],
			autoRecall: resolved.config.autoRecall,
		});
		const preamble = body?.startsWith(guide.slice(0, guide.indexOf("\n\nKnowledge pages:")))
			? body
			: undefined;
		return { status: "ready", session: new HindsightSession(resolved, gateway, signal, preamble) };
	} catch (error) {
		return { status: "error", error: errorMessage(error) };
	}
}
