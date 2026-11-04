import { describe, expect, test, vi } from "vitest";
import { reconcileAskUserTool } from "../src/reconcile";

describe("reconcileAskUserTool", () => {
	test("strips ask_user from active tools when UI is absent", () => {
		const active = ["read", "bash", "ask_user"];
		const setActiveTools = vi.fn();
		const pi = {
			getActiveTools: () => active,
			setActiveTools,
		} as any;
		reconcileAskUserTool(pi, { hasUI: false } as any);
		expect(setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
	});

	test("restores ask_user to active tools when UI is present", () => {
		const active = ["read", "bash"];
		const setActiveTools = vi.fn();
		const pi = {
			getActiveTools: () => active,
			setActiveTools,
		} as any;
		reconcileAskUserTool(pi, { hasUI: true } as any);
		expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "ask_user"]);
	});

	test("leaves active tools untouched when already matching UI availability", () => {
		const setActiveTools = vi.fn();
		const pi = {
			getActiveTools: () => ["read", "bash"],
			setActiveTools,
		} as any;
		reconcileAskUserTool(pi, { hasUI: false } as any);
		expect(setActiveTools).not.toHaveBeenCalled();
	});
});
