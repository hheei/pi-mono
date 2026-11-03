import {
	AssistantMessageComponent,
	type ExtensionContext,
	type ExtensionUIContext,
	InteractiveMode,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { MessageView } from "./message-view.js";
import {
	type Member,
	memberParts,
	type RequestFact,
	TailUnit,
	type ToolGroupClock,
	ToolGroupView,
	type Usage,
} from "./tool-group-view.js";
import { type ToolStatusKind, ToolView, toSingleRow } from "./tool-view.js";

const SEAMS = ["getRegisteredToolDefinition", "showExtensionNotify"] as const;
type Seam = (typeof SEAMS)[number];
type NoticeType = "info" | "warning" | "error";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface Host {
	readonly chat: Container;
	readonly ui: ExtensionUIContext;
	readonly requestRender: () => void;
}

// Audited Pi >=1.5.0 compiles these TS-private members to ordinary JS properties.
// All host-private access stays here.
function readHost(value: unknown): Host {
	if (!record(value)) throw new Error("Invalid InteractiveMode instance");
	const chat = value.chatContainer;
	const session: unknown = value.session;
	const tui: unknown = value.ui;
	if (!record(session) || !record(tui) || typeof tui.requestRender !== "function") {
		throw new Error("Pi host session/TUI shape changed");
	}
	const runner: unknown = session.extensionRunner;
	if (
		!(chat instanceof Container) ||
		!record(runner) ||
		typeof runner.getUIContext !== "function"
	) {
		throw new Error("Pi host transcript/runner shape changed");
	}
	const ui: ExtensionUIContext = runner.getUIContext();
	const requestRender = tui.requestRender;
	return { chat, ui, requestRender: () => requestRender.call(tui) };
}

function readUsage(value: unknown): Usage | undefined {
	if (!record(value)) return undefined;
	const { input, output, cacheRead, cacheWrite } = value;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		typeof cacheRead !== "number" ||
		typeof cacheWrite !== "number"
	)
		return undefined;
	return { input, output, cacheRead, cacheWrite };
}

