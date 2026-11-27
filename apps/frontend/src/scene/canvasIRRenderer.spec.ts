import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "@collaborative-whiteboard/shared";
import { renderIRFrame, renderIRItems } from "./canvasIRRenderer";
import type { RenderIRFrame, RenderIRItem } from "./renderIR";

const make2dCtx = () => ({
	canvas: { width: 800, height: 600 },
	save: vi.fn(),
	restore: vi.fn(),
	setTransform: vi.fn(),
	scale: vi.fn(),
	transform: vi.fn(),
	clearRect: vi.fn(),
	drawImage: vi.fn(),
	beginPath: vi.fn(),
	closePath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	quadraticCurveTo: vi.fn(),
	arc: vi.fn(),
	fill: vi.fn(),
	stroke: vi.fn(),
	setLineDash: vi.fn(),
	fillStyle: "#000",
	strokeStyle: "#000",
	lineWidth: 1,
	lineCap: "round",
	lineJoin: "round",
	globalAlpha: 1,
	globalCompositeOperation: "source-over",
	shadowColor: "",
	lineDashOffset: 0,
});

describe("canvasIRRenderer", () => {
	beforeEach(() => {
		class MockOffscreenCanvas {
			width: number;
			height: number;
			private ctx = make2dCtx();
			constructor(width = 800, height = 600) {
				this.width = width;
				this.height = height;
			}
			getContext() {
				return this.ctx;
			}
		}
		vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders regular items, highlighter layers, and erase masks in renderIRFrame", () => {
		const ctx = make2dCtx() as unknown as CanvasRenderingContext2D;
		const box = { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 };
		const items: RenderIRItem[] = [
			{
				atom: {
					ref: 0,
					atomId: "pen-1",
					elementId: "e-pen",
					elementRevision: 1,
					pageId: 0,
					order: { lamport: 1, opId: "o1", sourceIndex: 0, subIndex: 0 },
					recipeId: "stroke",
					primitive: "dot",
					toolId: "pen",
					style: { color: "#000", size: 4 },
					bounds: box,
					x: 0.2,
					y: 0.2,
					width: 4,
				},
				matrix: IDENTITY_MATRIX,
				eraseMasks: [],
			},
			{
				atom: {
					ref: 1,
					atomId: "hl-1",
					elementId: "e-hl",
					elementRevision: 1,
					pageId: 0,
					order: { lamport: 2, opId: "o2", sourceIndex: 0, subIndex: 0 },
					recipeId: "stroke",
					primitive: "dot",
					toolId: "highlighter",
					style: { color: "#ff0", size: 8, opacity: 0.32 },
					bounds: box,
					x: 0.25,
					y: 0.25,
					width: 8,
				},
				matrix: IDENTITY_MATRIX,
				eraseMasks: [
					{
						width: 800,
						height: 600,
						size: 12,
						inverseMatrix: IDENTITY_MATRIX,
						points: [
							{ x: 0.1, y: 0.1 },
							{ x: 0.2, y: 0.2 },
						],
					},
				],
			},
		];
		const frame: RenderIRFrame = { revision: 2, pageId: 0, width: 800, height: 600, items };
		expect(renderIRFrame(ctx, frame, 800, 600)).toBe(2);
		expect(renderIRItems(ctx, items, 800, 600, IDENTITY_MATRIX)).toBe(2);
	});
});
