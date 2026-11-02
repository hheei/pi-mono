import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "packages");
const buildCacheDir = path.join(root, ".pi-dev");
// Extensions built and loaded automatically by pi-dev.
// Explicitly excluded from autoloading:
// - pi-ext-core: shared library, not a standalone extension entry
const builtPackageNames = [
	"pi-ext-addon",
	"pi-ext-memory",
	"pi-ext-tools",
	"pi-bg-bash",
	"pi-apply-patch",
	"pi-python-eval",
	"pi-todo",
	"pi-ext-ui",
	"pi-loadout",
	"pi-optimizer",
	"pi-settings",
	"pi-status",
	"pi-subagents",
	"pi-web-access",
	"pi-ask-user",
] as const;
// Extension sources loaded explicitly next to the local packages: an external package that is not
// built here, and the built-ins that `--no-extensions` below would otherwise disable.
// tool_search is provided by pi-ext-tools; codemode and mcp remain Pi built-ins.
const explicitExtensionSources = ["builtin:codemode", "builtin:mcp"] as const;
const builtPackageDirs = builtPackageNames
	.map((name) => path.join(packageRoot, name))
	.filter(existsSync);
const toolsPackageDir = path.join(packageRoot, "pi-ext-tools");

// The bundle embeds its own TUI and bypasses pnpm's patchedDependencies.
const piCli =
	process.env.PI_CLI ??
	path.join(
		toolsPackageDir,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"cli.js",
	);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const requiredBuildDirectories = [path.join(packageRoot, "pi-ext-core")].filter(existsSync);
if (!existsSync(piCli)) {
	console.error(
		process.env.PI_CLI !== undefined
			? `Missing PI_CLI entry: ${JSON.stringify(piCli)}`
			: "Missing local Pi. Run pnpm install from the repository root.",
	);
	process.exit(1);
}
console.error(
	`[pi-dev] Pi host: ${JSON.stringify(piCli)} (${
		process.env.PI_CLI !== undefined
			? "PI_CLI override; workspace TUI patches are not guaranteed"
			: "workspace, unbundled"
	})`,
);

function updateSourceHash(hash: ReturnType<typeof createHash>, directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			updateSourceHash(hash, filePath);
		} else if (entry.isFile() && filePath.endsWith(".ts")) {
			hash.update(filePath);
			hash.update(readFileSync(filePath));
		}
	}
}

function buildFingerprint(directories: readonly string[]): string {
	const hash = createHash("sha256");
	for (const filePath of [
		path.join(root, "pnpm-lock.yaml"),
		path.join(root, "tsconfig.base.json"),
	]) {
		hash.update(filePath);
		hash.update(readFileSync(filePath));
	}
	for (const directory of directories) {
		for (const fileName of ["package.json", "tsconfig.json", "tsconfig.build.json"]) {
			const filePath = path.join(directory, fileName);
			if (!existsSync(filePath)) continue;
			hash.update(filePath);
			hash.update(readFileSync(filePath));
		}
		const sourceDir = path.join(directory, "src");
		if (existsSync(sourceDir)) updateSourceHash(hash, sourceDir);
	}
	return hash.digest("hex");
}

function runWorkspaceScript(directory: string, script: string): void {
	const result = spawnSync(pnpmCommand, ["run", script], {
		cwd: directory,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(buildCacheDir, { recursive: true });
const buildStatePath = path.join(buildCacheDir, "build.json");
const buildDirectories = [...requiredBuildDirectories, ...builtPackageDirs];
const isSubagent = process.env.PI_SUBAGENTS_CHILD_ID !== undefined;
const typescriptFingerprint = isSubagent ? undefined : buildFingerprint(buildDirectories);
let cachedTypeScriptFingerprint: string | undefined;
try {
	const cached: unknown = JSON.parse(readFileSync(buildStatePath, "utf8"));
	if (
		typeof cached === "object" &&
		cached !== null &&
		"typescriptFingerprint" in cached &&
		typeof cached.typescriptFingerprint === "string"
	) {
		cachedTypeScriptFingerprint = cached.typescriptFingerprint;
	}
} catch {
	// No cached build state requires a fresh build.
}

const needsTypeScriptBuild =
	!isSubagent &&
	(cachedTypeScriptFingerprint !== typescriptFingerprint ||
		buildDirectories.some((directory) => !existsSync(path.join(directory, "dist"))));

if (needsTypeScriptBuild) {
	for (const directory of buildDirectories) runWorkspaceScript(directory, "build");
	writeFileSync(buildStatePath, `${JSON.stringify({ typescriptFingerprint })}\n`);
}

const extensionArgs: string[] = [];
for (const directory of builtPackageDirs) {
	const extensionPath = path.join(directory, "dist", "extension.js");
	if (existsSync(extensionPath)) {
		extensionArgs.push("--extension", extensionPath);
	}
}
for (const source of explicitExtensionSources) {
	extensionArgs.push("--extension", source);
}
const moshiHookPath = path.join(homedir(), ".pi", "agent", "extensions", "moshi-hooks.ts");
if (existsSync(moshiHookPath)) {
	extensionArgs.push("--extension", moshiHookPath);
}
const childEnv = {
	...process.env,
	PI_DEV: "1",
	PI_DEV_BIN: process.env.PI_DEV_BIN ?? path.join(root, "scripts", "pi-dev"),
};
delete childEnv.OPENAI_API_KEY;

const argsToPass = process.argv.slice(2);
const hasApproveOption = argsToPass.includes("--approve") || argsToPass.includes("--no-approve");
const spawnArgs = [
	piCli,
	...(hasApproveOption ? [] : ["--approve"]),
	"--no-extensions",
	...extensionArgs,
	...argsToPass,
];

const result = spawnSync(process.execPath, spawnArgs, {
	cwd: process.cwd(),
	env: childEnv,
	stdio: "inherit",
});
process.exit(result.status ?? 1);
