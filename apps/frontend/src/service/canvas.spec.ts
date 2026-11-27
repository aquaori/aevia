import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, FlatPoint } from "@collaborative-whiteboard/shared";
import {
	canvasRef,
	ctx,
	finishIncrementalStroke,
	hasPendingSceneDependencies,
	hitTestScene,
	quarantineSceneMissingElements,
	querySceneElements,
	renderClippedPointSequence,
	renderIncrementPoint,
	renderPointSequence,
	renderSceneCommands,
	renderWithPoints,
	resetIncrementalStroke,
} from "./canvas";

const createMockCtx = () =>
	({
		canvas: { width: 800, height: 600 },
		save: vi.fn(),
		restore: vi.fn(),
		setTransform: vi.fn(),
		beginPath: vi.fn(),
		closePath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		arc: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		clip: vi.fn(),
		rect: vi.fn(),
		clearRect: vi.fn(),
		fillRect: vi.fn(),
		setLineDash: vi.fn(),
		translate: vi.fn(),
		scale: vi.fn(),
		rotate: vi.fn(),
		transform: vi.fn(),
		globalAlpha: 1,
		globalCompositeOperation: "source-over",
		fillStyle: "#000",
		strokeStyle: "#000",
		lineWidth: 1,
		lineCap: "round",
		lineJoin: "round",
	}) as unknown as CanvasRenderingContext2D;

describe("service/canvas helpers", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.stubGlobal("Path2D", class { moveTo = vi.fn(); lineTo = vi.fn(); quadraticCurveTo = vi.fn(); arc = vi.fn(); });
		canvasRef.value = { width: 800, height: 600 } as HTMLCanvasElement;
		ctx.value = createMockCtx();
		Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
	});

	afterEach(() => {
		canvasRef.value = null;
		ctx.value = null;
	});

	it("renders incremental points, finishes strokes, and replays point sequences", () => {
		const cmd: Command = {
			id: "stroke-1",
			type: "path",
			tool: "pen",
			color: "#111",
			size: 4,
			pageId: 0,
			userId: "u1",
			lamport: 1,
			points: [],
			isDeleted: false,
		};
		renderIncrementPoint(cmd, [{ x: 0.1, y: 0.2, p: 0.5, lamport: 1 }, { x: 0.3, y: 0.4, p: 0.6, lamport: 2 }], ctx.value!, 400, 300, false, "remote");
		finishIncrementalStroke(cmd, ctx.value!, 400, 300);
		resetIncrementalStroke(cmd.id);

		const flat: FlatPoint[] = [
			{ x: 0.1, y: 0.1, p: 0.5, lamport: 1, cmdId: "f1", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: false },
			{ x: 0.2, y: 0.2, p: 0.5, lamport: 2, cmdId: "f1", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: false },
			{ x: 0.5, y: 0.5, p: 0.5, lamport: 3, cmdId: "del", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: true },
		];
		const states = renderPointSequence(ctx.value!, 400, 300, flat);
		expect(states.has("f1")).toBe(true);
		expect(states.has("del")).toBe(false);

		renderWithPoints(flat);
		const dirtyCount = renderClippedPointSequence(ctx.value!, 400, 300, { minX: 0, minY: 0, width: 1, height: 1 });
		expect(typeof dirtyCount).toBe("number");
	});

	it("rebuilds scene commands, hit tests, queries elements, and exposes pending dependencies", () => {
		const cmd: Command = {
			id: "op-rect",
			type: "scene-op",
			pageId: 0,
			userId: "u1",
			lamport: 5,
			isDeleted: false,
			sceneOperation: {
				schemaVersion: 2,
				opId: "op-rect",
				elementId: "rect-1",
				actorId: "u1",
				roomId: "r1",
				historyGroupId: "hg-1",
				pageId: 0,
				lamport: 5,
				kind: "element.create",
				payload: {
					descriptor: {
						elementKind: "shape",
						recipeId: "shape",
						toolId: "rectangle",
						style: { color: "#000", size: 2 },
						start: { x: 0.2, y: 0.2 },
						end: { x: 0.4, y: 0.4 },
					},
				},
			},
		};
		expect(renderSceneCommands([cmd], 0)).toBe(false);
		expect(hasPendingSceneDependencies()).toBe(false);
		expect(quarantineSceneMissingElements([])).toEqual([]);

		const hit = hitTestScene(120, 90);
		expect(hit.elementId === null || typeof hit.elementId === "string").toBe(true);
		const queried = querySceneElements({ minX: 0, minY: 0, maxX: 400, maxY: 300, width: 400, height: 300 });
		expect(queried.elementIds).toContain("rect-1");
		expect(queried.bounds).not.toBeNull();
	});
});
