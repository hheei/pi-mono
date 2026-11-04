import type { SettingChange } from "@hheei/pi-ext-core";
import { expect, test, vi } from "vitest";
import {
	activityGroupsEnabled,
	createToolGroupSettings,
	toolBackgroundsEnabled,
	toolCopyControlEnabled,
} from "../src/settings.js";

test("activity groups stay on unless settings explicitly disable them", () => {
	expect(activityGroupsEnabled(undefined)).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: {} })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: "false" } })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: true } })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: false } })).toBe(false);
});

test("tool backgrounds stay off unless settings explicitly enable them", () => {
	expect(toolBackgroundsEnabled(undefined)).toBe(false);
	expect(toolBackgroundsEnabled({ toolGroups: {} })).toBe(false);
	expect(toolBackgroundsEnabled({ toolGroups: { toolBackgrounds: "true" } })).toBe(false);
	expect(toolBackgroundsEnabled({ toolGroups: { toolBackgrounds: true } })).toBe(true);
});

test("the copy control stays on unless settings explicitly remove it", () => {
	expect(toolCopyControlEnabled(undefined)).toBe(true);
	expect(toolCopyControlEnabled({ toolGroups: {} })).toBe(true);
	expect(toolCopyControlEnabled({ toolGroups: { copyControl: "false" } })).toBe(true);
	expect(toolCopyControlEnabled({ toolGroups: { copyControl: true } })).toBe(true);
	expect(toolCopyControlEnabled({ toolGroups: { copyControl: false } })).toBe(false);
});

test("a change reaches the callback that owns its field and no other", async () => {
	const onEnabled = vi.fn();
	const onBackgrounds = vi.fn();
	const onCopyControl = vi.fn();
	const provider = createToolGroupSettings({ onEnabled, onBackgrounds, onCopyControl });
	const onChange = provider.onChange!;
	const change = (groupId: string, fieldId: string, value: unknown) =>
		onChange({ groupId, fieldId, value } as SettingChange, { sessionId: "test" });

	await change("toolGroups", "enabled", false);
	expect(onEnabled).toHaveBeenLastCalledWith(false);
	await change("toolGroups", "toolBackgrounds", true);
	expect(onBackgrounds).toHaveBeenLastCalledWith(true);
	await change("toolGroups", "copyControl", false);
	expect(onCopyControl).toHaveBeenLastCalledWith(false);
	await change("another-extension", "enabled", false);
	expect(onEnabled).toHaveBeenCalledTimes(1);
	expect(onBackgrounds).toHaveBeenCalledTimes(1);
	expect(onCopyControl).toHaveBeenCalledTimes(1);
});
