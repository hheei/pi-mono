import {
	createJsonSettingsStorage,
	type SettingChange,
	type SettingsProvider,
	type SettingsState,
} from "@hheei/pi-ext-core";

const GROUP = "toolGroups";
const FIELD = "enabled";
const BACKGROUNDS = "toolBackgrounds";
const COPY_CONTROL = "copyControl";

/** Missing or non-boolean values stay on; only an explicit false disables groups. */
export function activityGroupsEnabled(state: SettingsState | undefined): boolean {
	const value = state?.[GROUP]?.[FIELD];
	return value !== false;
}

/** Off by default: a tool row only paints Pi's own surface when the reader asks for it. */
export function toolBackgroundsEnabled(state: SettingsState | undefined): boolean {
	return state?.[GROUP]?.[BACKGROUNDS] === true;
}

/** Missing or non-boolean values keep the control; only an explicit false removes it. */
export function toolCopyControlEnabled(state: SettingsState | undefined): boolean {
	return state?.[GROUP]?.[COPY_CONTROL] !== false;
}

export function createToolGroupSettings(options: {
	readonly onEnabled: (enabled: boolean) => void;
	readonly onBackgrounds: (enabled: boolean) => void;
	readonly onCopyControl: (enabled: boolean) => void;
}): SettingsProvider {
	return {
		id: "pi-ext-ui",
		title: "Tool UI",
		origin: "@hheei/pi-ext-ui",
		groups: [
			{
				id: GROUP,
				title: "Tool activity",
				fields: [
					{
						id: FIELD,
						label: "Activity groups",
						type: "boolean",
						defaultValue: true,
						description:
							"Group consecutive tool, thinking, and notification rows in the TUI transcript.",
						parse: (draft) => draft === "true",
					},
					{
						id: BACKGROUNDS,
						label: "Tool backgrounds",
						type: "boolean",
						defaultValue: false,
						description:
							"Paint each tool with Pi's own success/error surface, one padding row above and below, and no leading rail. The activity group then stays transparent.",
						parse: (draft) => draft === "true",
					},
					{
						id: COPY_CONTROL,
						label: "Copy button",
						type: "boolean",
						defaultValue: true,
						description:
							"Show the copy control on tool rows and the shift+click hint for omitted output. Off leaves the rows clean and nothing to copy with the mouse.",
						parse: (draft) => draft === "true",
					},
				],
			},
		],
		storage: createJsonSettingsStorage({ group: GROUP }),
		onChange(change: SettingChange): void {
			if (change.groupId !== GROUP) return;
			if (change.fieldId === FIELD) options.onEnabled(change.value === true);
			if (change.fieldId === BACKGROUNDS) options.onBackgrounds(change.value === true);
			if (change.fieldId === COPY_CONTROL) options.onCopyControl(change.value === true);
		},
	};
}
