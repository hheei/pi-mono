import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { textToolResult } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { hashId } from "../../ids.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, ObservationKind, Relevance } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";
import { runWorkerAgent, type WorkerLoopArgs } from "../run-agent.js";
import { OBSERVER_SYSTEM } from "./prompts.js";

interface RunObserverArgs extends WorkerLoopArgs {
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	/**
	 * Local minute timestamp for an observation, derived by the caller from the
	 * cited source entries. The model does not author times any more: the chunk is
	 * read long after the conversation happened, so a self-reported time is a guess
	 * (the incident session carried a hallucinated date and 54 out-of-order lines).
	 */
	resolveTimestamp: (sourceEntryIds: readonly string[]) => string;
}

const RelevanceSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

const KindSchema = Type.Union(
	[Type.Literal("user"), Type.Literal("decision"), Type.Literal("fact"), Type.Literal("progress")],
	{
		description:
			"What the observation is: 'progress' for work that was done (including anything 'completed:'), " +
			"'fact' for code, documentation or environment facts, 'decision' for a choice, invariant or plan and " +
			"its rationale, 'user' for something the user asserted or corrected. Kind decides removal order " +
			"(progress leaves first), so choose the kind, then rate relevance by how hard it would be to " +
			"re-derive the fact.",
	},
);

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
			relevance: RelevanceSchema,
			kind: KindSchema,
			sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description:
					"Exact source entry ids from the chunk that directly support this observation. " +
					"Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
			}),
		}),
		{
			description: "Batch of new observations. May be empty only if the tool is not called at all.",
		},
	),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

/**
 * Thrown when the agent loop ends with an API/stream failure (`stopReason`
 * `"error"`/`"aborted"`) without recording anything. agent-core returns such
 * runs normally, so without this the caller cannot tell a hard failure from a
 * deliberate empty result (#32).
 */
export class ObserverStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(
			`observer stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`,
		);
		this.name = "ObserverStreamError";
		this.stopReason = stopReason;
	}
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (const [i, id] of allowedSourceEntryIds.entries()) allowedOrder.set(id, i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export async function runObserver(args: RunObserverArgs): Promise<Observation[] | undefined> {
	const { priorReflections, priorObservations, chunk, allowedSourceEntryIds, resolveTimestamp } =
		args;
	const conversation = chunk.trim();
	if (!conversation) return undefined;

	const accumulated = new Map<string, Observation>();

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description:
			"Record a batch of new observations distilled from the conversation chunk. " +
			"Call this multiple times as you work through the chunk. Stop calling when coverage is complete, " +
			"then emit a short plain-text confirmation to end the run.",
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const obs of params.observations) {
				const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(obs.content);
				const id = hashId(content);
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				const timestamp = resolveTimestamp(sourceEntryIds);
				accumulated.set(id, {
					id,
					content,
					timestamp,
					relevance: obs.relevance as Relevance,
					kind: obs.kind as ObservationKind,
					sourceEntryIds,
					tokenCount: observationLineTokenCount({
						id,
						timestamp,
						relevance: obs.relevance,
						content,
					}),
				});
				added++;
			}
			const rejectedPart =
				rejected > 0
					? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
					: "";
			const ack =
				`Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
				(duplicates > 0
					? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).`
					: ".") +
				rejectedPart +
				` Total so far this run: ${accumulated.size}. ` +
				`Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
			return textToolResult(ack, { added, duplicates, rejected, total: accumulated.size });
		},
	};

	const now = nowTimestamp();
	const userText = `CURRENT REFLECTIONS:
${joinOrEmpty(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(priorObservations)}

Current local time: ${now}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Observation times are derived from the source entries you cite, so cite the entries the observation actually comes from. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		messages: [{ role: "system", content: OBSERVER_SYSTEM, timestamp: Date.now() }],
		tools: [recordObservations as unknown as AgentTool],
	};

	const streamError = await runWorkerAgent("observer", args, prompts, context);

	if (accumulated.size === 0) {
		if (streamError !== undefined)
			throw new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
		return undefined;
	}
	return Array.from(accumulated.values());
}
