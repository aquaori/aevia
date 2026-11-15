// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { SceneCore, sortInSteps } from "./sceneCore";
import { applyRenderIRDelta } from "./renderIR";
import { decodeRenderIR, encodeRenderIR } from "./renderIRCodec";

describe("SceneCore without browser rendering", () => {
	it("sorts large out-of-order input across multiple slices", () => {
		const values = Array.from({ length: 5000 }, (_, index) => ({ value: (4999 - index) % 113, index }));
		const expected = [...values].sort((a, b) => a.value - b.value);
		const steps = sortInSteps(values, (a, b) => a.value - b.value);
		let slices = 0;
		while (!steps.next().done) slices += 1;
		expect(slices).toBeGreaterThan(1);
		expect(values).toEqual(expected);
	});
	it("exports only newly appended atoms in the render delta", () => {
		const core = new SceneCore();
		const create: SceneOperationEnvelopeV2 = {
			schemaVersion: 2, opId: "create-long", elementId: "long", actorId: "author", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "long",
			kind: "element.create", payload: {
				descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 4 } },
				points: Array.from({ length: 100 }, (_, i) => ({ x: i / 200, y: 0.5, p: 0.5, lamport: i + 1 })),
				isComplete: false,
			},
		};
		core.applyOperation(create);
		const before = core.getRenderIR();
		core.applyOperation({ ...create, kind: "element.append", opId: "append-long", lamport: 101, payload: { sourceStart: 100, points: [{ x: 0.51, y: 0.5, p: 0.5, lamport: 101 }], isComplete: false } });
		const delta = core.getRenderIRDelta(before)!;
		expect(delta.upserted).toHaveLength(1);
		const afterAppend = applyRenderIRDelta(before, delta);
		expect(afterAppend).toEqual(core.getRenderIR());
		core.applyOperation({ ...create, kind: "element.append", opId: "finish-long", lamport: 102, payload: { sourceStart: 101, points: [], isComplete: true } });
		const finish = core.getRenderIRDelta(afterAppend)!;
		expect(finish.upserted).toHaveLength(1);
		expect(applyRenderIRDelta(afterAppend, finish)).toEqual(core.getRenderIR());
	});
	it("accepts legacy stickers and rejects unknown versioned assets", () => {
		const core = new SceneCore();
		const create: SceneOperationEnvelopeV2 = {
			schemaVersion: 2, opId: "sticker", elementId: "sticker", actorId: "author", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "sticker",
			kind: "element.create", payload: { descriptor: { elementKind: "sticker", toolId: "sticker", recipeId: "bitmap", style: { color: "#000", size: 4 }, sticker: "🎉" } },
		};
		core.applyOperation(create);
		const revision = core.getSceneRevision();
		core.applyOperation(create);
		expect(core.getSceneRevision()).toBe(revision);
		expect(core.getRenderIR().items[0]?.atom).toMatchObject({ primitive: "bitmap", value: "🎉" });
		core.applyOperation({ ...create, opId: "unknown", elementId: "unknown", payload: { descriptor: { ...create.payload.descriptor, asset: { key: "unknown", version: 1 } } } });
		expect(core.needsResync).toBe(true);
	});

	it("folds operations and queries geometry without a DOM or Canvas", () => {
		const core = new SceneCore();
		const create: SceneOperationEnvelopeV2 = {
			schemaVersion: 2, opId: "create", elementId: "stroke", actorId: "author", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "create",
			kind: "element.create", payload: {
				descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#111", size: 4, strokePattern: "solid" } },
				points: [{ x: 0.1, y: 0.1, p: 0.5, lamport: 1 }, { x: 0.5, y: 0.5, p: 0.5, lamport: 2 }], isComplete: true,
			},
		};
		core.applyOperation(create);
		expect(core.exportFlatPoints()).toHaveLength(2);
		const revision = core.getSceneRevision();
		expect(core.queryElements({ minX: 0, minY: 0, maxX: 600, maxY: 600, width: 600, height: 600 }, 1000, 1000)).toContain("stroke");
		const initial = core.getRenderIR();
		core.applyOperation({
			...create, opId: "move", lamport: 3, historyGroupId: "move", kind: "element.transform",
			payload: { targets: [{ elementId: "stroke", deltaMatrix: [1, 0, 0, 1, 0.1, 0] }] },
		});
		expect(core.getSceneRevision()).toBeGreaterThan(revision);
		const delta = core.getRenderIRDelta(initial)!;
		const moved = core.getRenderIR();
		expect(delta.upserted.length).toBeGreaterThan(0);
		expect(applyRenderIRDelta(initial, delta)).toEqual(moved);
		expect(() => applyRenderIRDelta(moved, delta)).toThrow("revision mismatch");
		expect(initial.items[0]?.matrix).not.toEqual(moved.items[0]?.matrix);
		expect(decodeRenderIR(encodeRenderIR(moved))).toEqual(moved);
		expect(decodeRenderIR(encodeRenderIR(delta))).toEqual(delta);
		const corrupt = encodeRenderIR(moved);
		corrupt[corrupt.length - 1] ^= 1;
		expect(() => decodeRenderIR(corrupt)).toThrow("Corrupt Render IR");
		const handle = moved.items[0]!.handle;
		expect(core.resolveAtomHandle(handle)?.id).toBe(moved.items[0]!.id);
		core.reset();
		core.applyOperation(create);
		expect(core.resolveAtomHandle(handle)).toBeNull();
		expect(new SceneCore().resolveAtomHandle(handle)).toBeNull();
	});
});
