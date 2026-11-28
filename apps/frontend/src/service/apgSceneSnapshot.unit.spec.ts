// @vitest-environment node
import { describe, expect, it } from "vitest";
import { APG_SCENE_SNAPSHOT_LIMIT, buildApgSceneSnapshot, selectApgSceneSnapshot } from "./apgSceneSnapshot";

const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 };

const item = (index: number) => ({
	atom: { elementId: `el-${index}`, primitive: "stroke", bounds },
});

describe("buildApgSceneSnapshot", () => {
	it("caps the snapshot and flags truncation for a large scene", () => {
		const frame = { revision: 7, items: Array.from({ length: APG_SCENE_SNAPSHOT_LIMIT + 5 }, (_, index) => item(index)) };
		const snapshot = buildApgSceneSnapshot(frame)!;
		expect(snapshot.revision).toBe(7);
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.items).toHaveLength(APG_SCENE_SNAPSHOT_LIMIT);
		expect(snapshot.items[0]).toEqual({ elementId: "el-0", primitive: "stroke", bounds });
		expect(snapshot.items.at(-1)?.elementId).toBe(`el-${APG_SCENE_SNAPSHOT_LIMIT - 1}`);
	});

	it("does not invent truncation for a scene that fits", () => {
		const snapshot = buildApgSceneSnapshot({ revision: 2, items: [item(0), item(1)] })!;
		expect(snapshot.truncated).toBe(false);
		expect(snapshot.items).toHaveLength(2);
	});

	it("drops detached metadata that is not complete instead of sending half-shaped atoms", () => {
		const snapshot = buildApgSceneSnapshot({
			revision: 3,
			items: [
				item(0),
				{ atom: { elementId: "no-primitive", bounds } },
				{ atom: { elementId: "bad-bounds", primitive: "shape", bounds: { minX: 0 } } },
				{ atom: { elementId: "missing-bounds", primitive: "shape" } },
				{},
			],
		})!;
		expect(snapshot.items.map(entry => entry.elementId)).toEqual(["el-0"]);
		expect(snapshot.revision).toBe(3);
	});

	it("returns null for a frame that is not Render IR", () => {
		expect(buildApgSceneSnapshot(null)).toBeNull();
		expect(buildApgSceneSnapshot({ revision: 1 } as never)).toBeNull();
	});

	it("reads the worker frame, the fallback engine, or neither, but never an invented empty scene", () => {
		const workerFrame = { revision: 9, items: [item(0)] };
		const fallbackFrame = { revision: 4, items: [item(1), item(2)] };
		expect(selectApgSceneSnapshot(workerFrame, true, fallbackFrame)).toEqual(buildApgSceneSnapshot(workerFrame));
		expect(selectApgSceneSnapshot(null, false, fallbackFrame)).toEqual(buildApgSceneSnapshot(fallbackFrame));
		// A worker that is enabled but returned nothing is a failure, not an empty scene.
		expect(selectApgSceneSnapshot(null, true, fallbackFrame)).toBeNull();
		expect(selectApgSceneSnapshot(undefined, false, null)).toBeNull();
	});
});
