import { readFileSync } from "node:fs";
import {
	createJsonSettingsStorage,
	defaultExtensionSettingsPaths,
	isRecord,
	type SettingsProvider,
} from "@hheei/pi-ext-core";

/** One settings group owns every goal default; goals snapshot the values they were started with. */
export const GOAL_SETTINGS_GROUP = "goal";

export interface GoalSettings {
	readonly review: boolean;
	readonly continuations: number;
	readonly reviews: number;
	readonly reviewAgent: string;
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
	review: false,
	continuations: 8,
	reviews: 3,
	reviewAgent: "reviewer",
};

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function countAt(fields: Record<string, unknown>, key: string, fallback: number): number {
	const value = fields[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error(`goal.${key} must be a non-negative whole number`);
	return value;
}

/**
 * Reads the goal defaults synchronously: `/goal start` needs them before any async settings load.
 * A missing file means defaults; a file that cannot be read, parsed, or validated throws so an
 * explicit independent-review policy is never silently replaced by review=false.
 */
export function readGoalSettings(path?: string): GoalSettings {
	const file = path ?? defaultExtensionSettingsPaths().globalPath;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return DEFAULT_GOAL_SETTINGS;
		throw new Error(`Goal settings could not be read from ${file}`);
	}
	let root: unknown;
	try {
		root = JSON.parse(raw);
	} catch {
		throw new Error(`Goal settings file ${file} is not valid JSON`);
	}
	if (!isRecord(root)) throw new Error(`Goal settings file ${file} must contain a JSON object`);
	const group = root[GOAL_SETTINGS_GROUP];
	if (group === undefined) return DEFAULT_GOAL_SETTINGS;
	if (!isRecord(group))
		throw new Error(`Goal settings group "${GOAL_SETTINGS_GROUP}" must be a JSON object`);
	const review = group.review;
	if (review !== undefined && typeof review !== "boolean")
		throw new Error("goal.review must be true or false");
	const agent = group.reviewAgent;
	if (agent !== undefined && (typeof agent !== "string" || agent.trim() === ""))
		throw new Error("goal.reviewAgent must be a non-empty string");
	return {
		review: review ?? DEFAULT_GOAL_SETTINGS.review,
		continuations: countAt(group, "continuations", DEFAULT_GOAL_SETTINGS.continuations),
		reviews: countAt(group, "reviews", DEFAULT_GOAL_SETTINGS.reviews),
		reviewAgent: agent?.trim() ?? DEFAULT_GOAL_SETTINGS.reviewAgent,
	};
}

export interface GoalSettingsProviderOptions {
	readonly path?: string;
}

/** Registers the `goal` group so `@hheei/pi-settings` can edit the same file this reader uses. */
export function createGoalSettingsProvider(
	options: GoalSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-goal",
		title: "Goal",
		origin: "@hheei/pi-goal",
		description: "Defaults projected into each goal when it starts.",
		groups: [
			{
				id: GOAL_SETTINGS_GROUP,
				title: "",
				fields: [
					{
						id: "review",
						label: "Independent review",
						type: "boolean",
						defaultValue: DEFAULT_GOAL_SETTINGS.review,
						description:
							"Require an owned pi-subagents reviewer to approve completion. Applied when a goal starts; an active goal keeps the mode it was started with.",
						parse: (value) => value.trim().toLowerCase() === "true",
					},
					{
						id: "continuations",
						label: "Continuation budget",
						type: "number",
						defaultValue: DEFAULT_GOAL_SETTINGS.continuations,
						description:
							"Autonomous parent continuations allowed per goal. Resume never refills it.",
						parse: (value) => Number(value),
						validate: (value) =>
							typeof value !== "number" || !Number.isInteger(value) || value < 0
								? "Continuation budget must be a non-negative whole number"
								: undefined,
					},
					{
						id: "reviews",
						label: "Review attempts",
						type: "number",
						defaultValue: DEFAULT_GOAL_SETTINGS.reviews,
						description: "Review attempts allowed per goal. A failed dispatch still counts.",
						parse: (value) => Number(value),
						validate: (value) =>
							typeof value !== "number" || !Number.isInteger(value) || value < 0
								? "Review attempts must be a non-negative whole number"
								: undefined,
					},
					{
						id: "reviewAgent",
						label: "Review agent",
						type: "text",
						defaultValue: DEFAULT_GOAL_SETTINGS.reviewAgent,
						description: "pi-subagents agent definition used for the independent review.",
						parse: (value) => value.trim(),
						validate: (value) =>
							typeof value !== "string" || value.trim() === ""
								? "Review agent must not be empty"
								: undefined,
					},
				],
			},
		],
		storage: createJsonSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			group: GOAL_SETTINGS_GROUP,
		}),
	};
}
