import { describe, expect, it } from "vitest";
import type { Point, SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { cutIntervalsForStrokeAtom } from "./eraseGeometry";
import { DirtyRegionSet } from "./dirtyRegionSet";
import { SceneEngine } from "./sceneEngine";
import type { QuadraticAtom } from "./sceneTypes";
import { SpatialGridIndex } from "./spatialGridIndex";

const points: Point[] = [
	{ x: 0.1, y: 0.1, p: 0.5, lamport: 1 },
	{ x: 0.4, y: 0.4, p: 0.5, lamport: 2 },
	{ x: 0.8, y: 0.2, p: 0.5, lamport: 3 },
];

const base = (opId: string, lamport: number) => ({
	schemaVersion: 2 as const,
	opId,
	elementId: "element-a",
	actorId: "actor-a",
	roomId: "room-a",
	pageId: 0,
	lamport,
	historyGroupId: opId,
});

const createOperation: SceneOperationEnvelopeV2 = {
	...base("create", 1),
	kind: "element.create",
	payload: {
		descriptor: {
			elementKind: "path",
			toolId: "pen",
			recipeId: "stroke",
			style: { color: "#111111", size: 4, strokePattern: "solid" },
		},
		points,
		isComplete: true,
	},
};

const transformOperation: SceneOperationEnvelopeV2 = {
	...base("transform", 5),
	kind: "element.transform",
	payload: { targets: [{ elementId: "element-a", deltaMatrix: [1, 0, 0, 1, 0.05, 0.1] }] },
};

const eraseOperation: SceneOperationEnvelopeV2 = {
	...base("erase", 6),
	kind: "element.erase",
	payload: {
		targets: [{ elementId: "element-a", atomId: "element-a:1:0", intervals: [{ start: 1200, end: 2400 }] }],
	},
};

describe("SceneEngine", () => {
	it("converges when immutable operations arrive in different orders", () => {
		const first = new SceneEngine();
		const second = new SceneEngine();
		for (const operation of [createOperation, transformOperation, eraseOperation]) first.applyOperation(operation);
		for (const operation of [eraseOperation, transformOperation, createOperation]) second.applyOperation(operation);

		expect(first.sceneHash()).toBe(second.sceneHash());
		expect(first.getStats().visibleAtoms).toBeGreaterThan(0);
	});

	it("undoes and redoes a transform by toggling its history group", () => {
		const engine = new SceneEngine();
		engine.applyOperation(createOperation);
		const original = engine.getElementBounds("element-a");
		engine.applyOperation(transformOperation);
		const moved = engine.getElementBounds("element-a");
		expect(moved!.minX).toBeGreaterThan(original!.minX);

		engine.applyOperation({
			...base("undo", 7),
			kind: "history.toggle",
			payload: { targetHistoryGroupId: "transform", enabled: false },
		});
		expect(engine.getElementBounds("element-a")!.minX).toBeCloseTo(original!.minX);

		engine.applyOperation({
			...base("redo", 8),
			kind: "history.toggle",
			payload: { targetHistoryGroupId: "transform", enabled: true },
		});
		expect(engine.getElementBounds("element-a")!.minX).toBeCloseTo(moved!.minX);
	});

	it("keeps point and glyph atoms interleaved by their own order keys", () => {
		const engine = new SceneEngine();
		const pathCreate: SceneOperationEnvelopeV2 = {
			...base("path-create", 1),
			elementId: "path",
			historyGroupId: "path",
			kind: "element.create",
			payload: {
				descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#000", size: 3 } },
				points: [{ x: 0.1, y: 0.2, p: 0.5, lamport: 1 }],
			},
		};
		const textCreate: SceneOperationEnvelopeV2 = {
			...base("text-create", 3),
			elementId: "text",
			historyGroupId: "text",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "text", toolId: "text", recipeId: "glyph",
					style: { color: "#111", size: 3, fontSize: 20 },
					box: { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.3, width: 0.3, height: 0.1 },
					text: "字",
				},
			},
		};
		const pathAppend: SceneOperationEnvelopeV2 = {
			...base("path-append", 5),
			elementId: "path",
			historyGroupId: "path",
			kind: "element.append",
			payload: { points: [{ x: 0.7, y: 0.2, p: 0.5, lamport: 5 }], sourceStart: 1, isComplete: true },
		};
		for (const operation of [pathCreate, textCreate, pathAppend]) engine.applyOperation(operation);

		expect(engine.getVisibleAtomOrder().map((atom) => atom.elementId)).toEqual([
			"path", "text", "path", "path",
		]);
	});

	it("adopts V2 path geometry from the ordered init stream without duplicating atoms", () => {
		const engine = new SceneEngine();
		points.forEach((point, pointIndex) => {
			engine.ingestFlatPoint({
				...point,
				cmdId: "element-a",
				orderOpId: pointIndex === 0 ? "create" : "append",
				pointIndex,
				pageId: 0,
				userId: "actor-a",
				tool: "pen",
				color: "#111111",
				size: 4,
				isDeleted: false,
			});
		});
		engine.finishAllOpenStrokes();
		const atomsBeforeOperations = engine.getStats().atoms;

		engine.applyOperation({
			...createOperation,
			payload: { ...createOperation.payload, points: [points[0]!] },
		});
		engine.applyOperation({
			...base("append", 3),
			kind: "element.append",
			payload: { points: points.slice(1), sourceStart: 1, isComplete: true },
		});

		expect(engine.getStats().atoms).toBe(atomsBeforeOperations);
		expect(engine.getVisibleAtomOrder().map((atom) => atom.order.opId)).toEqual([
			"create", "append", "append", "append",
		]);
	});

	it("rebuilds only the history group's affected elements", () => {
		const engine = new SceneEngine();
		engine.applyOperation(createOperation);
		engine.applyOperation({
			...base("other-create", 4),
			elementId: "element-b",
			historyGroupId: "element-b",
			kind: "element.create",
			payload: {
				descriptor: { elementKind: "shape", toolId: "rectangle", recipeId: "shape", style: { color: "#000", size: 2 }, shapeKind: "rectangle", box: { minX: 0.7, minY: 0.7, maxX: 0.8, maxY: 0.8, width: 0.1, height: 0.1 } },
			},
		});
		engine.applyOperation(transformOperation);
		engine.applyOperation({
			...base("undo-transform", 7),
			kind: "history.toggle",
			payload: { targetHistoryGroupId: "transform", enabled: false },
		});

		expect(engine.getVisibleAtomOrder().filter((atom) => atom.elementId === "element-b")).toHaveLength(1);
	});

	it("uses inverse geometry for rotated element hit testing", () => {
		const engine = new SceneEngine();
		engine.applyOperation({
			...base("shape", 1),
			elementId: "shape",
			kind: "element.create",
			payload: {
					descriptor: { elementKind: "shape", toolId: "rectangle", recipeId: "shape", style: { color: "#000", fillColor: "#fff", size: 2 }, shapeKind: "rectangle", box: { minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6, width: 0.2, height: 0.2 } },
			},
		});
		const angle = Math.PI / 4;
		const cosine = Math.cos(angle);
		const sine = Math.sin(angle);
		engine.applyOperation({
			...base("rotate", 2),
			elementId: "shape",
			kind: "element.transform",
			payload: { targets: [{ elementId: "shape", deltaMatrix: [
				cosine, sine, -sine, cosine,
				0.5 - cosine * 0.5 + sine * 0.5,
				0.5 - sine * 0.5 - cosine * 0.5,
			] }] },
		});

		expect(engine.hitTestTopmost(640, 640, 1000, 1000)).toBeNull();
		expect(engine.hitTestTopmost(500, 500, 1000, 1000)).toBe("shape");
	});

	it("hits visible shape geometry instead of its coarse AABB", () => {
		const engine = new SceneEngine();
		engine.applyOperation({
			...base("hollow-rectangle", 1),
			elementId: "hollow-rectangle",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "shape",
					toolId: "rectangle",
					recipeId: "shape",
					style: { color: "#000", size: 2 },
					shapeKind: "rectangle",
					box: { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8, width: 0.6, height: 0.6 },
				},
			},
		});

		expect(engine.hitTestTopmost(500, 500, 1000, 1000)).toBeNull();
		expect(engine.hitTestTopmost(202, 500, 1000, 1000)).toBe("hollow-rectangle");
		expect(engine.queryElements(
			{ minX: 450, minY: 450, maxX: 550, maxY: 550, width: 100, height: 100 },
			1000,
			1000
		)).toEqual([]);
	});

	it("does not select a dashed line through one of its gaps", () => {
		const engine = new SceneEngine();
		engine.applyOperation({
			...base("dashed-line", 1),
			elementId: "dashed-line",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "shape",
					toolId: "line",
					recipeId: "shape",
					style: { color: "#000", size: 10, strokePattern: "dashed" },
					shapeKind: "line",
					shapeStart: { x: 0.1, y: 0.5 },
					shapeEnd: { x: 0.9, y: 0.5 },
					box: { minX: 0.1, minY: 0.5, maxX: 0.9, maxY: 0.5, width: 0.8, height: 0 },
				},
			},
		});

		expect(engine.hitTestTopmost(120, 500, 1000, 1000)).toBe("dashed-line");
		expect(engine.hitTestTopmost(150, 500, 1000, 1000)).toBeNull();
	});

	it("removes erased stroke intervals from hit testing", () => {
		const engine = new SceneEngine();
		engine.applyOperation(createOperation);
		const targets = engine.getVisibleAtomOrder().map((atom) => ({
			elementId: atom.elementId,
			atomId: atom.atomId,
			intervals: [{ start: 0, end: 0xffff }],
		}));
		engine.applyOperation({
			...base("erase-all", 8),
			kind: "element.erase",
			payload: { targets },
		});
		expect(engine.hitTestTopmost(100, 100, 1000, 1000)).toBeNull();
	});

	it("only object-erases an outlined shape after the eraser touches its geometry", () => {
		const engine = new SceneEngine();
		engine.applyOperation({
			...base("outlined-shape", 1),
			elementId: "outlined-shape",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "shape",
					toolId: "rectangle",
					recipeId: "shape",
					shapeKind: "rectangle",
					style: { color: "#111", size: 4 },
					box: { minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6, width: 0.2, height: 0.2 },
				},
			},
		});

		expect(engine.computeEraseTargets([{ x: 0.5, y: 0.5, p: 1, lamport: 2 }], 20, 1000, 1000, true)).toEqual([]);
		expect(engine.computeEraseTargets([{ x: 0.385, y: 0.5, p: 1, lamport: 3 }], 20, 1000, 1000, true)).toEqual([]);
		expect(engine.computeEraseTargets([{ x: 0.391, y: 0.5, p: 1, lamport: 4 }], 20, 1000, 1000, true)).toEqual([
			{ elementId: "outlined-shape", eraseWhole: true },
		]);
	});

	it("keeps erased geometry hidden after a later transform and restores it through history", () => {
		const engine = new SceneEngine();
		engine.applyOperation(createOperation);
		const targets = engine.getVisibleAtomOrder().map((atom) => ({
			elementId: atom.elementId,
			atomId: atom.atomId,
			intervals: [{ start: 0, end: 0xffff }],
		}));
		engine.applyOperation({ ...eraseOperation, opId: "erase-everything", historyGroupId: "erase-everything", payload: { targets } });
		engine.applyOperation(transformOperation);
		expect(engine.hitTestTopmost(150, 200, 1000, 1000)).toBeNull();

		engine.applyOperation({
			...base("undo-erase", 9),
			kind: "history.toggle",
			payload: { targetHistoryGroupId: "erase-everything", enabled: false },
		});
		expect(engine.hitTestTopmost(150, 200, 1000, 1000)).toBe("element-a");
	});

	it("makes page clear append-only and independently undoable", () => {
		const engine = new SceneEngine();
		engine.applyOperation(createOperation);
		engine.applyOperation({
			...base("clear-page", 4),
			elementId: "page:0",
			kind: "page.clear",
			payload: { before: { lamport: 4, opId: "clear-page", sourceIndex: 0, subIndex: 0 } },
		});
		engine.applyOperation({
			...base("after-clear", 5),
			elementId: "after-clear",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "sticker",
					toolId: "sticker",
					recipeId: "bitmap",
					style: { color: "#000", size: 20 },
					box: { minX: 0.6, minY: 0.6, maxX: 0.7, maxY: 0.7, width: 0.1, height: 0.1 },
					sticker: "✨",
				},
			},
		});
		expect(engine.getVisibleAtomOrder().every((atom) => atom.elementId === "after-clear")).toBe(true);

		engine.applyOperation({
			...base("undo-clear", 6),
			kind: "history.toggle",
			payload: { targetHistoryGroupId: "clear-page", enabled: false },
		});
		expect(new Set(engine.getVisibleAtomOrder().map((atom) => atom.elementId))).toEqual(
			new Set(["element-a", "after-clear"])
		);
	});

	it("orders concurrent RGA siblings deterministically", () => {
		const createText: SceneOperationEnvelopeV2 = {
			...base("create-text", 1),
			elementId: "text-rga",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "text",
					toolId: "text",
					recipeId: "glyph",
					style: { color: "#000", size: 2, fontSize: 20 },
					box: { minX: 0.1, minY: 0.1, maxX: 0.8, maxY: 0.3, width: 0.7, height: 0.2 },
				},
			},
		};
		const patchA: SceneOperationEnvelopeV2 = {
			...base("patch-a", 2), elementId: "text-rga", actorId: "actor-a", kind: "text.patch",
			payload: { patches: [{ type: "insert", charId: "char-a", afterId: null, grapheme: "A" }] },
		};
		const patchB: SceneOperationEnvelopeV2 = {
			...base("patch-b", 2), elementId: "text-rga", actorId: "actor-b", kind: "text.patch",
			payload: { patches: [{ type: "insert", charId: "char-b", afterId: null, grapheme: "B" }] },
		};
		const first = new SceneEngine();
		const second = new SceneEngine();
		for (const operation of [createText, patchA, patchB]) first.applyOperation(operation);
		for (const operation of [patchB, createText, patchA]) second.applyOperation(operation);
		expect(first.sceneHash()).toBe(second.sceneHash());
		expect(first.getVisibleAtomOrder().map((atom) => atom.atomId)).toEqual(
			second.getVisibleAtomOrder().map((atom) => atom.atomId)
		);
	});

	it("applies and undoes immutable text style operations", () => {
		const engine = new SceneEngine();
		engine.applyOperation({
			...base("styled-text", 1),
			elementId: "styled-text",
			kind: "element.create",
			payload: {
				descriptor: {
					elementKind: "text", toolId: "text", recipeId: "glyph",
					style: { color: "#111", size: 2, fontSize: 20, fontWeight: 400, textAlign: "left" },
					box: { minX: 0.1, minY: 0.1, maxX: 0.7, maxY: 0.3, width: 0.6, height: 0.2 },
					text: "AB",
				},
			},
		});
		const originalHash = engine.sceneHash();
		engine.applyOperation({
			...base("style-text", 2),
			elementId: "styled-text",
			kind: "element.style",
			payload: { style: { fontSize: 32, fontWeight: 700, textAlign: "center" } },
		});
		expect(engine.sceneHash()).not.toBe(originalHash);

		engine.applyOperation({
			...base("undo-style", 3),
			kind: "history.toggle",
			payload: { targetHistoryGroupId: "style-text", enabled: false },
		});
		expect(engine.sceneHash()).toBe(originalHash);
	});
});

