import { describe, expect, it } from "vitest";

import {
	compactionRangeStartIndex,
	contextCostFromUsage,
	countSourceEntriesAfterCompaction,
	type Entry,
	earlierCoverageMarkerId,
	entryIndexById,
	findPersistedSettledTime,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	latestGateEnabled,
	observedTokensSinceLastCompaction,
	rawTokensAfterIndex,
	rawTokensSinceDropCoverage,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	unobservedSourceSpanBefore,
} from "../src/session-ledger/index.js";
import {
	branchSummary,
	compactionEntry,
	customMessage,
	gateEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	V3_OBSERVATIONS_DROPPED,
	V3_OBSERVATIONS_RECORDED,
	V3_REFLECTIONS_RECORDED,
} from "./fixtures/session.js";

describe("session-ledger V3 progress helpers", () => {
	it("detects only raw/source entries as source entries", () => {
		expect(isSourceEntry(textCustomMessage("raw-1", "abcd"))).toBe(true);
		expect(isSourceEntry(branchSummary("sum-1", "abcd"))).toBe(true);
		expect(
			isSourceEntry(
				observationsRecordedEntry("om-1", {
					observations: [observation("aaaaaaaaaaaa")],
					coversUpToId: "raw-1",
				}),
			),
		).toBe(false);
		expect(isSourceEntry(compactionEntry("cmp-1"))).toBe(false);
	});

	it("builds a branch id to index map", () => {
		const entries = [textCustomMessage("raw-1", "abcd"), textCustomMessage("raw-2", "efgh")];
		expect(entryIndexById(entries).get("raw-1")).toBe(0);
		expect(entryIndexById(entries).get("raw-2")).toBe(1);
	});

	it("counts raw tokens after a branch index and ignores memory/compaction entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			branchSummary("sum-1", "cccccccccccc"),
		];

		expect(rawTokensAfterIndex(entries, 0)).toBe(5); // raw-2: 2 + sum-1: 3
		expect(rawTokensAfterIndex(entries, 1)).toBe(5);
		expect(rawTokensAfterIndex(entries, 2)).toBe(3);
	});

	it("uses independent coverage clocks for observations, reflections, and drops", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", {
				reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
				coversUpToId: "raw-2",
			}),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsDroppedEntry("om-drop-1", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "om-eeeeeeeeeeee",
			}),
			textCustomMessage("raw-4", "dddddddddddddddd"),
		];

		expect(rawTokensSinceObservationCoverage(entries)).toBe(9); // raw-2 + raw-3 + raw-4
		expect(rawTokensSinceReflectionCoverage(entries)).toBe(7); // raw-3 + raw-4
		expect(rawTokensSinceDropCoverage(entries)).toBe(7); // covers ledger entry om-eeeeeeeeeeee, raw after it
	});

	it("lets coversUpToId point to a memory ledger entry", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", {
				reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
				coversUpToId: "raw-1",
			}),
			observationsDroppedEntry("om-drop-1", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "om-eeeeeeeeeeee",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(latestCoverageIndex(entries, V3_OBSERVATIONS_DROPPED)).toBe(1);
		expect(rawTokensSinceDropCoverage(entries)).toBe(2);
	});

	it("chooses the max covered branch position, not merely latest ledger entry order", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-2",
			}),
			observationsRecordedEntry("om-bbbbbbbbbbbb", {
				observations: [observation("bbbbbbbbbbbb")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-3", "cccccccccccc"),
		];

		expect(latestCoverageIndex(entries, V3_OBSERVATIONS_RECORDED)).toBe(1);
		expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe("raw-2");
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
	});

	it("returns latest inner coverage marker and earlier marker by branch index", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-3",
			}),
			reflectionsRecordedEntry("om-ref", {
				reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
				coversUpToId: "raw-2",
			}),
		];

		expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe("raw-3");
		expect(latestCoverageMarkerId(entries, V3_REFLECTIONS_RECORDED)).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-3", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-1", undefined)).toBe("raw-1");
		expect(earlierCoverageMarkerId(entries, "missing", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "missing-a", "missing-b")).toBeUndefined();
	});

	it("ignores invalid coverage markers and old V2 markers without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			observationsRecordedEntry("om-obs-invalid", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "missing",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(() => rawTokensSinceObservationCoverage(entries)).not.toThrow();
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
		expect(latestCoverageIndex(entries, V3_REFLECTIONS_RECORDED)).toBe(-1);
	});

	it("counts raw tokens since the latest Pi compaction without throwing on old memory details", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			oldV2ObservationEntry("v2-obs"),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(rawTokensSinceLastCompaction(entries)).toBe(3); // raw-1 + raw-2 from live tail starting at firstKeptEntryId
	});

	it("counts source entries strictly after latest compaction", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
		];
		// Immediately after compaction, no new source entries exist
		expect(countSourceEntriesAfterCompaction(entries)).toBe(0);

		// When new user message arrives after compaction
		entries.push(textCustomMessage("raw-3", "cccc"));
		expect(countSourceEntriesAfterCompaction(entries)).toBe(1);

		// With multiple messages after compaction
		entries.push(textCustomMessage("raw-4", "dddd"));
		expect(countSourceEntriesAfterCompaction(entries)).toBe(2);
	});

	it("counts all source entries when no compaction has occurred", () => {
		const entries = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")];
		expect(countSourceEntriesAfterCompaction(entries)).toBe(2);
	});

	it("finds persisted settled time in epoch seconds from latest completed assistant or compaction entry", () => {
		const nowSec = 1700000000;
		const message = (id: string, timestamp: number, stopReason?: string): Entry => ({
			id,
			type: "message",
			message: { role: "assistant", content: id, ...(stopReason ? { stopReason } : {}) },
			timestamp: new Date(timestamp * 1000).toISOString(),
		});
		const entries: Entry[] = [
			{ id: "user-1", type: "message", message: { role: "user", content: "hello" } },
			message("asst-1", nowSec - 5),
		];

		expect(findPersistedSettledTime(entries, nowSec)).toBe(nowSec - 5);

		entries.push(customMessage("custom-1", "extension event"));
		entries.push(branchSummary("branch-1", "summary"));
		expect(findPersistedSettledTime(entries, nowSec)).toBe(nowSec - 5);

		// When a compaction entry is later
		entries.push({
			id: "cmp-1",
			type: "compaction",
			timestamp: new Date((nowSec - 2) * 1000).toISOString(),
		});
		expect(findPersistedSettledTime(entries, nowSec)).toBe(nowSec - 2);

		// Discards future timestamps
		entries.push(message("asst-near-future", nowSec + 1));
		expect(findPersistedSettledTime(entries, nowSec)).toBe(nowSec - 2);

		entries.push(message("asst-future", nowSec + 120));
		expect(findPersistedSettledTime(entries, nowSec)).toBe(nowSec - 2);

		// Does not fall back through an unfinished latest assistant message
		entries.push(message("asst-aborted", nowSec - 1, "aborted"));
		expect(findPersistedSettledTime(entries, nowSec)).toBeUndefined();

		entries.push(message("asst-error", nowSec - 1, "error"));
		expect(findPersistedSettledTime(entries, nowSec)).toBeUndefined();

		entries.push(message("asst-tool-use", nowSec, "toolUse"));
		expect(findPersistedSettledTime(entries, nowSec)).toBeUndefined();

		entries.push({ id: "user-2", type: "message", message: { role: "user", content: "pending" } });
		expect(findPersistedSettledTime(entries, nowSec)).toBeUndefined();
	});
});

