import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import piSubagentsExtension from "../src/extension.js";
import { withoutInheritedChildIdentity } from "./helpers/bridge-env.js";

withoutInheritedChildIdentity();

test("the real subagents extension initializes in a standalone SDK parent without a TUI", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-mcp-real-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	try {
		const createRuntime = async ({
			cwd,
			sessionManager,
		}: {
			cwd: string;
			sessionManager: SessionManager;
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: dir,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noContextFiles: true,
					extensionFactories: [piSubagentsExtension],
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: dir,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(dir),
		});
		try {
			await runtime.session.bindExtensions({ mode: "print" });
			const names = runtime.session.extensionRunner
				.getAllRegisteredTools()
				.map((tool) => tool.definition.name);
			expect(names).toContain("agents_delegate");
			expect(names).toContain("agents_get");
		} finally {
			await runtime.dispose();
		}
	} finally {
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a Pi SDK headless parent can start an extension without a prompt or TUI", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-mcp-headless-"));
	const started: string[] = [];
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						expect(ctx.hasUI).toBe(false);
						expect(ctx.mode).toBe("print");
						started.push(ctx.sessionManager.getSessionId());
					});
				},
			],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(dir),
		}));
		expect(started).toEqual([]);
		await session.bindExtensions({ mode: "print" });
		expect(started).toHaveLength(1);
		expect(started[0]).toBeTruthy();
	} finally {
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
