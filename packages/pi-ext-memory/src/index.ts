import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	isRecord,
	isSubagentProcess,
	MEMORY_COMPACTOR_SERVICE_KEY,
	provideService,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import { registerOmCommand } from "./commands/om.js";
import { transformHindsightMarkdown } from "./hindsight/markdown.js";
import {
	checkMcpFileOverride,
	HINDSIGHT_MCP_SERVER_NAME,
	HINDSIGHT_MCP_TIMEOUT_SECONDS,
	HINDSIGHT_MCP_TOOL_EXPOSURES,
	isHindsightBusinessError,
	isHindsightWriteTool,
} from "./hindsight/mcp.js";
import { registerHindsightRenderers } from "./hindsight/renderers.js";
import { type HindsightSession, startHindsightSession } from "./hindsight/session.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { createMemoryInfo } from "./info.js";
import { Runtime } from "./runtime.js";
import {
	hydrateCompactionCheckpoints,
	installCompactionCheckpointDedup,
} from "./session-ledger/compaction-checkpoint.js";
import {
	countSourceEntriesAfterCompaction,
	type Entry,
	foldLedger,
	latestGateEnabled,
} from "./session-ledger/index.js";
import { renderSummary } from "./session-ledger/render-summary.js";
import { createMemorySettingsProvider } from "./settings.js";
import { registerRecallEvidenceTool } from "./tools/om-recall-evidence.js";

export default function observationalMemory(pi: ExtensionAPI): void {
	registerHindsightRenderers(pi);
	const runtime = new Runtime();
	let hindsight: HindsightSession | undefined;
	let lastFileOverride: string | undefined;

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerOmCommand(pi, runtime, {
		getHindsightDiagnostics: () => hindsight?.diagnostics(lastFileOverride),
	});
	registerRecallEvidenceTool(pi);
	if (typeof pi.registerMarkdownTransformer === "function") {
		pi.registerMarkdownTransformer(transformHindsightMarkdown);
	}
	const info = createMemoryInfo(pi);

	pi.on("before_agent_start", async (event, ctx) => {
		if (hindsight === undefined || isSubagentProcess()) return;
		const shouldRecall =
			hindsight.resolved.config.autoRecall &&
			event.messageType === "user" &&
			event.prompt.trim().length > 0;
		if (shouldRecall) ctx?.ui?.setWorkingMessage?.("Recalling");
		try {
			const injected = await hindsight.beforeAgentStart(event);
			if (injected === undefined) return;
			info(injected.summary, {
				pages: injected.pages.map(({ pageId, page, snippet }) => ({ pageId, page, snippet })),
				truncated: injected.truncated,
			});
		} finally {
			if (shouldRecall) ctx?.ui?.setWorkingMessage?.(undefined);
		}
	});
	pi.on("agent_end", async (event, context) => {
		if (isSubagentProcess()) return;
		hindsight?.agentEnd(event, context);
	});
	pi.on("tool_result", async (event) => {
		if (isSubagentProcess()) return;
		if (!event.toolName.startsWith("mcp__hindsight__")) return;

		const isBusinessError = isHindsightBusinessError(event);
		if (isBusinessError) {
			let structuredContent = event.structuredContent;
			let innerNeedsFix = false;
			if (isRecord(structuredContent) && structuredContent.isError !== true) {
				structuredContent = { ...structuredContent, isError: true };
				innerNeedsFix = true;
			}
			if (!event.isError || innerNeedsFix) {
				return {
					isError: true,
					...(structuredContent !== undefined ? { structuredContent } : {}),
				};
			}
			return;
		}

		if (hindsight !== undefined && isHindsightWriteTool(event.toolName, pi.getAllTools())) {
			hindsight.invalidateRecallCache();
		}
	});

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-memory",
		async start(context) {
			const { extension, signal, resources } = context;
			const uninstallCheckpointDedup = installCompactionCheckpointDedup(SessionManager);
			resources.add("compaction-checkpoint-dedup", uninstallCheckpointDedup);
			hydrateCompactionCheckpoints(extension.sessionManager);

			const generation = await runtime.startSession(extension.cwd, signal);
			resources.add("observational-memory-runtime", () => {
				runtime.endSession(generation);
			});
			runtime.onSessionIdleReady?.(extension);

			provideService(context, MEMORY_COMPACTOR_SERVICE_KEY, {
				createCompactionDraft(firstKeptEntryId) {
					const branch = extension.sessionManager.getBranch() as Entry[];
					if (!latestGateEnabled(branch) || runtime.compactInFlight || runtime.compactHookInFlight)
						return undefined;
					if (countSourceEntriesAfterCompaction(branch) === 0) return undefined;
					const folded =
						typeof runtime.foldWithSnapshot === "function"
							? runtime.foldWithSnapshot(branch)
							: foldLedger(branch);
					if (folded.activeObservations.length === 0 && folded.activeReflections.length === 0)
						return undefined;
					const summary = renderSummary(folded.activeReflections, folded.activeObservations);
					return summary ? { summary, firstKeptEntryId } : undefined;
				},
			});

			const settingsRegistry = getRuntimeSettingsRegistry(pi);
			const configuredModelRef = runtime.config.model
				? `${runtime.config.model.provider}/${runtime.config.model.id}`
				: undefined;
			const settingsProvider = createMemorySettingsProvider({
				modelRegistry: extension.modelRegistry,
				configuredModel: configuredModelRef,
				onSaved: async () => {
					await runtime.reloadConfig(extension.cwd);
				},
			});
			resources.add("pi-ext-memory-settings", registerSettings(settingsProvider, settingsRegistry));

			const isSub = isSubagentProcess();
			const started = isSub
				? { status: "disabled" as const }
				: await startHindsightSession(extension, signal);
			if (started.status !== "ready") {
				if (started.status === "error" && !isSub) {
					extension.ui.notify(`Hindsight memory: ${started.error}`, "warning");
				}
				return;
			}

			const session = started.session;
			hindsight = session;

			// Registered before mcp-server so on shutdown, mcp-server unregisters first,
			// and then hindsight-session flushes writeback before runtime is torn down.
			resources.add("hindsight-session", () => {
				if (hindsight === session) {
					hindsight = undefined;
					lastFileOverride = undefined;
				}
				return session.dispose();
			});

			resources.add("hindsight-mcp-server", () => {
				pi.unregisterMcpServer(HINDSIGHT_MCP_SERVER_NAME);
			});

			const fileOverride = await checkMcpFileOverride(extension.cwd);
			lastFileOverride = fileOverride;
			if (fileOverride) {
				extension.ui.notify(
					`Hindsight memory: MCP server "hindsight" is ${fileOverride}. Session bank routing may be overridden by the file configuration.`,
					"warning",
				);
			}

			try {
				pi.registerMcpServer(HINDSIGHT_MCP_SERVER_NAME, {
					type: "http",
					url: session.resolved.bankMcpUrl,
					exposure: "deferred",
					toolExposure: { ...HINDSIGHT_MCP_TOOL_EXPOSURES },
					description: "Hindsight memory and knowledge vault tools",
					timeout: HINDSIGHT_MCP_TIMEOUT_SECONDS,
					...(session.resolved.config.apiToken
						? { headers: { Authorization: `Bearer ${session.resolved.config.apiToken}` } }
						: {}),
				});
			} catch {
				extension.ui.notify("Hindsight memory: failed to register MCP server", "error");
			}
		},
	});
}
