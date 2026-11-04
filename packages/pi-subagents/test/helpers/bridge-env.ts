import { afterEach, beforeEach } from "vitest";
import {
	BRIDGE_ENVIRONMENT_KEYS,
	CHILD_AGENT_ENV_KEY,
	CHILD_SESSION_ENV_KEY,
	CHILD_TITLE_ENV_KEY,
} from "../../src/domain.js";

const CHILD_ENVIRONMENT = [
	...Object.values(BRIDGE_ENVIRONMENT_KEYS),
	CHILD_AGENT_ENV_KEY,
	CHILD_SESSION_ENV_KEY,
	CHILD_TITLE_ENV_KEY,
];

/**
 * A developer (or an agent) running this suite from inside a subagent inherits that child's bridge
 * environment, which makes the extension under test register itself as a child. A test of the
 * parent path starts from no inherited identity, exactly as a real parent process does.
 */
export function withoutInheritedChildIdentity(): void {
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of CHILD_ENVIRONMENT) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
	});
}
