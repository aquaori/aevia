import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildApgBrushViews,
	buildApgContributionIndex,
	buildApgPaletteViews,
	fetchApgCatalog,
	isApgBrushCurrent,
	resolveApgBrushSelection,
	isUserPaletteEnabled,
	parseApgCatalog,
	watchApgPalettePreferences,
	setUserPaletteEnabled,
	watchApgCatalog,
} from "./apgCatalog";

const validCatalog = {
	version: 1,
	plugins: [
		{
			enabled: true,
			manifest: {
				manifestVersion: 1,
				id: "acme.system-brushes",
				name: "Acme Brushes",
				version: "1.2.3",
				scope: "system",
				contributes: {
					palettes: [{ id: "brand", label: "Brand", colors: ["#112233", "#AABBCC"] }],
					brushes: [{ id: "marker", label: "Marker", base: "highlighter", color: "#AABBCC", size: 12, opacity: 0.5 }],
				},
			},
		},
		{
			enabled: true,
			manifest: {
				manifestVersion: 1,
				id: "acme.personal-colors",
				name: "Personal Colors",
				version: "2.0.0",
				scope: "user",
				contributes: {
					palettes: [{ id: "pastel", label: "Pastel", colors: ["#FFEEDD"] }],
				},
			},
		},
	],
} as const;

/** Mutating a catalog is only done to build deliberately invalid input for the parser. */
type MutableCatalog = {
	plugins: Array<{
		manifest: {
			contributes: {
				brushes: Array<Record<string, unknown> & { size?: number }>;
				palettes: Array<{ id: string; label: string; colors: string[] }>;
			};
		};
	}>;
};