describe("session gate state", () => {
	it("is on by default and follows the newest gate entry", () => {
		expect(latestGateEnabled([])).toBe(true);
		expect(latestGateEnabled([textCustomMessage("raw-1", "abcd")])).toBe(true);
		expect(latestGateEnabled([gateEntry("gate-1", false)])).toBe(false);
		expect(latestGateEnabled([gateEntry("gate-1", false), gateEntry("gate-2", true)])).toBe(true);
		expect(latestGateEnabled([gateEntry("gate-1", true), gateEntry("gate-2", false)])).toBe(false);
	});

	it("ignores malformed gate data instead of trusting it", () => {
		const bogus = {
			type: "custom",
			id: "gate-bad",
			customType: "om.gate",
			data: { enabled: "yes" },
		};
		expect(latestGateEnabled([bogus])).toBe(true);
		expect(latestGateEnabled([bogus, gateEntry("gate-1", false)])).toBe(false);
	});

	it("reads the branch only: an off gate before an on gate is superseded", () => {
		const entries = [
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			gateEntry("gate-1", false),
			textCustomMessage("raw-1", "abcd"),
		];
		expect(latestGateEnabled(entries)).toBe(false);
	});
});

describe("provider-reported cost", () => {
	it("reads usage.cost.total and refuses empty or non-positive totals", () => {
		expect(contextCostFromUsage({ cost: { total: 0.0125 } })).toBeCloseTo(0.0125, 10);
		expect(contextCostFromUsage({ cost: { total: 0 } })).toBeUndefined();
		expect(contextCostFromUsage({ cost: { total: -1 } })).toBeUndefined();
		expect(contextCostFromUsage({ cost: { total: Number.NaN } })).toBeUndefined();
		expect(contextCostFromUsage({ cost: {} })).toBeUndefined();
		expect(contextCostFromUsage({ totalTokens: 10 })).toBeUndefined();
		expect(contextCostFromUsage(undefined)).toBeUndefined();
		expect(contextCostFromUsage("expensive")).toBeUndefined();
	});

	describe("compaction range and unobserved spans", () => {
		it("compactionRangeStartIndex returns 0 when no compaction exists", () => {
			expect(compactionRangeStartIndex([])).toBe(0);
			expect(compactionRangeStartIndex([textCustomMessage("raw-1", "a")])).toBe(0);
		});

		it("compactionRangeStartIndex returns index of firstKeptEntryId", () => {
			const entries = [
				textCustomMessage("raw-1", "a"),
				textCustomMessage("raw-2", "b"),
				compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
				textCustomMessage("raw-3", "c"),
			];
			expect(compactionRangeStartIndex(entries)).toBe(1);
		});

		it("observedTokensSinceLastCompaction measures tokens up to coverage marker", () => {
			const entries = [
				textCustomMessage("raw-1", "aaaa"),
				textCustomMessage("raw-2", "bbbb"),
				observationsRecordedEntry("om-obs-1", {
					observations: [observation("aaaaaaaaaaaa")],
					coversUpToId: "raw-2",
				}),
			];
			expect(observedTokensSinceLastCompaction(entries)).toBe(2);
		});

		it("unobservedSourceSpanBefore reports unobserved entries before cut", () => {
			const entries = [
				textCustomMessage("raw-1", "aaaa"),
				observationsRecordedEntry("om-obs-1", {
					observations: [observation("aaaaaaaaaaaa")],
					coversUpToId: "raw-1",
				}),
				textCustomMessage("raw-2", "bbbb"),
				textCustomMessage("raw-3", "cccc"),
			];
			const span = unobservedSourceSpanBefore(entries, 3);
			expect(span).toMatchObject({ firstIndex: 2, lastIndex: 2, entryCount: 1 });
		});
	});
});
