import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { resolvePromptSettings } from "../src/preferences";
import { customUI, isolateAgentDir, setupTool, stubEnv } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

/** Points the agent dir at a temp directory holding `ext_settings.json`. */
function useSettingsFile(content: unknown): void {
	const dir = mkdtempSync(join(tmpdir(), "ask-user-agent-dir-"));
	writeFileSync(
		join(dir, "ext_settings.json"),
		typeof content === "string" ? content : JSON.stringify({ askUser: content }),
		"utf8",
	);
	stubEnv("PI_CODING_AGENT_DIR", dir);
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
}

describe("resolvePromptSettings", () => {
	test("uses the documented default", async () => {
		const settings = await resolvePromptSettings({});
		expect(settings).toEqual({ displayMode: "overlay" });
	});

	test("reads the askUser section of ext_settings.json", async () => {
		useSettingsFile({ displayMode: "inline" });
		const settings = await resolvePromptSettings({});
		expect(settings.displayMode).toBe("inline");
	});

	test("the call parameter wins over the settings file", async () => {
		useSettingsFile({ displayMode: "inline" });
		const settings = await resolvePromptSettings({ displayMode: "overlay" });
		expect(settings.displayMode).toBe("overlay");
	});

	test("ignores an unknown value", async () => {
		useSettingsFile({ displayMode: "fullscreen" });
		const settings = await resolvePromptSettings({});
		expect(settings.displayMode).toBe("overlay");
	});

	test("a malformed settings file fails with its path", async () => {
		useSettingsFile("{ not json");
		await expect(resolvePromptSettings({})).rejects.toThrow(/ext_settings\.json/);
	});
});

describe("ask_user preference wiring", () => {
	test("displayMode from the settings file reaches the surface options", async () => {
		useSettingsFile({ displayMode: "inline" });
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute("id", { question: "Q", options: ["A", "B"] }, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async (_factory, options) => {
					capturedOptions = options;
					return null;
				}),
			},
		});

		expect(capturedOptions?.overlay).toBeUndefined();
	});
});
