import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import {
	defaultExtensionSettingsPaths,
	readJsonSettingsRoot,
	updateJsonSettingsRoot,
} from "./json-settings.js";
import { isRecord } from "./record.js";
import { runtimeIdentity } from "./runtime-identity.js";

export type SettingPrimitive = boolean | number | string;
export type SettingValue = SettingPrimitive | readonly string[] | null;
export type SettingsState = Record<string, Record<string, SettingValue>>;

export interface SettingsContext {
	/** Current Pi session identity supplied to provider callbacks; hosts must not fabricate it. */
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly cwd?: string;
	readonly [key: string]: unknown;
}

export type SettingType = "boolean" | "enum" | "text" | "number" | "path" | "list";

export interface SettingOption<T extends SettingPrimitive = SettingPrimitive> {
	readonly value: T;
	readonly label?: string;
	readonly description?: string;
}

export interface SettingTabCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: SettingPrimitive;
	readonly options: readonly SettingOption[];
	readonly separator?: string;
}

export interface SettingField<T extends SettingValue = SettingValue> {
	readonly id: string;
	readonly label: string;
	readonly type: SettingType;
	readonly defaultValue: T;
	readonly description: string;
	readonly options?: readonly SettingOption[];
	readonly tabCycle?: SettingTabCycle;
	format?(value: T): string;
	formatDisplay?(value: T, relatedValue?: SettingPrimitive): string;
	formatDescription?(value: T, relatedValue?: SettingPrimitive): string;
	parse(draft: string): T;
	validate?(value: T): string | undefined;
	enabled?(state: SettingsState): boolean;
}

export interface SettingGroup {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly fields: readonly SettingField[];
}

export interface SettingChange {
	readonly groupId: string;
	readonly fieldId: string;
	readonly value: SettingValue;
	readonly previousValue?: SettingValue;
	readonly state: SettingsState;
}

/**
 * Persistence boundary for one settings provider. Loading and saving JSON is core's
 * responsibility; applying a loaded value to live feature state remains provider-owned.
 */
export interface SettingsStorage {
	load(context: SettingsContext): SettingsState | undefined | Promise<SettingsState | undefined>;
	save(state: SettingsState, context: SettingsContext): void | Promise<void>;
}

/** Rendered by a settings-surface owner; core does not render panels. */
export interface SettingsPanel {
	readonly id: string;
	readonly label?: string;
	render(width: number): readonly string[];
	handleInput?(input: string): boolean | undefined | Promise<boolean | undefined>;
	invalidate?(): void;
}

/**
 * Describes one package's settings without owning a settings UI. A future host invokes
 * the provider callbacks; extensions decide whether a change affects live state now or
 * only on the next session start/reload.
 */
export interface SettingsProvider {
	readonly id: string;
	readonly title: string;
	readonly moduleName?: string;
	readonly origin?: string;
	readonly description?: string;
	readonly groups: readonly SettingGroup[];
	readonly panels?: readonly SettingsPanel[];
	readonly storage: SettingsStorage;
	onChange?(change: SettingChange, context: SettingsContext): void | Promise<void>;
}

/** Runtime-scoped provider registry; it stores no settings values and renders no UI. */
export interface SettingsRegistry {
	register(provider: SettingsProvider): () => void;
	replace(provider: SettingsProvider): () => void;
	/** Reserves non-UI top-level ext_settings.json groups; any existing claim fails. */
	registerGroups(owner: string, groupIds: readonly string[]): () => void;
	list(options?: { readonly includeEmpty?: boolean }): readonly SettingsProvider[];
	get(id: string): SettingsProvider | undefined;
}

interface SettingsGroupClaim {
	readonly token: symbol;
}

class RuntimeSettingsRegistry implements SettingsRegistry {
	readonly #providers = new Map<string, SettingsProvider>();
	readonly #tokens = new Map<string, symbol>();
	readonly #groupClaims = new Map<string, SettingsGroupClaim>();