describe("deterministic erasure", () => {
	it("produces byte-identical quantized intervals", () => {
		const atom: QuadraticAtom = {
			ref: 0,
			atomId: "a:1:0",
			elementId: "a",
			elementRevision: 0,
			pageId: 0,
			order: { lamport: 1, opId: "a", sourceIndex: 1, subIndex: 0 },
			recipeId: "stroke",
			primitive: "quadratic",
			toolId: "pen",
			style: { color: "#000", size: 4 },
			bounds: { minX: 0.1, minY: 0.1, maxX: 0.9, maxY: 0.5, width: 0.8, height: 0.4 },
			fromX: 0.1,
			fromY: 0.1,
			viaX: 0.5,
			viaY: 0.5,
			toX: 0.9,
			toY: 0.1,
			width: 4,
			dashOffset: 0,
		};
		const eraser = [
			{ x: 0.45, y: 0.2, p: 1, lamport: 1 },
			{ x: 0.55, y: 0.4, p: 1, lamport: 2 },
		];
		const first = cutIntervalsForStrokeAtom(atom, eraser, 18, 1000, 800);
		const second = cutIntervalsForStrokeAtom(atom, eraser, 18, 1000, 800);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.every((interval) => Number.isInteger(interval.start) && Number.isInteger(interval.end))).toBe(true);
	});
});

