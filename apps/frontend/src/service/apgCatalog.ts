// File role: declarative Aevia Plugin (APG) catalog client and browser-local palette preferences.
import { apiUrl } from "../config/endpoints";

export type ApgScope = "system" | "user";
export type ApgBrushBase = "pen" | "pencil" | "highlighter";
export type ApgPermission = "scene.read" | "scene.write" | "ui.preview" | "ui.download" | "storage.shared";
export interface ApgCommandContribution { id: string; label: string; shortcut?: string; resource?: string }

export interface ApgPaletteContribution {
	id: string;
	label: string;
	colors: string[];
}

export interface ApgBrushContribution {
	id: string;
	label: string;
	base: ApgBrushBase;
	color?: string;
	size?: number;
	opacity?: number;
}

export interface ApgManifest {
	manifestVersion: 1 | 2;
	id: string;
	name: string;
	version: string;
	scope: ApgScope;
	apiVersion?: 1;
	permissions?: ApgPermission[];
	/** Versions the shared-state value under this plugin id; 0/absent means unversioned. */
	stateSchemaVersion?: number;
	main?: "main.js";
	contributes: {
		palettes?: ApgPaletteContribution[];
		brushes?: ApgBrushContribution[];
		commands?: ApgCommandContribution[];
	};
}

export interface ApgCatalogPlugin {
	manifest: ApgManifest;
	enabled: true;
	program?: string;
	digest?: string;
	signedBy?: string;
}

export interface ApgCatalog {
	version: 1;
	revision?: string;
	plugins: ApgCatalogPlugin[];
}

export interface ApgPaletteView extends ApgPaletteContribution {
	pluginId: string;
	pluginName: string;
	scope: ApgScope;
	enabled: boolean;
	toggleable: boolean;
}

export interface ApgBrushView extends ApgBrushContribution {
	pluginId: string;
	pluginName: string;
}

const MAX_CATALOG_PLUGINS = 256;
const MAX_PALETTES_PER_PLUGIN = 64;
const MAX_BRUSHES_PER_PLUGIN = 64;
const MAX_COLORS_PER_PALETTE = 64;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 256;
const MAX_BRUSH_SIZE = 30;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PERMISSIONS: readonly string[] = ["scene.read", "scene.write", "ui.preview", "ui.download", "storage.shared"];
const USER_PALETTE_STORAGE_PREFIX = "aevia.apg.palette.enabled.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
	Object.keys(value).every((key) => allowed.includes(key));

const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
const isLabel = (value: unknown): value is string =>
	typeof value === "string" && value.length <= MAX_TEXT_LENGTH && value.trim().length > 0;
const isColor = (value: unknown): value is string => typeof value === "string" && COLOR_PATTERN.test(value);

const parsePalette = (value: unknown): ApgPaletteContribution | null => {
	if (!isRecord(value) || !hasOnlyKeys(value, ["id", "label", "colors"])) return null;
	if (!isId(value.id) || !isLabel(value.label) || !Array.isArray(value.colors) || value.colors.length === 0 || value.colors.length > MAX_COLORS_PER_PALETTE) return null;
	if (!value.colors.every(isColor)) return null;
	return { id: value.id, label: value.label, colors: [...value.colors] };
};

const parseBrush = (value: unknown): ApgBrushContribution | null => {
	if (!isRecord(value) || !hasOnlyKeys(value, ["id", "label", "base", "color", "size", "opacity"])) return null;
	if (!isId(value.id) || !isLabel(value.label) || !["pen", "pencil", "highlighter"].includes(String(value.base))) return null;
	if (value.color !== undefined && !isColor(value.color)) return null;
	if (value.size !== undefined && (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0.1 || value.size > MAX_BRUSH_SIZE)) return null;
	if (value.opacity !== undefined && (typeof value.opacity !== "number" || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1)) return null;
	return {
		id: value.id,
		label: value.label,
		base: value.base as ApgBrushBase,
		...(value.color !== undefined ? { color: value.color } : {}),
		...(value.size !== undefined ? { size: value.size } : {}),
		...(value.opacity !== undefined ? { opacity: value.opacity } : {}),
	};
};