	register(provider: SettingsProvider): () => void {
		if (this.#providers.has(provider.id))
			throw new Error(`Settings provider id collision: ${provider.id}`);
		this.assertGroupsAvailable(provider.groups.map((group) => group.id));
		return this.set(provider);
	}

	replace(provider: SettingsProvider): () => void {
		const existingToken = this.#tokens.get(provider.id);
		this.assertGroupsAvailable(
			provider.groups.map((group) => group.id),
			existingToken,
		);
		if (existingToken !== undefined)
			for (const [groupId, claim] of this.#groupClaims)
				if (claim.token === existingToken) this.#groupClaims.delete(groupId);
		return this.set(provider);
	}

	registerGroups(owner: string, groupIds: readonly string[]): () => void {
		this.assertGroupsAvailable(groupIds);
		const token = Symbol(owner);
		for (const groupId of groupIds) this.#groupClaims.set(groupId, { token });
		return () => {
			for (const groupId of groupIds)
				if (this.#groupClaims.get(groupId)?.token === token) this.#groupClaims.delete(groupId);
		};
	}

	private assertGroupsAvailable(groupIds: readonly string[], allowedToken?: symbol): void {
		const ownGroups = new Set<string>();
		for (const groupId of groupIds) {
			const claim = this.#groupClaims.get(groupId);
			if (ownGroups.has(groupId) || (claim !== undefined && claim.token !== allowedToken))
				throw new Error(`Settings group id collision: ${groupId}`);
			ownGroups.add(groupId);
		}
	}

	list(options: { readonly includeEmpty?: boolean } = {}): readonly SettingsProvider[] {
		return [...this.#providers.values()]
			.filter(
				(provider) =>
					options.includeEmpty === true ||
					provider.groups.some((group) => group.fields.length > 0) ||
					(provider.panels?.length ?? 0) > 0,
			)
			.sort(
				(left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
			);
	}

	get(id: string): SettingsProvider | undefined {
		return this.#providers.get(id);
	}

	private set(provider: SettingsProvider): () => void {
		const token = Symbol(provider.id);
		this.#providers.set(provider.id, provider);
		this.#tokens.set(provider.id, token);
		for (const group of provider.groups) this.#groupClaims.set(group.id, { token });
		return () => {
			if (this.#tokens.get(provider.id) !== token) return;
			this.#tokens.delete(provider.id);
			this.#providers.delete(provider.id);
			for (const group of provider.groups)
				if (this.#groupClaims.get(group.id)?.token === token) this.#groupClaims.delete(group.id);
		};
	}
}

/** Runtime-scoped registry shared across independently evaluated extension packages. */
export function getRuntimeSettingsRegistry(pi: ExtensionAPI): SettingsRegistry {
	const registries = getGlobalState(
		"settings-registries",
		(): WeakMap<object, SettingsRegistry> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const existing = registries.get(identity);
	if (existing !== undefined) return existing;
	const created = new RuntimeSettingsRegistry();
	registries.set(identity, created);
	return created;
}

export function registerSettings(
	provider: SettingsProvider,
	registry: SettingsRegistry,
): () => void {
	return registry.register(provider);
}

export interface JsonSettingsStorageOptions {
	readonly path?: string;
	readonly group: string;
}

function isSettingValue(value: unknown): value is SettingValue {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string" ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"))
	);
}

/**
 * Stores one globally registered settings group as a top-level ext_settings.json object.
 * The registry rejects duplicate group IDs; atomic root updates preserve every sibling group.
 */
export function createJsonSettingsStorage(options: JsonSettingsStorageOptions): SettingsStorage {
	return {
		async load(context): Promise<SettingsState | undefined> {
			const path = options.path ?? defaultExtensionSettingsPaths().globalPath;
			const root = await readJsonSettingsRoot(path, context.signal);
			const group = root[options.group];
			if (group !== undefined && !isRecord(group))
				throw new Error(`Expected ${options.group} to be an object in ${path}`);
			if (!isRecord(group)) return undefined;
			return {
				[options.group]: Object.fromEntries(
					Object.entries(group).filter((entry): entry is [string, SettingValue] =>
						isSettingValue(entry[1]),
					),
				),
			};
		},
		async save(state, context): Promise<void> {
			const path = options.path ?? defaultExtensionSettingsPaths().globalPath;
			await updateJsonSettingsRoot(
				path,
				(root) => {
					const group = root[options.group];
					if (group !== undefined && !isRecord(group))
						throw new Error(`Expected ${options.group} to be an object in ${path}`);
					const existing = isRecord(group) ? group : {};
					root[options.group] = { ...existing, ...(state[options.group] ?? {}) };
				},
				context.signal,
			);
		},
	};
}