function assistantInfo(component: AssistantMessageComponent): {
	calls: Set<string>;
	eligible: boolean;
	thinking: string;
	hidden: boolean;
	usage: Usage | undefined;
} {
	const message: unknown = Reflect.get(component, "lastMessage");
	if (!record(message) || !Array.isArray(message.content)) {
		throw new Error("Pi assistant message shape changed");
	}
	const hidden: unknown = Reflect.get(component, "hideThinkingBlock");
	const calls = new Set<string>();
	let eligible = !["length", "aborted", "error"].includes(String(message.stopReason));
	const thinking: string[] = [];
	for (const block of message.content) {
		if (!record(block)) throw new Error("Pi assistant content shape changed");
		if (block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
		else if (block.type === "thinking" && typeof block.thinking === "string") {
			// Pi joins a thinking run with blank lines; the same separator keeps paragraphs readable here.
			const text = block.thinking.trim();
			if (text !== "") thinking.push(text);
		} else if (block.type !== "text" || typeof block.text !== "string" || block.text.trim() !== "")
			eligible = false;
	}
	return {
		calls,
		eligible,
		thinking: thinking.join("\n\n"),
		hidden: hidden === true,
		usage: readUsage(message.usage),
	};
}

function toolMember(component: ToolExecutionComponent, calls: Set<string>): Member | undefined {
	const id: unknown = Reflect.get(component, "toolCallId");
	const name: unknown = Reflect.get(component, "toolName");
	const partial: unknown = Reflect.get(component, "isPartial");
	const complete: unknown = Reflect.get(component, "argsComplete");
	const result: unknown = Reflect.get(component, "result");
	const renderer: unknown = Reflect.get(component, "resultRendererComponent");
	const callRenderer: unknown = Reflect.get(component, "callRendererComponent");
	if (
		typeof id !== "string" ||
		typeof name !== "string" ||
		typeof partial !== "boolean" ||
		typeof complete !== "boolean"
	) {
		throw new Error("Pi tool component shape changed");
	}
	if (!calls.has(id) || !(callRenderer instanceof ToolView)) return undefined;
	if (
		result !== undefined &&
		(!record(result) ||
			!Array.isArray(result.content) ||
			!result.content.every((block: unknown) => record(block) && block.type === "text") ||
			!(renderer instanceof ToolView))
	)
		return undefined;
	// The visible view decides the facts: a hidden call renderer reports no summary of its own.
	const view = renderer instanceof ToolView ? renderer : callRenderer;
	if (view.summary === undefined) return undefined;
	const status: ToolStatusKind = !complete
		? "streaming"
		: partial
			? "running"
			: record(result) && result.isError === true
				? "error"
				: "ok";
	const children = view.children;
	return {
		kind: "tool",
		component,
		title: toSingleRow(stripTerminalSequences(name)),
		status,
		// The host keeps isPartial true until it stores a final result; argsComplete alone is not
		// completion, and restored history never sets it. The result is the observed end fact.
		completed: !partial && result !== undefined,
		...(children === undefined || children.length === 0 ? {} : { children }),
		...(view.childCount === undefined ? {} : { childCount: view.childCount }),
	};
}

function messageView(component: Component): MessageView | undefined {
	if (component instanceof MessageView) return component;
	if (!(component instanceof Container)) return undefined;
	for (const child of component.children) if (child instanceof MessageView) return child;
	return undefined;
}

/** Shared transcript notices stay in the group. The frame is the contract, not each custom type. */
function noticeMember(component: Component): Member | undefined {
	const view = messageView(component);
	if (view === undefined) return undefined;
	return {
		kind: "notice",
		component,
		title: view.kind,
		summary: view.activitySummary,
		// Preview is visible content; only a real body opens. A preview-only notice therefore never
		// grows a second expansion level, and the notice lays out both blocks itself.
		content: (width) => view.previewRows(width),
		...(view.expandable ? { detail: (width: number) => view.bodyRows(width) } : {}),
	};
}

/**
 * A captured `ui.notify`. It owns its content: one indented, width-wrapped block with the notice's
 * semantic color. The group draws these rows once, so a plain notice has no expansion of its own.
 */
class NotifyView implements Component {
	readonly #text = new Text("", 0, 0);
	readonly #ui: ExtensionUIContext;
	readonly #outputPad: () => number;
	readonly #message: string;
	readonly #type: NoticeType;

	constructor(message: string, type: NoticeType, ui: ExtensionUIContext, outputPad: () => number) {
		this.#ui = ui;
		this.#outputPad = outputPad;
		this.#message = message;
		this.#type = type;
	}

	get member(): Member {
		return {
			kind: "notice",
			component: this,
			title: this.#type,
			content: (width) => this.rows(width),
		};
	}

	/** The notice body as it appears both in the transcript and inside the activity group. */
	rows(width: number): string[] {
		// The pad setting can change while a notice is on screen, so it is read per render.
		this.#text.setPaddingX(this.#outputPad());
		// info is the terminal's own readable text; a warning or error keeps its status token and
		// its written prefix, so the level never depends on color alone.
		this.#text.setText(
			this.#ui.theme.fg(this.#type === "info" ? "text" : this.#type, this.#content),
		);
		return this.#text.render(width);
	}

	get #content(): string {
		const prefix = this.#type === "error" ? "Error: " : this.#type === "warning" ? "Warning: " : "";
		return `${prefix}${this.#message}`;
	}

	render(width: number): string[] {
		return ["", ...this.rows(width)];
	}

	invalidate(): void {
		this.#text.invalidate();
	}
}

interface RunBox {
	/** Components first observed during a live loop distinguish live blocks from restored history. */
	current?: { readonly run: { endedAt?: number } } | undefined;
	/** Presence marks observation; undefined identifies history observed outside a live run. */
	readonly observed: WeakMap<
		Component,
		{ readonly at: number; readonly run: { endedAt?: number } } | undefined
	>;
	/** A component keeps the clock of its continuous block across transcript rebuilds. */
	readonly clocks: WeakMap<Component, ToolGroupClock>;
	readonly activeClocks: Set<ToolGroupClock>;
}

interface Attachment {
	dispose(): void;
	notify(message: string, type: NoticeType): boolean;
	/** Claim every transcript component that first appeared during the measured run. */
	observe(): void;
}

