import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	defaultExtensionSettingsPaths,
	isRecord,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/**
 * How `compactAfterTokens` is interpreted.
 *
 * - `"calibrated"` (default): use the static `compactAfterTokens` value directly.
 *   Backwards-compatible with all existing V3 configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * compactAfterTokensRatio)`. This auto-scales the
 *   proactive compaction trigger to the active model's context window, so a 1M
 *   context model is not preempted at the same 81K threshold as a 128K model.
 *
 *   Some models advertise a large context window but lose attention at long
 *   range; users can lower `compactAfterTokensRatio` to compact earlier on such
 *   models without giving up the window on models that stay sharp.
 *
 *   When the active model's `contextWindow` is unavailable (undefined, 0, or
 *   negative), ratio mode falls back to the calibrated `compactAfterTokens`
 *   value so compaction still triggers safely.
 */
export type CompactAfterTokensMode = "calibrated" | "ratio";

export interface Config {
	observeAfterTokens: number;
	reflectAfterTokens: number;
	/**
	 * Maximum estimated source tokens serialized into a single observer chunk.
	 * Unset (default) derives the cap from the resolved memory model's context
	 * window; see {@link resolveObserverChunkMaxTokens}.
	 */
	observerChunkMaxTokens?: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	/**
	 * Idle duration before notifying that the next message will trigger compaction.
	 * Formats: "30m", "1h", "300s", or raw seconds.
	 * Set to "never", false, or 0 to disable.
	 */
	idleCompactionTtlSeconds?: number | undefined;
	/**
	 * Minimum uncompacted tokens accumulated before idle compaction may trigger.
	 * When unset, defaults to Pi's compaction keepRecentTokens cap (or 20,000).
	 */
	idleCompactionMinTokens?: number | undefined;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	/**
	 * Hard upper bound for how many tokens of memory may stay visible, shared by
	 * the rendered compaction summary, the pool-maintenance target and what the
	 * memory agents are given to read.
	 *
	 * Unset (default) derives the cap from the effective compaction trigger and
	 * the model's context window; see {@link defaultMemoryCap}. Set it to trade
	 * long-lived memory against context cost explicitly. Values below
	 * `MEMORY_MIN_TOKENS` are honored as written.
	 */
	memoryMaxTokens?: number;
	agentMaxTurns: number;
	/**
	 * Maximum output tokens requested for background memory-agent loops
	 * (observer/reflector/dropper). Always clamped to the model's own
	 * `maxTokens` when available. Lower it for local servers with a modest
	 * context window, where concurrent sub-agent requests share KV with the
	 * main session and the default 32K response budget can overflow the slot.
	 */
	agentMaxTokens: number;
	/**
	 * Maximum observer chunks the compaction hook may run synchronously to cover
	 * source entries the background observer has not reached before Pi's cut.
	 * 0 disables synchronous catch-up.
	 */
	compactionCatchUpMaxChunks: number;
	/**
	 * Token budget for retained raw entries kept in context when the compaction
	 * cut is moved back to protect unobserved source.
	 */
	compactionMaxRetainedTokens?: number;
	/**
	 * Estimated token budget for prior memory carried by observer, reflector,
	 * and dropper worker requests. Unset derives it from the memory model's context window.
	 */
	workerMemoryMaxTokens?: number;
	model?: ConfiguredModel;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	idleCompactionTtlSeconds: 1800,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	agentMaxTurns: 16,
	agentMaxTokens: 32_000,
	compactionCatchUpMaxChunks: 2,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

export const COMPACT_AFTER_TOKENS_MODE_VALUES: readonly CompactAfterTokensMode[] = [
	"calibrated",
	"ratio",
] as const;

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and active model context window.
 *
 * In `"calibrated"` mode this is always `config.compactAfterTokens`.
 *
 * In `"ratio"` mode this is `floor(contextWindow * compactAfterTokensRatio)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number, and
 * falls back to `config.compactAfterTokens` otherwise.
 */
export function resolveCompactAfterTokens(
	config: Config,
	contextWindow: number | undefined,
): number {
	if (
		config.compactAfterTokensMode === "ratio" &&
		typeof contextWindow === "number" &&
		contextWindow > 0
	) {
		return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
	}
	return config.compactAfterTokens;
}

export const COMPACTION_RETAINED_FALLBACK_MAX_TOKENS = 35_000;
export const COMPACTION_RETAINED_CONTEXT_RATIO = 0.35;

export function resolveCompactionMaxRetainedTokens(
	config: Config,
	contextWindow: number | undefined,
): number {
	if (config.compactionMaxRetainedTokens !== undefined && config.compactionMaxRetainedTokens > 0) {
		return config.compactionMaxRetainedTokens;
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * COMPACTION_RETAINED_CONTEXT_RATIO));
	}
	return COMPACTION_RETAINED_FALLBACK_MAX_TOKENS;
}

export const WORKER_MEMORY_CONTEXT_RATIO = 0.25;
export const WORKER_MEMORY_FALLBACK_MAX_TOKENS = 16_000;

export function resolveWorkerMemoryMaxTokens(
	config: Config,
	contextWindow: number | undefined,
): number {
	if (config.workerMemoryMaxTokens !== undefined && config.workerMemoryMaxTokens > 0) {
		return config.workerMemoryMaxTokens;
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * WORKER_MEMORY_CONTEXT_RATIO));
	}
	return WORKER_MEMORY_FALLBACK_MAX_TOKENS;
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimated at ~4 chars/token, which can undercount
 * real tokens by up to ~4x on non-ASCII content, so 0.2 keeps even the worst
 * case at ~80% of the window with room left for the system prompt, prior
 * memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the
 * cap is `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved
 * memory model, falling back to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when
 * the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g.
 * after repeated observer failures, or when the extension is enabled mid-way
 * into a long session) makes every observer call fail, so coverage never
 * advances and the session can never recover. With the cap, oversized backlogs
 * are drained oldest-first across successive runs.
 */
