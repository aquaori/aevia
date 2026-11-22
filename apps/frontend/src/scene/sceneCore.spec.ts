// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { SceneCore, sortInSteps } from "./sceneCore";
import { applyRenderIRDelta } from "./renderIR";
import { decodeRenderIR, encodeRenderIR } from "./renderIRCodec";

describe("SceneCore without browser rendering", () => {
	it("appends an interleaved stroke without rebuilding it when its own history is ordered", () => {
		const core = new SceneCore();
		const reference = new SceneCore();
		const create: SceneOperationEnvelopeV2 = {
			schemaVersion: 2, opId: "create-a", elementId: "a", actorId: "a", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "a", kind: "element.create",
			payload: { descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 4 } }, points: [{ x: .1, y: .2, p: .5, lamport: 1 }] },
		};
		const other: SceneOperationEnvelopeV2 = { ...create, opId: "create-b", elementId: "b", actorId: "b", lamport: 10, historyGroupId: "b" };
		const append: SceneOperationEnvelopeV2 = { ...create, opId: "append-a", lamport: 2, kind: "element.append", payload: { sourceStart: 1, points: [{ x: .3, y: .4, p: .5, lamport: 2 }] } };
		const rebuild = vi.spyOn(core as unknown as { rebuildElementsSteps: (...args: never[]) => Generator<void> }, "rebuildElementsSteps");
		core.applyOperation(create);
		core.applyOperation(other);
		core.applyOperation(append);
		reference.applyOperation(create);
		reference.applyOperation(append);
		reference.applyOperation(other);
		expect(rebuild).not.toHaveBeenCalled();
		expect(core.sceneHash()).toBe(reference.sceneHash());
		expect(core.getElementPoints("a")).toEqual(reference.getElementPoints("a"));
		const style: SceneOperationEnvelopeV2 = { ...create, opId: "style-a", lamport: 4, kind: "element.style", payload: { style: { color: "#f00" } } };
		const earlierAppend: SceneOperationEnvelopeV2 = { ...append, opId: "append-earlier", lamport: 3, payload: { sourceStart: 2, points: [{ x: .5, y: .6, p: .5, lamport: 3 }], isComplete: true } };
		core.applyOperation(style);
		rebuild.mockClear();
		core.applyOperation(earlierAppend);
		reference.applyOperation(earlierAppend);
		reference.applyOperation(style);
		expect(rebuild).toHaveBeenCalled();
		expect(core.sceneHash()).toBe(reference.sceneHash());
	});
	it("retains orphan text through quarantine and applies it if its create arrives later", () => {
		const core = new SceneCore();
		const common = { schemaVersion: 2 as const, elementId: "text", actorId: "author", roomId: "room", pageId: 0 };
		core.applyOperation({ ...common, opId: "patch", lamport: 2, historyGroupId: "patch", kind: "text.patch", payload: { patches: [{ type: "insert", charId: "a", afterId: null, grapheme: "A" }] } });
		expect(core.hasPendingDependencies()).toBe(true);
		expect(core.quarantineMissingElements()).toEqual(["text"]);
		expect(core.hasPendingDependencies()).toBe(false);
		expect(core.hasQuarantinedElements()).toBe(true);
		core.applyOperation({ ...common, opId: "create", lamport: 1, historyGroupId: "create", kind: "element.create", payload: { descriptor: { elementKind: "text", toolId: "text", recipeId: "glyph", style: { color: "#000", size: 2 }, box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }, text: "" } } });
		expect(core.hasQuarantinedElements()).toBe(false);
		expect(core.getTextEditorState("text")?.characters.map((character) => character.grapheme).join("")).toBe("A");
	});
	it("keeps an existing stroke's missing point range eligible for resync", () => {
		const core = new SceneCore();
		const common = { schemaVersion: 2 as const, elementId: "stroke", actorId: "author", roomId: "room", pageId: 0 };
		core.applyOperation({ ...common, opId: "create", lamport: 1, historyGroupId: "create", kind: "element.create", payload: { descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 2 } }, points: [{ x: .1, y: .2, p: .5, lamport: 1 }] } });
		core.applyOperation({ ...common, opId: "append", lamport: 2, historyGroupId: "append", kind: "element.append", payload: { sourceStart: 3, points: [{ x: .2, y: .3, p: .5, lamport: 2 }] } });
		expect(core.quarantineMissingElements()).toEqual([]);
		expect(core.hasPendingDependencies()).toBe(true);
	});
	it("retains an orphan stroke append and applies it after its create arrives", () => {
		const core = new SceneCore();
		const common = { schemaVersion: 2 as const, elementId: "stroke", actorId: "author", roomId: "room", pageId: 0 };
		core.applyOperation({ ...common, opId: "append", lamport: 2, historyGroupId: "append", kind: "element.append", payload: { sourceStart: 1, points: [{ x: .3, y: .4, p: .5, lamport: 2 }], isComplete: true } });
		expect(core.quarantineMissingElements()).toEqual(["stroke"]);
		expect(core.hasPendingDependencies()).toBe(false);
		core.applyOperation({ ...common, opId: "create", lamport: 1, historyGroupId: "create", kind: "element.create", payload: { descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 2 } }, points: [{ x: .1, y: .2, p: .5, lamport: 1 }] } });
		expect(core.hasQuarantinedElements()).toBe(false);
		expect(core.hasPendingDependencies()).toBe(false);
		expect(core.getStats().visibleAtoms).toBeGreaterThan(0);
	});
	it("retains more than 1024 operations whose element create arrives later", () => {
		const core = new SceneCore();
		const common = { schemaVersion: 2 as const, actorId: "author", roomId: "room", pageId: 0 };
		for (let i = 0; i < 1100; i++) {
			core.applyOperation({ ...common, opId: `stroke-${i}`, elementId: "stroke", lamport: i + 1, historyGroupId: `stroke-${i}`, kind: "element.append", payload: { sourceStart: i, points: [{ x: (i % 100) / 100, y: .2, p: .5, lamport: i + 1 }], isComplete: i === 1099 } });
			core.applyOperation({ ...common, opId: `text-${i}`, elementId: "text", lamport: i + 1, historyGroupId: `text-${i}`, kind: "text.patch", payload: { patches: [{ type: "insert", charId: `char-${i}`, afterId: i ? `char-${i - 1}` : null, grapheme: "A" }] } });
		}
		expect(core.needsResync).toBe(false);
		expect(new Set(core.quarantineMissingElements())).toEqual(new Set(["stroke", "text"]));
		const restore = core.applyOperationSteps({ ...common, opId: "stroke-create", elementId: "stroke", lamport: 1101, historyGroupId: "stroke-create", kind: "element.create", payload: { descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 2 } }, points: [] } });
		let slices = 0;
		while (!restore.next().done) slices++;
		expect(slices).toBeGreaterThan(1);
		core.applyOperation({ ...common, opId: "text-create", elementId: "text", lamport: 1101, historyGroupId: "text-create", kind: "element.create", payload: { descriptor: { elementKind: "text", toolId: "text", recipeId: "glyph", style: { color: "#000", size: 2 }, box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 } } } });
		expect(core.hasPendingDependencies()).toBe(false);
		expect(core.hasQuarantinedElements()).toBe(false);
		expect(core.getTextEditorState("text")?.characters).toHaveLength(1100);
		expect(core.getStats().visibleAtoms).toBeGreaterThan(1000);
	});
	it("restores a valid element checkpoint and invalidates it when earlier history changes", () => {
		const core = new SceneCore();
		const reference = new SceneCore();
		(reference as unknown as { maybeCheckpointElement: () => Generator<void> }).maybeCheckpointElement = function* () {};
		const create: SceneOperationEnvelopeV2 = {
			schemaVersion: 2, opId: "create", elementId: "stroke", actorId: "author", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "create", kind: "element.create",
			payload: { descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 4 } }, points: [{ x: .1, y: .2, p: .5, lamport: 1 }] },
		};
		const apply = (op: SceneOperationEnvelopeV2) => { core.applyOperation(op); reference.applyOperation(op); };
		apply(create);
		for (let index = 1; index < 140; index++) apply({ ...create, opId: `append-${index}`, lamport: index + 1, historyGroupId: `append-${index}`, kind: "element.append", payload: { sourceStart: index, points: [{ x: .1 + index / 1000, y: .2, p: .5, lamport: index + 1 }] } });
		const checkpoints = (core as unknown as { elementCheckpoints: Map<string, unknown> }).elementCheckpoints;
		expect(checkpoints.has("stroke")).toBe(true);
		apply({ ...create, opId: "style", lamport: 200, historyGroupId: "style", kind: "element.style", payload: { style: { color: "#f00" } } });
		apply({ ...create, opId: "undo-style", lamport: 201, historyGroupId: "undo-style", kind: "history.toggle", payload: { targetHistoryGroupId: "style", enabled: false } });
		expect(checkpoints.has("stroke")).toBe(true);
		expect(core.sceneHash()).toBe(reference.sceneHash());
		expect(core.getRenderIR().items.every(({ atom }) => atom.style.color === "#000")).toBe(true);
		apply({ ...create, opId: "redo-style", lamport: 202, historyGroupId: "redo-style", kind: "history.toggle", payload: { targetHistoryGroupId: "style", enabled: true } });
		expect(core.sceneHash()).toBe(reference.sceneHash());
		expect(core.getRenderIR().items.every(({ atom }) => atom.style.color === "#f00")).toBe(true);
		apply({ ...create, opId: "undo-style-again", lamport: 203, historyGroupId: "undo-style-again", kind: "history.toggle", payload: { targetHistoryGroupId: "style", enabled: false } });
		expect(core.sceneHash()).toBe(reference.sceneHash());
		expect(core.getRenderIR().items.every(({ atom }) => atom.style.color === "#000")).toBe(true);
		apply({ ...create, opId: "undo-early", lamport: 204, historyGroupId: "undo-early", kind: "history.toggle", payload: { targetHistoryGroupId: "append-2", enabled: false } });
		expect(checkpoints.has("stroke")).toBe(false);
		expect(core.sceneHash()).toBe(reference.sceneHash());
	});
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