function attach(
	host: Host,
	run: RunBox,
	background: () => boolean,
	outputPad: () => number,
): Attachment {
	const chat = host.chat;
	const original = {
		render: chat.render,
		handleMouse: chat.handleMouse,
		invalidate: chat.invalidate,
	};
	const descriptors = Object.getOwnPropertyDescriptors(chat);
	for (const key of ["render", "handleMouse", "invalidate"]) {
		const descriptor = descriptors[key];
		if (descriptor !== undefined && descriptor.writable !== true) {
			throw new Error(`Pi transcript ${key} cannot be replaced`);
		}
	}
	if (!Object.isExtensible(chat)) throw new Error("Pi transcript cannot accept instance methods");
	const projection = new Container();
	let groups = new Map<Component, ToolGroupView>();
	let active = true;
	const disposeGroups = (): void => {
		for (const group of groups.values()) group.dispose();
		groups.clear();
	};
	/**
	 * Record first observation time for new components during a live loop. Restored history stays
	 * unknown until live content joins its block.
	 */
	const claim = (child: Component): void => {
		if (run.observed.has(child)) return;
		const current = run.current;
		run.observed.set(
			child,
			current !== undefined && current.run.endedAt === undefined
				? { at: performance.now(), run: current.run }
				: undefined,
		);
	};
	const observe = (): void => {
		for (const child of chat.children) claim(child);
	};
	/** Create or recover one clock for each live continuous block. */
	const clockOf = (members: readonly Member[], endedAt?: number): ToolGroupClock | undefined => {
		const parts = members.flatMap(memberParts);
		let clock: ToolGroupClock | undefined;
		for (const part of parts) {
			clock = run.clocks.get(part);
			if (clock !== undefined) break;
		}
		if (clock === undefined) {
			const origin = parts
				.map((part) => run.observed.get(part))
				.find((value) => value !== undefined);
			if (origin === undefined) return undefined;
			clock = { startedAt: origin.at };
			if (origin.run.endedAt !== undefined) clock.endedAt = origin.run.endedAt;
			else run.activeClocks.add(clock);
		}
		if (endedAt !== undefined && clock.endedAt === undefined) {
			clock.endedAt = endedAt;
			run.activeClocks.delete(clock);
		}
		for (const part of parts) if (run.clocks.get(part) === undefined) run.clocks.set(part, clock);
		return clock;
	};
	const rebuild = () => {
		const next = new Map<Component, ToolGroupView>();
		const children: Component[] = [];
		const blocks: {
			group: ToolGroupView;
			members: Member[];
			tail: Member | undefined;
			requests: readonly RequestFact[];
			clock: ToolGroupClock | undefined;
		}[] = [];
		let calls = new Set<string>();
		let members: Member[] = [];
		/** Every request this pending block owns, in transcript order, whether or not it is displayed. */
		let requests: RequestFact[] = [];
		/**
		 * Closes the pending block. `ended` is false only for the block still open at the transcript tail:
		 * that one keeps its last visible unit outside the group, and its facts still count here.
		 */
		const flush = (ended: boolean, boundary?: Component) => {
			const first = members[0]?.component;
			// Empty assistant/tool-call placeholders do not replace the last visible tail.
			const tail = ended
				? undefined
				: [...members]
						.reverse()
						.find(
							(member) =>
								member.kind !== "thinking" ||
								(member.thinking !== undefined && member.thinking !== ""),
						);
			const inside = members.filter((member) => member !== tail);
			let weight = 0;
			for (const member of members) {
				if (member.kind === "tool") weight += 1;
				else if (
					member.kind === "notice" ||
					(member.thinking !== undefined && member.thinking !== "")
				)
					weight += 0.5;
			}
			if (first !== undefined && weight >= 2) {
				const group =
					groups.get(first) ??
					new ToolGroupView(host.ui, host.requestRender, background, outputPad);
				const boundaryTime =
					ended && boundary !== undefined
						? (run.observed.get(boundary)?.at ?? performance.now())
						: undefined;
				const clock = clockOf(members, boundaryTime);
				blocks.push({ group, members: inside, tail, requests, clock });
				next.set(first, group);
				children.push(group);
			} else children.push(...inside.flatMap(memberParts));
			if (tail !== undefined) children.push(new TailUnit(tail, background));
			members = [];
			requests = [];
		};
		for (const child of chat.children) {
			claim(child);
			if (child instanceof AssistantMessageComponent) {
				const info = assistantInfo(child);
				calls = info.calls;
				// The request belongs to the block whose work it answers, even when its text is native
				// content the aggregate never shows.
				requests.push(info.usage === undefined ? {} : { usage: info.usage });
				if (info.eligible) {
					const thinking = info.thinking;
					const previous = members.at(-1);
					if (thinking !== "" && previous?.kind === "thinking") {
						// One continuous run: consecutive thinking blocks are one item, paragraphs kept.
						members[members.length - 1] = {
							...previous,
							thinking: `${previous.thinking ?? ""}\n\n${thinking}`,
							parts: [...memberParts(previous), child],
							...(previous.thinkingHidden === true || info.hidden ? { thinkingHidden: true } : {}),
						};
					} else {
						members.push({
							kind: "thinking",
							component: child,
							// The host's hide setting is a display preference, not a content filter: the text
							// stays available to the group's preview and expansion, and is never written back.
							...(thinking === ""
								? {}
								: { thinking, ...(info.hidden ? { thinkingHidden: true } : {}) }),
						});
					}
					continue;
				}
			} else if (child instanceof ToolExecutionComponent) {
				const member = toolMember(child, calls);
				if (member !== undefined) {
					members.push(member);
					continue;
				}
			} else if (child instanceof NotifyView) {
				members.push(child.member);
				continue;
			} else {
				const continuation = noticeMember(child);
				if (continuation !== undefined) {
					members.push(continuation);
					continue;
				}
			}
			flush(true, child);
			children.push(child);
		}
		flush(false);
		for (const block of blocks) {
			block.group.update(block.members, block.tail, block.requests, block.clock);
		}
		// A block the new projection does not reuse is gone: its hold timer must go with it.
		for (const [key, group] of groups) {
			if (next.get(key) !== group) group.dispose();
		}
		groups = next;
		projection.children = children;
	};
	const wrappers = {
		render(width: number): string[] {
			if (!active) return original.render.call(chat, width);
			try {
				rebuild();
			} catch (error) {
				active = false;
				disposeGroups();
				projection.clear();
				host.ui.notify(
					`Tool grouping disabled: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return original.render.call(chat, width);
			}
			// Real renderer errors propagate; never hide a tool-rendering failure.
			return projection.render(width);
		},
		handleMouse(event: Parameters<Container["handleMouse"]>[0]) {
			return active ? projection.handleMouse(event) : original.handleMouse.call(chat, event);
		},
		invalidate() {
			original.invalidate.call(chat);
			for (const group of groups.values()) group.invalidate();
		},
	};
	Object.assign(chat, wrappers);
	host.requestRender();
	let disposed = false;
	return {
		notify(message, type) {
			if (!active) return false;
			chat.addChild(new NotifyView(message, type, host.ui, outputPad));
			host.requestRender();
			return true;
		},
		observe,
		dispose() {
			if (disposed) return;
			disposed = true;
			active = false;
			disposeGroups();
			projection.clear();
			let conflict = false;
			for (const key of ["render", "handleMouse", "invalidate"] as const) {
				if (chat[key] !== wrappers[key]) {
					conflict = true;
					continue;
				}
				const descriptor = descriptors[key];
				if (descriptor === undefined) Reflect.deleteProperty(chat, key);
				else Object.defineProperty(chat, key, descriptor);
			}
			if (conflict)
				host.ui.notify(
					"Tool grouping patch changed by another extension; restart Pi to fully unload it.",
					"warning",
				);
			host.requestRender();
		},
	};
}

interface Owner {
	readonly ui: ExtensionUIContext;
	readonly hosts: Map<Container, Attachment & { requestRender(): void }>;
	readonly attach: (host: Host) => Attachment;
	readonly failed: WeakSet<Container>;
}

function connect(owner: Owner, host: Host): void {
	if (owner.hosts.has(host.chat) || owner.failed.has(host.chat)) return;
	try {
		owner.hosts.set(host.chat, { ...owner.attach(host), requestRender: host.requestRender });
	} catch (error) {
		owner.failed.add(host.chat);
		owner.ui.notify(
			`Tool grouping unavailable: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

interface PatchState {
	readonly owners: Map<ExtensionUIContext, Owner>;
	readonly hosts: Set<WeakRef<object>>;
	readonly originals: Record<Seam, PropertyDescriptor>;
	readonly wrappers: {
		getRegisteredToolDefinition(this: unknown, name: string): unknown;
		showExtensionNotify(this: unknown, message: string, type?: NoticeType): unknown;
	};
}

function patchState(): PatchState {
	const prototype = InteractiveMode.prototype;
	const key = Symbol.for("@hheei/pi-ext-ui/host-tool-groups/2");
	const existing = Reflect.get(prototype, key) as PatchState | undefined;
	if (existing !== undefined) {
		if (
			!record(existing) ||
			!(existing.owners instanceof Map) ||
			!(existing.hosts instanceof Set) ||
			!record(existing.originals) ||
			!record(existing.wrappers) ||
			SEAMS.some(
				(seam) =>
					!record(existing.originals[seam]) || typeof existing.wrappers[seam] !== "function",
			)
		)
			throw new Error("Invalid tool grouping patch owner");
		return existing;
	}
	const lookup = Object.getOwnPropertyDescriptor(prototype, SEAMS[0]);
	const notify = Object.getOwnPropertyDescriptor(prototype, SEAMS[1]);
	if (
		typeof lookup?.value !== "function" ||
		!lookup.writable ||
		lookup.value.length !== 1 ||
		typeof notify?.value !== "function" ||
		!notify.writable ||
		notify.value.length !== 2
	)
		throw new Error("Pi tool/notification seam changed or is already patched");
	const owners = new Map<ExtensionUIContext, Owner>();
	const hosts = new Set<WeakRef<object>>();
	const seen = new WeakSet<object>();
	const failed = new WeakSet<object>();
	const locate = (instance: unknown): { owner: Owner; host: Host } | undefined => {
		if (owners.size === 0 || (record(instance) && failed.has(instance))) return undefined;
		let host: Host;
		try {
			host = readHost(instance);
		} catch (error) {
			if (record(instance)) failed.add(instance);
			for (const owner of owners.values())
				owner.ui.notify(
					`Tool grouping unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			return undefined;
		}
		if (record(instance) && !seen.has(instance)) {
			seen.add(instance);
			hosts.add(new WeakRef(instance));
		}
		const owner = owners.get(host.ui);
		if (owner === undefined) return undefined;
		connect(owner, host);
		return { owner, host };
	};
	const state: PatchState = {
		owners,
		hosts,
		originals: { getRegisteredToolDefinition: lookup, showExtensionNotify: notify },
		wrappers: {
			getRegisteredToolDefinition(this: unknown, name: string): unknown {
				const result: unknown = Reflect.apply(lookup.value, this, [name]);
				locate(this);
				return result;
			},
			showExtensionNotify(this: unknown, message: string, type?: NoticeType): unknown {
				const match = locate(this);
				if (match?.owner.hosts.get(match.host.chat)?.notify(message, type ?? "info")) return;
				return Reflect.apply(notify.value, this, [message, type]);
			},
		},
	};
	Object.defineProperty(prototype, key, { value: state });
	return state;
}

/** Private to pi-ext-ui: two process hooks, scoped by the actual host UI facade. */
export function installHostToolGroups(
	context: ExtensionContext,
	background: () => boolean,
	outputPad: () => number,
): {
	dispose(): void;
	requestRender(): void;
	beginRun(): void;
	endRun(): void;
} {
	const state = patchState();
	const ui = context.ui;
	if (state.owners.has(ui)) throw new Error("Tool grouping already owns this UI runtime");
	if (state.owners.size === 0) {
		for (const seam of SEAMS) {
			if (
				Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value !==
				state.originals[seam].value
			)
				throw new Error("Pi tool/notification seam was changed by another extension");
		}
		for (const seam of SEAMS)
			Object.defineProperty(InteractiveMode.prototype, seam, {
				...state.originals[seam],
				value: state.wrappers[seam],
			});
	}
	const run: RunBox = {
		observed: new WeakMap(),
		clocks: new WeakMap(),
		activeClocks: new Set(),
	};
	const owner: Owner = {
		ui,
		hosts: new Map(),
		failed: new WeakSet(),
		attach: (host) => attach(host, run, background, outputPad),
	};
	state.owners.set(ui, owner);
	// Reload rebuilds history before session_start; reconnect already discovered instances.
	for (const reference of state.hosts) {
		const instance = reference.deref();
		if (instance === undefined) {
			state.hosts.delete(reference);
			continue;
		}
		try {
			const host = readHost(instance);
			if (host.ui === ui) connect(owner, host);
		} catch {
			state.hosts.delete(reference);
		}
	}
	let disposed = false;
	return {
		requestRender() {
			for (const host of owner.hosts.values()) host.requestRender();
		},
		beginRun() {
			// History may not have rendered yet. Claim it before opening the new live run.
			for (const host of owner.hosts.values()) host.observe();
			run.current = { run: {} };
		},
		endRun() {
			// Mark unseen transcript children before ending the run so later renders treat them as history.
			for (const host of owner.hosts.values()) host.observe();
			const endedAt = performance.now();
			const current = run.current;
			if (current !== undefined && current.run.endedAt === undefined) current.run.endedAt = endedAt;
			for (const clock of run.activeClocks) clock.endedAt = endedAt;
			run.activeClocks.clear();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			run.current = undefined;
			run.activeClocks.clear();
			state.owners.delete(ui);
			for (const host of owner.hosts.values()) host.dispose();
			owner.hosts.clear();
			if (state.owners.size !== 0) return;
			for (const seam of SEAMS) {
				if (
					Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value ===
					state.wrappers[seam]
				)
					Object.defineProperty(InteractiveMode.prototype, seam, state.originals[seam]);
				else
					ui.notify(
						"Tool grouping seam changed by another extension; restart Pi to fully unload it.",
						"warning",
					);
			}
		},
	};
}