export function resolveObserverChunkMaxTokens(
	config: Config,
	contextWindow: number | undefined,
): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const SETTINGS_KEY = "pi-ext-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";
const OM_DISABLE_ENV = "PI_OBSERVATIONAL_MEMORY_DISABLE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

const DURATION_REGEX = /^([0-9]+(?:\.[0-9]+)?)\s*([smhd])$/i;

const UNIT_MULTIPLIERS_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
};

/** Maximum delay allowed by Node.js setTimeout (2^31 - 1 ms) expressed in integer seconds. */
export const MAX_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

/**
 * Parse an idle compaction TTL duration string, number, or boolean into integer seconds.
 *
 * Explicit disable values: `false`, `0`, `""`, or `"never"` (case-insensitive) -> `undefined`.
 * Raw numbers or numeric strings are interpreted as seconds (e.g. 1800 -> 1800).
 * Duration strings with units ("30s", "30m", "1h", "2d") -> parsed into seconds.
 * Unrecognized, invalid, or overflowing formats fall back to `fallbackSeconds` (default 1800s).
 */
export function parseDurationToSeconds(
	value: unknown,
	fallbackSeconds: number | undefined = DEFAULTS.idleCompactionTtlSeconds,
): number | undefined {
	if (value === false || value === 0 || value === "") return undefined;
	if (typeof value === "string" && value.trim().toLowerCase() === "never") return undefined;

	if (typeof value === "number") {
		if (Number.isFinite(value) && value > 0 && value <= MAX_TIMEOUT_SECONDS) {
			const seconds = Math.floor(value);
			return seconds > 0 ? seconds : fallbackSeconds;
		}
		return fallbackSeconds;
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^[0-9]+$/.test(trimmed)) {
			const parsed = Number(trimmed);
			if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMEOUT_SECONDS) {
				return parsed;
			}
			return fallbackSeconds;
		}
		const match = DURATION_REGEX.exec(trimmed);
		if (match?.[1] && match[2]) {
			const num = Number(match[1]);
			const unit = match[2].toLowerCase();
			const multiplier = UNIT_MULTIPLIERS_SECONDS[unit];
			if (Number.isFinite(num) && num > 0 && multiplier !== undefined) {
				const sec = Math.floor(num * multiplier);
				if (sec > 0 && sec <= MAX_TIMEOUT_SECONDS) return sec;
			}
		}
		return fallbackSeconds;
	}

	return fallbackSeconds;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isCompactAfterTokensMode(value: unknown): value is CompactAfterTokensMode {
	return (
		typeof value === "string" &&
		(COMPACT_AFTER_TOKENS_MODE_VALUES as readonly string[]).includes(value)
	);
}

/**
 * A valid ratio is a finite number strictly between 0 and 1.
 * 0 would never trigger; >= 1 would compact at/after the full window with no
 * room left for the response.
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
		? value
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"observerChunkMaxTokens",
		"compactAfterTokens",
		"idleCompactionMinTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"memoryMaxTokens",
		"agentMaxTurns",
		"agentMaxTokens",
		"compactionMaxRetainedTokens",
		"workerMemoryMaxTokens",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (
		Number.isInteger(value.compactionCatchUpMaxChunks) &&
		(value.compactionCatchUpMaxChunks as number) >= 0
	) {
		normalized.compactionCatchUpMaxChunks = value.compactionCatchUpMaxChunks as number;
	}
	if (isCompactAfterTokensMode(value.compactAfterTokensMode)) {
		normalized.compactAfterTokensMode = value.compactAfterTokensMode;
	}
	const ratio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (ratio !== undefined) normalized.compactAfterTokensRatio = ratio;
	if (value.idleCompactionTtl !== undefined) {
		normalized.idleCompactionTtlSeconds = parseDurationToSeconds(value.idleCompactionTtl);
	}
	if (typeof value.showWorkerNotifications === "boolean")
		normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	return normalized;
}

function parseBooleanString(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const lower = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(lower)) return true;
	if (["0", "false", "no", "off"].includes(lower)) return false;
	return undefined;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawDisable = parseBooleanString(env[OM_DISABLE_ENV]);
	if (rawDisable !== undefined) return { passive: rawDisable };
	const rawPassive = parseBooleanString(env[PASSIVE_ENV]);
	if (rawPassive !== undefined) return { passive: rawPassive };
	return {};
}

export async function loadConfig(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<Config> {
	const paths = defaultExtensionSettingsPaths(cwd);
	const settings = await readMergedJsonSettingsSection({
		paths,
		section: SETTINGS_KEY,
		...(signal ? { signal } : {}),
	});
	const fileConfig = normalizeSettingsConfig(settings.merged);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...fileConfig,
		...envConfig,
	};
	const target =
		validTargetOrUndefined(merged.observationsPoolTargetTokens, merged.observationsPoolMaxTokens) ??
		derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

	return {
		...merged,
		observationsPoolTargetTokens: target,
	};
}
