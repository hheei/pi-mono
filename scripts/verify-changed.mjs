#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const args = process.argv.slice(2);
const skipGraph = args.includes("--no-graph");

console.log("[verify-changed] Step 1: Checking changed file formats with Biome...");
execFileSync("node", [resolve(repoRoot, "scripts/check-changed.mjs")], {
	cwd: repoRoot,
	stdio: "inherit",
});

// Determine changed files
const gitOutput = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
	cwd: repoRoot,
	encoding: "utf8",
});

const changedFiles = [];
for (const line of gitOutput.split("\n")) {
	if (!line) continue;
	if (line.slice(0, 2).includes("D")) continue;
	let path = line.slice(3).trim();
	if (path.includes(" -> ")) path = path.split(" -> ")[1].trim();
	if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
	if (existsSync(resolve(repoRoot, path))) {
		changedFiles.push(path);
	}
}

if (changedFiles.length === 0) {
	console.log("[verify-changed] No changed files detected.");
	process.exit(0);
}

const isDocOnly = changedFiles.every(
	(f) => f.endsWith(".md") || f.startsWith("docs/") || f === "LICENSE",
);

if (isDocOnly) {
	console.log(
		"[verify-changed] Lowest-sufficient verification satisfied: documentation-only changes.",
	);
	process.exit(0);
}

// Check if shared roots or core affected
const touchesSharedRoot = changedFiles.some(
	(f) =>
		f === "package.json" ||
		f === "pnpm-lock.yaml" ||
		f.startsWith("tsconfig") ||
		f.startsWith("packages/pi-ext-core/") ||
		f.startsWith("scripts/"),
);

const affectedPackages = new Map();

for (const f of changedFiles) {
	const match = f.match(/^packages\/([^/]+)\//);
	if (match) {
		const pkgDir = `packages/${match[1]}`;
		const pkgJsonPath = resolve(repoRoot, pkgDir, "package.json");
		if (existsSync(pkgJsonPath)) {
			try {
				const pkgData = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
				if (!affectedPackages.has(pkgDir)) {
					affectedPackages.set(pkgDir, {
						name: pkgData.name,
						hasBuild: Boolean(pkgData.scripts?.build),
						files: [],
					});
				}
				affectedPackages.get(pkgDir).files.push(f);
			} catch {}
		}
	}
}

console.log(`\n[verify-changed] Step 2: Impact assessment:`);
console.log(`  - Touches shared root / infrastructure: ${touchesSharedRoot}`);
console.log(
	`  - Affected packages: ${
		Array.from(affectedPackages.values())
			.map((p) => p.name)
			.join(", ") || "none"
	}`,
);

if (touchesSharedRoot) {
	console.log(
		"\n[verify-changed] Upgrading to repo-wide typecheck due to shared infrastructure modifications...",
	);
	execFileSync("pnpm", ["run", "typecheck"], { cwd: repoRoot, stdio: "inherit" });
}

const buildPackages = Array.from(affectedPackages.values()).filter((p) => p.hasBuild);
if (buildPackages.length > 0) {
	console.log(
		`\n[verify-changed] Concurrently building ${buildPackages.length} affected package(s)...`,
	);
	const filterArgs = buildPackages.flatMap((p) => ["--filter", p.name]);
	execFileSync("pnpm", [...filterArgs, "run", "build"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
}

const testTargets = [];
const integrationTargets = [];
for (const [pkgDir, pkgInfo] of affectedPackages.entries()) {
	const testFiles = pkgInfo.files.filter(
		(f) => f.startsWith(`${pkgDir}/test/`) && f.endsWith(".test.ts"),
	);
	if (testFiles.length > 0) {
		testTargets.push(...testFiles);
	} else if (pkgInfo.files.some((f) => !f.startsWith(`${pkgDir}/test-integration/`))) {
		testTargets.push(pkgDir);
	}
	if (pkgInfo.files.some((f) => f.startsWith(`${pkgDir}/test-integration/`))) {
		integrationTargets.push(pkgDir);
	}
}

if (testTargets.length > 0) {
	console.log(
		`\n[verify-changed] Running focused tests across ${affectedPackages.size} affected package(s)...`,
	);
	execFileSync("pnpm", ["exec", "vitest", "run", ...testTargets], {
		cwd: repoRoot,
		stdio: "inherit",
	});
}
if (integrationTargets.length > 0) {
	console.log("\n[verify-changed] Running affected integration tests...");
	execFileSync(
		"pnpm",
		["exec", "vitest", "run", "-c", "vitest.integration.config.ts", ...integrationTargets],
		{
			cwd: repoRoot,
			stdio: "inherit",
		},
	);
}

// Auto-update graphify if code files were modified
const hasCodeChanges = changedFiles.some((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));
if (!skipGraph && hasCodeChanges) {
	try {
		console.log("\n[verify-changed] Step 3: Updating repository code graph (graphify update .)...");
		// graphify snapshots every semantic graph into graphify-out/<date>/ before overwriting it,
		// which keeps ~15MB per day in the working tree. The graph is regenerated, not edited by
		// hand, so the dated copies buy nothing here.
		execFileSync("graphify", ["update", "."], {
			cwd: repoRoot,
			stdio: "inherit",
			env: { ...process.env, GRAPHIFY_NO_BACKUP: "1" },
		});
	} catch (e) {
		console.warn(
			"[verify-changed] Notice: graphify update . was skipped or encountered an issue:",
			e.message,
		);
	}
} else if (skipGraph) {
	console.log("\n[verify-changed] Skipping graphify update (--no-graph flag passed).");
}

console.log("\n[verify-changed] Focused verification successfully completed!");
