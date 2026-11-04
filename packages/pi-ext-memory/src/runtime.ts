import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { debugLog } from "./debug-log.js";
import { type FoldedLedger, foldLedger } from "./session-ledger/fold.js";
import type { Entry } from "./session-ledger/types.js";

export type ResolveResult =
	| {
			ok: true;
			model: Model<Api>;
			apiKey?: string | undefined;
			headers?: ProviderHeaders | undefined;
			env?: Record<string, string> | undefined;
			baseUrl?: string | undefined;
	  }
	| { ok: false; reason: string };

/**
 * Mirrors pi's own request-auth acceptance rule (`AgentSession._getRequiredRequestAuth`):
 * resolved auth is usable when it carries an apiKey OR at least one header value.
 * OAuth providers (kimi-coding, xai, openai-codex, anthropic OAuth, …) authenticate via
 * `toAuth()` returning `{ headers: { Authorization: "Bearer …" } }` with no apiKey, and
 * pi-ai providers accept a caller-supplied Authorization header in place of an apiKey.
 *
 * NOTE: a `false` result does NOT mean "unauthenticated" — see `resolveModel`. Providers
 * that authenticate at request time (Amazon Bedrock SigV4 from AWS_PROFILE/SSO, Google
 * Vertex ADC) legitimately expose neither an apiKey nor a header, because pi signs their
 * requests itself.
 */
function hasUsableAuth(auth: { apiKey?: unknown; headers?: unknown }): boolean {
	if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
	return countUsableHeaders(auth.headers) > 0;
}

/** How many headers the auth payload carries at all (diagnostics only, never values). */
function countHeaders(headers: unknown): number {
	return headers && typeof headers === "object"
		? Object.keys(headers as Record<string, unknown>).length
		: 0;
}

/** How many headers carry a non-empty string value — the ones pi could actually send. */
function countUsableHeaders(headers: unknown): number {
	if (!headers || typeof headers !== "object") return 0;
	return Object.values(headers as Record<string, unknown>).filter(
		(value) => typeof value === "string" && value.length > 0,
	).length;
}

/**
 * How long to wait for the availability re-check in `recheckProviderCredential`, and how
 * long before the same provider may be re-checked again.
 *
 * The re-check is network-free and measured at ~1ms on a warm Bedrock/SSO host, but
 * `checkAuth` can block on a provider's own credential resolution, so it is bounded. The
 * re-arm interval keeps an unauthenticated host from paying the cost on every
 * consolidation while still recovering within a session when credentials are renewed out
 * of band (`aws sso login` in another terminal, `gcloud auth application-default login`).
 */
const AVAILABILITY_RECHECK_TIMEOUT_MS = 5_000;
const AVAILABILITY_RECHECK_REARM_MS = 60_000;

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

/**
 * One stage of the consolidation pipeline. The enforcer runs no model, so it is
 * not a worker: it records no cost and appears in no run count, but it still
 * reports itself as the running phase.
 */
export type ConsolidationStage = ConsolidationPhase | "enforcer";

export const MAX_NOTIFY_ERROR_CHARS = 200;

export function flattenErrorMessageForNotify(message: string): string {
	const singleLine = message.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_NOTIFY_ERROR_CHARS) return singleLine;
	return `${singleLine.slice(0, MAX_NOTIFY_ERROR_CHARS - 1)}…`;
}

/**
 * Session-scoped worker spend and run counts, for `/om status`.
 *
 * Deliberately in-memory: cost is a host run-time metric, so it is never appended to the
 * ledger (that would pollute the fold and the projections). It is also never rolled back
 * by a `/tree` switch, because the API calls it accounts for were really made.
 */
export interface WorkerCostStats {
	/** Provider-reported USD across every worker call this session. */
	totalUsd: number;
	runs: Record<ConsolidationPhase, number>;
}

function emptyWorkerCostStats(): WorkerCostStats {
	return { totalUsd: 0, runs: { observer: 0, reflector: 0, dropper: 0 } };
}