const parseManifest = (value: unknown): ApgManifest | null => {
	if (!isRecord(value) || !hasOnlyKeys(value, ["manifestVersion", "id", "name", "version", "scope", "contributes", "apiVersion", "permissions", "stateSchemaVersion", "main"])) return null;
	if ((value.manifestVersion !== 1 && value.manifestVersion !== 2) || !isId(value.id) || !isLabel(value.name)) return null;
	if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) return null;
	if (value.scope !== "system" && value.scope !== "user") return null;
	if (!isRecord(value.contributes) || !hasOnlyKeys(value.contributes, ["palettes", "brushes", "commands"])) return null;
	const commands = value.contributes.commands;
	const permissions = value.permissions;
	if (value.manifestVersion === 1 && (value.apiVersion !== undefined || permissions !== undefined || value.stateSchemaVersion !== undefined || value.main !== undefined || commands !== undefined)) return null;
	if (value.manifestVersion === 2 && value.apiVersion !== 1) return null;
	if (value.main !== undefined && value.main !== "main.js") return null;
	if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every(p => typeof p === "string" && PERMISSIONS.includes(p)) || new Set(permissions).size !== permissions.length)) return null;
	if (commands !== undefined && (!Array.isArray(commands) || commands.length > 64 || (commands.length > 0 && value.main !== "main.js") || !commands.every(c => isRecord(c) && hasOnlyKeys(c, ["id", "label", "shortcut", "resource"]) && isId(c.id) && isLabel(c.label) && (c.shortcut === undefined || (typeof c.shortcut === "string" && /^Alt\+Shift\+[0-9]$/.test(c.shortcut))) && (c.resource === undefined || (value.scope === "system" && typeof c.resource === "string" && /^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/.test(c.resource)))) || new Set(commands.map(c => c.id)).size !== commands.length)) return null;
	if (value.scope === "user" && Array.isArray(permissions) && (permissions.includes("scene.write") || permissions.includes("storage.shared"))) return null;
	const stateSchemaVersion = value.stateSchemaVersion;
	if (stateSchemaVersion !== undefined && (!Number.isInteger(stateSchemaVersion) || (stateSchemaVersion as number) < 0 || (stateSchemaVersion as number) > 1000)) return null;
	if (typeof stateSchemaVersion === "number" && stateSchemaVersion !== 0 && !(Array.isArray(permissions) && permissions.includes("storage.shared"))) return null;

	const palettes = value.contributes.palettes;
	const brushes = value.contributes.brushes;
	if (palettes !== undefined && (!Array.isArray(palettes) || palettes.length > MAX_PALETTES_PER_PLUGIN)) return null;
	if (brushes !== undefined && (!Array.isArray(brushes) || brushes.length > MAX_BRUSHES_PER_PLUGIN)) return null;
	if (value.scope === "user" && Array.isArray(brushes) && brushes.length > 0) return null;

	const parsedPalettes = palettes?.map(parsePalette) ?? [];
	const parsedBrushes = brushes?.map(parseBrush) ?? [];
	if (parsedPalettes.some((item) => item === null) || parsedBrushes.some((item) => item === null)) return null;
	if (new Set(parsedPalettes.map((item) => item!.id)).size !== parsedPalettes.length) return null;
	if (new Set(parsedBrushes.map((item) => item!.id)).size !== parsedBrushes.length) return null;

	return {
		manifestVersion: value.manifestVersion,
		id: value.id,
		name: value.name,
		version: value.version,
		scope: value.scope,
		...(value.manifestVersion === 2 ? { apiVersion: 1 as const } : {}),
		...(permissions !== undefined ? { permissions: permissions as ApgPermission[] } : {}),
		...(typeof stateSchemaVersion === "number" ? { stateSchemaVersion } : {}),
		...(value.main === "main.js" ? { main: "main.js" as const } : {}),
		contributes: {
			...(palettes !== undefined ? { palettes: parsedPalettes as ApgPaletteContribution[] } : {}),
			...(brushes !== undefined ? { brushes: parsedBrushes as ApgBrushContribution[] } : {}),
			...(commands !== undefined ? { commands: commands as ApgCommandContribution[] } : {}),
		},
	};
};