describe("APG catalog", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("accepts the strict v1 contract and exposes only system brush presets", () => {
		const catalog = parseApgCatalog(validCatalog);
		expect(catalog).not.toBeNull();
		expect(buildApgBrushViews(catalog!)).toEqual([
			expect.objectContaining({ pluginId: "acme.system-brushes", id: "marker", base: "highlighter", opacity: 0.5 }),
		]);
		expect(buildApgPaletteViews(catalog!)).toEqual([
			expect.objectContaining({ pluginId: "acme.system-brushes", toggleable: false, enabled: true }),
			expect.objectContaining({ pluginId: "acme.personal-colors", toggleable: true, enabled: true }),
		]);
	});

	it("accepts catalog integrity metadata and v2 executable manifests", () => {
		const digest = "a".repeat(64);
		const manifest = { manifestVersion: 2, apiVersion: 1, id: "acme.command", name: "Command", version: "1.0.0", scope: "user", main: "main.js", permissions: ["ui.preview"], contributes: { commands: [{ id: "hello", label: "Hello" }] } };
		const plugin = { enabled: true, manifest, program: "function activate() {}", digest, signedBy: "acme" };
		expect(parseApgCatalog({ version: 1, revision: digest, plugins: [plugin] })?.plugins[0]).toEqual(plugin);
		expect(parseApgCatalog({ version: 1, plugins: [{ ...plugin, manifest: { ...manifest, permissions: ["storage.shared"] } }] })).toBeNull();
		expect(parseApgCatalog({ version: 1, plugins: [{ ...plugin, manifest: { ...manifest, permissions: ["scene.write"] } }] })).toBeNull();
		expect(parseApgCatalog({ version: 1, plugins: [{ ...plugin, program: undefined }] })).toBeNull();
		expect(parseApgCatalog({ version: 1, plugins: [{ ...plugin, manifest: { ...manifest, apiVersion: 99 } }] })).toBeNull();
	});

	it("refreshes and revokes the catalog, suppresses duplicate snapshots, and stops on disposal", async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => validCatalog });
			vi.stubGlobal("fetch", fetcher);
			const publish = vi.fn();
			const watcher = watchApgCatalog(publish, 100);
			await vi.advanceTimersByTimeAsync(0);
			expect(publish).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(100);
			expect(publish).toHaveBeenCalledTimes(1);
			fetcher.mockRejectedValue(new Error("offline"));
			await vi.advanceTimersByTimeAsync(100);
			expect(publish).toHaveBeenLastCalledWith({ version: 1, plugins: [] });
			watcher.dispose();
			const count = fetcher.mock.calls.length;
			await vi.advanceTimersByTimeAsync(1000);
			expect(fetcher).toHaveBeenCalledTimes(count);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("rejects extra keys and user-scope brushes", () => {
		expect(parseApgCatalog({ ...validCatalog, extra: true })).toBeNull();
		const userBrush = structuredClone(validCatalog) as unknown as MutableCatalog;
		userBrush.plugins[1].manifest.contributes.brushes = [{ id: "bad", label: "Bad", base: "pen" }];
		expect(parseApgCatalog(userBrush)).toBeNull();
	});

	it("rejects duplicate ids and catalog contribution limits", () => {
		const duplicatePlugin = structuredClone(validCatalog) as unknown as MutableCatalog;
		duplicatePlugin.plugins.push(structuredClone(duplicatePlugin.plugins[0]));
		expect(parseApgCatalog(duplicatePlugin)).toBeNull();

		const duplicatePalette = structuredClone(validCatalog) as unknown as MutableCatalog;
		duplicatePalette.plugins[0].manifest.contributes.palettes.push({ id: "brand", label: "Again", colors: ["#123456"] });
		expect(parseApgCatalog(duplicatePalette)).toBeNull();

		const tooManyColors = structuredClone(validCatalog) as unknown as MutableCatalog;
		tooManyColors.plugins[0].manifest.contributes.palettes[0].colors = Array.from({ length: 65 }, () => "#123456");
		expect(parseApgCatalog(tooManyColors)).toBeNull();

		const oversizedBrush = structuredClone(validCatalog) as unknown as MutableCatalog;
		oversizedBrush.plugins[0].manifest.contributes.brushes[0].size = 31;
		expect(parseApgCatalog(oversizedBrush)).toBeNull();
	});

	it("derives one contribution index and refuses ambiguous shortcuts", () => {
		const commandPlugin = (id: string, shortcut: string, scope: "system" | "user" = "system") => ({
			enabled: true,
			manifest: {
				manifestVersion: 2,
				apiVersion: 1,
				id,
				name: id,
				version: "1.0.0",
				scope,
				main: "main.js",
				permissions: ["ui.preview"],
				contributes: { commands: [{ id: "run", label: id, shortcut }] },
			},
			program: "void 0",
		});
		const catalog = parseApgCatalog({
			version: 1,
			plugins: [
				commandPlugin("acme.a", "Alt+Shift+1"),
				commandPlugin("acme.b", "Alt+Shift+1"),
				commandPlugin("acme.c", "Alt+Shift+2"),
				commandPlugin("acme.d", "Alt+Shift+3", "user"),
			],
		})!;
		expect(catalog).not.toBeNull();
		const index = buildApgContributionIndex(catalog);
		expect(index.commands).toHaveLength(4);
		expect(index.commands[0]).toEqual(expect.objectContaining({ pluginId: "acme.a", id: "run", scope: "system" }));
		// Two plugins claim Alt+Shift+1: binding is withheld instead of picking one.
		expect(index.shortcuts.get("Alt+Shift+1")).toBeNull();
		expect(index.shortcuts.get("Alt+Shift+2")).toEqual({ pluginId: "acme.c", command: "run", label: "acme.c" });
		expect(index.shortcuts.has("Alt+Shift+9")).toBe(false);
		// Disabling a user plugin (or a host policy change) withdraws its contributions.
		const narrowed = buildApgContributionIndex(catalog, (id) => id !== "acme.d");
		expect(narrowed.commands.map((command) => command.pluginId)).toEqual(["acme.a", "acme.b", "acme.c"]);
		expect(narrowed.shortcuts.has("Alt+Shift+3")).toBe(false);
		expect(buildApgContributionIndex(catalog, () => false).commands).toEqual([]);
	});

	it("keeps contributed ids namespaced per plugin instead of merging them", () => {
		const brushPlugin = (id: string) => ({
			enabled: true,
			manifest: {
				manifestVersion: 2,
				apiVersion: 1,
				id,
				name: id,
				version: "1.0.0",
				scope: "system" as const,
				permissions: ["scene.read"],
				contributes: {
					brushes: [{ id: "marker", label: "Marker", base: "highlighter" as const, size: 12 }],
					palettes: [{ id: "studio", label: "Studio", colors: ["#112233"] }],
				},
			},
		});
		const userPlugin = {
			enabled: true,
			manifest: {
				manifestVersion: 2,
				apiVersion: 1,
				id: "acme.user",
				name: "acme.user",
				version: "1.0.0",
				scope: "user" as const,
				contributes: { palettes: [{ id: "studio", label: "My Studio", colors: ["#445566"] }] },
			},
		};
		const catalog = parseApgCatalog({ version: 1, plugins: [brushPlugin("acme.a"), brushPlugin("acme.b"), userPlugin] })!;
		expect(catalog).not.toBeNull();
		// The same plain id in two plugins is two distinct contributions: the UI identifies them
		// by plugin id, so neither shadows the other.
		const index = buildApgContributionIndex(catalog);
		expect(index.brushes.map((brush) => `${brush.pluginId}:${brush.id}`)).toEqual(["acme.a:marker", "acme.b:marker"]);
		expect(index.palettes.map((palette) => `${palette.pluginId}:${palette.id}`)).toEqual(["acme.a:studio", "acme.b:studio", "acme.user:studio"]);
		// Commands follow the caller's enablement, but a palette entry is never dropped: it owns
		// the toggle that re-enables its plugin in that same UI.
		const withoutUser = buildApgContributionIndex(catalog, (id) => id !== "acme.user");
		expect(withoutUser.palettes.map((palette) => palette.pluginId)).toEqual(["acme.a", "acme.b", "acme.user"]);
	});

	it("keeps a switched-off personal palette listed so it can be turned back on", () => {
		const catalog = parseApgCatalog(validCatalog)!;
		setUserPaletteEnabled("acme.personal-colors", false);
		const disabled = buildApgContributionIndex(catalog).palettes.find((palette) => palette.pluginId === "acme.personal-colors");
		expect(disabled?.enabled).toBe(false);
		expect(disabled?.toggleable).toBe(true);
		setUserPaletteEnabled("acme.personal-colors", true);
		expect(buildApgContributionIndex(catalog).palettes.find((palette) => palette.pluginId === "acme.personal-colors")?.enabled).toBe(true);
	});

	it("maps a preset to a native tool selection and refuses stale presets", () => {
		const catalog = parseApgCatalog(validCatalog)!;
		const [marker] = buildApgBrushViews(catalog);
		expect(resolveApgBrushSelection(marker)).toEqual({
			base: "highlighter",
			color: "#AABBCC",
			size: 12,
			opacity: 0.5,
		});
		expect(isApgBrushCurrent(marker, [marker])).toBe(true);
		// Revoked (empty catalog) or edited presets must not be applied from a stale click.
		expect(isApgBrushCurrent(marker, [])).toBe(false);
		expect(isApgBrushCurrent({ ...marker, opacity: 0.9 }, [marker])).toBe(false);
		expect(isApgBrushCurrent({ ...marker, pluginId: "acme.other" }, [marker])).toBe(false);

		// A preset that declares nothing leaves tool, colour, size and opacity at host defaults.
		const penOnly = {
			id: "clean",
			label: "Clean",
			base: "pen" as const,
			pluginId: "acme.system-brushes",
			pluginName: "Acme Brushes",
		};
		expect(resolveApgBrushSelection(penOnly)).toEqual({ base: "pen" });
		expect(isApgBrushCurrent(penOnly, [penOnly])).toBe(true);
	});

	it("persists personal palette choice in browser storage", () => {
		expect(isUserPaletteEnabled("acme.personal-colors")).toBe(true);
		setUserPaletteEnabled("acme.personal-colors", false);
		expect(isUserPaletteEnabled("acme.personal-colors")).toBe(false);
		const catalog = parseApgCatalog(validCatalog)!;
		expect(buildApgPaletteViews(catalog).find((item) => item.pluginId === "acme.personal-colors")?.enabled).toBe(false);
	});

	it("keeps personal palettes usable when browser storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
		expect(isUserPaletteEnabled("acme.personal-colors")).toBe(true);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
		expect(() => setUserPaletteEnabled("acme.personal-colors", false)).not.toThrow();
	});

	it("adopts palette switches made in another tab and stops on dispose", () => {
		const seen: Array<string | null> = [];
		const stop = watchApgPalettePreferences((pluginId) => seen.push(pluginId));
		window.dispatchEvent(new StorageEvent("storage", { key: "aevia.apg.palette.enabled.acme.personal-colors", newValue: "false" }));
		window.dispatchEvent(new StorageEvent("storage", { key: "unrelated.key", newValue: "x" }));
		window.dispatchEvent(new StorageEvent("storage", { key: "aevia.apg.palette.enabled." }));
		window.dispatchEvent(new StorageEvent("storage", { key: null }));
		stop();
		window.dispatchEvent(new StorageEvent("storage", { key: "aevia.apg.palette.enabled.acme.personal-colors", newValue: "true" }));
		expect(seen).toEqual(["acme.personal-colors", null]);
	});

	it("falls back to an empty catalog when the endpoint is unavailable or malformed", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
		await expect(fetchApgCatalog()).resolves.toEqual({ version: 1, plugins: [] });

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 1, plugins: [{ enabled: false }] }) }));
		await expect(fetchApgCatalog()).resolves.toEqual({ version: 1, plugins: [] });
		vi.unstubAllGlobals();
	});

	it("keeps one account's palette switches out of another account", () => {
		const catalog = parseApgCatalog(validCatalog);
		if (!catalog) throw new Error("catalog did not parse");
		const pluginId = "acme.personal-colors";
		expect(isUserPaletteEnabled(pluginId, "user-a")).toBe(true);
		setUserPaletteEnabled(pluginId, false, "user-a");
		expect(isUserPaletteEnabled(pluginId, "user-a")).toBe(false);
		// A second account on the same browser must not inherit the switch.
		expect(isUserPaletteEnabled(pluginId, "user-b")).toBe(true);
		expect(localStorage.getItem("aevia.apg.palette.enabled.user-a:acme.personal-colors")).toBe("false");
		expect(localStorage.getItem("aevia.apg.palette.enabled.user-b:acme.personal-colors")).toBeNull();

		const forA = buildApgContributionIndex(catalog, () => true, "user-a").palettes.find(p => p.pluginId === pluginId);
		const forB = buildApgContributionIndex(catalog, () => true, "user-b").palettes.find(p => p.pluginId === pluginId);
		expect(forA?.enabled).toBe(false);
		expect(forB?.enabled).toBe(true);
		// Cleanup so later cases see the default.
		setUserPaletteEnabled(pluginId, true, "user-a");
	});

});
