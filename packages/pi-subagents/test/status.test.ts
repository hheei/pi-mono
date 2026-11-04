import { describe, expect, test, vi } from "vitest";
import { createSubagentStatus, formatSubagentStatus } from "../src/status.js";
import { child } from "./helpers/records.js";

const theme = { fg: (_color: string, text: string) => text };

describe("native subagent status", () => {
	test("shows agents xN for running child count", () => {
		expect(
			formatSubagentStatus(
				[
					child({ id: "agent-21" }),
					child({ id: "agent-22", presentation: "panel" }),
					child({ id: "agent-23" }),
					child({ id: "agent-24", state: "done" }),
					child({ id: "agent-25", state: "error" }),
					child({ id: "agent-26", interrupted: "waiting for input" }),
				],
				theme,
			),
		).toBe("agents x3");
	});

	test("formats with theme tokens: muted for agents, accent for count", () => {
		const themed = { fg: (token: string, text: string) => `[${token}]${text}[/${token}]` };
		expect(formatSubagentStatus([child({ id: "agent-1" })], themed)).toBe(
			"[muted]agents[/muted] [accent]x1[/accent]",
		);
	});

	test("removes the status on completion and cannot restore it after abort", () => {
		const setStatus = vi.fn();
		const controller = new AbortController();
		const status = createSubagentStatus({ theme, setStatus }, controller.signal);
		status.refresh([child({ id: "agent-21" })]);
		expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", "agents x1");
		status.refresh([child({ id: "agent-21", state: "done" })]);
		expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", undefined);
		status.refresh([child({ id: "agent-22" })]);
		controller.abort();
		expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", undefined);
		setStatus.mockClear();
		status.refresh([child({ id: "agent-23" })]);
		status.dispose();
		expect(setStatus).not.toHaveBeenCalled();
	});
});