export const parseApgCatalog = (value: unknown): ApgCatalog | null => {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "plugins", "revision"])) return null;
	if (value.version !== 1 || !Array.isArray(value.plugins) || value.plugins.length > MAX_CATALOG_PLUGINS) return null;
	if (value.revision !== undefined && (typeof value.revision !== "string" || !DIGEST_PATTERN.test(value.revision))) return null;
	const plugins: ApgCatalogPlugin[] = [];
	const pluginIds = new Set<string>();
	for (const item of value.plugins) {
		if (!isRecord(item) || !hasOnlyKeys(item, ["manifest", "enabled", "program", "digest", "signedBy"]) || item.enabled !== true) return null;
		const manifest = parseManifest(item.manifest);
		if (!manifest) return null;
		if (item.digest !== undefined && (typeof item.digest !== "string" || !DIGEST_PATTERN.test(item.digest))) return null;
		if (item.signedBy !== undefined && !isId(item.signedBy)) return null;
		if (manifest.main ? (typeof item.program !== "string" || item.program.length === 0 || new TextEncoder().encode(item.program).length > 128 * 1024) : item.program !== undefined) return null;
		if (pluginIds.has(manifest.id)) return null;
		pluginIds.add(manifest.id);
		plugins.push({ manifest, enabled: true, ...(typeof item.program === "string" ? { program: item.program } : {}), ...(typeof item.digest === "string" ? { digest: item.digest } : {}), ...(typeof item.signedBy === "string" ? { signedBy: item.signedBy } : {}) });
	}
	return { version: 1, plugins, ...(typeof value.revision === "string" ? { revision: value.revision } : {}) };
};

export const fetchApgCatalog = async (signal?: AbortSignal): Promise<ApgCatalog> => {
	try {
		const response = await fetch(apiUrl("/api/apg/catalog"), { headers: { Accept: "application/json" }, cache: "no-store", signal });
		if (!response.ok) return { version: 1, plugins: [] };
		return parseApgCatalog(await response.json()) ?? { version: 1, plugins: [] };
	} catch {
		return { version: 1, plugins: [] };
	}
};

// A single request in flight; revocation is fail-closed, including on network errors.
export function watchApgCatalog(onCatalog: (catalog: ApgCatalog) => void, intervalMs = 15_000) {
	let disposed = false;
	let pending: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last = "";
	const refresh = async () => {
		if (disposed || pending) return;
		if (timer !== undefined) clearTimeout(timer);
		const controller = new AbortController();
		pending = controller;
		const deadline = setTimeout(() => controller.abort(), 8_000);
		try {
			const catalog = await fetchApgCatalog(controller.signal);
			if (disposed) return;
			const key = JSON.stringify(catalog);
			if (key !== last) {
				last = key;
				onCatalog(catalog);
			}
		} finally {
			clearTimeout(deadline);
			pending = undefined;
			if (!disposed) timer = setTimeout(() => { void refresh(); }, intervalMs);
		}
	};
	void refresh();
	return { refresh, dispose() {
		disposed = true;
		pending?.abort();
		if (timer !== undefined) clearTimeout(timer);
	} };
}

/** Preferences belong to one signed-in account on this browser. A shared key would let the
 * next account inherit the previous account's palette choices, so the owner is part of the
 * key; guests share the `guest` slot because they have no stable identity. */
const palettePreferenceKey = (pluginId: string, owner = "") =>
	`${USER_PALETTE_STORAGE_PREFIX}${owner || "guest"}:${pluginId}`;
const preferences = new Map<string, boolean>();

export const isUserPaletteEnabled = (pluginId: string, owner = "") => {
	if (typeof localStorage === "undefined") return preferences.get(palettePreferenceKey(pluginId, owner)) ?? true;
	try {
		return localStorage.getItem(palettePreferenceKey(pluginId, owner)) !== "false";
	} catch {
		return preferences.get(palettePreferenceKey(pluginId, owner)) ?? true;
	}
};

export const setUserPaletteEnabled = (pluginId: string, enabled: boolean, owner = "") => {
	preferences.set(palettePreferenceKey(pluginId, owner), enabled);
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(palettePreferenceKey(pluginId, owner), enabled ? "true" : "false");
	} catch {
		// Storage can be unavailable in privacy modes; keep the in-memory UI state usable.
	}
};

/**
 * Reports palette-preference changes made by *other* tabs. Writes in this tab do not fire
 * `storage` events, so callers keep bumping their own revision after `setUserPaletteEnabled`.
 * `pluginId === null` means the other tab cleared storage, so every preference reverted.
 */
export const watchApgPalettePreferences = (
	listener: (pluginId: string | null) => void,
): (() => void) => {
	if (typeof window === "undefined") return () => {};
	const handler = (event: StorageEvent) => {
		if (event.key === null) {
			listener(null);
			return;
		}
		if (!event.key.startsWith(USER_PALETTE_STORAGE_PREFIX)) return;
		const rest = event.key.slice(USER_PALETTE_STORAGE_PREFIX.length);
		// Keys are `<owner>:<pluginId>`; keys written before the owner was added had no colon.
		const split = rest.indexOf(":");
		const pluginId = split === -1 ? rest : rest.slice(split + 1);
		if (pluginId) listener(pluginId);
	};
	window.addEventListener("storage", handler);
	return () => window.removeEventListener("storage", handler);
};

