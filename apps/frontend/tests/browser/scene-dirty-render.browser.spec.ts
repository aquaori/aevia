import { describe, expect, it } from "vitest";
import type { SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { SceneEngine } from "../../src/scene/sceneEngine";
import { drawPrimitive } from "../../src/scene/primitiveRenderer";
import type { ShapeAtom } from "../../src/scene/sceneTypes";
import { IDENTITY_MATRIX } from "@collaborative-whiteboard/shared";

const WIDTH = 512;
const HEIGHT = 360;

const createCanvasContext = () => {
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas2D is unavailable");
	return context;
};

const pixelRect = (bounds: NonNullable<ReturnType<SceneEngine["getElementBounds"]>>) => ({
	minX: bounds.minX * WIDTH,
	minY: bounds.minY * HEIGHT,
	maxX: bounds.maxX * WIDTH,
	maxY: bounds.maxY * HEIGHT,
	width: bounds.width * WIDTH,
	height: bounds.height * HEIGHT,
});

const operations: SceneOperationEnvelopeV2[] = [
	{
		schemaVersion: 2,
		opId: "background-shape",
		elementId: "background-shape",
		actorId: "browser-test",
		roomId: "room",
		pageId: 0,
		lamport: 1,
		historyGroupId: "background-shape",
		kind: "element.create",
		payload: {
			descriptor: {
				elementKind: "shape",
				toolId: "rounded-rectangle",
				recipeId: "shape",
				shapeKind: "rounded-rectangle",
				style: { color: "#1d4ed8", fillColor: "#dbeafe", size: 4 },
				box: { minX: 0.08, minY: 0.12, maxX: 0.72, maxY: 0.82, width: 0.64, height: 0.7 },
			},
		},
	},
	{
		schemaVersion: 2,
		opId: "foreground-stroke",
		elementId: "foreground-stroke",
		actorId: "browser-test",
		roomId: "room",
		pageId: 0,
		lamport: 2,
		historyGroupId: "foreground-stroke",
		kind: "element.create",
		payload: {
			descriptor: {
				elementKind: "path",
				toolId: "highlighter",
				recipeId: "stroke",
				style: { color: "#facc15", size: 22, opacity: 0.32, strokePattern: "dash-dot" },
			},
			points: [
				{ x: 0.12, y: 0.25, p: 0.5, lamport: 2 },
				{ x: 0.32, y: 0.55, p: 0.7, lamport: 3 },
				{ x: 0.62, y: 0.32, p: 0.6, lamport: 4 },
			],
			isComplete: true,
		},
	},
];

const transform: SceneOperationEnvelopeV2 = {
	schemaVersion: 2,
	opId: "move-background",
	elementId: "background-shape",
	actorId: "browser-test",
	roomId: "room",
	pageId: 0,
	lamport: 5,
	historyGroupId: "move-background",
	kind: "element.transform",
	payload: {
		targets: [{ elementId: "background-shape", deltaMatrix: [1, 0, 0, 1, 0.18, -0.05] }],
	},
};

describe("SceneEngine text layout", () => {
	it("uses the browser font metrics for mixed-width glyphs", () => {
		const engine = new SceneEngine();
		engine.applyOperation({
			schemaVersion: 2, opId: "text-metrics", elementId: "text-metrics", actorId: "browser-test", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "text-metrics", kind: "element.create",
			payload: { descriptor: { elementKind: "text", toolId: "text", recipeId: "glyph", style: { color: "#000", size: 2, fontSize: 20, fontFamily: "Arial, sans-serif" },
				box: { minX: 0.1, minY: 0.1, maxX: 0.9, maxY: 0.9, width: 0.8, height: 0.8 }, text: "Wi中", textLayout: { version: 1, referenceWidth: WIDTH, aspectRatio: WIDTH / HEIGHT } } },
		});
		const context = createCanvasContext();
		context.font = "400 20px Arial, sans-serif";
		const expected = [..."Wi中"].reduce((sum, character) => sum + context.measureText(character).width, 0);
		const bounds = engine.getAtomBoundsSince(0)!;
		expect(bounds.width * WIDTH).toBeCloseTo(expected, 3);
	});
});

describe("SceneEngine dirty rendering", () => {
	it("renders a sticky note independently of the selected pen width", () => {
		const box = { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8, width: 0.6, height: 0.6 };
		const atom: ShapeAtom = {
			ref: 0, atomId: "sticky", elementId: "sticky", elementRevision: 0, pageId: 0,
			order: { lamport: 1, opId: "sticky", sourceIndex: 0, subIndex: -1 }, recipeId: "shape", primitive: "shape",
			toolId: "sticky", shapeKind: "rounded-rectangle", bounds: box, box, style: { color: "#e7d58a", fillColor: "#fff7cc", size: 2 },
		};
		const a = createCanvasContext();
		const b = createCanvasContext();
		drawPrimitive(a, atom, IDENTITY_MATRIX, WIDTH, HEIGHT);
		drawPrimitive(b, { ...atom, style: { ...atom.style, size: 80, strokePattern: "double" } }, IDENTITY_MATRIX, WIDTH, HEIGHT);
		const ap = a.getImageData(0, 0, WIDTH, HEIGHT).data;
		const bp = b.getImageData(0, 0, WIDTH, HEIGHT).data;
		let different = 0;
		for (let i = 0; i < ap.length; i += 1) if (ap[i] !== bp[i]) different += 1;
		expect(different).toBe(0);
	});
	it("replays pencil texture deterministically and distinctly from pen", () => {
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		const render = (toolId: "pencil" | "pen") => {
			const engine = new SceneEngine();
			engine.applyOperation({ ...stroke, payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId, style: { color: "#000", size: 24 } } } });
			const ctx = createCanvasContext();
			engine.renderFull(ctx, WIDTH, HEIGHT);
			return ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
		};
		const first = render("pencil");
		const replay = render("pencil");
		const pen = render("pen");
		let replayDifferences = 0;
		let penDifferences = 0;
		for (let index = 0; index < first.length; index += 1) {
			if (first[index] !== replay[index]) replayDifferences += 1;
			if (first[index] !== pen[index]) penDifferences += 1;
		}
		expect(replayDifferences).toBe(0);
		expect(penDifferences).toBeGreaterThan(100);
	});
	it.each(["line", "arrow", "rectangle", "rounded-rectangle", "ellipse"] as const)("renders two visible contours for %s", (shapeKind) => {
		const ctx = createCanvasContext();
		const box = { minX: 0.2, minY: 0.25, maxX: 0.8, maxY: 0.75, width: 0.6, height: 0.5 };
		const atom: ShapeAtom = {
			ref: 0, atomId: "shape", elementId: "shape", elementRevision: 0, pageId: 0,
			order: { lamport: 1, opId: "shape", sourceIndex: 0, subIndex: 0 }, recipeId: "shape", primitive: "shape",
			toolId: shapeKind, shapeKind, bounds: box, box, style: { color: "#000", size: 12, strokePattern: "double" },
			shapeStart: { x: 0.2, y: 0.25 }, shapeEnd: { x: 0.8, y: 0.25 },
		};
		drawPrimitive(ctx, atom, IDENTITY_MATRIX, WIDTH, HEIGHT);
		const alpha = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3]!;
		const x = WIDTH / 2;
		const y = HEIGHT * 0.25;
		expect(alpha(x, y - 4)).toBeGreaterThan(100);
		expect(alpha(x, y + 4)).toBeGreaterThan(100);
		expect(alpha(x, y)).toBe(0);
	});
	it("clears the entire width of a thick stroke when it is undone", () => {
		const engine = new SceneEngine();
		const reference = new SceneEngine();
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		const thick: SceneOperationEnvelopeV2 = { ...stroke, payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, style: { color: "#000000", size: 100 } } } };
		const hide: SceneOperationEnvelopeV2 = { schemaVersion: 2, opId: "hide-stroke", elementId: stroke.elementId, actorId: stroke.actorId, roomId: "room", pageId: 0, lamport: 10, historyGroupId: "hide-stroke", kind: "history.toggle", payload: { targetHistoryGroupId: stroke.historyGroupId, enabled: false } };
		engine.applyOperation(thick);
		reference.applyOperation(thick);
		const dirty = createCanvasContext();
		const full = createCanvasContext();
		engine.renderFull(dirty, WIDTH, HEIGHT);
		const bounds = engine.getElementBounds(stroke.elementId);
		if (!bounds) throw new Error("Expected stroke bounds");
		engine.applyOperation(hide);
		reference.applyOperation(hide);
		engine.renderDirty(dirty, pixelRect(bounds), WIDTH, HEIGHT);
		reference.renderFull(full, WIDTH, HEIGHT);
		const actual = dirty.getImageData(0, 0, WIDTH, HEIGHT).data;
		const expected = full.getImageData(0, 0, WIDTH, HEIGHT).data;
		let different = 0;
		for (let index = 0; index < actual.length; index += 1) if (actual[index] !== expected[index]) different += 1;
		expect(different).toBe(0);
	});
	it("is pixel-identical to a full redraw after a transform", () => {
		const dirtyEngine = new SceneEngine();
		const fullEngine = new SceneEngine();
		for (const operation of operations) {
			dirtyEngine.applyOperation(operation);
			fullEngine.applyOperation(operation);
		}
		const dirtyContext = createCanvasContext();
		const fullContext = createCanvasContext();
		dirtyEngine.renderFull(dirtyContext, WIDTH, HEIGHT);
		fullEngine.renderFull(fullContext, WIDTH, HEIGHT);

		const oldBounds = dirtyEngine.getElementBounds("background-shape");
		dirtyEngine.applyOperation(transform);
		fullEngine.applyOperation(transform);
		const newBounds = dirtyEngine.getElementBounds("background-shape");
		if (!oldBounds || !newBounds) throw new Error("Expected transform bounds");

		dirtyEngine.renderDirtyRegions(
			dirtyContext,
			[pixelRect(oldBounds), pixelRect(newBounds)],
			WIDTH,
			HEIGHT
		);
		fullEngine.renderFull(fullContext, WIDTH, HEIGHT);

		const dirtyPixels = dirtyContext.getImageData(0, 0, WIDTH, HEIGHT).data;
		const fullPixels = fullContext.getImageData(0, 0, WIDTH, HEIGHT).data;
		let different = 0;
		for (let index = 0; index < dirtyPixels.length; index += 1) {
			if (dirtyPixels[index] !== fullPixels[index]) different += 1;
		}
		expect(different).toBe(0);
	});
});
