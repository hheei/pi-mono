import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mock.agentDir,
}));

import {
	type Config,
	DEFAULTS,
	loadConfig,
	MAX_TIMEOUT_SECONDS,
	parseDurationToSeconds,
	readEnvConfig,
	resolveCompactAfterTokens,
	resolveCompactionMaxRetainedTokens,
	resolveWorkerMemoryMaxTokens,
} from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", async () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			reflectAfterTokens: 20000,
			compactAfterTokens: 81000,
			compactAfterTokensMode: "calibrated",
			compactAfterTokensRatio: 0.68,
			idleCompactionTtlSeconds: 1800,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			agentMaxTokens: 32000,
			compactionCatchUpMaxChunks: 2,
			showWorkerNotifications: true,
			passive: false,
			debugLog: false,
		});
		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("merges global, project, and env V3 settings in order", async () => {
		writeJson(join(agentDir, "ext_settings.json"), {
			"pi-ext-memory": {
				observeAfterTokens: 10,
				reflectAfterTokens: 20,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				agentMaxTokens: 8192,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				showWorkerNotifications: true,
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
				showWorkerNotifications: false,
			},
		});

		expect(await loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			agentMaxTokens: 8192,
			model: { provider: "openai", id: "project", thinking: "low" },
			showWorkerNotifications: false,
			passive: true,
			debugLog: true,
		});
	});

	it("accepts max as a valid model thinking level", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": {
				model: { provider: "anthropic", id: "claude", thinking: "max" },
			},
		});

		expect(await loadConfig(cwd, {})).toMatchObject({
			model: { provider: "anthropic", id: "claude", thinking: "max" },
		});
	});

	it("ignores invalid V3 values", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": {
				observeAfterTokens: -1,
				reflectAfterTokens: 0,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				memoryMaxTokens: "4000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				showWorkerNotifications: "no",
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("reads an explicit memory budget and leaves it unset by default", async () => {
		expect((await loadConfig(cwd, {})).memoryMaxTokens).toBeUndefined();

		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": { memoryMaxTokens: 4_000 },
		});

		expect((await loadConfig(cwd, {})).memoryMaxTokens).toBe(4_000);
	});

	it("derives observation pool target from the final max when omitted", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(await loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", async () => {
		writeJson(join(agentDir, "ext_settings.json"), {
			"pi-ext-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(await loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"pi-ext-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("strictly ignores legacy settings.json without fallback compatibility", async () => {
		writeJson(join(agentDir, "settings.json"), {
			"pi-ext-memory": {
				observeAfterTokens: 99,
				model: { provider: "anthropic", id: "legacy" },
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"pi-ext-memory": {
				observeAfterTokens: 88,
				model: { provider: "openai", id: "legacy" },
			},
		});

		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it.each([
		["on", { passive: true }],
		["0", { passive: false }],
		["maybe", {}],
	] as const)("parses PI_OBSERVATIONAL_MEMORY_PASSIVE=%s", (value, expected) => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: value })).toEqual(expected);
	});

	it.each([
		["1", { passive: true }],
		["on", { passive: true }],
		["0", { passive: false }],
	] as const)("parses PI_OBSERVATIONAL_MEMORY_DISABLE=%s", (value, expected) => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_DISABLE: value })).toEqual(expected);
	});

	describe("compactAfterTokens ratio mode", () => {
		it("accepts compactAfterTokensMode and compactAfterTokensRatio", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"pi-ext-memory": {
					compactAfterTokensMode: "ratio",
					compactAfterTokensRatio: 0.5,
				},
			});

			expect(await loadConfig(cwd, {})).toMatchObject({
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
		});

		it.each([
			["mode auto", { compactAfterTokensMode: "auto" }, { compactAfterTokensMode: "calibrated" }],
			["ratio 0", { compactAfterTokensRatio: 0 }, { compactAfterTokensRatio: 0.68 }],
			["ratio 1", { compactAfterTokensRatio: 1 }, { compactAfterTokensRatio: 0.68 }],
			["ratio 1.5", { compactAfterTokensRatio: 1.5 }, { compactAfterTokensRatio: 0.68 }],
			["ratio -0.2", { compactAfterTokensRatio: -0.2 }, { compactAfterTokensRatio: 0.68 }],
			["non-numeric ratio", { compactAfterTokensRatio: "0.5" }, { compactAfterTokensRatio: 0.68 }],
		] as const)("rejects %s and keeps the calibrated default", async (_label, patch, expected) => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"pi-ext-memory": patch,
			});
			expect(await loadConfig(cwd, {})).toMatchObject(expected);
		});
	});

	describe("resolveCompactAfterTokens", () => {
		it.each([
			{
				label: "calibrated mode returns compactAfterTokens for any window",
				mode: "calibrated",
				ratio: 0.68,
				tokens: 81_000,
				window: 1_000_000,
				expected: 81_000,
			},
			{
				label: "calibrated mode ignores a missing window",
				mode: "calibrated",
				ratio: 0.68,
				tokens: 81_000,
				window: undefined,
				expected: 81_000,
			},
			{
				label: "calibrated mode ignores a zero window",
				mode: "calibrated",
				ratio: 0.68,
				tokens: 81_000,
				window: 0,
				expected: 81_000,
			},
			{
				label: "ratio mode scales a 1_000_000 window by 0.5",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: 1_000_000,
				expected: 500_000,
			},
			{
				label: "ratio mode scales a 200_000 window by 0.5",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: 200_000,
				expected: 100_000,
			},
			{
				label: "ratio mode floors a fractional result to at least 1",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: 3,
				expected: 1,
			},
			{
				label: "ratio mode floors a 1-token window to 1",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: 1,
				expected: 1,
			},
			{
				label: "ratio mode falls back when the window is missing",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: undefined,
				expected: 81_000,
			},
			{
				label: "ratio mode falls back when the window is 0",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: 0,
				expected: 81_000,
			},
			{
				label: "ratio mode falls back when the window is negative",
				mode: "ratio",
				ratio: 0.5,
				tokens: 81_000,
				window: -1,
				expected: 81_000,
			},
		] as const)("$label", ({ mode, ratio, tokens, window, expected }) => {
			const config: Config = {
				...DEFAULTS,
				compactAfterTokensMode: mode,
				compactAfterTokensRatio: ratio,
				compactAfterTokens: tokens,
			};
			expect(resolveCompactAfterTokens(config, window)).toBe(expected);
		});
	});

	describe("parseDurationToSeconds", () => {
		const fallback = DEFAULTS.idleCompactionTtlSeconds;

		it.each([
			["30m", 30 * 60],
			["5m", 5 * 60],
			["1h", 60 * 60],
			["1.5h", 90 * 60],
			["300s", 300],
			["2d", 2 * 24 * 60 * 60],
			["60", 60],
			[120, 120],
			["1800", 1800],
			[1800, 1800],
		] as const)("parses %j as %s seconds", (value, seconds) => {
			expect(parseDurationToSeconds(value)).toBe(seconds);
		});

		it.each([false, 0, "", "never", "NEVER"] as const)("disables on %j", (value) => {
			expect(parseDurationToSeconds(value)).toBeUndefined();
		});

		it.each([
			0.5,
			"invalid",
			-100,
			"foo5m",
			true,
			MAX_TIMEOUT_SECONDS + 1,
			"9999999999999",
			"3000d",
		] as const)("falls back for %j", (value) => {
			expect(parseDurationToSeconds(value)).toBe(fallback);
		});
	});

	describe("idle compaction config loading", () => {
		it("loads idle TTL and idleCompactionMinTokens", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"pi-ext-memory": {
					idleCompactionTtl: "1h",
					idleCompactionMinTokens: 50_000,
				},
			});
			const config = await loadConfig(cwd, {});
			expect(config.idleCompactionTtlSeconds).toBe(3600);
			expect(config.idleCompactionMinTokens).toBe(50_000);
		});

		it.each([
			"never",
			false,
		] as const)("disables idle compaction when idleCompactionTtl is %j", async (idleCompactionTtl) => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"pi-ext-memory": { idleCompactionTtl },
			});
			expect((await loadConfig(cwd, {})).idleCompactionTtlSeconds).toBeUndefined();
		});
	});

	describe("worker memory and compaction retention resolvers", () => {
		it("resolves worker memory max tokens from config, ratio or fallback", () => {
			expect(
				resolveWorkerMemoryMaxTokens({ ...DEFAULTS, workerMemoryMaxTokens: 5000 }, 64000),
			).toBe(5000);
			expect(resolveWorkerMemoryMaxTokens(DEFAULTS, 64000)).toBe(16000); // 0.25 * 64000
			expect(resolveWorkerMemoryMaxTokens(DEFAULTS, undefined)).toBe(16000);
		});

		it("resolves compaction max retained tokens from config, ratio or fallback", () => {
			expect(
				resolveCompactionMaxRetainedTokens(
					{ ...DEFAULTS, compactionMaxRetainedTokens: 12000 },
					100000,
				),
			).toBe(12000);
			expect(resolveCompactionMaxRetainedTokens(DEFAULTS, 100000)).toBe(35000); // 0.35 * 100000
			expect(resolveCompactionMaxRetainedTokens(DEFAULTS, undefined)).toBe(35000);
		});

		it("loads catch-up chunks and retention tokens from ext_settings.json", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"pi-ext-memory": {
					compactionCatchUpMaxChunks: 4,
					compactionMaxRetainedTokens: 40000,
					workerMemoryMaxTokens: 8000,
				},
			});
			const config = await loadConfig(cwd, {});
			expect(config.compactionCatchUpMaxChunks).toBe(4);
			expect(config.compactionMaxRetainedTokens).toBe(40000);
			expect(config.workerMemoryMaxTokens).toBe(8000);
		});

		it("allows 0 for compactionCatchUpMaxChunks to disable catch-up", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"pi-ext-memory": { compactionCatchUpMaxChunks: 0 },
			});
			expect((await loadConfig(cwd, {})).compactionCatchUpMaxChunks).toBe(0);
		});
	});
});
