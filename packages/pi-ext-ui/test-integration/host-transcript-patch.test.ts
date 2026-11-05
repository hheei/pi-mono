import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.each([
	{ mode: "regular", notice: false },
	{ mode: "fullscreen", notice: false },
	{ mode: "regular", notice: true },
])("published JS groups history and live activity in bundled CLI ($mode, notice=$notice)", ({
	mode,
	notice,
}) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ui-groups-"));
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const cli =
		process.env.PI_UI_GROUPS_TEST_CLI ??
		join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
	const extension = join(directory, "probe.mjs");
	const evidence = join(directory, "evidence.json");
	const session = join(directory, "session.jsonl");
	const stagedUi = join(directory, "node_modules/@hheei/pi-ext-ui");
	const timestamp = new Date().toISOString();
	const ids = ["a", "b", "c", "d"];
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Historical private thinking" },
			...ids.map((id) => ({
				type: "toolCall",
				id,
				name: "read",
				arguments: { path: "fixture.txt" },
			})),
		],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const entries = [
		{
			type: "session",
			version: 3,
			id: "11111111-1111-4111-8111-111111111111",
			cwd: directory,
			timestamp,
		},
		{ type: "message", id: "assistant", parentId: null, timestamp, message },
		...ids.map((id, index) => ({
			type: "message",
			id: `result-${id}`,
			parentId: index === 0 ? "assistant" : `result-${ids[index - 1]}`,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: `original ${id}` }],
				isError: false,
				timestamp: 0,
			},
		})),
	];
	try {
		// Stage published files without physical host devDependencies: bundled Pi owns module identity.
		for (const name of ["pi-ext-ui", "pi-ext-core"]) {
			const source = join(packageRoot, "..", name);
			const target = join(directory, "node_modules/@hheei", name);
			mkdirSync(target, { recursive: true });
			cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
			cpSync(join(source, "package.json"), join(target, "package.json"));
		}
		writeFileSync(session, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		// Test-only instrumentation observes the actual running host; production adds no event patch.
		writeFileSync(
			extension,
			String.raw`
import { writeFileSync } from "node:fs";
import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    const prototype = InteractiveMode.prototype;
    const original = prototype.getRegisteredToolDefinition;
    let observed = false;
    let lookups = 0;
    prototype.getRegisteredToolDefinition = function(name) {
      if (++lookups === 3 && ${notice}) ctx.ui.notify("BOUNDARY", "info");
      const result = original.call(this, name);
      if (!observed) {
        observed = true;
        const host = this;
        const chat = this.chatContainer;
        const render = chat.render;
        chat.render = function(width) {
          const rows = render.call(this, width);
          const ready = chat.children.filter(child => child instanceof ToolExecutionComponent && child.result && !child.isPartial).length === 4;
          if (ready) {
            const text = stripTerminalSequences(rows.join("\n"));
            chat.render = render;
            prototype.getRegisteredToolDefinition = original;
            void (async () => {
              await host.session.extensionRunner.emit({ type: "agent_start" });
              await host.handleEvent({ type: "agent_start" });
              const live = { ...${JSON.stringify(message)}, content: [
                { type: "thinking", thinking: "Streaming private thinking" },
                ...["live-a", "live-b"].map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
              ] };
              await host.handleEvent({ type: "message_start", message: live });
              await host.handleEvent({ type: "message_update", message: live });
              const streaming = stripTerminalSequences(render.call(chat, width).join("\n"));
              await host.handleEvent({ type: "message_end", message: live });
              await host.handleEvent({ type: "tool_execution_start", toolCallId: "live-a", toolName: "read", args: { path: "live-a" } });
              const running = stripTerminalSequences(render.call(chat, width).join("\n"));
              await host.handleEvent({ type: "tool_execution_update", toolCallId: "live-a", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "PARTIAL BODY" }] } });
              const partial = stripTerminalSequences(render.call(chat, width).join("\n"));
              ctx.ui.notify("FIRST NOTICE", "info");
              ctx.ui.notify("SECOND NOTICE\nsecond line", "warning");
              await host.handleEvent({ type: "tool_execution_end", toolCallId: "live-a", toolName: "read", result: { content: [{ type: "text", text: "DONE BODY" }] }, isError: false });
              const finished = stripTerminalSequences(render.call(chat, width).join("\n"));
              ctx.ui.setToolsExpanded(true);
              const expandedRows = render.call(chat, width);
              const expandedText = stripTerminalSequences(expandedRows.join("\n"));
              ctx.ui.setToolsExpanded(false);
              const restored = stripTerminalSequences(render.call(chat, width).join("\n"));
              await host.handleEvent({ type: "tool_execution_end", toolCallId: "live-b", toolName: "read", result: { content: [{ type: "text", text: "DONE B" }] }, isError: false });
              await host.session.extensionRunner.emit({ type: "agent_end", messages: [live] });
              await host.handleEvent({ type: "agent_end", messages: [live] });
              const settled = stripTerminalSequences(render.call(chat, width).join("\n"));
              writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({
                text, streaming, running, partial, finished, restored, settled, expandedText,
                expanded: expandedRows.length > rows.length,
              }));
              ctx.shutdown();
            })().catch(error => {
              writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ error: String(error), stack: error.stack }));
              ctx.shutdown();
            });
          }
          return rows;
        };
      }
      return result;
    };
  });
}
`,
		);
		const argv = [
			process.execPath,
			cli,
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--extension",
			join(stagedUi, "dist/extension.js"),
			"--extension",
			extension,
			"--tui-mode",
			mode,
			"--session",
			session,
			"--model",
			"openai/gpt-4o",
		];
		const command = argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
		// util-linux script supplies a PTY; ordinary pipes select non-interactive Pi.
		const result = spawnSync("script", ["-q", "-e", "-c", command, "/dev/null"], {
			cwd: directory,
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				TERM: "xterm-256color",
			},
		});
		expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(existsSync(evidence), `${result.stdout}\n${result.stderr}`).toBe(true);
		const observed: unknown = JSON.parse(readFileSync(evidence, "utf8"));
		expect(observed, JSON.stringify(observed)).toMatchObject({
			expanded: true,
			// Restored history: the last read is the unit outside, so the block lists the other three.
			text: expect.stringContaining("read ×3"),
			// The live call is the transcript's last unit and draws its own header.
			streaming: expect.stringMatching(/[·✢✳✶✻✽] read/),
			running: expect.stringMatching(/[·✢✳✶✻✽] read/),
			// A partial result is not a completed call: the count stays at the four finished reads.
			partial: expect.stringContaining("read ×4"),
			finished: expect.stringContaining("read ×5"),
			// live-b is still running, so the restored frame counts five completed calls.
			restored: expect.stringContaining("read ×5"),
			// The block holds this run's content, so its frozen duration survives the end.
			settled: expect.stringMatching(/collapse views · \d+s · 6 calls/),
			expandedText: expect.stringContaining("second line"),
		});
		// The footer closes the block; its colored padding row is the single separator before the
		// outside unit. No second blank row belongs to the host.
		expect(observed).toMatchObject({
			text: expect.stringMatching(/requests ×1 · ↑— · ↓— *\n\n *▸ ✓ read/),
			settled: expect.stringMatching(/requests ×2[^\n]*\n\n *Tool output: collapsed/),
		});
		const resultText = JSON.stringify(observed);
		expect(observed).toMatchObject({ expandedText: expect.stringContaining("DONE BODY") });
		expect(resultText).toContain("FIRST NOTICE");
		expect(resultText).toContain("SECOND NOTICE");
		expect(observed).toMatchObject({
			restored: expect.stringContaining("requests ×2"),
			settled: expect.stringContaining("read ×6"),
			// A partial result and a still-running call never enter the completed count.
			partial: expect.not.stringContaining("read ×5"),
			// Historical and streaming thinking runs are two items, split by the tools between them.
			streaming: expect.stringContaining("thinking x2 · 14 tokens"),
		});
		expect(resultText).not.toContain("notify ×");
		expect(resultText).not.toContain("collapse views · — · 6 calls");
		if (notice) expect(resultText).toContain("BOUNDARY");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 25_000);
