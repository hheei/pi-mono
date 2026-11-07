import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readMessageView } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BashJobReminder, BashTerminalEvent } from "./bash-jobs.js";
import { formatBashId } from "./status.js";

export const BASH_INFO_TYPE = "bg-bash-info";
const schema = Type.Object({
	id: Type.String(),
	status: Type.Union([
		Type.Literal("running"),
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
		Type.Literal("timed_out"),
		Type.Literal("unknown"),
	]),
	kind: Type.Union([
		Type.Literal("terminal"),
		Type.Literal("idle"),
		Type.Literal("heartbeat"),
		Type.Literal("held"),
	]),
	message: Type.String(),
});
type BashInfo = {
	readonly id: string;
	readonly status: string;
	readonly kind: string;
	readonly message: string;
};

function shown(data: unknown): BashInfo | undefined {
	if (!Value.Check(schema, data)) return undefined;
	const clean = (text: string): string =>
		stripVTControlCharacters(text)
			.replaceAll("\t", "    ")
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
	return {
		id: clean(data.id).replace(/\s+/gu, " "),
		status: data.status,
		kind: data.kind,
		message: clean(data.message),
	};
}

function tone(status: string): "accent" | "success" | "warning" | "error" {
	if (status === "completed") return "success";
	if (status === "failed" || status === "unknown") return "error";
	if (status === "cancelled" || status === "timed_out") return "warning";
	return "accent";
}

/** Same glyph vocabulary as a subagent entry: one status, one mark. */
function glyph(status: string): string {
	if (status === "completed") return "\u2713";
	if (status === "failed" || status === "unknown") return "\u2717";
	if (status === "cancelled" || status === "timed_out") return "!";
	return "\u2722";
}

function summary(value: BashInfo): string {
	return `${glyph(value.status)} ${formatBashId(value.id)} ${value.kind} \u00b7 ${value.status}`;
}

function heading(value: BashInfo, theme: Pick<Theme, "fg">): string {
	return (
		theme.fg("dim", "info \u00b7 bg-bash \u00b7 ") + theme.fg(tone(value.status), summary(value))
	);
}

export function appendBashInfo(
	pi: Pick<ExtensionAPI, "appendEntry">,
	event: BashTerminalEvent | BashJobReminder,
	message: string,
	terminalKind: "terminal" | "held" = "terminal",
): void {
	const kind =
		"kind" in event && (event.kind === "idle" || event.kind === "heartbeat")
			? event.kind
			: terminalKind;
	const job = "job" in event ? event.job : event;
	const status = job.status;
	pi.appendEntry(BASH_INFO_TYPE, { id: job.id, status, kind, message });
}

export function registerBashInfo(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	pi.registerEntryRenderer(BASH_INFO_TYPE, (entry, options, theme) => {
		const value = shown(entry.data);
		if (value === undefined) return undefined;
		const create = readMessageView(pi);
		if (create !== undefined)
			return create({
				theme,
				header: {
					kind: "bg-bash",
					summary: summary(value),
					tone: tone(value.status),
				},
				...(value.message.trim() === "" ? {} : { body: value.message }),
				stateHolder: entry,
				forcedExpanded: options.expanded,
			});
		return new Text(
			options.expanded ? `${heading(value, theme)}\n${value.message}` : heading(value, theme),
			1,
			0,
		);
	});
}
