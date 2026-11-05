import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
	isDeepSeekAvailable,
	resolveDeepSeekApiRoot,
	resolveDeepSeekAuth,
	searchWithDeepSeek,
} from "../src/deepseek.ts";
import {
	isCurrentModelHostedSearchEligible,
	isOpenAISubscriptionModelSelected,
	searchWithCurrentModelOpenAI,
	searchWithVirtualModel,
} from "../src/openai-search.ts";

describe("DeepSeek integration improvements", () => {
	test("resolveDeepSeekApiRoot strips API suffixes and keeps proxy paths", () => {
		const cases: Array<[string | undefined, string]> = [
			[undefined, "https://api.deepseek.com"],
			["https://api.deepseek.com", "https://api.deepseek.com"],
			["https://api.deepseek.com/", "https://api.deepseek.com"],
			["https://api.deepseek.com/v1", "https://api.deepseek.com"],
			["https://api.deepseek.com/v1/", "https://api.deepseek.com"],
			["https://api.deepseek.com/anthropic", "https://api.deepseek.com"],
			["https://api.deepseek.com/anthropic/v1", "https://api.deepseek.com"],
			["https://proxy.example.com/deepseek", "https://proxy.example.com/deepseek"],
			["https://proxy.example.com/deepseek/v1", "https://proxy.example.com/deepseek"],
			["https://proxy.example.com/deepseek/anthropic/v1/", "https://proxy.example.com/deepseek"],
		];

		for (const [input, expected] of cases) {
			expect(resolveDeepSeekApiRoot(input)).toBe(expected);
		}
	});

	test("resolveDeepSeekAuth extracts credentials from ctx.modelRegistry", async () => {
		const mockModel = {
			id: "deepseek-chat",
			provider: "deepseek",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com/v1",
		} as unknown as Model<Api>;

		const mockCtx = {
			modelRegistry: {
				getAll: () => [mockModel],
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "sk-from-registry",
					headers: { "X-Custom": "test-header" },
				}),
				hasConfiguredAuth: () => true,
			},
		} as unknown as ExtensionContext;

		const auth = await resolveDeepSeekAuth(mockCtx);
		expect(auth).toEqual({
			apiKey: "sk-from-registry",
			root: "https://api.deepseek.com",
			headers: { "X-Custom": "test-header" },
		});
		expect(isDeepSeekAvailable(mockCtx)).toBe(true);
	});

	test("searchWithDeepSeek formats HTTP error status codes accurately", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(JSON.stringify({ error: { message: "insufficient balance" } }), {
				status: 402,
				statusText: "Payment Required",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const mockCtx = {
				modelRegistry: {
					getAll: () => [
						{
							id: "deepseek-chat",
							provider: "deepseek",
							api: "openai-completions",
						} as unknown as Model<Api>,
					],
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
					hasConfiguredAuth: () => true,
				},
			} as unknown as ExtensionContext;

			await expect(searchWithDeepSeek("test query", { extensionContext: mockCtx })).rejects.toThrow(
				/insufficient account balance/,
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Virtual Models in Web Search", () => {
	const virtualModel = {
		id: "default",
		provider: "pi",
		api: "pi-virtual",
	} as unknown as Model<Api>;

	test("recognizes virtual model as eligible for current model search", () => {
		const ctx = { model: virtualModel } as unknown as ExtensionContext;
		expect(isCurrentModelHostedSearchEligible(ctx)).toBe(true);
		expect(isOpenAISubscriptionModelSelected(ctx)).toBe(true);
	});

	test("searchWithVirtualModel configures OpenAI responses and collects streaming events", async () => {
		let onPayloadCalled = false;
		let onStreamEventCalled = false;

		const mockCtx = {
			model: virtualModel,
			sessionManager: {
				getSessionId: () => "test-session-id",
			},
			modelRegistry: {
				streamSimple: (
					_model: unknown,
					_context: unknown,
					options: {
						onPayload: (payload: unknown, target: Model<Api>) => unknown;
						onProviderStreamEvent: (event: unknown) => void;
					},
				) => {
					return {
						result: async () => {
							const target = {
								id: "gpt-5",
								provider: "openai",
								api: "openai-responses",
							} as unknown as Model<Api>;

							const request = options.onPayload({}, target) as Record<string, unknown>;
							onPayloadCalled = true;
							expect(request.store).toBe(false);
							expect(request.tools).toBeDefined();

							options.onProviderStreamEvent({
								type: "response.output_text.delta",
								delta: "The answer is 42.",
							});
							options.onProviderStreamEvent({
								type: "response.output_item.done",
								item: {
									type: "web_search_call",
									action: {
										sources: [{ url: "https://example.com/source", title: "Example Source" }],
									},
								},
							});
							onStreamEventCalled = true;

							return {
								stopReason: "stop",
							};
						},
					};
				},
			},
		} as unknown as ExtensionContext;

		const result = await searchWithCurrentModelOpenAI("what is the answer", {}, mockCtx);
		expect(onPayloadCalled).toBe(true);
		expect(onStreamEventCalled).toBe(true);
		expect(result.answer).toBe("The answer is 42.");
		expect(result.results).toEqual([
			{
				title: "Example Source",
				url: "https://example.com/source",
				snippet: "",
			},
		]);
	});

	test("searchWithVirtualModel configures Google generative ai and collects grounding chunks", async () => {
		const mockCtx = {
			model: virtualModel,
			sessionManager: {
				getSessionId: () => "test-session-id",
			},
			modelRegistry: {
				streamSimple: (
					_model: unknown,
					_context: unknown,
					options: {
						onPayload: (payload: unknown, target: Model<Api>) => unknown;
						onProviderStreamEvent: (event: unknown) => void;
					},
				) => {
					return {
						result: async () => {
							const target = {
								id: "gemini-2.5-flash",
								provider: "google",
								api: "google-generative-ai",
							} as unknown as Model<Api>;

							const payload = options.onPayload({ config: {} }, target) as Record<string, unknown>;
							expect((payload.config as { tools: unknown[] }).tools).toEqual([
								{ googleSearch: {} },
							]);

							options.onProviderStreamEvent({
								candidates: [
									{
										content: {
											parts: [
												{ thought: true, text: "thinking..." },
												{ text: "Google search answer." },
											],
										},
										groundingMetadata: {
											groundingChunks: [
												{
													web: {
														uri: "https://google.com/search-result",
														title: "Google Hit",
													},
												},
											],
										},
									},
								],
							});

							return {
								stopReason: "stop",
							};
						},
					};
				},
			},
		} as unknown as ExtensionContext;

		const result = await searchWithVirtualModel("test google grounding", {}, mockCtx);
		expect(result.answer).toBe("Google search answer.");
		expect(result.results).toEqual([
			{
				title: "Google Hit",
				url: "https://google.com/search-result",
				snippet: "",
			},
		]);
	});

	test("searchWithVirtualModel rejects unsupported routed models", async () => {
		const mockCtx = {
			model: virtualModel,
			sessionManager: {
				getSessionId: () => "test-session-id",
			},
			modelRegistry: {
				streamSimple: (
					_model: unknown,
					_context: unknown,
					options: {
						onPayload: (payload: unknown, target: Model<Api>) => unknown;
					},
				) => {
					return {
						result: async () => {
							const target = {
								id: "local-model",
								provider: "ollama",
								api: "openai-completions",
							} as unknown as Model<Api>;

							options.onPayload({}, target);
							return { stopReason: "stop" };
						},
					};
				},
			},
		} as unknown as ExtensionContext;

		await expect(searchWithVirtualModel("test query", {}, mockCtx)).rejects.toThrow(
			/routed to an unsupported search model/,
		);
	});
});
