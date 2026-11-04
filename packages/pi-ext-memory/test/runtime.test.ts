import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
	flattenErrorMessageForNotify,
	MAX_NOTIFY_ERROR_CHARS,
	type ResolvedAuth,
	Runtime,
} from "../src/runtime.js";
import { testModel } from "./fixtures/model.js";

function modelRegistry(args: { found?: Model<Api>; auth?: ResolvedAuth } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(
			async (_model: Model<Api>): Promise<ResolvedAuth> =>
				args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } },
		),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = testModel({ provider: "anthropic", id: "configured" });
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({
			model: testModel({ provider: "openai", id: "session-model" }),
			modelRegistry: registry,
			hasUI: false,
		});

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({
			ok: true,
			model: configured,
			apiKey: "key",
			headers: { test: "yes" },
		});
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = testModel({ provider: "openai", id: "session-model" });
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({
			model: sessionModel,
			modelRegistry: registry,
			hasUI: true,
			ui: { notify },
		});

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"om: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(
			runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false }),
		).resolves.toEqual({
			ok: false,
			reason:
				"no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false, error: "no credential" } });
		await expect(
			runtime.resolveModel({
				model: testModel({ provider: "anthropic", id: "claude" }),
				modelRegistry: registry,
				hasUI: false,
			}),
		).resolves.toEqual({
			ok: false,
			reason: 'no API key or auth headers for provider "anthropic"',
		});
	});

	it("accepts OAuth-shaped auth (headers only, no apiKey)", async () => {
		const runtime = new Runtime();
		const model = testModel({ provider: "kimi-coding", id: "kimi-for-coding" });
		const registry = modelRegistry({
			auth: { ok: true, headers: { Authorization: "Bearer oauth-token" } },
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model,
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});
	});

	it("accepts apiKey auth unchanged", async () => {
		const runtime = new Runtime();
		const model = testModel({ provider: "anthropic", id: "claude" });
		const registry = modelRegistry({ auth: { ok: true, apiKey: "sk-ant-key" } });

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({ ok: true, model, apiKey: "sk-ant-key", headers: undefined });
	});

	it.each([
		{ configured: false, headersOnly: false },
		{ configured: true, headersOnly: false },
		{ configured: false, headersOnly: true },
		{ configured: true, headersOnly: true },
	])("applies auth baseUrl without mutating the model (configured=$configured, headersOnly=$headersOnly)", async ({
		configured,
		headersOnly,
	}) => {
		const runtime = new Runtime();
		const model = Object.freeze(
			testModel({
				provider: "github-copilot",
				id: "gpt-4.1",
				baseUrl: "https://api.individual.githubcopilot.com",
				api: "openai-completions",
				contextWindow: 128_000,
			}),
		);
		const baseUrl = "https://api.business.githubcopilot.com";
		const auth: ResolvedAuth = headersOnly
			? { ok: true, headers: { Authorization: "Bearer test-token" }, baseUrl }
			: { ok: true, apiKey: "test-key", headers: { Authorization: "Bearer test-token" }, baseUrl };
		const registry = modelRegistry({ found: model, auth });
		const sessionModel = configured
			? testModel({ provider: "openai", id: "session-model" })
			: model;
		if (configured)
			runtime.config = { ...runtime.config, model: { provider: model.provider, id: model.id } };

		const result = await runtime.resolveModel({
			model: sessionModel,
			modelRegistry: registry,
			hasUI: false,
		});

		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(result).toMatchObject({
			ok: true,
			model: { ...model, baseUrl },
			apiKey: headersOnly ? undefined : "test-key",
			headers: { Authorization: "Bearer test-token" },
		});
		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).not.toBe(model);
		expect(model.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it.each([undefined, ""])("keeps the original model when auth baseUrl is %j", async (baseUrl) => {
		const runtime = new Runtime();
		const model = Object.freeze(
			testModel({ provider: "openai", id: "test-model", baseUrl: "https://example.com/v1" }),
		);
		const registry = modelRegistry({
			auth: { ok: true, apiKey: "test-key", ...(baseUrl === undefined ? {} : { baseUrl }) },
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).toBe(model);
	});

	it("rejects auth that carries neither apiKey nor usable headers", async () => {
		const runtime = new Runtime();
		const model = testModel({ provider: "xai", id: "grok-4" });

		const rejected: ResolvedAuth[] = [
			{ ok: true },
			{ ok: true, apiKey: "" },
			{ ok: true, headers: {} },
			{ ok: true, headers: { Authorization: "" } },
		];
		for (const auth of rejected) {
			const registry = modelRegistry({ auth });
			await expect(
				runtime.resolveModel({ model, modelRegistry: registry, hasUI: false }),
			).resolves.toEqual({
				ok: false,
				reason: 'no API key or auth headers for provider "xai"',
			});
		}
	});

	it("points OAuth providers at /login when auth resolution fails", async () => {
		const runtime = new Runtime();
		const model = testModel({ provider: "openai-codex", id: "gpt-5-codex" });
		const registry = {
			...modelRegistry({ auth: { ok: false, error: "refresh failed" } }),
			isUsingOAuth: vi.fn((candidate: Model<Api>) => candidate.provider === "openai-codex"),
		};

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(registry.isUsingOAuth).toHaveBeenCalledWith(model);
		expect(result).toEqual({
			ok: false,
			reason:
				"authentication failed for provider \"openai-codex\" — OAuth credentials may have expired; run '/login openai-codex' to re-authenticate",
		});
	});

	it("resets session-owned state and rejects stale consolidation mutations", async () => {
		const runtime = new Runtime();
		const first = new AbortController();
		const firstGeneration = await runtime.startSession("/tmp/pi-memory-test", first.signal);
		runtime.configLoaded = true;
		runtime.resolveFailureNotified = true;
		runtime.availabilityRecheckedAt.set("anthropic", Date.now());
		runtime.observerEmptyBackoff = {
			sessionIdentity: "first",
			coverageId: "coverage",
			tokensAtEmpty: 3,
		};

		let release: (() => void) | undefined;
		const oldTask = runtime.launchConsolidationTask(
			{ hasUI: false, sessionGeneration: firstGeneration },
			async () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const second = new AbortController();
		const secondGeneration = await runtime.startSession("/tmp/pi-memory-test", second.signal);
		runtime.consolidationInFlight = true;
		runtime.recordConsolidationStageError(
			{ hasUI: false, sessionGeneration: firstGeneration },
			"observer",
			new Error("stale failure"),
		);

		expect(secondGeneration).toBeGreaterThan(firstGeneration);
		expect(runtime.configLoaded).toBe(true);
		expect(runtime.resolveFailureNotified).toBe(false);
		expect(runtime.availabilityRecheckedAt).toEqual(new Map());
		expect(runtime.observerEmptyBackoff).toBeUndefined();
		expect(runtime.lastObserverError).toBeUndefined();

		release?.();
		await oldTask;
		expect(runtime.consolidationInFlight).toBe(true);
	});

	it("records worker runs and provider-reported cost, and resets them per session", async () => {
		const runtime = new Runtime();
		const first = new AbortController();
		await runtime.startSession("/tmp/pi-memory-test", first.signal);

		runtime.recordWorkerRun("observer");
		runtime.recordWorkerRun("observer");
		runtime.recordWorkerRun("reflector");
		expect(runtime.recordWorkerCost(0.0025)).toBe(0.0025);
		expect(runtime.recordWorkerCost(0.001)).toBe(0.001);
		// Unreported and free runs must not move the spend total, and must report nothing recorded.
		expect(runtime.recordWorkerCost(0)).toBe(0);
		expect(runtime.recordWorkerCost(Number.NaN)).toBe(0);

		expect(runtime.workerCost.runs).toEqual({ observer: 2, reflector: 1, dropper: 0 });
		expect(runtime.workerCost.totalUsd).toBeCloseTo(0.0035, 10);

		const second = new AbortController();
		await runtime.startSession("/tmp/pi-memory-test", second.signal);

		expect(runtime.workerCost).toEqual({
			totalUsd: 0,
			runs: { observer: 0, reflector: 0, dropper: 0 },
		});
	});

	it("starts session and updates generation", async () => {
		const runtime = new Runtime();
		const controller = new AbortController();
		const generation = await runtime.startSession("/tmp/pi-memory-test", controller.signal);
		expect(runtime.sessionGeneration).toBe(generation);
		runtime.endSession(generation);
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(
			runtime.recordConsolidationStageError(
				{ hasUI: true, ui: { notify } },
				"observer",
				new Error("observe failed"),
			),
		).toBe("observe failed");
		expect(
			runtime.recordConsolidationStageError(
				{ hasUI: true, ui: { notify } },
				"reflector",
				new Error("reflect failed"),
			),
		).toBe("reflect failed");
		expect(
			runtime.recordConsolidationStageError(
				{ hasUI: true, ui: { notify } },
				"dropper",
				"drop failed",
			),
		).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("om: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("om: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("om: dropper failed: drop failed", "warning");
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("forwards env and baseUrl from model registry", async () => {
		const runtime = new Runtime();
		const model = testModel({
			provider: "cloudflare-workers-ai",
			id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
		});
		const registry = modelRegistry({
			auth: {
				ok: true,
				apiKey: "test-key",
				headers: { Authorization: "Bearer test" },
				env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
			},
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model: {
				...model,
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
			},
			apiKey: "test-key",
			headers: { Authorization: "Bearer test" },
			env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
			baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
		});
	});

	describe("flattenErrorMessageForNotify", () => {
		it("flattens multiline error JSON into a single line capped at MAX_NOTIFY_ERROR_CHARS", () => {
			const multiline = `Error: 400 Bad Request
{
  "error": {
    "message": "Model context size exceeded",
    "type": "invalid_request_error"
  }
}`;
			const flattened = flattenErrorMessageForNotify(multiline);
			expect(flattened).not.toContain("\n");
			expect(flattened).not.toContain("\r");
			expect(flattened).toContain('Error: 400 Bad Request { "error":');
		});

		it("truncates errors exceeding MAX_NOTIFY_ERROR_CHARS with ellipsis", () => {
			const longError = "x".repeat(MAX_NOTIFY_ERROR_CHARS + 50);
			const flattened = flattenErrorMessageForNotify(longError);
			expect(flattened.length).toBe(MAX_NOTIFY_ERROR_CHARS);
			expect(flattened.endsWith("…")).toBe(true);
		});

		it("keeps errors within the limit untouched except whitespace", () => {
			expect(flattenErrorMessageForNotify("  simple error  ")).toBe("simple error");
		});
	});
});