/**
 * Whether pi positively reports a working credential source for this model's provider.
 *
 * `ModelRegistry.hasConfiguredAuth(model)` is true when pi's availability check
 * (`ModelRuntime.checkAuth`) resolved *something* for the provider — an API key, a
 * stored credential, or an ambient source such as `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`
 * / gcloud ADC. Combined with `ok: true` and an auth payload that carries
 * nothing, that is the signature of a provider pi signs at request time:
 *
 *   pi has a credential source, and deliberately hands the caller nothing to attach.
 *
 * Measured on a Bedrock/SSO host (pi 0.84.2), with `AWS_PROFILE` exported:
 *   checkAuth("amazon-bedrock") -> { source: "AWS_PROFILE", type: "api_key" }
 *   hasConfiguredAuth(model)    -> true
 *   getApiKeyAndHeaders(model)  -> { ok: true, apiKey: undefined, headers: undefined }
 * `googleVertexProvider`'s ADC branch returns the same empty-auth resolution.
 *
 * The inverse case — `hasConfiguredAuth === false` with an empty auth payload — is a
 * provider pi could not authenticate at all (no key, no ambient source). That must
 * keep failing: it is the ordinary "not logged in" state, not ambient auth.
 *
 * A missing or throwing answer must not be read as "authenticated".
 */
function hasConfiguredProviderCredential(registry: ModelRegistryLike, model: Model<Api>): boolean {
	try {
		return registry.hasConfiguredAuth?.(model) === true;
	} catch {
		return false;
	}
}

/**
 * The slice of Pi's `ModelRegistry` facade this runtime resolves credentials through.
 *
 * Every member is declared with the facade's own signature, so the real registry satisfies
 * it and a host context needs no cast. Each one stays optional, so a credential-free test
 * double can leave a member out instead of faking it.
 */
export interface ModelRegistryLike {
	find?: ModelRegistry["find"] | undefined;
	getApiKeyAndHeaders?: ModelRegistry["getApiKeyAndHeaders"] | undefined;
	isUsingOAuth?: ModelRegistry["isUsingOAuth"] | undefined;
	hasConfiguredAuth?: ModelRegistry["hasConfiguredAuth"] | undefined;
	refresh?: ModelRegistry["refresh"] | undefined;
}

/** What `getApiKeyAndHeaders` resolves to (`ResolvedRequestAuth` in the facade). */
export type ResolvedAuth = Awaited<
	ReturnType<NonNullable<ModelRegistryLike["getApiKeyAndHeaders"]>>
>;

