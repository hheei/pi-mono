import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import piGoalExtension from "../../src/extension.js";

/** How a test revokes the run whose kickoff the host deferred past `agent_settled`. */
export type KickoffRevocation = "pause" | "clear" | "navigation";

function assistant(
	model: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; id: string },
	text: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A real provider that answers every request immediately and counts how many it received. */
function countingProvider(pi: ExtensionAPI): { readonly calls: number } {
	const state = { calls: 0 };
	pi.registerProvider("goal-test", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "goal-test-key",
		models: [
			{
				id: "counting",
				name: "Counting",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple(model) {
			state.calls += 1;
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: assistant(model, "done") });
			return stream;
		},
	});
	return {
		get calls() {
			return state.calls;
		},
	};
}

export async function waitUntil(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export interface BootedKickoffHost {
	readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	readonly calls: number;
	readonly notices: string[];
	readonly invokeGoal: (verb: string) => Promise<void>;
	/** Revokes the run a late settle handler just resumed, leaving its kickoff deferred. */
	armRevocation(how: KickoffRevocation): void;
	dispose(): Promise<void>;
}

/**
 * A real Pi session whose goal has no continuation budget, so the first settlement pauses the goal
 * and a later `agent_settled` handler can resume it while the host is still emitting that event.
 * Pi defers the kickoff `sendMessage` of such a resume, which is the stale-kickoff race.
 */
export async function bootKickoffHost(): Promise<BootedKickoffHost> {
	const savedChildEnv = process.env.PI_SUBAGENTS_CHILD_ID;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-kickoff-host-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENTS_CHILD_ID;
	await writeFile(
		join(dir, "ext_settings.json"),
		JSON.stringify({ goal: { review: false, continuations: 0 } }),
	);
	let provider: { readonly calls: number } | undefined;
	let revocation: KickoffRevocation | undefined;
	let invoke: ((verb: string) => Promise<void>) | undefined;
	let navigateTarget: (() => Promise<void>) | undefined;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				provider = countingProvider(pi);
			},
			piGoalExtension,
			// Registered after Goal: it resumes the just-paused goal inside the settlement.
			(pi) =>
				registerExtensionLifecycle(pi, {
					key: "goal-test-late-kickoff",
					start({ pi: runtimePi, resources }) {
						resources.add(
							"late-resume",
							runtimePi.on("agent_settled", async () => {
								const how = revocation;
								if (how === undefined) return;
								revocation = undefined;
								await invoke?.("resume");
								if (how === "pause") await invoke?.("pause");
								else if (how === "clear") await invoke?.("clear");
								else await navigateTarget?.();
							}),
						);
					},
				}),
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
	});
	await session.bindExtensions({ mode: "print" });
	const model = session.modelRuntime.getModel("goal-test", "counting");
	if (model === undefined) throw new Error("the counting test provider was not registered");
	await session.setModel(model);
	const command = session.extensionRunner.getCommand("goal");
	if (command === undefined) throw new Error("the goal command was not registered");
	if (provider === undefined) throw new Error("the counting provider was not loaded");
	const counted = provider;
	const base = session.extensionRunner.createCommandContext();
	const notices: string[] = [];
	const ctx = {
		...base,
		ui: {
			...base.ui,
			notify(message: string) {
				notices.push(message);
			},
		},
	};
	const invokeGoal = async (verb: string): Promise<void> => {
		await command.handler(verb, ctx);
	};
	invoke = invokeGoal;
	// Navigation needs a real entry to return to; the goal entry itself keeps the goal on the
	// destination branch so only the run is revoked.
	navigateTarget = async (): Promise<void> => {
		const goalEntry = session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "pi-goal");
		if (goalEntry === undefined) throw new Error("the goal entry was not written");
		await session.navigateTree(goalEntry.id);
	};
	const dispose = async (): Promise<void> => {
		// Sessions in one process share the ext-core runtime identity, so the lifecycle must shut
		// down explicitly or the next boot sees a duplicate settings provider.
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await rm(dir, { recursive: true, force: true });
		if (savedChildEnv === undefined) delete process.env.PI_SUBAGENTS_CHILD_ID;
		else process.env.PI_SUBAGENTS_CHILD_ID = savedChildEnv;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	};
	return {
		session,
		get calls() {
			return counted.calls;
		},
		notices,
		invokeGoal,
		armRevocation(how) {
			revocation = how;
		},
		dispose,
	};
}
