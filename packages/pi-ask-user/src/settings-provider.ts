import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createJsonSettingsStorage,
	getRuntimeSettingsRegistry,
	registerSettings,
	type SettingField,
	type SettingsProvider,
} from "@hheei/pi-ext-core";
import { SETTINGS_SECTION } from "./constants";
import type { AskDisplayMode } from "./schema";

export const ASK_USER_SETTINGS_PROVIDER_ID = "pi-ask-user";

function enumField<T extends string>(
	id: string,
	label: string,
	description: string,
	defaultValue: T,
	values: readonly T[],
): SettingField<T> {
	return {
		id,
		label,
		type: "enum",
		defaultValue,
		description,
		options: values.map((value) => ({ value, label: value })),
		parse: (draft) => (values.includes(draft as T) ? (draft as T) : defaultValue),
	};
}

/**
 * The `askUser` section, defined once: the settings UI renders these fields and the tool
 * resolves its own defaults from them. Values land in the global layer; a project layer
 * still wins when the tool resolves preferences.
 */
export const ASK_USER_FIELDS = {
	displayMode: enumField<AskDisplayMode>(
		"displayMode",
		"display mode",
		"Overlay shows a centered modal; inline renders the prompt in place.",
		"overlay",
		["overlay", "inline"],
	),
};

export function createAskUserSettingsProvider(): SettingsProvider {
	return {
		id: ASK_USER_SETTINGS_PROVIDER_ID,
		title: "ask_user",
		origin: "@hheei/pi-ask-user",
		description: "Interactive prompts: where the question is drawn.",
		groups: [
			{
				id: SETTINGS_SECTION,
				title: "",
				fields: Object.values(ASK_USER_FIELDS),
			},
		],
		storage: createJsonSettingsStorage({ group: SETTINGS_SECTION }),
	};
}

/** Registers the provider in the runtime registry; returns the unregister handle. */
export function registerAskUserSettings(pi: ExtensionAPI): () => void {
	return registerSettings(createAskUserSettingsProvider(), getRuntimeSettingsRegistry(pi));
}
