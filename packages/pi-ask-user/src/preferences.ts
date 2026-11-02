import {
	defaultExtensionSettingsPaths,
	readMergedJsonSettingsSection,
	type SettingField,
} from "@hheei/pi-ext-core";
import { SETTINGS_SECTION } from "./constants";
import type { AskDisplayMode, AskParams } from "./schema";
import { ASK_USER_FIELDS } from "./settings-provider";

export { SETTINGS_SECTION };

export interface PromptSettings {
	displayMode: AskDisplayMode;
}

function pickEnum<T extends string>(raw: unknown, field: SettingField<T>): T {
	// ext-core types option values as SettingPrimitive; an enum field only ever lists its own T.
	const matched = field.options?.find((option) => option.value === raw)?.value as T | undefined;
	return matched ?? field.defaultValue;
}

/** Read on every ask_user call so edits apply without restarting Pi. */
async function readAskUserSettings(signal?: AbortSignal): Promise<Record<string, unknown>> {
	const { merged } = await readMergedJsonSettingsSection({
		paths: defaultExtensionSettingsPaths(),
		section: SETTINGS_SECTION,
		...(signal ? { signal } : {}),
	});
	return merged;
}

/** Resolve presentation preferences: call parameter, then the askUser section of ext_settings.json, then the field default. */
export async function resolvePromptSettings(
	params: AskParams,
	signal?: AbortSignal,
): Promise<PromptSettings> {
	const raw = await readAskUserSettings(signal);
	return {
		displayMode: params.displayMode ?? pickEnum(raw.displayMode, ASK_USER_FIELDS.displayMode),
	};
}
