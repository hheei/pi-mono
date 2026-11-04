import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function reconcileAskUserTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return;
	}
	const active = pi.getActiveTools();
	const hasTool = active.includes("ask_user");
	if (!ctx.hasUI && hasTool) {
		pi.setActiveTools(active.filter((t) => t !== "ask_user"));
	} else if (ctx.hasUI && !hasTool) {
		pi.setActiveTools([...active, "ask_user"]);
	}
}
