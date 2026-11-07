import { type AgentContext, type AgentLoopConfig, agentLoop } from "@earendil-works/pi-agent-core";
import type {
	Api,
	Message,
	Model,
	ModelThinkingLevel,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../model-budget.js";
import { contextCostFromUsage } from "../session-ledger/index.js";
import { logAgentStreamError, type WorkerStage } from "./stream-errors.js";
import {
	resolveWorkerStreamSimple,
	type StreamableModelRegistry,
	type WorkerStreamSimple,
} from "./worker-stream.js";

/**
 * Credentials and loop knobs every memory worker takes from its caller.
 *
 * The observer, reflector and dropper build the same loop from these, so they
 * share one shape; each worker adds only its own domain inputs on top.
 */
export interface WorkerLoopArgs {
	readonly model: Model<Api>;
	readonly apiKey?: string | undefined;
	readonly headers?: ProviderHeaders | undefined;
	readonly env?: Record<string, string> | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly agentLoop?: typeof agentLoop | undefined;
	readonly maxTurns?: number | undefined;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	readonly maxOutputTokens?: number | undefined;
	readonly thinkingLevel?: ModelThinkingLevel | undefined;
	readonly modelRegistry: StreamableModelRegistry;
	/**
	 * Parent session identity, so the provider can key prompt caching and request routing on the
	 * session. Workers keep no history of their own; this only makes their shared static prefix
	 * (system prompt and tools) reachable again on the next stage.
	 */
	readonly sessionId?: string | undefined;
	readonly streamSimple?: WorkerStreamSimple | undefined;
	/** Receives the provider-reported USD cost of each assistant turn in this loop. */
	readonly onCost?: ((costUsd: number) => void) | undefined;
}

/** Terminal API/stream failure reported by the loop's final assistant message. */
export interface WorkerStreamFailure {
	readonly stopReason: string;
	readonly errorMessage?: string | undefined;
}

/**
 * Run one worker loop and drain its event stream.
 *
 * The drain exists for its side effects: tool execution collects the records the
 * caller reads afterwards, costs reach `onCost`, and a terminal API failure is
 * reported to the debug log. That failure is also returned, because an empty
 * result must not be conflated with a deliberate empty result — the observer
 * turns it into an error while the reflector and dropper keep their own
 * reporting. `prompts` and `context` are built by the caller, which owns the
 * system prompt, tool and user text of its stage.
 */
export async function runWorkerAgent(
	stage: WorkerStage,
	args: WorkerLoopArgs,
	prompts: Message[],
	context: AgentContext,
): Promise<WorkerStreamFailure | undefined> {
	const { model, apiKey, headers, env, signal } = args;
	const reasoning = model.reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		...(apiKey !== undefined ? { apiKey } : {}),
		...(headers !== undefined ? { headers } : {}),
		...(env !== undefined ? { env } : {}),
		...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
					finishTurn: (turn) => {
						if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted")
							return;
						return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
					},
				}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(args.modelRegistry, args.streamSimple),
	);
	let streamError: WorkerStreamFailure | undefined;
	for await (const event of stream) {
		// Tool execution collects records; this drain only watches cost and failures.
		logAgentStreamError(stage, event);
		const message = (
			event as {
				message?: { role?: string; stopReason?: string; errorMessage?: string; usage?: unknown };
			}
		).message;
		const cost = contextCostFromUsage(message?.usage);
		if (cost !== undefined) args.onCost?.(cost);
		if (
			message?.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted")
		) {
			streamError = {
				stopReason: message.stopReason,
				...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
			};
		}
	}
	await stream.result();
	return streamError;
}
