import { describe, expect, it, vi } from "vitest";
import type { SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { SceneEngine } from "../../src/scene/sceneEngine";
import { renderIRFrame, renderIRItems } from "../../src/scene/canvasIRRenderer";
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
	it("compares streamed opaque strokes with their final full replay", () => {
		const engine = new SceneEngine();
		const streamed = createCanvasContext();
		for (let stroke = 0; stroke < 8; stroke++) {
			for (let index = 0; index < 40; index++) {
				const t = index / 39;
				const refs = engine.ingestFlatPoint({
					cmdId: `stream-${stroke}`, userId: "browser-test", pageId: 0,
					tool: "pen", color: stroke % 2 ? "#e11d48" : "#111827", size: 8,
					isDeleted: false, pointIndex: index, lamport: stroke * 40 + index + 1,
					x: stroke === 0 ? 0.15 + t * 0.3 : 0.45 + (t - 0.5) * 0.28,
					y: stroke === 0 ? 0.45 : 0.22 + t * 0.46 + (stroke - 1) * 0.01,
					p: .5,
				});
				engine.renderAtomRefs(streamed, refs, WIDTH, HEIGHT);
			}
		}
		engine.renderAtomRefs(streamed, engine.finishAllOpenStrokes(), WIDTH, HEIGHT);
		const complete = createCanvasContext();
		engine.renderFull(complete, WIDTH, HEIGHT);
		const a = streamed.getImageData(0, 0, WIDTH, HEIGHT).data;
		const b = complete.getImageData(0, 0, WIDTH, HEIGHT).data;
		// Unfinished streamed strokes flush their tail atoms after later strokes,
		// so initialization still needs its final reconciliation even for opaque pens.
		expect(a.some((value, index) => value !== b[index])).toBe(true);
	});
	it("rebuilds moved content without clipping antialiased tile edges", () => {
		const engine = new SceneEngine(); engine.applyOperation(operations[0]!);
		const shape = operations[0]!;
		if (shape.kind !== "element.create") throw new Error("Expected create");
		for (let i = 0; i < 8; i++) engine.applyOperation({ ...shape, opId: `far-${i}`, elementId: `far-${i}`, lamport: 20 + i, historyGroupId: `far-${i}`, payload: { ...shape.payload, descriptor: { ...shape.payload.descriptor, box: { minX: .95, minY: .9, maxX: .96, maxY: .91, width: .01, height: .01 } } } });
		const ctx = createCanvasContext(); engine.renderFull(ctx, WIDTH, HEIGHT);
		const oldBounds = pixelRect(engine.getElementBounds("background-shape")!);
		engine.applyOperation(transform); const newBounds = pixelRect(engine.getElementBounds("background-shape")!);
		const ref = createCanvasContext(); engine.renderFull(ref, WIDTH, HEIGHT);
		let locallyRendered = 0;
		for (let y = 0; y < HEIGHT; y += 64) for (let x = 0; x < WIDTH; x += 64) {
			if (![oldBounds, newBounds].some((b) => x <= b.maxX + 24 && x + 64 >= b.minX - 24 && y <= b.maxY + 24 && y + 64 >= b.minY - 24)) continue;
			const staging = createCanvasContext();
			const result = engine.renderDirty(staging, { minX: x - 24, minY: y - 24, maxX: x + 88, maxY: y + 88, width: 112, height: 112 }, WIDTH, HEIGHT);
			if (result.mode === "dirty") locallyRendered++;
			const tileWidth = Math.min(64, WIDTH - x), tileHeight = Math.min(64, HEIGHT - y);
			ctx.clearRect(x, y, tileWidth, tileHeight);
			ctx.drawImage(staging.canvas, x, y, tileWidth, tileHeight, x, y, tileWidth, tileHeight);
		}
		const a = ctx.getImageData(0, 0, WIDTH, HEIGHT).data, b = ref.getImageData(0, 0, WIDTH, HEIGHT).data;
		let max = 0, at = 0;
		for (let i = 0; i < a.length; i += 4) {
			let diff = Math.abs(a[i + 3]! - b[i + 3]!);
			for (let channel = 0; channel < 3; channel++) diff = Math.max(diff, Math.abs(a[i + channel]! * a[i + 3]! - b[i + channel]! * b[i + 3]!) / 255);
			if (diff > max) { max = diff; at = i / 4; }
		}
		expect(max, `maximum premultiplied difference at ${at % WIDTH},${Math.floor(at / WIDTH)}`).toBeLessThanOrEqual(2);
		expect(locallyRendered).toBeGreaterThan(0);
	});
	it("preserves ordered prefix compositing for a later translucent stroke", () => {
		const engine = new SceneEngine();
		engine.applyOperation(operations[0]!);
		const cached = createCanvasContext();
		engine.renderFull(cached, WIDTH, HEIGHT);
		const oldOrder = engine.lastAtomOrder();
		const firstRef = engine.atomCount;
		engine.applyOperation(operations[1]!);
		const reference = createCanvasContext();
		engine.renderFull(reference, WIDTH, HEIGHT);
		const items = engine.getRenderIR().items.filter((item) => item.atom.ref >= firstRef);
		expect(oldOrder).not.toBeNull();
		renderIRItems(cached, items, WIDTH, HEIGHT);
		expect(cached.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(reference.getImageData(0, 0, WIDTH, HEIGHT).data);
	});
	it("preserves translucent compositing across integer-aligned cached tiles", () => {
		const engine = new SceneEngine();
		engine.applyOperation(operations[0]!);
		const prefix = createCanvasContext();
		engine.renderFull(prefix, WIDTH, HEIGHT);
		const firstRef = engine.atomCount;
		engine.applyOperation(operations[1]!);
		const suffix = engine.getRenderIR().items.filter((item) => item.atom.ref >= firstRef);
		const reference = createCanvasContext();
		engine.renderFull(reference, WIDTH, HEIGHT);
		const tiled = createCanvasContext();
		for (let y = 0; y < HEIGHT; y += 128) {
			for (let x = 0; x < WIDTH; x += 128) {
				tiled.save();
				tiled.beginPath();
				tiled.rect(x, y, 128, 128);
				tiled.clip();
				tiled.drawImage(prefix.canvas, 0, 0);
				renderIRItems(tiled, suffix, WIDTH, HEIGHT);
				tiled.restore();
			}
		}
		expect(tiled.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(reference.getImageData(0, 0, WIDTH, HEIGHT).data);
	});
	it("requires a cached prefix to be rebuilt after an element moves", () => {
		const engine = new SceneEngine();
		engine.applyOperation(operations[0]!);
		const cached = createCanvasContext();
		engine.renderFull(cached, WIDTH, HEIGHT);
		engine.applyOperation(transform);
		const reference = createCanvasContext();
		engine.renderFull(reference, WIDTH, HEIGHT);
		const stalePixels = cached.getImageData(0, 0, WIDTH, HEIGHT).data;
		const expectedPixels = reference.getImageData(0, 0, WIDTH, HEIGHT).data;
		expect(stalePixels.some((value, index) => value !== expectedPixels[index])).toBe(true);
		engine.renderFull(cached, WIDTH, HEIGHT);
		const rebuiltPixels = cached.getImageData(0, 0, WIDTH, HEIGHT).data;
		expect(rebuiltPixels.every((value, index) => Math.abs(value - expectedPixels[index]!) <= 1)).toBe(true);
	});
	it("rejects direct painting for an older interleaved pen stroke", () => {
		const engine = new SceneEngine();
		engine.applyOperation({ ...operations[0]!, lamport: 10 });
		const cached = createCanvasContext();
		engine.renderFull(cached, WIDTH, HEIGHT);
		const previousOrder = engine.lastAtomOrder();
		const firstRef = engine.atomCount;
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		engine.applyOperation({ ...stroke, lamport: 2, payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId: "pen", style: { color: "#000", size: 22 } }, points: [{ x: .01, y: .5, p: .5, lamport: 2 }, { x: .99, y: .5, p: .5, lamport: 3 }] } });
		expect(engine.renderNewPenAtomsOnTop(cached, firstRef, previousOrder, WIDTH, HEIGHT)).toBe(false);
		const reference = createCanvasContext();
		engine.renderFull(reference, WIDTH, HEIGHT);
		const stale = cached.getImageData(0, 0, WIDTH, HEIGHT).data;
		const expected = reference.getImageData(0, 0, WIDTH, HEIGHT).data;
		expect(stale.some((value, index) => value !== expected[index])).toBe(true);
	});
	it("keeps dense local redraw in full-scene paint order", () => {
		const engine = new SceneEngine();
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		const insidePoints = Array.from({ length: 2400 }, (_, i) => {
			const row = Math.floor(i / 40);
			const col = row % 2 === 0 ? i % 40 : 39 - (i % 40);
			return { x: 0.06 + (col / 39) * 0.32, y: 0.08 + ((row % 30) / 29) * 0.32, p: 0.5, lamport: i + 2 };
		});
		const topPoints = Array.from({ length: 200 }, (_, i) => ({
			x: 0.08 + (i / 199) * 0.28, y: 0.24 + Math.sin(i / 8) * 0.1, p: 0.5, lamport: 3000 + i,
		}));
		const outsidePoints = Array.from({ length: 1600 }, (_, i) => {
			const row = Math.floor(i / 40);
			const col = row % 2 === 0 ? i % 40 : 39 - (i % 40);
			return { x: 0.65 + (col / 39) * 0.28, y: 0.66 + ((row % 20) / 19) * 0.26, p: 0.5, lamport: 4000 + i };
		});
		engine.applyOperation({ ...stroke, opId: "dense-inside", elementId: "dense-inside", historyGroupId: "dense-inside", payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId: "pen", style: { color: "#000", size: 3 } }, points: insidePoints } });
		engine.applyOperation({ ...stroke, opId: "dense-top", elementId: "dense-top", lamport: 3000, historyGroupId: "dense-top", payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId: "pen", style: { color: "#e11d48", size: 4 } }, points: topPoints } });
		engine.applyOperation({ ...stroke, opId: "dense-outside", elementId: "dense-outside", lamport: 4000, historyGroupId: "dense-outside", payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId: "pen", style: { color: "#000", size: 3 } }, points: outsidePoints } });
		const dirty = createCanvasContext();
		const full = createCanvasContext();
		engine.renderFull(dirty, WIDTH, HEIGHT);
		engine.renderFull(full, WIDTH, HEIGHT);
		const rect = { minX: 0, minY: 0, maxX: 240, maxY: 180, width: 240, height: 180 };
		const result = engine.renderDirty(dirty, rect, WIDTH, HEIGHT);
		expect(result.mode).toBe("dirty");
		expect(result.candidateAtoms).toBeGreaterThan(2048);
		expect(dirty.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(full.getImageData(0, 0, WIDTH, HEIGHT).data);
	});
	it("paints a topmost pen increment identically to full replay and rejects older atoms", () => {
		const engine = new SceneEngine();
		engine.applyOperation(operations[0]!);
		const ctx = createCanvasContext();
		engine.renderFull(ctx, WIDTH, HEIGHT);
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		const before = engine.lastAtomOrder();
		const first = engine.atomCount;
		engine.applyOperation({ ...stroke, payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId: "pen", style: { color: "#000", size: 8 } } } });
		expect(engine.renderNewPenAtomsOnTop(ctx, first, before, WIDTH, HEIGHT)).toBe(true);
		const reference = createCanvasContext();
		engine.renderFull(reference, WIDTH, HEIGHT);
		expect(ctx.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(reference.getImageData(0, 0, WIDTH, HEIGHT).data);
		const latest = engine.lastAtomOrder();
		const next = engine.atomCount;
		engine.applyOperation({ ...stroke, opId: "old-stroke", elementId: "old-stroke", lamport: 1, historyGroupId: "old-stroke", payload: { ...stroke.payload, descriptor: { ...stroke.payload.descriptor, toolId: "pen" }, points: [{ x: .2, y: .2, p: .5, lamport: 1 }] } });
		expect(engine.renderNewPenAtomsOnTop(ctx, next, latest, WIDTH, HEIGHT)).toBe(false);
	});
	it("renders a sliced full frame identically to the synchronous renderer", () => {
		const engine = new SceneEngine();
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		engine.applyOperation({ ...stroke, payload: { ...stroke.payload, points: Array.from({ length: 600 }, (_, i) => ({ x: 0.05 + i / 700, y: 0.5 + Math.sin(i / 40) * 0.1, p: 0.5, lamport: i + 2 })) } });
		const expected = createCanvasContext();
		const sliced = createCanvasContext();
		engine.renderFull(expected, WIDTH, HEIGHT);
		const steps = engine.renderFullSteps(sliced, WIDTH, HEIGHT);
		const layerPrototype = typeof OffscreenCanvasRenderingContext2D === "undefined" ? CanvasRenderingContext2D.prototype : OffscreenCanvasRenderingContext2D.prototype;
		const drawn = vi.spyOn(layerPrototype, "quadraticCurveTo");
		const first = steps.next();
		expect(first.done).toBe(false);
		expect(drawn).toHaveBeenCalled();
		drawn.mockRestore();
		let count = 1;
		while (!steps.next().done) count += 1;
		expect(count).toBeGreaterThan(1);
		expect(sliced.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(expected.getImageData(0, 0, WIDTH, HEIGHT).data);
	});
	it("keeps existing thick strokes intact across repeated narrow dirty redraws", () => {
		const engine = new SceneEngine();
		const stroke = operations[1]!;
		if (stroke.kind !== "element.create") throw new Error("Expected create");
		engine.applyOperation({
			...stroke,
			payload: {
				...stroke.payload,
				descriptor: { ...stroke.payload.descriptor, toolId: "pen", style: { color: "#000", size: 20 } },
				points: Array.from({ length: 200 }, (_, index) => ({ x: 0.1 + index * 0.004, y: 0.5, p: 0.5, lamport: index + 2 })),
			},
		});
		const context = createCanvasContext();
		engine.renderFull(context, WIDTH, HEIGHT);
		const before = context.getImageData(0, 0, WIDTH, HEIGHT).data;
		for (let x = 80.3; x < 440; x += 4.7) {
			engine.renderDirty(context, { minX: x, minY: 176.2, maxX: x + 2, maxY: 183.2, width: 2, height: 7 }, WIDTH, HEIGHT);
		}
		const after = context.getImageData(0, 0, WIDTH, HEIGHT).data;
		for (let x = 80; x < 440; x += 1) {
			const alpha = (180 * WIDTH + x) * 4 + 3;
			if (before[alpha]! > 240) expect(after[alpha]).toBeGreaterThan(230);
		}
	});
	it("renders a detached IR frame identically to the live scene", () => {
		const engine = new SceneEngine();
		for (const operation of operations) engine.applyOperation(operation);
		engine.applyOperation(transform);
		const live = createCanvasContext();
		const detached = createCanvasContext();
		engine.renderFull(live, WIDTH, HEIGHT);
		renderIRFrame(detached, engine.getRenderIR(), WIDTH, HEIGHT);
		expect(detached.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(live.getImageData(0, 0, WIDTH, HEIGHT).data);
	});
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
