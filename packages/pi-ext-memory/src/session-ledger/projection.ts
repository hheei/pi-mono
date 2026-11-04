import {
	type Entry,
	isMemoryDetails,
	isMemoryDetailsBudget,
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsDroppedEntry,
	isReflectionsRecordedEntry,
	type MemoryDetails,
	type MemoryDetailsBudget,
	type Observation,
	OM_FOLDED,
	type Reflection,
} from "./types.js";

export type Projection = {
	observations: Observation[];
	reflections: Reflection[];
};

export type ProjectionDiff = {
	observationsOnlyInFull: Observation[];
	reflectionsOnlyInFull: Reflection[];
	droppedOnlyInFull: Observation[];
	/** Reflections the full fold dropped while the visible projection still shows them. */
	droppedReflectionsOnlyInFull: Reflection[];
};

export type CompactionProjectionConfig = {
	observationsPoolMaxTokens: number;
};

export type CompactionProjection = Projection & {
	fullFold: boolean;
	details: MemoryDetails;
};

type ProjectionBoundary = { kind: "entry"; entryId: string } | { kind: "tip" } | { kind: "none" };

type ProjectionFoldOptions = {
	observationsBoundary: ProjectionBoundary;
	reflectionsBoundary: ProjectionBoundary;
	dropsBoundary: ProjectionBoundary;
};

function entryIndexById(entries: Entry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	for (const [i, entry] of entries.entries()) indexes.set(entry.id, i);
	return indexes;
}

function entryBoundary(entryId: string): ProjectionBoundary {
	return { kind: "entry", entryId };
}

function tipBoundary(): ProjectionBoundary {
	return { kind: "tip" };
}

function noneBoundary(): ProjectionBoundary {
	return { kind: "none" };
}

function boundaryIndex(
	entries: Entry[],
	indexes: Map<string, number>,
	boundary: ProjectionBoundary,
): number {
	if (boundary.kind === "tip") return entries.length - 1;
	if (boundary.kind === "none") return -1;
	return indexes.get(boundary.entryId) ?? -1;
}

function coverageIndex(
	entry: Entry & { data: { coversUpToId: string } },
	indexes: Map<string, number>,
): number {
	return indexes.get(entry.data.coversUpToId) ?? -1;
}

function isAtOrBefore(index: number, boundaryIndex: number): boolean {
	return index >= 0 && boundaryIndex >= 0 && index <= boundaryIndex;
}

function isCoveredAtOrBefore(
	entry: Entry & { data: { coversUpToId: string } },
	indexes: Map<string, number>,
	boundaryIndex: number,
): boolean {
	return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex);
}

function foldProjection(entries: Entry[], options: ProjectionFoldOptions): Projection {
	const indexes = entryIndexById(entries);
	const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
	const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
	const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
	const observations: Observation[] = [];
	const reflections: Reflection[] = [];
	const observationsById = new Set<string>();
	const reflectionsById = new Set<string>();
	const droppedObservationIds = new Set<string>();
	const droppedReflectionIds = new Set<string>();

	for (const entry of entries) {
		if (
			isObservationsRecordedEntry(entry) &&
			isCoveredAtOrBefore(entry, indexes, observationsBoundary)
		) {
			for (const observation of entry.data.observations) {
				if (observationsById.has(observation.id)) continue;
				observationsById.add(observation.id);
				observations.push(observation);
			}
			continue;
		}

		if (
			isReflectionsRecordedEntry(entry) &&
			isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)
		) {
			for (const reflection of entry.data.reflections) {
				if (reflectionsById.has(reflection.id)) continue;
				reflectionsById.add(reflection.id);
				reflections.push(reflection);
			}
			continue;
		}

		if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
			for (const observationId of entry.data.observationIds)
				droppedObservationIds.add(observationId);
			continue;
		}

		if (isReflectionsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
			for (const reflectionId of entry.data.reflectionIds) droppedReflectionIds.add(reflectionId);
		}
	}

	return {
		observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections: reflections.filter((reflection) => !droppedReflectionIds.has(reflection.id)),
	};
}

function projectionFromMemoryDetails(details: MemoryDetails): Projection {
	return {
		observations: [...details.observations],
		reflections: [...details.reflections],
	};
}

function latestV3CompactionDetails(entries: Entry[]): MemoryDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "compaction") continue;
		if (isMemoryDetails(entry.details)) return entry.details;
	}
	return undefined;
}

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
	const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
	return foldProjection(entries, {
		observationsBoundary: boundary,
		reflectionsBoundary: boundary,
		dropsBoundary: boundary,
	});
}

export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (!upToEntryId) {
		const details = latestV3CompactionDetails(entries);
		return details ? projectionFromMemoryDetails(details) : { observations: [], reflections: [] };
	}

	return buildCompactionProjection(entries, upToEntryId, {
		observationsPoolMaxTokens: Number.POSITIVE_INFINITY,
	});
}

/**
 * Budget accounting of the most recent memory compaction, for `/om status`.
 * Older compactions without budget details are skipped rather than reported as
 * a zero-token render.
 */
export function latestMemoryBudget(entries: Entry[]): MemoryDetailsBudget | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details)) continue;
		if (isMemoryDetailsBudget(entry.details.budget)) return entry.details.budget;
	}
	return undefined;
}

export function latestFullFoldBoundaryId(entries: Entry[]): string | undefined {
	const indexes = entryIndexById(entries);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details)) continue;
		if (!entry.details.fullFold) continue;
		const foldThroughId = entry.details.foldThroughEntryId;
		if (foldThroughId && indexes.has(foldThroughId)) return foldThroughId;
		if (!entry.firstKeptEntryId) continue;
		if (!indexes.has(entry.firstKeptEntryId)) continue;
		return entry.firstKeptEntryId;
	}
	return undefined;
}

export function buildCompactionProjection(
	entries: Entry[],
	foldThroughEntryId: string,
	config: CompactionProjectionConfig,
): CompactionProjection {
	const fullFoldBoundaryId = latestFullFoldBoundaryId(entries);
	const maintenanceBoundary = fullFoldBoundaryId
		? entryBoundary(fullFoldBoundaryId)
		: noneBoundary();
	const normalProjection = foldProjection(entries, {
		observationsBoundary: entryBoundary(foldThroughEntryId),
		reflectionsBoundary: maintenanceBoundary,
		dropsBoundary: maintenanceBoundary,
	});
	const observationTokens = normalProjection.observations.reduce(
		(total, observation) => total + observation.tokenCount,
		0,
	);
	const fullFold = observationTokens >= config.observationsPoolMaxTokens;
	const projection = fullFold ? fullProjection(entries, foldThroughEntryId) : normalProjection;

	const details: MemoryDetails = {
		type: OM_FOLDED,
		version: 1,
		fullFold,
		observations: projection.observations,
		reflections: projection.reflections,
		foldThroughEntryId,
	};

	return {
		fullFold,
		observations: projection.observations,
		reflections: projection.reflections,
		details,
	};
}

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
	const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
	const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
	const fullReflectionIds = new Set(full.reflections.map((reflection) => reflection.id));
	const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));

	return {
		observationsOnlyInFull: full.observations.filter(
			(observation) => !visibleObservationIds.has(observation.id),
		),
		reflectionsOnlyInFull: full.reflections.filter(
			(reflection) => !visibleReflectionIds.has(reflection.id),
		),
		droppedOnlyInFull: visible.observations.filter(
			(observation) => !fullObservationIds.has(observation.id),
		),
		droppedReflectionsOnlyInFull: visible.reflections.filter(
			(reflection) => !fullReflectionIds.has(reflection.id),
		),
	};
}
