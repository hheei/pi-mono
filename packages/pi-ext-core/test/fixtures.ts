import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionEvent = "session_start" | "session_shutdown";
type SessionHandler = (event: unknown, context: ExtensionContext) => void | Promise<void>;

export interface FakePiHost {
	readonly pi: ExtensionAPI;
	emit(type: SessionEvent, event?: Record<string, unknown>): Promise<void>;
}

export function createFakePiHost(): FakePiHost {
	const handlers = new Map<SessionEvent, SessionHandler[]>();
	const events = {};
	const pi = {
		events,
		on(event: SessionEvent, handler: SessionHandler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	const context = {
		sessionManager: { getSessionId: () => "test-session" },
	} as unknown as ExtensionContext;

	return {
		pi,
		async emit(type: SessionEvent, event: Record<string, unknown> = {}): Promise<void> {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
		},
	};
}
