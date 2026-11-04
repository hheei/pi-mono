import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REX_PROBE_TIMEOUT_MS = 3_000;

/**
 * One host application that can show the transcript. A provider answers whether that host should
 * receive `file://` links at all: a host that resolves paths itself, or one whose reader is on
 * another machine, must leave the text alone. Adding an app means adding one provider.
 */
export interface LinkHostProvider {
	readonly kind: string;
	/** Whether this app is the one running Pi, decided from the environment alone. */
	readonly matches: (env: NodeJS.ProcessEnv) => boolean;
	/** Whether paths here name files this reader can open, decided once per session. */
	readonly localLinks: (pi: ExtensionAPI) => Promise<boolean>;
}

/**
 * VS Code's own terminal link provider already opens a path on the side that owns the file, so a
 * remote window needs nothing from us. Wrapping the path in OSC 8 would shadow that handling.
 */
export const vsCodeProvider: LinkHostProvider = {
	kind: "vscode",
	matches: (env) => env.TERM_PROGRAM?.toLowerCase() === "vscode",
	localLinks: async () => false,
};

/**
 * Rex can be reached from another machine, and the client list is the only place that says so.
 * Every app client on loopback means the reader is here; anything else means the link would open a
 * path that does not exist on their machine, and an ssh target is not knowable from this side.
 */
export const rexProvider: LinkHostProvider = {
	kind: "rex",
	matches: (env) => Boolean(env.REX_SESSION?.trim()),
	localLinks: async (pi) => {
		try {
			const result = await pi.exec("rex", ["api", "call", "client.list"], {
				timeout: REX_PROBE_TIMEOUT_MS,
			});
			return result.code === 0 && hasRemoteRexReader(result.stdout) === false;
		} catch {
			return false;
		}
	},
};

export const LINK_HOST_PROVIDERS: readonly LinkHostProvider[] = [vsCodeProvider, rexProvider];

/** The first provider that recognizes this host decides; an unknown host keeps paths as text. */
export async function resolveLocalLinks(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv,
	providers: readonly LinkHostProvider[] = LINK_HOST_PROVIDERS,
): Promise<boolean> {
	const provider = providers.find((candidate) => candidate.matches(env));
	return provider === undefined ? false : provider.localLinks(pi);
}

/**
 * A Rex app client on the network, outside loopback, is a reader at another machine. The CLI client
 * is this process talking to its own server, so it never counts. `undefined` means the list could
 * not be read: that is not the same as "nobody remote", and neither answer may become a link.
 */
export function hasRemoteRexReader(output: string): boolean | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}
	const clients = (parsed as { clients?: unknown }).clients;
	if (!Array.isArray(clients)) return undefined;
	return clients.some((client) => {
		if (typeof client !== "object" || client === null) return false;
		const record = client as { info?: unknown; principal?: unknown };
		const info = onRecord(record.info);
		const principal = onRecord(record.principal);
		if (info?.kind !== "app" || principal?.transport !== "tcp") return false;
		return !isLoopback(principal.remote_addr);
	});
}

function onRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function isLoopback(address: unknown): boolean {
	if (typeof address !== "string") return false;
	const host = address.startsWith("[")
		? address.slice(1, address.indexOf("]"))
		: address.replace(/:\d+$/, "");
	return host === "::1" || host === "localhost" || host.startsWith("127.");
}

/**
 * Rewrites paths in prose as Markdown links to this machine's files. Rendering stays with the host:
 * Pi adds the OSC 8 sequence itself, and only where the terminal is known to forward it.
 */
export function linkPaths(markdown: string, base: string = process.cwd()): string {
	if (!markdown.includes("/")) return markdown;
	// Odd indexes are the parts the split captured: code, links, and URLs stay untouched.
	return markdown
		.split(SKIP)
		.map((part, index) => (index % 2 === 1 ? part : replacePaths(part, base)))
		.join("");
}

/** Code, existing links, and bare URLs are never rewritten, in either direction. */
const SKIP =
	/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s<>()]+|<[^>\n]+>)/g;

/**
 * Absolute paths, and relative paths that carry a file extension. A relative path without one is
 * the shape of prose (`and/or`, `src/main`), so it stays text: a missed link costs nothing, a wrong
 * one underlines words that were never paths.
 */
const PATH =
	/(?<![\w/:.~-])((?:\/(?:[\p{L}\p{N}._@+-]+\/)*[\p{L}\p{N}._@+-]+)|(?:[\p{L}\p{N}._-]+\/)+[\p{L}\p{N}._-]*\.[\p{L}\p{N}]{1,8})(?![\w/])/gu;

function replacePaths(part: string, base: string): string {
	return part.replace(PATH, (match) => {
		// Sentence punctuation belongs to the prose, not to the path.
		const path = match.replace(/[.,;:!?]+$/, "");
		const absolute = path.startsWith("/") ? path : joinPath(base, path);
		// Ghostty drops a file:// URI that carries no hostname, so the path always has one.
		return `[${path}](file://localhost${encodePath(absolute)})${match.slice(path.length)}`;
	});
}

function joinPath(base: string, relative: string): string {
	return `${base.replace(/\/+$/, "")}/${relative}`;
}

/** Percent-encodes each segment and keeps the separators. */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
