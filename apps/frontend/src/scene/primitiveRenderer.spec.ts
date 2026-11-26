import { describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "@collaborative-whiteboard/shared";
import type { BitmapAtom, DotAtom, GlyphAtom, QuadraticAtom, ShapeAtom } from "./sceneTypes";
import { drawPrimitive } from "./primitiveRenderer";

const makeCtx = () => {
	const pattern = {} as CanvasPattern;
	const grad = { addColorStop: vi.fn() };
	return {
		save: vi.fn(),
		restore: vi.fn(),
		beginPath: vi.fn(),
		closePath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		arc: vi.fn(),
		ellipse: vi.fn(),
		rect: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		fillRect: vi.fn(),
		setLineDash: vi.fn(),
		translate: vi.fn(),
		transform: vi.fn(),
		fillText: vi.fn(),
		createPattern: vi.fn(() => pattern),
		createLinearGradient: vi.fn(() => grad),
		globalAlpha: 1,
		globalCompositeOperation: "source-over",
		fillStyle: "#000",
		strokeStyle: "#000",
		lineWidth: 1,
		lineCap: "round",
		lineJoin: "round",
		lineDashOffset: 0,
		font: "",
		textAlign: "left",
		textBaseline: "top",
		shadowColor: "",
		shadowBlur: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
	} as unknown as CanvasRenderingContext2D;
};

describe("primitiveRenderer", () => {
	it("draws dot, quadratic (double, dashed, pencil, erased), glyph, and bitmap primitives", () => {
		const ctx = makeCtx();
		const box = { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 };
		const dot: DotAtom = {
			ref: 0,
			atomId: "d1",
			elementId: "e1",
			elementRevision: 1,
			pageId: 0,
			order: { lamport: 1, opId: "o1", sourceIndex: 0, subIndex: 0 },
			recipeId: "stroke",
			primitive: "dot",
			toolId: "pen",
			style: { color: "#111", size: 4 },
			bounds: box,
			x: 0.2,
			y: 0.2,
			width: 4,
		};
		drawPrimitive(ctx, dot, IDENTITY_MATRIX, 800, 600);
		// Fully erased dot skips arc/fill
		const arcsBefore = (ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length;
		drawPrimitive(ctx, dot, IDENTITY_MATRIX, 800, 600, [{ start: 0, end: 65535 }]);
		expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(arcsBefore);

		for (const [toolId, strokePattern] of [
			["pen", "double"],
			["highlighter", "dashed"],
			["pencil", "dotted"],
			["eraser", "dash-dot"],
		] as const) {
			const quad: QuadraticAtom = {
				ref: 1,
				atomId: `q-${toolId}`,
				elementId: "e2",
				elementRevision: 1,
				pageId: 0,
				order: { lamport: 2, opId: "o2", sourceIndex: 0, subIndex: 0 },
				recipeId: "stroke",
				primitive: "quadratic",
				toolId,
				style: { color: "#222", size: 4, strokePattern },
				bounds: box,
				fromX: 0.1,
				fromY: 0.1,
				viaX: 0.2,
				viaY: 0.15,
				toX: 0.3,
				toY: 0.3,
				width: 4,
				dashOffset: 0.01,
			};
			drawPrimitive(ctx, quad, IDENTITY_MATRIX, 800, 600, [{ start: 10000, end: 20000 }]);
		}

		const glyphRef: GlyphAtom = {
			ref: 2,
			atomId: "g1",
			elementId: "e3",
			elementRevision: 1,
			pageId: 0,
			order: { lamport: 3, opId: "o3", sourceIndex: 0, subIndex: 0 },
			recipeId: "text",
			primitive: "glyph",
			toolId: "text",
			style: { color: "#000", size: 1, fontSize: 18, fontWeight: 600, fontFamily: "sans-serif" },
			bounds: box,
			grapheme: "A",
			x: 0.2,
			y: 0.2,
			maxWidth: 0.5,
			referenceWidth: 1000,
		};
		drawPrimitive(ctx, glyphRef, IDENTITY_MATRIX, 800, 600);
		drawPrimitive(ctx, { ...glyphRef, referenceWidth: undefined, style: { ...glyphRef.style, textAlign: "center" } }, IDENTITY_MATRIX, 800, 600);

		const bitmap: BitmapAtom = {
			ref: 3,
			atomId: "b1",
			elementId: "e4",
			elementRevision: 1,
			pageId: 0,
			order: { lamport: 4, opId: "o4", sourceIndex: 0, subIndex: 0 },
			recipeId: "bitmap",
			primitive: "bitmap",
			toolId: "sticker",
			style: { color: "#000", size: 1 },
			bounds: box,
			box,
			value: "✨",
		};
		drawPrimitive(ctx, bitmap, IDENTITY_MATRIX, 800, 600);
		expect(ctx.fillText).toHaveBeenCalledTimes(3);
	});

	it("draws all shape variants including sticky notes and double-stroke borders", () => {
		const ctx = makeCtx();
		const box = { minX: 0.1, minY: 0.1, maxX: 0.4, maxY: 0.4, width: 0.3, height: 0.3 };
		const baseShape: ShapeAtom = {
			ref: 0,
			atomId: "s",
			elementId: "e",
			elementRevision: 1,
			pageId: 0,
			order: { lamport: 1, opId: "o", sourceIndex: 0, subIndex: 0 },
			recipeId: "shape",
			primitive: "shape",
			toolId: "rectangle",
			style: { color: "#000", fillColor: "#eee", size: 4, strokePattern: "solid" },
			bounds: box,
			box,
			shapeKind: "rectangle",
			shapeStart: { x: 0.1, y: 0.1 },
			shapeEnd: { x: 0.4, y: 0.4 },
		};

		drawPrimitive(ctx, { ...baseShape, shapeKind: "ellipse" }, IDENTITY_MATRIX, 800, 600);
		drawPrimitive(ctx, { ...baseShape, shapeKind: "arrow", style: { ...baseShape.style, strokePattern: "double" } }, IDENTITY_MATRIX, 800, 600);
		drawPrimitive(ctx, { ...baseShape, shapeKind: "rectangle", style: { ...baseShape.style, strokePattern: "double" } }, IDENTITY_MATRIX, 800, 600);
		drawPrimitive(ctx, { ...baseShape, shapeKind: "rounded-rectangle", toolId: "sticky" }, IDENTITY_MATRIX, 800, 600);
		expect(ctx.ellipse).toHaveBeenCalled();
		expect(ctx.createLinearGradient).toHaveBeenCalled();
	});
});
