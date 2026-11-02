import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { computeEffectiveEnabled, ResourcePatternStore } from "./pattern-store.js";
import type {
	LoadoutItem,
	ProjectOverrideState,
	ResourceCategory,
	ResourceOrigin,
} from "./types.js";

const BUILTIN_PATH_PREFIX = "builtin:";
const NPM_PREFIX = "npm:";

export interface LoadoutManagerOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly settingsManager?: SettingsManager;
	readonly builtinExtensions?: readonly string[];
}

const skillDescriptionCache = new Map<
	string,
	{ readonly mtimeMs: number; readonly desc: string | undefined }
>();

/**
 * Names one resource for the list. A package is named after the package, because
 * `dist/extension.js` is the same label for every installed package and therefore identifies none
 * of them; a resource nested deeper inside a package keeps the package name plus its folder.
 */
export function resourceDisplayName(params: {
	readonly category: ResourceCategory;
	readonly path: string;
	readonly origin: ResourceOrigin;
	readonly source: string;
	readonly baseDir: string | undefined;
}): string {
	const { category, path, origin, source, baseDir } = params;
	const fileName = basename(path);
	const parentFolder = basename(dirname(path));

	if (origin === "builtin") return path.slice(BUILTIN_PATH_PREFIX.length);
	if (origin !== "package" || baseDir === undefined) {
		return category === "skills" && fileName === "SKILL.md" ? parentFolder : fileName;
	}

	const trimmed = source.startsWith(NPM_PREFIX) ? source.slice(NPM_PREFIX.length) : source;
	const packageName = basename(trimmed.replace(/\\/g, "/"));
	// A skill is its own folder; anything else is whatever folder holds the file, which for a
	// package entry point is the build output directory and therefore no more useful than nothing.
	const folder =
		category === "skills" && fileName === "SKILL.md"
			? parentFolder
			: basename(dirname(relative(baseDir, path).replace(/\\/g, "/")));
	if (folder === "." || folder === "" || folder === "dist" || folder === packageName) {
		return packageName;
	}
	return `${packageName}/${folder}`;
}

/**
 * Distinguishes resources that would otherwise share one label. Two `research` skills from
 * different resource directories are two different resources, and an identical row tells the user
 * nothing about which one they are about to disable.
 */
function disambiguateNames(items: readonly LoadoutItem[]): LoadoutItem[] {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
	return items.map((item) => {
		if ((counts.get(item.name) ?? 0) < 2) return item;
		const qualifier = item.baseDir === undefined ? item.origin : basename(item.baseDir);
		return { ...item, name: `${item.name} (${qualifier})` };
	});
}

function extractSkillDescription(skillPath: string): string | undefined {
	try {
		if (!existsSync(skillPath)) return undefined;
		const stat = statSync(skillPath);
		const cached = skillDescriptionCache.get(skillPath);
		if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
			return cached.desc;
		}
		const content = readFileSync(skillPath, "utf8");
		let desc: string | undefined;
		const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
		if (fmMatch?.[1]) {
			const descMatch = /^description:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/mu.exec(fmMatch[1]);
			if (descMatch) {
				const val = (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "").trim();
				if (val) desc = val;
			}
		}
		if (desc === undefined) {
			const lines = content
				.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "")
				.trim()
				.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith("#")) {
					desc = trimmed;
					break;
				}
			}
		}
		skillDescriptionCache.set(skillPath, { mtimeMs: stat.mtimeMs, desc });
		return desc;
	} catch {
		return undefined;
	}
}

export class LoadoutManager {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly builtinExtensions: readonly string[];
	readonly store: ResourcePatternStore;

	#items: LoadoutItem[] = [];

	constructor(options: LoadoutManagerOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.settingsManager =
			options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.builtinExtensions = options.builtinExtensions ?? [];
		this.store = new ResourcePatternStore({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
	}

	get items(): readonly LoadoutItem[] {
		return this.#items;
	}

	setItemsForTest(items: LoadoutItem[]): void {
		this.#items = items;
	}

	isProjectTrusted(): boolean {
		return this.settingsManager.isProjectTrusted();
	}

	async refresh(): Promise<void> {
		// The global layer is resolved with project trust off, so a project's overrides never
		// leak into the baseline the project view inherits from.
		const globalSettingsManager = SettingsManager.create(this.cwd, this.agentDir, {
			projectTrusted: false,
		});

		const globalPm = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: globalSettingsManager,
			builtinExtensions: [...this.builtinExtensions],
		});
		const globalResolved = await globalPm.resolve();

		const nextItems: LoadoutItem[] = [];

		const addCategory = (
			category: ResourceCategory,
			resolvedList: typeof globalResolved.skills,
		) => {
			for (const res of resolvedList) {
				const { path, metadata } = res;
				const origin: ResourceOrigin =
					metadata.source === "builtin"
						? "builtin"
						: metadata.origin === "package"
							? "package"
							: metadata.scope === "project"
								? "project"
								: "user";

				const name = resourceDisplayName({
					category,
					path,
					origin,
					source: metadata.source,
					baseDir: metadata.baseDir,
				});

				const globalEnabled = res.enabled;
				const projectOverride = this.store.resolveProjectOverride(category, path, metadata);
				// Derived from the two facts the panel shows, not from a second resolution: an
				// untrusted project resolves to the global layer, which would otherwise report the
				// project decision and its result as contradicting each other.
				const effectiveEnabled = computeEffectiveEnabled(globalEnabled, projectOverride);
				const description = category === "skills" ? extractSkillDescription(path) : undefined;

				nextItems.push({
					id: `${category}:${path}`,
					category,
					name,
					path,
					origin,
					source: metadata.source,
					...(metadata.baseDir ? { baseDir: metadata.baseDir } : {}),
					...(description ? { description } : {}),
					globalEnabled,
					projectOverride,
					effectiveEnabled,
				});
			}
		};

		addCategory("skills", globalResolved.skills);
		addCategory("extensions", globalResolved.extensions);
		addCategory("prompts", globalResolved.prompts);
		addCategory("themes", globalResolved.themes);

		this.#items = disambiguateNames(nextItems);
	}

	toggleGlobal(item: LoadoutItem): void {
		this.store.toggleGlobal(item);
	}

	cycleProjectOverride(item: LoadoutItem): ProjectOverrideState {
		return this.store.cycleProjectOverride(item);
	}

	async flush(): Promise<void> {
		await this.store.flush();
	}
}
