// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseApgCatalog } from "./apgCatalog";
import { acceptApgStateNotice } from "./apgStateNotice";

const plugin = (overrides: Record<string, unknown> = {}) => ({
	enabled: true,
	digest: "a".repeat(64),
	manifest: {
		manifestVersion: 2,
		apiVersion: 1,
		id: "acme.counter",
		name: "Counter",
		version: "1.0.0",
		scope: "system",
		main: "main.js",
		permissions: ["storage.shared"],
		contributes: { commands: [{ id: "increment", label: "Increment" }] },
		stateSchemaVersion: 1,
	},
	program: "void 0",
	...overrides,
});

const catalog = parseApgCatalog({ version: 1, plugins: [plugin()] })!;

describe("APG state change notices", () => {
	it("accepts only a newer revision of the enabled shared-storage plugin", () => {
		expect(catalog).not.toBeNull();
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 2 }, catalog)).toEqual({
			pluginId: "acme.counter",
			revision: 2,
		});
		// A duplicate or out-of-order notice must not clear newer derived UI.
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 2 }, catalog, { "acme.counter": 2 })).toBeNull();
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 1 }, catalog, { "acme.counter": 5 })).toBeNull();
	});

	it("ignores notices for a replaced digest, a missing plugin or a malformed payload", () => {
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "b".repeat(64), revision: 2 }, catalog)).toBeNull();
		expect(acceptApgStateNotice({ pluginId: "acme.other", digest: "a".repeat(64), revision: 2 }, catalog)).toBeNull();
		expect(acceptApgStateNotice({ pluginId: "acme.counter", revision: 2 }, catalog)).toBeNull();
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 0 }, catalog)).toBeNull();
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 1.5 }, catalog)).toBeNull();
		expect(acceptApgStateNotice("not-a-notice", catalog)).toBeNull();
		expect(acceptApgStateNotice(null, catalog)).toBeNull();
	});

	it("ignores a user-scope plugin or one without shared storage", () => {
		const userCatalog = parseApgCatalog({
			version: 1,
			plugins: [
				{
					...plugin(),
					manifest: {
						...plugin().manifest,
						scope: "user",
						permissions: ["ui.preview"],
						contributes: { commands: [{ id: "show", label: "Show" }] },
						stateSchemaVersion: 0,
					},
				},
			],
		})!;
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 2 }, userCatalog)).toBeNull();
		const readOnlyCatalog = parseApgCatalog({
			version: 1,
			plugins: [{ ...plugin(), manifest: { ...plugin().manifest, permissions: ["scene.read"], stateSchemaVersion: 0 } }],
		})!;
		expect(acceptApgStateNotice({ pluginId: "acme.counter", digest: "a".repeat(64), revision: 2 }, readOnlyCatalog)).toBeNull();
	});
});
