import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, splitSubcommand, subcommandCompletions } from "@hheei/pi-ext-core";
import type { GoalCommandCall, GoalController } from "./controller.js";

export const GOAL_COMMAND_NAME = "goal";
export const GOAL_SUBCOMMANDS = ["start", "status", "pause", "resume", "clear"] as const;

export function registerGoalCommands(
	pi: ExtensionAPI,
	controller: () => GoalController | undefined,
): void {
	pi.registerCommand(GOAL_COMMAND_NAME, {
		description: "Start, inspect, pause, resume, or clear the session goal",
		getArgumentCompletions: subcommandCompletions(GOAL_SUBCOMMANDS),
		async handler(args, ctx) {
			const active = controller();
			if (active === undefined) {
				ctx.ui.notify("Goal runtime is not available in this session.", "warning");
				return;
			}
			const { verb, rest } = splitSubcommand(args);
			try {
				await dispatch(active, verb, rest, ctx);
			} catch (error) {
				ctx.ui.notify(`Goal: ${errorMessage(error)}`, "error");
			}
		},
	});
}

async function dispatch(
	active: GoalController,
	verb: string,
	rest: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	switch (verb) {
		case "start":
			await start(active, rest, ctx);
			return;
		case "status":
			ctx.ui.notify(active.statusText(), "info");
			return;
		case "pause": {
			const paused = await active.pause("paused by the user");
			if (!paused) ctx.ui.notify("Goal is not running.", "warning");
			return;
		}
		case "resume":
			ctx.ui.notify(await active.resume(commandCall(ctx)), "info");
			return;
		case "clear":
			ctx.ui.notify(await active.clear(commandCall(ctx)), "info");
			return;
		default:
			ctx.ui.notify("Usage: /goal start [objective] | status | pause | resume | clear", "warning");
	}
}

async function start(
	active: GoalController,
	rest: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const existing = active.document;
	if (
		existing !== undefined &&
		(existing.disposition === "open" || existing.disposition === "blocked")
	) {
		if (!ctx.hasUI)
			throw new Error(
				`Goal ${existing.goalId} is still ${existing.disposition}; clear it before starting another.`,
			);
		const replace = await ctx.ui.confirm(
			"Replace goal?",
			`Goal ${existing.goalId} is ${existing.disposition}. Starting a new goal clears its run.`,
		);
		if (!replace) {
			ctx.ui.notify("Goal start cancelled.", "info");
			return;
		}
	}
	let objective = rest;
	if (objective === "") {
		if (!ctx.hasUI) throw new Error("A goal needs an objective: /goal start <objective>");
		const typed = await ctx.ui.editor("Goal objective");
		if (typed === undefined || typed.trim() === "") {
			ctx.ui.notify("Goal start cancelled.", "info");
			return;
		}
		objective = typed;
	}
	ctx.ui.notify(await active.start(objective, commandCall(ctx)), "info");
}

/** Live context capabilities for one submission: both re-read the session, never a snapshot. */
function commandCall(ctx: ExtensionCommandContext): GoalCommandCall {
	return {
		waitForIdle: () => ctx.waitForIdle(),
		modelReady: () => ctx.model !== undefined,
	};
}
