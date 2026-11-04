import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
	hasRemoteRexReader,
	type LinkHostProvider,
	linkPaths,
	resolveLocalLinks,
	rexProvider,
	vsCodeProvider,
} from "../src/file-links.js";

function rexClientList(
	clients: Array<{ kind: string; transport: string; address: string }>,
): string {
	return JSON.stringify({
		clients: clients.map((client) => ({
			info: { kind: client.kind },
			principal: { transport: client.transport, remote_addr: client.address },
		})),
	});
}

function rexPi(output: string, code = 0): ExtensionAPI {
	return {
		exec: async () => ({ code, stdout: output, stderr: "", killed: false, truncated: false }),
	} as unknown as ExtensionAPI;
}

test("VS Code keeps paths as text: its own link provider resolves them on the owning side", async () => {
	expect(vsCodeProvider.matches({ TERM_PROGRAM: "vscode" })).toBe(true);
	expect(vsCodeProvider.matches({ TERM_PROGRAM: "herdr" })).toBe(false);
	expect(await resolveLocalLinks(rexPi(""), { TERM_PROGRAM: "vscode" })).toBe(false);
});

test("Rex links local files only while every app client is on this machine", async () => {
	const local = rexClientList([{ kind: "app", transport: "tcp", address: "127.0.0.1:51584" }]);
	const remote = rexClientList([{ kind: "app", transport: "tcp", address: "100.96.2.36:51584" }]);
	expect(rexProvider.matches({ REX_SESSION: "work" })).toBe(true);
	expect(rexProvider.matches({ REX_SESSION: "  " })).toBe(false);
	expect(await resolveLocalLinks(rexPi(local), { REX_SESSION: "work" })).toBe(true);
	expect(await resolveLocalLinks(rexPi(remote), { REX_SESSION: "work" })).toBe(false);
});

test("an unreadable Rex client list keeps paths as text", async () => {
	expect(await resolveLocalLinks(rexPi("not json"), { REX_SESSION: "work" })).toBe(false);
	expect(await resolveLocalLinks(rexPi("", 1), { REX_SESSION: "work" })).toBe(false);
	const failing = {
		exec: async () => {
			throw new Error("rex is not installed");
		},
	} as unknown as ExtensionAPI;
	expect(await resolveLocalLinks(failing, { REX_SESSION: "work" })).toBe(false);
});

test("an unknown host keeps paths as text", async () => {
	expect(await resolveLocalLinks(rexPi(""), { TERM_PROGRAM: "herdr", SSH_TTY: "/dev/pts/1" })).toBe(
		false,
	);
});

test("the first matching provider decides", async () => {
	const order: string[] = [];
	const provider = (kind: string, matches: boolean): LinkHostProvider => ({
		kind,
		matches: () => matches,
		localLinks: async () => {
			order.push(kind);
			return true;
		},
	});
	const providers = [provider("first", true), provider("second", true)];
	expect(await resolveLocalLinks(rexPi(""), {}, providers)).toBe(true);
	expect(order).toEqual(["first"]);
});

test("only a Rex app on the network counts as a remote reader", () => {
	const app = (address: string): string =>
		rexClientList([{ kind: "app", transport: "tcp", address }]);
	expect(hasRemoteRexReader(app("100.96.2.36:51584"))).toBe(true);
	expect(hasRemoteRexReader(app("[::1]:51584"))).toBe(false);
	expect(hasRemoteRexReader(app("127.0.0.1:51584"))).toBe(false);
	expect(
		hasRemoteRexReader(rexClientList([{ kind: "cli", transport: "unix", address: "unix" }])),
	).toBe(false);
	expect(hasRemoteRexReader("not json")).toBeUndefined();
});

test("prose paths become links against the working directory", () => {
	expect(linkPaths("Fixed src/main.ts and /home/user/x.ts.", "/work/repo")).toBe(
		"Fixed [src/main.ts](file://localhost/work/repo/src/main.ts) and [/home/user/x.ts](file://localhost/home/user/x.ts).",
	);
});

test("path segments are percent-encoded and the hostname is always present", () => {
	expect(linkPaths("See /home/user/中文.ts", "/repo")).toBe(
		"See [/home/user/中文.ts](file://localhost/home/user/%E4%B8%AD%E6%96%87.ts)",
	);
});

test("code, existing links, and URLs are never rewritten", () => {
	const markdown = [
		"`src/main.ts` stays code.",
		"[src/main.ts](https://example.com/src/main.ts) stays a link.",
		"```",
		"see src/main.ts",
		"```",
		"~~~",
		"see ~/src/main.ts",
		"~~~",
		"https://example.com/src/main.ts stays a URL.",
	].join("\n");
	expect(linkPaths(markdown, "/repo")).toBe(markdown);
});

test("paths without an extension stay text, and sentence punctuation stays outside the link", () => {
	expect(linkPaths("Either and/or neither.", "/repo")).toBe("Either and/or neither.");
	expect(linkPaths("See src/main.ts.", "/repo")).toBe(
		"See [src/main.ts](file://localhost/repo/src/main.ts).",
	);
});