describe("SpatialGridIndex", () => {
	it("keeps a fixed local query independent of unrelated scene size", () => {
		const grid = new SpatialGridIndex();
		for (let index = 0; index < 100_000; index += 1) {
			const x = 0.5 + (index % 500) / 1000;
			const y = 0.5 + (Math.floor(index / 500) % 500) / 1000;
			grid.addAtom(`far-${index >> 6}`, index, { minX: x, minY: y, maxX: x + 0.0001, maxY: y + 0.0001, width: 0.0001, height: 0.0001 });
		}
		grid.addAtom("near", 100_001, { minX: 0.01, minY: 0.01, maxX: 0.02, maxY: 0.02, width: 0.01, height: 0.01 });
		const result = grid.query({ minX: 0, minY: 0, maxX: 0.03, maxY: 0.03, width: 0.03, height: 0.03 });
		expect(result.atomRefs).toEqual([100_001]);
		expect(result.gridCells).toBe(1);
	});
});

describe("DirtyRegionSet", () => {
	it("uses separate enter and exit thresholds for dense-frame fallback", () => {
		const regions = new DirtyRegionSet();
		regions.add({ minX: 0, minY: 0, maxX: 360, maxY: 1000, width: 360, height: 1000 });
		expect(regions.shouldRenderFull(1000, 1000, 10, 100, false)).toBe(true);

		regions.clear();
		regions.add({ minX: 0, minY: 0, maxX: 320, maxY: 1000, width: 320, height: 1000 });
		expect(regions.shouldRenderFull(1000, 1000, 10, 100, true)).toBe(true);

		regions.clear();
		regions.add({ minX: 0, minY: 0, maxX: 240, maxY: 1000, width: 240, height: 1000 });
		expect(regions.shouldRenderFull(1000, 1000, 10, 100, true)).toBe(false);
	});
});
