import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DEFAULT_GOAL_SETTINGS, readGoalSettings } from "../src/settings.js";

const dirs: string[] = [];

function settingsFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-settings-"));
	dirs.push(dir);
	const path = join(dir, "ext_settings.json");
	writeFileSync(path, content);
	return path;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("goal settings", () => {
	test("a missing file keeps the documented defaults, including review off", () => {
		const path = join(tmpdir(), "pi-goal-missing", "ext_settings.json");
		expect(readGoalSettings(path)).toEqual(DEFAULT_GOAL_SETTINGS);
	});

	test("an explicit group overrides the defaults", () => {
		const path = settingsFile(
			JSON.stringify({
				goal: { review: true, continuations: 2, reviews: 4, reviewAgent: "  strict  " },
			}),
		);
		expect(readGoalSettings(path)).toEqual({
			review: true,
			continuations: 2,
			reviews: 4,
			reviewAgent: "strict",
		});
	});

	test("a malformed file or field is an error, never a silent review=false", () => {
		expect(() => readGoalSettings(settingsFile("not json"))).toThrow("not valid JSON");
		expect(() => readGoalSettings(settingsFile("[]"))).toThrow("JSON object");
		expect(() => readGoalSettings(settingsFile(JSON.stringify({ goal: [] })))).toThrow(
			"must be a JSON object",
		);
		expect(() =>
			readGoalSettings(settingsFile(JSON.stringify({ goal: { review: "yes" } }))),
		).toThrow("goal.review must be true or false");
		expect(() =>
			readGoalSettings(settingsFile(JSON.stringify({ goal: { reviewAgent: "" } }))),
		).toThrow("goal.reviewAgent");
		expect(() =>
			readGoalSettings(settingsFile(JSON.stringify({ goal: { continuations: -1 } }))),
		).toThrow("goal.continuations");
	});
});
