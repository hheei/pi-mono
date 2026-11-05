import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	getBackgroundDelivery,
	getRuntimeSettingsRegistry,
	getService,
	registerExtensionLifecycle,
	registerSettings,
	setPromptSection,
} from "@hheei/pi-ext-core";
import { SUBAGENT_OWNERSHIP_SERVICE } from "@hheei/pi-subagents/ownership";
import { registerGoalCommands } from "./commands.js";
import { GoalController, type GoalDelivery, type GoalHost } from "./controller.js";
import {
	GOAL_ENTRY_TYPE,
	GOAL_KICKOFF_MESSAGE_TYPE,
	GOAL_REVIEW_MESSAGE_TYPE,
	SUBAGENT_CHILD_SESSION_ENV,
} from "./document.js";
import { renderGoalEntry } from "./format.js";
import { createGoalSettingsProvider, readGoalSettings } from "./settings.js";
import { GOAL_TOOL_NAME, registerGoalTool } from "./tool.js";

/**
 * One extension entry. Registration that Pi cannot undo (tool, command, entry renderer) happens
 * once; session-scoped hooks and the live controller are recreated by the lifecycle.
 */
export default function piGoalExtension(pi: ExtensionAPI): void {
	// A pi-subagents child session runs the same extensions; it must never bootstrap a goal runtime.
	if (process.env[SUBAGENT_CHILD_SESSION_ENV] !== undefined) return;

	let active: GoalController | undefined;

	registerGoalTool(pi, () => active);
	registerGoalCommands(pi, () => active);
	pi.registerEntryRenderer(GOAL_ENTRY_TYPE, renderGoalEntry);

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-goal",
		async start(runtime) {
			const context = runtime.extension;
			const sessionManager = context.sessionManager;
			runtime.resources.add(
				"goal-settings",
				registerSettings(createGoalSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);

			// Run-bound deliveries: the channel validates the run again at flush time, so a kickoff or
			// reviewer feedback that outlived its run is dropped instead of waking the parent.
			let held: GoalDelivery[] = [];
			let requestDelivery = (): void => {};
			let controller: GoalController | undefined;
			// Drop deliveries that no longer belong to the live run before the coordinator decides who
			// sends the final wakeup; otherwise a stale Goal item makes a real producer silent.
			const liveDeliveries = (): GoalDelivery[] => {
				if (runtime.signal.aborted) return [];
				const live = held.filter((delivery) => controller?.deliveryText(delivery) !== undefined);
				if (live.length !== held.length) held = live;
				return live;
			};
			const registration = getBackgroundDelivery(pi).registerChannel({
				isIdle: () => context.isIdle(),
				hasPending: () => liveDeliveries().length > 0,
				flush(triggerTurn) {
					// Goal messages must never enter Pi's native follow-up queue: a paused or replaced
					// run would leave a stale wakeup behind. Keep them held until the session is idle and
					// request another flush when the current operation settles. One message per flush
					// means a send that starts a turn cannot cause the next message to be queued.
					if (!context.isIdle()) return;
					const delivery = held.shift();
					if (delivery === undefined) return;
					const text = controller?.deliveryText(delivery);
					if (text === undefined) {
						context.ui.notify(
							"Dropped a stale goal delivery: its run, revision, or review attempt is no longer current.",
							"warning",
						);
						if (held.length > 0) requestDelivery();
						return;
					}
					try {
						pi.sendMessage(
							{
								customType:
									delivery.kind === "kickoff"
										? GOAL_KICKOFF_MESSAGE_TYPE
										: GOAL_REVIEW_MESSAGE_TYPE,
								content: text,
								display: true,
								details: {
									kind: delivery.kind,
									goalId: delivery.goalId,
									runId: delivery.runId,
									definitionRevision: delivery.definitionRevision,
									...(delivery.kind === "feedback" ? { attempt: delivery.attempt } : {}),
								},
							},
							{ triggerTurn, deliverAs: "followUp" },
						);
					} catch (error) {
						context.ui.notify(`Goal delivery failed: ${errorMessage(error)}`, "error");
					}
					if (held.length > 0) requestDelivery();
				},
			});
			requestDelivery = () => registration.request();
			runtime.resources.add("goal-delivery", () => registration.dispose());

			const host: GoalHost = {
				sessionId: sessionManager.getSessionId(),
				settings: () => readGoalSettings(),
				append: (goal) => pi.appendEntry(GOAL_ENTRY_TYPE, goal),
				branch: () => sessionManager.getBranch(),
				durable: () => {
					const file = sessionManager.getSessionFile();
					return file !== undefined && existsSync(file);
				},
				notify: (message, level) => context.ui.notify(message, level),
				deliver: (delivery) => {
					if (runtime.signal.aborted) return;
					held.push(delivery);
					requestDelivery();
				},
				setGoalToolActive: (wanted) => setGoalToolActive(pi, wanted),
				ownership: () => getService(pi, SUBAGENT_OWNERSHIP_SERVICE),
				abort: () => context.abort(),
				now: () => new Date(),
			};
			const created = new GoalController(host);
			controller = created;
			active = created;
			await created.restore();
			await created.retryCleanup();
			const unsubscribers = [
				pi.on("agent_start", () => created.handleAgentStart()),
				pi.on("agent_before_settle", (event) => created.handleBoundary(event)),
				pi.on("agent_settled", async (event) => {
					await created.handleSettled(event.aborted);
					requestDelivery();
				}),
				pi.on("session_before_tree", async () => {
					await created.beginBranchNavigation("paused before tree navigation");
				}),
				pi.on("session_tree", async () => {
					await created.restore();
					await created.retryCleanup();
				}),
				pi.on("session_before_switch", async () => {
					await created.suspend("paused before a session switch");
				}),
				pi.on("session_before_fork", async () => {
					await created.suspend("paused before a fork");
				}),
				pi.on("before_agent_start", (event) => {
					created.handleBeforeAgentStart(event);
					setPromptSection(event.systemPromptOptions.sections, "goal", created.promptSection());
				}),
			];
			runtime.resources.add("goal-events", () => {
				for (const off of unsubscribers) off();
			});
			runtime.resources.add("goal-runtime", async () => {
				if (active === created) active = undefined;
				await created.dispose("session shutdown");
			});
		},
	});
}

function setGoalToolActive(pi: ExtensionAPI, wanted: boolean): void {
	const names = pi.getActiveTools();
	const present = names.includes(GOAL_TOOL_NAME);
	if (wanted === present) return;
	pi.setActiveTools(
		wanted ? [...names, GOAL_TOOL_NAME] : names.filter((name) => name !== GOAL_TOOL_NAME),
	);
}
