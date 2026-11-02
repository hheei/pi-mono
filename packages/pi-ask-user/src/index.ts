import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./tool";

export default function askUser(pi: ExtensionAPI): void {
	registerAskUserTool(pi);
}
