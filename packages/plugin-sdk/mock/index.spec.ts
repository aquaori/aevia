import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "../index";
import { createApgMockHost } from "./index";

const program = (relativePath: string) =>
	readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("APG mock host", () => {
	it("runs the official shared-counter program outside the browser", () => {
		const host = createApgMockHost();
		host.load(program("plugins/official/shared-counter/main.js"));
		expect(host.commands).toEqual(["increment", "read"]);

		expect(host.runCommand("increment").preview).toBe("Counter: 1");
		expect(host.sharedState).toEqual({ revision: 1, value: 1 });
		expect(host.runCommand("increment").preview).toBe("Counter: 2");
		expect(host.sharedState).toEqual({ revision: 2, value: 2 });
		expect(host.writes).toEqual([2]);
		expect(host.runCommand("read").preview).toBe("Counter: 2");
		expect(host.writes).toEqual([]);
		expect(host.lastCall()).toMatchObject({ command: "read", preview: "Counter: 2" });
	});

	it("runs the official scene-export program and records the requested file", () => {
		const scene: SceneSnapshot = {
			revision: 4,
			truncated: false,
			items: [
				{ elementId: "a", primitive: "shape", bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 } },
				{ elementId: "a", primitive: "shape", bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 } },
			],
		};
		const host = createApgMockHost({ scene });
		host.load(program("plugins/official/scene-export/main.js"));
		expect(host.commands).toEqual(["export"]);
		const call = host.runCommand("export");
		expect(call.preview).toBe("Scene exported");
		expect(call.downloads).toHaveLength(1);
		expect(call.downloads[0]!.name).toBe("aevia-scene.json");
		expect(call.downloads[0]!.mime).toBe("application/json");
		expect(JSON.parse(call.downloads[0]!.text)).toEqual({ revision: 4, truncated: false, elements: 2, primitives: { shape: 2 } });
		// A plugin without a scene gets a message instead of an empty "successful" export.
		const empty = createApgMockHost();
		empty.load(program("plugins/official/scene-export/main.js"));
		expect(empty.runCommand("export").preview).toBe("Scene unavailable");
		expect(empty.downloads).toEqual([]);
	});

	it("runs the official scene-inspector program against a fixed snapshot", () => {
		const scene: SceneSnapshot = {
			revision: 7,
			truncated: false,
			items: [
				{ elementId: "a", primitive: "shape", bounds: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5, width: 0.5, height: 0.5 } },
				{ elementId: "a", primitive: "shape", bounds: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5, width: 0.5, height: 0.5 } },
				{ elementId: "b", primitive: "stroke", bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 } },
			],
		};
		const host = createApgMockHost({ scene });
		host.load(program("plugins/official/scene-inspector/main.js"));
		expect(host.runCommand("inspect").preview).toBe("Visible elements: 2");

		const truncated = createApgMockHost({ scene: { ...scene, truncated: true } });
		truncated.load(program("plugins/official/scene-inspector/main.js"));
		expect(truncated.runCommand("inspect").preview).toBe("Visible elements: 2 (partial snapshot)");
	});

	it("runs the official shape-template program and records its native bundle", () => {
		const body = {
			kind: "shape.create" as const,
			shape: "rounded-rectangle" as const,
			start: { x: 0.2, y: 0.2 },
			end: { x: 0.6, y: 0.5 },
			color: "#2563EB",
			size: 2,
			fillColor: "#F8FAFC",
		};
		const resource = { shapes: [body, { ...body, shape: "rectangle" as const }] };
		const host = createApgMockHost({ resource });
		host.load(program("plugins/official/shape-template/main.js"));
		const call = host.runCommand("insert");
		expect(call.preview).toBe("Card inserted");
		expect(call.mutations).toEqual(resource.shapes);

		const broken = createApgMockHost({ resource: { shapes: { kind: "nope" } } });
		broken.load(program("plugins/official/shape-template/main.js"));
		expect(() => broken.runCommand("insert")).toThrow("Invalid card template");
	});

	it("rejects unknown commands and duplicate registrations", () => {
		const host = createApgMockHost();
		host.load(program("plugins/official/shared-counter/main.js"));
		expect(() => host.runCommand("missing")).toThrow("APG mock: unknown command missing");
		expect(() =>
			host.load('apg.registerCommand("increment", () => {});'),
		).toThrow("APG mock: duplicate command increment");
	});
});
