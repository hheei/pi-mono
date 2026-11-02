import { describe, expect, test } from "vitest";
import { resolvePromptSettings, SETTINGS_SECTION } from "../src/preferences";
import {
	ASK_USER_SETTINGS_PROVIDER_ID,
	createAskUserSettingsProvider,
} from "../src/settings-provider";
import { isolateAgentDir } from "./fixtures/harness";

isolateAgentDir();

describe("ask_user settings provider", () => {
	const provider = createAskUserSettingsProvider();
	const fields = new Map((provider.groups[0]?.fields ?? []).map((field) => [field.id, field]));

	test("claims the askUser group and covers every key the parser accepts", () => {
		expect(provider.id).toBe(ASK_USER_SETTINGS_PROVIDER_ID);
		expect(provider.groups.map((group) => group.id)).toEqual([SETTINGS_SECTION]);
		expect([...fields.keys()]).toEqual(["displayMode"]);
		for (const field of fields.values()) expect(field.label.length).toBeGreaterThan(0);
	});

	test("parses drafts into the values the tool accepts", () => {
		expect(fields.get("displayMode")?.parse("inline")).toBe("inline");
		expect(fields.get("displayMode")?.parse("nonsense")).toBe("overlay");
	});

	test("defaults match the documented behaviour", () => {
		expect(fields.get("displayMode")?.defaultValue).toBe("overlay");
	});

	test("saves into the section the tool reads back", async () => {
		await provider.storage.save(
			{ [SETTINGS_SECTION]: { displayMode: "inline" } },
			{ sessionId: "settings-provider-test" },
		);

		const settings = await resolvePromptSettings({});
		expect(settings.displayMode).toBe("inline");
	});
});