export interface ResolveCtx {
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistryLike;
	hasUI: boolean;
	ui?: { notify: Notify } | undefined;
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify } | undefined;
	sessionGeneration?: number | undefined;
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	private configPromise: Promise<void> | undefined;
	/** Monotonic owner id; async work must not mutate state after this changes. */
	sessionGeneration = 0;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	consolidationPhase: ConsolidationStage | undefined;
	compactInFlight = false;
	idleCompactInFlight = false;
	compactHookInFlight = false;
	workerCost: WorkerCostStats = emptyWorkerCostStats();
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	lastEnforcerError: string | undefined;
	lifecycleSignal?: AbortSignal | undefined;
	pendingCompactionTimer?: ReturnType<typeof setTimeout> | undefined;
	pendingIdleNoticeTimer?: ReturnType<typeof setTimeout> | undefined;
	idleNoticeEmitted = false;
	/** Unix seconds. Idle duration counts from here after the user aborts compaction. */
	idleClockResetSec?: number | undefined;
	/** When true, session_start skips the idle check. The lifecycle start calls `onSessionIdleReady` after config and generation are current. */
	deferSessionIdleCheck = true;
	modelSwitchCompaction?: { fromKey: string } | undefined;
	onSessionIdleReady?: ((ctx: ExtensionContext) => void) | undefined;
	private lifecycleAbortCleanup: (() => void) | undefined;
	/** provider -> epoch ms of the last availability re-check (see `recheckProviderCredential`). */
	availabilityRecheckedAt = new Map<string, number>();
	/** Deliberate-empty backoff (#23): skip observer re-fires over the same span until enough new tokens arrive. */
	observerEmptyBackoff:
		| {
				sessionIdentity: string | undefined;
				coverageId: string | undefined;
				tokensAtEmpty: number;
		  }
		| undefined;
	ledgerSnapshot?:
		| {
				snapshot: FoldedLedger;
				fromEntryId: string;
		  }
		| undefined;

	foldWithSnapshot(entries: Entry[]): FoldedLedger {
		const folded = foldLedger(entries, this.ledgerSnapshot ? { base: this.ledgerSnapshot } : {});
		const lastEntry = entries[entries.length - 1];
		if (lastEntry) {
			this.ledgerSnapshot = { snapshot: folded, fromEntryId: lastEntry.id };
		}
		return folded;
	}

	invalidateSnapshot(): void {
		this.ledgerSnapshot = undefined;
	}

	async startSession(cwd: string, signal: AbortSignal): Promise<number> {
		this.lifecycleAbortCleanup?.();
		this.lifecycleAbortCleanup = undefined;
		this.clearPendingCompactionTimer();
		this.clearPendingIdleNoticeTimer();
		this.clearModelSwitchCompaction();
		this.idleNoticeEmitted = false;
		this.idleClockResetSec = undefined;
		this.sessionGeneration += 1;
		this.config = { ...DEFAULTS };
		this.configLoaded = false;
		this.configPromise = undefined;
		this.consolidationInFlight = false;
		this.consolidationPromise = null;
		this.consolidationPhase = undefined;
		this.compactInFlight = false;
		this.idleCompactInFlight = false;
		this.compactHookInFlight = false;
		this.workerCost = emptyWorkerCostStats();
		this.resolveFailureNotified = false;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		this.lastEnforcerError = undefined;
		this.availabilityRecheckedAt.clear();
		this.observerEmptyBackoff = undefined;
		this.ledgerSnapshot = undefined;
		this.lifecycleSignal = signal;
		await this.ensureConfig(cwd, signal);
		return this.sessionGeneration;
	}

	endSession(generation: number): void {
		if (!this.isSessionCurrent(generation)) return;
		this.ledgerSnapshot = undefined;
		this.lifecycleAbortCleanup?.();
		this.lifecycleAbortCleanup = undefined;
		this.clearPendingCompactionTimer();
		this.clearPendingIdleNoticeTimer();
		this.clearModelSwitchCompaction();
		this.idleNoticeEmitted = false;
		this.idleClockResetSec = undefined;
		this.lifecycleSignal = undefined;
		this.sessionGeneration += 1;
		this.consolidationInFlight = false;
		this.consolidationPromise = null;
		this.consolidationPhase = undefined;
		this.compactInFlight = false;
		this.idleCompactInFlight = false;
		this.compactHookInFlight = false;
	}

	isSessionCurrent(generation: number | undefined): boolean {
		return generation === undefined || generation === this.sessionGeneration;
	}

	async ensureConfig(cwd: string, signal?: AbortSignal): Promise<void> {
		if (this.configLoaded) return;
		this.configPromise ??= loadConfig(cwd, process.env, signal).then((config) => {
			this.config = config;
			this.configLoaded = true;
		});
		await this.configPromise;
	}

	async reloadConfig(cwd: string, signal?: AbortSignal): Promise<void> {
		const nextConfig = await loadConfig(cwd, process.env, signal);
		this.config = nextConfig;
		this.configLoaded = true;
		this.configPromise = Promise.resolve();
	}

	clearPendingCompactionTimer(): void {
		if (this.pendingCompactionTimer !== undefined) {
			clearTimeout(this.pendingCompactionTimer);
			this.pendingCompactionTimer = undefined;
		}
	}

	clearPendingIdleNoticeTimer(): void {
		if (this.pendingIdleNoticeTimer !== undefined) {
			clearTimeout(this.pendingIdleNoticeTimer);
			this.pendingIdleNoticeTimer = undefined;
		}
	}

	clearModelSwitchCompaction(): void {
		this.modelSwitchCompaction = undefined;
	}

	/** Count one worker model call, whether or not the provider reports a cost. */
	recordWorkerRun(stage: ConsolidationPhase): void {
		this.workerCost.runs[stage] += 1;
	}

	/**
	 * Add one provider-reported worker cost. Unreported (`undefined`) and free (`0`) are ignored.
	 *
	 * Returns the amount that was recorded (`0` when it was ignored) so a caller that keeps
	 * its own per-run total stays exactly in step with this session-wide one.
	 */
	recordWorkerCost(costUsd: number): number {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
		this.workerCost.totalUsd += costUsd;
		return costUsd;
	}

	async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
		let model = ctx.model;
		if (this.config.model) {
			const configured = ctx.modelRegistry.find?.(this.config.model.provider, this.config.model.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI && ctx.ui) {
				try {
					ctx.ui.notify(
						`om: configured model ${this.config.model.provider}/${this.config.model.id} not found, using session model`,
						"warning",
					);
				} catch {}
			}
		}
		if (!model)
			return {
				ok: false,
				reason:
					"no model available (session has no model and no observational-memory model configured)",
			};
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders?.(model);
		const resolved: Extract<ResolvedAuth, { ok: true }> | undefined =
			auth?.ok === true ? auth : undefined;
		const provider = model.provider;
		const isOAuth = ctx.modelRegistry.isUsingOAuth?.(model) === true;
		// `ok: false` is the only unambiguous failure: pi returns it when a
		// provider requires a request auth header and no credential resolved.
		//
		// `ok: true` with neither apiKey nor headers, for a provider pi DOES
		// report a credential source for, is not a failure — it is how pi describes a
		// provider that authenticates at request time: Amazon Bedrock signing SigV4 from
		// ambient AWS credentials (`bedrockAuth.resolve` returns `{ auth: {}, source:
		// "AWS_PROFILE" }`), Google Vertex using ADC (same empty resolution). pi's own
		// native streaming path forwards no apiKey either, and its pre-prompt gate is
		// merely `hasConfiguredAuth(provider) || checkAuth(provider) !== undefined` —
		// om's pre-flight check must not be stricter than pi's own. Treating it as "no
		// auth" aborted consolidation before the model was ever called, disabling
		// observational memory silently — no error, no cost, no latency — on such hosts.
		//
		// Three cases deliberately keep failing: OAuth providers, where an empty
		// resolution means the credentials no longer resolve and the user must log in
		// again; a credential that resolved to an empty *string* key, which is a
		// misconfiguration rather than ambient auth; and a provider pi reports no
		// credential source for at all, which is simply unauthenticated.
		const usable = resolved !== undefined && hasUsableAuth(resolved);
		const resolvedEmptyApiKey = resolved?.apiKey === "";
		let providerCredentialConfigured = hasConfiguredProviderCredential(ctx.modelRegistry, model);
		// pi's gate has TWO halves and never trusts the snapshot alone (agent-session.js):
		//
		//   hasConfiguredAuth(provider) || (await checkAuth(provider)) !== undefined
		//
		// `hasConfiguredAuth` reads `snapshot.configuredProviders`, which is populated by an
		// availability pass — and left untouched when that pass is skipped
		// (`refreshOnCreate: false`), aborted, or FAILS (its catch records `availabilityError`
		// and returns). A provider whose credential could not be checked at startup — an
		// expired SSO token, say — is therefore absent from the snapshot for the rest of the
		// session, even after the user renews it out of band. pi recovers on the next turn
		// because its second half re-checks live; reading only the snapshot half would leave
		// consolidation dead for the whole session, which is the same silent-failure class as
		// the bug this gate was fixed for.
		//
		// The facade exposes no `checkAuth`, but `refresh({ providers })` performs the same
		// live check and then updates the snapshot, so re-reading afterwards is equivalent.
		// Only attempted when everything else already looks like the ambient shape, so an
		// ordinary unauthenticated provider still fails on the first call.
		if (
			resolved !== undefined &&
			!usable &&
			!isOAuth &&
			!resolvedEmptyApiKey &&
			!providerCredentialConfigured
		) {
			providerCredentialConfigured = await this.recheckProviderCredential(
				ctx.modelRegistry,
				model,
				provider,
			);
		}
		const signsAtRequestTime =
			resolved !== undefined && !isOAuth && !resolvedEmptyApiKey && providerCredentialConfigured;
		if (resolved === undefined || (!usable && !signsAtRequestTime)) {
			const reason = isOAuth
				? `authentication failed for provider "${provider}" — OAuth credentials may have expired; run '/login ${provider}' to re-authenticate`
				: `no API key or auth headers for provider "${provider}"`;
			// The reason string alone cannot tell `ok: false` from `ok: true` with nothing to
			// carry, which is what made the ambient-credential outage un-diagnosable from the
			// debug log. Record the decision inputs — booleans and counts only, never values.
			debugLog("resolve.rejected", {
				provider,
				reason,
				authOk: resolved !== undefined,
				hasApiKey: typeof resolved?.apiKey === "string" && resolved.apiKey.length > 0,
				resolvedEmptyApiKey,
				headerCount: countHeaders(resolved?.headers),
				usableHeaderCount: countUsableHeaders(resolved?.headers),
				isOAuth,
				providerCredentialConfigured,
				signsAtRequestTime,
			});
			return { ok: false, reason };
		}
		if (!usable) {
			debugLog("resolve.request_time_signing", { provider, providerCredentialConfigured });
		}
		// Match pi's request model: OAuth may route to an account-specific endpoint
		// (e.g. Copilot Business). Do not mutate the shared session/registry model.
		const requestModel: Model<Api> = resolved.baseUrl
			? { ...model, baseUrl: resolved.baseUrl }
			: model;
		return {
			ok: true,
			model: requestModel,
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			env: resolved.env,
			baseUrl: resolved.baseUrl,
		};
	}

	/**
	 * Re-check one provider's credential live, then re-read pi's snapshot.
	 *
	 * Implements the second half of pi's own auth gate for the only case that needs it: an
	 * otherwise-ambient-looking resolution whose provider is missing from a stale or never
	 * populated availability snapshot. Bounded and rate-limited; never throws.
	 */
	private async recheckProviderCredential(
		registry: ModelRegistryLike,
		model: Model<Api>,
		provider: string,
	): Promise<boolean> {
		const last = this.availabilityRecheckedAt.get(provider);
		const now = Date.now();
		if (last !== undefined && now - last < AVAILABILITY_RECHECK_REARM_MS) return false;
		this.availabilityRecheckedAt.set(provider, now);

		const refresh = registry.refresh;
		if (typeof refresh !== "function") {
			debugLog("resolve.availability_recheck", {
				provider,
				refreshed: false,
				reason: "registry exposes no refresh()",
			});
			return false;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AVAILABILITY_RECHECK_TIMEOUT_MS);
		let refreshError: string | undefined;
		let timedOut = false;
		try {
			// allowNetwork:false — a credential re-check must not wait on a model-catalog fetch.
			// providers:[provider] — scope the work, and the snapshot writes, to the one provider.
			// A refresh that ignores the abort signal still cannot hold the caller: the race
			// below bounds it.
			await Promise.race([
				refresh.call(registry, {
					allowNetwork: false,
					providers: [provider],
					signal: controller.signal,
				}),
				new Promise<void>((resolve) => {
					controller.signal.addEventListener("abort", () => {
						timedOut = true;
						resolve();
					});
				}),
			]);
		} catch (error) {
			refreshError = errorMessage(error);
		} finally {
			clearTimeout(timer);
		}

		// Re-read even when the refresh reported an error or timed out: a scoped pass can
		// update the snapshot for this provider and still fail elsewhere.
		const recovered = hasConfiguredProviderCredential(registry, model);
		debugLog("resolve.availability_recheck", {
			provider,
			refreshed: refreshError === undefined && !timedOut,
			recovered,
			elapsedMs: Date.now() - now,
			timedOut,
			...(refreshError === undefined ? {} : { refreshError }),
		});
		return recovered;
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		const generation = ctx.sessionGeneration ?? this.sessionGeneration;
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		this.lastEnforcerError = undefined;
		const promise = (async () => {
			try {
				await work();
			} catch (error) {
				if (this.lifecycleSignal?.aborted === true || !this.isSessionCurrent(generation)) return;
				const message = errorMessage(error);
				if (message.includes("stale")) return;
				if (ctx.hasUI && ctx.ui) {
					try {
						ctx.ui.notify(
							`om: consolidation failed: ${flattenErrorMessageForNotify(message)}`,
							"warning",
						);
					} catch {}
				}
			} finally {
				if (this.isSessionCurrent(generation)) {
					this.consolidationInFlight = false;
					this.consolidationPhase = undefined;
					this.consolidationPromise = null;
				}
			}
		})();
		this.consolidationPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationStage, error: unknown): string {
		const message = errorMessage(error);
		if (!this.isSessionCurrent(ctx.sessionGeneration) || message.includes("stale")) return message;
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		if (phase === "enforcer") this.lastEnforcerError = message;
		if (this.lifecycleSignal?.aborted !== true && ctx.hasUI && ctx.ui) {
			try {
				ctx.ui.notify(`om: ${phase} failed: ${flattenErrorMessageForNotify(message)}`, "warning");
			} catch {}
		}
		return message;
	}
}
