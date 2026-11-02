import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { agentResultText, isRecord } from "@hheei/pi-ext-core";
import { HINDSIGHT_MCP_SERVER_NAME, isHindsightBusinessError } from "./mcp.js";

/** A self shell owns its own padding, so the configured output pad is applied here. */
function renderBox(lines: readonly string[], outputPad: number): Component {
	const pad = Math.max(0, outputPad);
	const leftPad = " ".repeat(pad);
	return {
		render(width: number): string[] {
			const inner = Math.max(1, width - pad * 2);
			return lines.map((line) => leftPad + truncateToWidth(line, inner, "…"));
		},
		invalidate(): void {},
	};
}

/** Applies shared chrome without changing the host's MCP registration or execution. */
export function registerHindsightRenderers(pi: ExtensionAPI): void {
	const prefix = `mcp__${HINDSIGHT_MCP_SERVER_NAME}__`;
	pi.registerToolRenderer((toolName, next): ToolRenderers | undefined => {
		if (!toolName.startsWith(prefix)) return next();
		const name = toolName.slice(prefix.length);
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const query = isRecord(args)
					? typeof args.query === "string"
						? args.query
						: args.page_id
					: undefined;
				const summaryText = typeof query === "string" ? stripTerminalSequences(query) : "";
				const rows: string[] = [theme.fg("dim", `hindsight/${name}`)];
				if (summaryText !== "") {
					rows.push(theme.fg("dim", summaryText));
				}

				if (isRecord(args)) {
					const entries = Object.entries(args).filter(
						([key, value]) =>
							!(
								(key === "query" || (key === "page_id" && typeof args.query !== "string")) &&
								typeof value === "string"
							),
					);
					if (entries.length > 0) {
						const jsonText = JSON.stringify(Object.fromEntries(entries), null, 2);
						for (const line of jsonText.split("\n")) {
							rows.push(theme.fg("dim", stripTerminalSequences(line)));
						}
					}
				}
				return renderBox(rows, context.outputPad);
			},
			renderResult(result, _options, theme, context) {
				let text = agentResultText(result);
				if (!text && result.structuredContent !== undefined) {
					text = JSON.stringify(result.structuredContent, null, 2);
				}
				const isError = context.isError || isHindsightBusinessError(result);
				const color = isError ? "error" : "toolOutput";
				const lines = stripTerminalSequences(text)
					.split("\n")
					.map((line) => theme.fg(color, line));
				return renderBox(lines, context.outputPad);
			},
		};
	});
}
