import type { SystemMessage } from "@earendil-works/pi-ai";
import { isRecord } from "@hheei/pi-ext-core";

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/**
 * Reflection tombstones. A reflection leaves active memory only through a merge
 * or upgrade the reflector declares, never through deterministic eviction, so
 * this entry names the reflections a newer reflection replaces.
 */
export const OM_REFLECTIONS_DROPPED = "om.reflections.dropped";
export const OM_FOLDED = "om.folded";
/**
 * Session gate entry (`/om on` / `/om off`). It is metadata, not memory: the fold
 * ignores it, and it is not a source entry, so it never moves a token clock.
 */
export const OM_GATE = "om.gate";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

/**
 * What an observation is, which is what decides how easily it can leave active
 * memory: process narration is disposable, durable decisions are not. Recorded
 * by the observer. An entry without a kind is not an observation.
 */
export const OBSERVATION_KINDS = ["user", "decision", "fact", "progress"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Removal order for kinds: lowest first. Progress lines narrate work that the
 * transcript and the code already record, so they go before everything else;
 * a user assertion or a decision cannot be re-derived and goes last.
 */
export const OBSERVATION_KIND_DROP_RANK: Record<ObservationKind, number> = {
	progress: 0,
	fact: 1,
	user: 2,
	decision: 3,
};

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Entry = {
	type: string;
	id: string;
	timestamp?: string | undefined;
	message?: unknown;
	content?: unknown;
	customType?: string | undefined;
	summary?: unknown;
	fromId?: string | undefined;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string | undefined;
	checkpointEntryId?: string | undefined;
	systemMessage?: SystemMessage | undefined;
};

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	kind: ObservationKind;
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ReflectionsRecordedEntryData = {
	reflections: Reflection[];
	coversUpToId: string;
};

export type ObservationsDroppedEntryData = {
	observationIds: string[];
	coversUpToId: string;
};

export type ReflectionsDroppedEntryData = {
	reflectionIds: string[];
	coversUpToId: string;
};

export type GateEntryData = {
	enabled: boolean;
};

/**
 * What the compaction hook spent on one rendered summary. Observational: it is
 * written for `/om status` and the session record, never read back into the
 * projection.
 */
export type MemoryDetailsBudget = {
	maxTokens: number;
	renderedTokens: number;
	tailTokens: number;
	softLimit: number;
	trimmedObservations: number;
	trimmedReflections: number;
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
	budget?: MemoryDetailsBudget | undefined;
	foldThroughEntryId?: string | undefined;
};

export type V3MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_REFLECTIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED
	| typeof OM_REFLECTIONS_DROPPED;

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isObservationKind(value: unknown): value is ObservationKind {
	return typeof value === "string" && (OBSERVATION_KINDS as readonly string[]).includes(value);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isObservation(value: unknown): value is Observation {
	if (!isRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		isObservationKind(value.kind) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.reflections) &&
		value.reflections.length > 0 &&
		value.reflections.every(isReflection) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isRecord(value)) return false;
	return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

export function isReflectionsDroppedData(value: unknown): value is ReflectionsDroppedEntryData {
	if (!isRecord(value)) return false;
	return isNonEmptyStringArray(value.reflectionIds) && isNonEmptyString(value.coversUpToId);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection) &&
		(value.foldThroughEntryId === undefined || typeof value.foldThroughEntryId === "string")
	);
}

/**
 * Validate a recorded budget. Session files are read back from disk, so the
 * numbers are checked before they reach `/om status`.
 */
export function isMemoryDetailsBudget(value: unknown): value is MemoryDetailsBudget {
	if (!isRecord(value)) return false;
	return (
		isTokenCount(value.maxTokens) &&
		isTokenCount(value.renderedTokens) &&
		isTokenCount(value.tailTokens) &&
		isTokenCount(value.softLimit) &&
		isTokenCount(value.trimmedObservations) &&
		isTokenCount(value.trimmedReflections)
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return (
		entry.type === "custom" &&
		entry.customType === OM_OBSERVATIONS_RECORDED &&
		isObservationsRecordedData(entry.data)
	);
}

export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_RECORDED;
	data: ReflectionsRecordedEntryData;
} {
	return (
		entry.type === "custom" &&
		entry.customType === OM_REFLECTIONS_RECORDED &&
		isReflectionsRecordedData(entry.data)
	);
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return (
		entry.type === "custom" &&
		entry.customType === OM_OBSERVATIONS_DROPPED &&
		isObservationsDroppedData(entry.data)
	);
}

export function isReflectionsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_DROPPED;
	data: ReflectionsDroppedEntryData;
} {
	return (
		entry.type === "custom" &&
		entry.customType === OM_REFLECTIONS_DROPPED &&
		isReflectionsDroppedData(entry.data)
	);
}

export function isGateData(value: unknown): value is GateEntryData {
	return isRecord(value) && typeof value.enabled === "boolean";
}

export function isGateEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_GATE;
	data: GateEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_GATE && isGateData(entry.data);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
	if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observations, coversUpToId };
}

export function buildReflectionsRecordedData(
	reflections: Reflection[],
	coversUpToId: string,
): ReflectionsRecordedEntryData | undefined {
	if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { reflections, coversUpToId };
}

export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationIds, coversUpToId };
}

export function buildReflectionsDroppedData(
	reflectionIds: string[],
	coversUpToId: string,
): ReflectionsDroppedEntryData | undefined {
	if (reflectionIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { reflectionIds, coversUpToId };
}