export const buildApgPaletteViews = (catalog: ApgCatalog, owner = ""): ApgPaletteView[] =>
	catalog.plugins.flatMap(({ manifest }) =>
		(manifest.contributes.palettes ?? []).map((palette) => ({
			...palette,
			pluginId: manifest.id,
			pluginName: manifest.name,
			scope: manifest.scope,
			toggleable: manifest.scope === "user",
			enabled: manifest.scope === "system" || isUserPaletteEnabled(manifest.id, owner),
		}))
	);

/** Native tool style a contributed preset selects. `opacity` is omitted when the
 * preset does not declare one, so the stroke keeps the host default instead of
 * being silently forced to some other value. */
export interface ApgBrushSelection {
	base: ApgBrushBase;
	color?: string;
	size?: number;
	opacity?: number;
}

/** A brush object only stays valid while it is still exactly what the current
 * catalog snapshot contributes: a revoked or edited preset cannot be applied
 * from a stale click. */
export const isApgBrushCurrent = (brush: ApgBrushView, brushes: readonly ApgBrushView[]): boolean =>
	brushes.some(
		(candidate) =>
			candidate.pluginId === brush.pluginId &&
			candidate.id === brush.id &&
			JSON.stringify(candidate) === JSON.stringify(brush),
	);

export const resolveApgBrushSelection = (brush: ApgBrushView): ApgBrushSelection => ({
	base: brush.base,
	...(brush.color !== undefined ? { color: brush.color } : {}),
	...(brush.size !== undefined ? { size: brush.size } : {}),
	...(brush.opacity !== undefined ? { opacity: brush.opacity } : {}),
});

export const buildApgBrushViews = (catalog: ApgCatalog): ApgBrushView[] =>
	catalog.plugins.flatMap(({ manifest }) =>
		manifest.scope === "system"
			? (manifest.contributes.brushes ?? []).map((brush) => ({ ...brush, pluginId: manifest.id, pluginName: manifest.name }))
			: []
	);

export interface ApgCommandView extends ApgCommandContribution {
	pluginId: string;
	pluginName: string;
	scope: ApgScope;
}

export interface ApgShortcutBinding {
	pluginId: string;
	command: string;
	label: string;
}

export interface ApgContributionIndex {
	brushes: ApgBrushView[];
	palettes: ApgPaletteView[];
	commands: ApgCommandView[];
	/**
	 * `Alt+Shift+<digit>` bindings for the contributions the host accepts right
	 * now. A `null` value means two or more enabled plugins claim the same
	 * shortcut, so the host refuses to guess which one the user meant.
	 */
	shortcuts: ReadonlyMap<string, ApgShortcutBinding | null>;
}

/**
 * Resolve every contribution the host accepts from one catalog snapshot.
 * The host re-derives this index on each snapshot, so disabling, updating or
 * uninstalling a plugin removes its commands, brushes and shortcuts without a
 * residual registration to clean up separately.
 */
export const buildApgContributionIndex = (
	catalog: ApgCatalog,
	isEnabled: (pluginId: string) => boolean = () => true,
	owner = ""
): ApgContributionIndex => {
	const commands: ApgCommandView[] = [];
	const shortcuts = new Map<string, ApgShortcutBinding | null>();
	for (const { manifest } of catalog.plugins) {
		if (!isEnabled(manifest.id)) continue;
		for (const command of manifest.contributes.commands ?? []) {
			commands.push({ ...command, pluginId: manifest.id, pluginName: manifest.name, scope: manifest.scope });
			if (!command.shortcut) continue;
			const binding: ApgShortcutBinding = { pluginId: manifest.id, command: command.id, label: command.label };
			shortcuts.set(command.shortcut, shortcuts.has(command.shortcut) ? null : binding);
		}
	}
	return {
		// Brushes are system-only, so a personal preference never hides them; the filter only
		// reacts to an id the caller no longer considers active (for example while reconciling).
		brushes: buildApgBrushViews(catalog).filter((brush) => isEnabled(brush.pluginId)),
		// Palettes stay listed when the user switches them off: `enabled` hides the swatches,
		// while the entry itself carries the toggle that turns them back on. Global revocation
		// removes the plugin from the catalog entirely.
		palettes: buildApgPaletteViews(catalog, owner),
		commands,
		shortcuts,
	};
};
