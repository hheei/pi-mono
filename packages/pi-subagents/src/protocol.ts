import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { PROTOCOL_VERSION } from "./domain.js";

/** How many queued child events a parent that stopped reading keeps before the oldest are dropped. */
export const DEFAULT_MAX_BUFFERED_EVENTS = 256;

/**
 * Every operation one end of the bridge may ask of the other. The parent drives the child with the
 * input and state operations; the child returns reports and its Task result as requests, so a
 * report the parent refuses (a second Task result) is refused to the child that sent it.
 */
export const BRIDGE_OPERATIONS = [
	"prompt",
	"steer",
	"abort",
	"get_state",
	"get_entries",
	"session_facts",
	"shutdown",
	"contact_parent",
	"task_result",
] as const;

export type BridgeOperation = (typeof BRIDGE_OPERATIONS)[number];

/** Child-branch event: the child left the bound session, quit, or was interrupted. */
export const CHILD_LIFECYCLE_EVENT = "child_lifecycle" as const;

/** Child-to-parent event: the task child submitted its final result. */

/** Child-to-parent event: input arrived in the child, carrying only where it came from. */
export const CHILD_INPUT_EVENT = "child_input" as const;

export type ChildInputSource = "interactive" | "extension" | "rpc";

/**
 * Transport-level failure with a stable code, shared by both ends of the bridge: the parent sees
 * it when a child call fails, the child sees the code the parent refused a report with.
 */
export class BridgeError extends Error {
	public readonly code: string;

	public constructor(code: string, message: string) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
	}
}

const nonEmptyString = Type.String({ minLength: 1 });

const operationSchema = Type.Union(BRIDGE_OPERATIONS.map((operation) => Type.Literal(operation)));

const identityProperties = {
	parentSessionId: nonEmptyString,
	subagentId: nonEmptyString,
	runtimeIdentity: nonEmptyString,
	endpoint: nonEmptyString,
} as const;

export const HelloFrameSchema = Type.Object(
	{
		version: Type.Literal(PROTOCOL_VERSION),
		type: Type.Literal("hello"),
		role: Type.Optional(Type.Literal("child")),
		...identityProperties,
	},
	{ additionalProperties: false },
);

export const HelloAckFrameSchema = Type.Object(
	{ version: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("hello_ack") },
	{ additionalProperties: false },
);

export const RequestFrameSchema = Type.Object(
	{
		version: Type.Literal(PROTOCOL_VERSION),
		type: Type.Literal("request"),
		id: nonEmptyString,
		operation: operationSchema,
		payload: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);

export const BridgeErrorSchema = Type.Object(
	{ code: nonEmptyString, message: nonEmptyString },
	{ additionalProperties: false },
);

export const ResponseFrameSchema = Type.Union([
	Type.Object(
		{
			version: Type.Literal(PROTOCOL_VERSION),
			type: Type.Literal("response"),
			id: nonEmptyString,
			ok: Type.Literal(true),
			data: Type.Optional(Type.Unknown()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			version: Type.Literal(PROTOCOL_VERSION),
			type: Type.Literal("response"),
			id: nonEmptyString,
			ok: Type.Literal(false),
			error: BridgeErrorSchema,
		},
		{ additionalProperties: false },
	),
]);

export const EventFrameSchema = Type.Object(
	{ version: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("event"), event: Type.Unknown() },
	{ additionalProperties: false },
);

export const ContactReportPayloadSchema = Type.Object(
	{
		type: Type.Literal("pi_subagent_report"),
		parentSessionId: nonEmptyString,
		childId: nonEmptyString,
		runtimeIdentity: nonEmptyString,
		reason: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("blocked")])),
		message: nonEmptyString,
		sessionId: Type.Optional(nonEmptyString),
		/** The compaction this report belongs to, so it settles that operation and no other. */
		controlId: Type.Optional(nonEmptyString),
	},
	{ additionalProperties: false },
);

export const ChildLifecyclePayloadSchema = Type.Object(
	{
		type: Type.Literal("child_lifecycle"),
		parentSessionId: nonEmptyString,
		childId: nonEmptyString,
		runtimeIdentity: nonEmptyString,
		kind: Type.Union([
			Type.Literal("left_session"),
			Type.Literal("tui_quit"),
			Type.Literal("user_interrupt"),
		]),
		sessionId: nonEmptyString,
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/**
 * Only the source of the input, never its text: the parent needs to know a human used the child,
 * and the child's conversation stays in the child.
 */
export const ChildInputPayloadSchema = Type.Object(
	{
		type: Type.Literal(CHILD_INPUT_EVENT),
		parentSessionId: nonEmptyString,
		childId: nonEmptyString,
		runtimeIdentity: nonEmptyString,
		source: Type.Union([
			Type.Literal("interactive"),
			Type.Literal("extension"),
			Type.Literal("rpc"),
		]),
	},
	{ additionalProperties: false },
);

export type HelloFrame = Static<typeof HelloFrameSchema>;
export type HelloAckFrame = Static<typeof HelloAckFrameSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type ContactReportPayload = Static<typeof ContactReportPayloadSchema>;
export type ChildLifecyclePayload = Static<typeof ChildLifecyclePayloadSchema>;
export type ChildInputPayload = Static<typeof ChildInputPayloadSchema>;

export function isHelloFrame(value: unknown): value is HelloFrame {
	return Value.Check(HelloFrameSchema, value);
}

export function isHelloAckFrame(value: unknown): value is HelloAckFrame {
	return Value.Check(HelloAckFrameSchema, value);
}

export function isRequestFrame(value: unknown): value is RequestFrame {
	return Value.Check(RequestFrameSchema, value);
}

export function isContactReportPayload(value: unknown): value is ContactReportPayload {
	return Value.Check(ContactReportPayloadSchema, value);
}

export function isChildLifecyclePayload(value: unknown): value is ChildLifecyclePayload {
	return Value.Check(ChildLifecyclePayloadSchema, value);
}

export function isChildInputPayload(value: unknown): value is ChildInputPayload {
	return Value.Check(ChildInputPayloadSchema, value);
}

export function isResponseFrame(value: unknown): value is ResponseFrame {
	return Value.Check(ResponseFrameSchema, value);
}

export function isEventFrame(value: unknown): value is EventFrame {
	return Value.Check(EventFrameSchema, value);
}

export function successResponse(id: string, data?: unknown): ResponseFrame {
	return {
		version: PROTOCOL_VERSION,
		type: "response",
		id,
		ok: true,
		...(data === undefined ? {} : { data }),
	};
}

export function failureResponse(id: string, code: string, message: string): ResponseFrame {
	return { version: PROTOCOL_VERSION, type: "response", id, ok: false, error: { code, message } };
}

export function eventFrame(event: unknown): EventFrame {
	return { version: PROTOCOL_VERSION, type: "event", event };
}
