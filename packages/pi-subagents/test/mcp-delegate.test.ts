import { describe, expect, test } from "vitest";
import { delegateToolMetadata, parseDelegateInput } from "../src/mcp/delegate.js";

describe("delegate MCP input", () => {
	test("accepts an agent for a new child", () => {
		expect(parseDelegateInput({ agent: "worker", task: "Implement feature" })).toEqual({
			agent: "worker",
			task: "Implement feature",
		});
	});

	test.each(["", " \t\n"])("accepts blank id %j for a new child", (id) => {
		expect(parseDelegateInput({ id, agent: "worker", task: "Work" })).toEqual({
			id,
			agent: "worker",
			task: "Work",
		});
		expect(() => parseDelegateInput({ id, task: "Work" })).toThrow(/Agent/);
		expect(() => parseDelegateInput({ id, agent: " ", task: "Work" })).toThrow(/Agent/);
	});

	test("describes omitted or empty id as creation, never an invented id", () => {
		expect(delegateToolMetadata.description).toContain('omit id or pass id: ""');
		expect(delegateToolMetadata.description).toContain("never invent an id");
	});

	test("accepts an existing child id without an agent", () => {
		expect(parseDelegateInput({ id: "agent-21", task: "Continue tests" })).toEqual({
			id: "agent-21",
			task: "Continue tests",
		});
	});

	test("allows id and agent together so the manager can silently ignore agent", () => {
		expect(
			parseDelegateInput({
				id: "agent-21",
				agent: "reviewer",
				task: "Continue tests",
			}),
		).toEqual({ id: "agent-21", agent: "reviewer", task: "Continue tests" });
		expect(delegateToolMetadata.name).toBe("delegate");
	});

	test("supports detached delegations without separate spawn/send tools", () => {
		expect(parseDelegateInput({ id: "agent-21", task: "Continue tests", wait: false })).toEqual({
			id: "agent-21",
			task: "Continue tests",
			wait: false,
		});
		expect(() => parseDelegateInput({ id: "agent-21", task: "Continue", wait: "false" })).toThrow();
	});

	test("rejects invalid boundary inputs and unexpected fields", () => {
		expect(() => parseDelegateInput({ id: "agent-21", task: 123 })).toThrow();
		expect(() => parseDelegateInput({ id: "agent-21", task: "Continue", extra: true })).toThrow();
		expect(() => parseDelegateInput({ agent: "worker", task: "" })).toThrow();
		expect(() => parseDelegateInput({ agent: "worker", task: "  " })).toThrow(/Task/);
		expect(() =>
			parseDelegateInput({ agent: "worker", task: "<hindsight-recall>context</hindsight-recall>" }),
		).toThrow(/Task/);
		expect(() => parseDelegateInput({ task: "Work" })).toThrow(/Agent/);
		expect(() => parseDelegateInput({ agent: "  ", task: "Work" })).toThrow(/Agent/);
		expect(parseDelegateInput({ id: "agent-21", agent: "", task: "Work" })).toEqual({
			id: "agent-21",
			agent: "",
			task: "Work",
		});
	});
});
