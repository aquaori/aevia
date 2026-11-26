import { describe, expect, it, vi } from "vitest";
import type { Command } from "@collaborative-whiteboard/shared";
import { createInteractionController } from "../controllers/interactionController";

describe("scene selection interaction", () => {
	const bounds = { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8, width: 0.6, height: 0.6 };
	const base = {
		canvasSize: { width: 1000, height: 500 },
		commands: [],
		selectedCommandIds: new Set(["scene-element"]),
		currentPageId: 0,
		getCommandBoundingBox: () => null,
		getGroupBoundingBox: () => null,
		selectedSceneBounds: bounds,
	};

	it("drags from empty space inside the selected scene bounds", () => {
		const result = createInteractionController().resolveCursorAction({ ...base, normalizedPoint: { x: 0.4, y: 0.4 } });
		expect(result.mode).toBe("dragging");
		expect(result.selectedIds).toEqual(["scene-element"]);
	});

	it("recognizes the rotation handle without a scene hit", () => {
		const result = createInteractionController().resolveCursorAction({ ...base, normalizedPoint: { x: 0.5, y: 0.2 - 33 / 500 } });
		expect(result.mode).toBe("rotating");
	});
});

describe("constrained shapes", () => {
	it.each([[-1, -1], [-1, 1], [1, -1], [1, 1]])("keeps equal pixel dimensions in quadrant %s,%s", (sx, sy) => {
		const start = { x: 0.5, y: 0.5 };
		const result = createInteractionController().constrainSquare(start, { x: 0.5 + sx * 0.1, y: 0.5 + sy * 0.1 }, { width: 1000, height: 500 });
		expect(Math.abs(result.x - start.x) * 1000).toBeCloseTo(Math.abs(result.y - start.y) * 500);
		expect(Math.sign(result.x - start.x)).toBe(sx);
		expect(Math.sign(result.y - start.y)).toBe(sy);
	});
	it("keeps the square within the canvas near an edge", () => {
		const start = { x: 0.95, y: 0.5 };
		const result = createInteractionController().constrainSquare(start, { x: 1, y: 0.9 }, { width: 1000, height: 500 });
		expect(result.x).toBeCloseTo(1);
		expect((result.x - start.x) * 1000).toBeCloseTo((result.y - start.y) * 500);
	});
});

it("rotates in screen coordinates on a non-square canvas", () => {
	const matrix = createInteractionController().getTransformMatrix({
		currentPos: { x: 0.6, y: 0.5 }, startPos: { x: 0.5, y: 0.3 }, handle: "rotate",
		initialBox: { minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6, width: 0.2, height: 0.2 },
		canvasSize: { width: 1000, height: 500 },
	});
	const x = matrix[0] * 0.6 + matrix[2] * 0.5 + matrix[4];
	const y = matrix[1] * 0.6 + matrix[3] * 0.5 + matrix[5];
	expect(x).toBeCloseTo(0.5);
	expect(y).toBeCloseTo(0.7);
});

describe("interactionController pointer sync, handles, preview, and stop helpers", () => {
	it("computes pointer coordinates, normalizes, syncs cursor, and notifies leave", () => {
		const ctrl = createInteractionController();
		const send = vi.fn();
		const canvas = document.createElement("canvas");
		canvas.width = 1000;
		canvas.height = 500;
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: 10,
			top: 20,
			width: 1000,
			height: 500,
			right: 1010,
			bottom: 520,
			x: 10,
			y: 20,
			toJSON: () => ({}),
		});
		Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });

		const coords = ctrl.getCoordinates(canvas, { clientX: 110, clientY: 120, pressure: 0.4 } as PointerEvent);
		expect(coords).toEqual({ x: 100, y: 100, pressure: 0.4 });
		expect(ctrl.normalizeCoordinates(canvas, coords)).toEqual({ x: 0.1, y: 0.2 });

		ctrl.syncPointerPosition({
			canvas,
			cursorX: 100,
			cursorY: 100,
			userId: "u1",
			userName: "Alice",
			currentPageId: 0,
			interactionMode: "box-selecting",
			selectedCommandIds: new Set(),
			dragStartPos: null,
			selectionRect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
			lastSentPos: { x: 0, y: 0 },
			send,
		});
		expect(send).toHaveBeenCalledWith("mouseMove", expect.objectContaining({ x: 0.1, y: 0.2 }));
		expect(send).toHaveBeenCalledWith("box-selection", expect.objectContaining({ userId: "u1" }));

		ctrl.notifyPointerLeave(send, { userId: "u1", userName: "Alice" });
		expect(send).toHaveBeenCalledWith("mouseLeave", { userId: "u1", userName: "Alice" });
	});

	it("exercises beginCursorInteraction, previewCursorInteraction, all resize handles, and finishCursorInteraction", () => {
		const ctrl = createInteractionController();
		const canvas = document.createElement("canvas");
		canvas.width = 1000;
		canvas.height = 500;
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 1000,
			height: 500,
			right: 1000,
			bottom: 500,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });

		const cmd: Command = {
			id: "cmd-1",
			type: "path",
			tool: "pen",
			pageId: 0,
			userId: "u1",
			lamport: 1,
			isDeleted: false,
			points: [{ x: 0.2, y: 0.2, p: 0.5, lamport: 1 }, { x: 0.4, y: 0.4, p: 0.5, lamport: 2 }],
			box: { minX: 0.2, minY: 0.2, maxX: 0.4, maxY: 0.4, width: 0.2, height: 0.2 },
		};
		const commandMap = new Map([[cmd.id, cmd]]);
		const getBox = (c: Command) => c.box ?? null;

		const begin = ctrl.beginCursorInteraction({
			canvas,
			event: { clientX: 300, clientY: 150, pressure: 0.5 } as PointerEvent,
			commands: [cmd],
			commandMap,
			selectedCommandIds: new Set(["cmd-1"]),
			currentPageId: 0,
			getCommandBoundingBox: getBox,
			getGroupBoundingBox: () => cmd.box!,
		});
		expect(begin.mode).toBe("dragging");

		const preview = ctrl.previewCursorInteraction({
			canvas,
			interactionMode: "dragging",
			x: 360,
			y: 200,
			dragStartPos: begin.normalizedPoint,
			selectedCommandIds: new Set(["cmd-1"]),
			activeTransformHandle: "body",
			initialGroupBox: cmd.box!,
			transformingCmdIds: new Set(),
		});
		expect(preview.shouldPromote).toBe(true);
		expect(preview.transformMatrix).not.toBeNull();

		const finishDrag = ctrl.finishCursorInteraction({
			interactionMode: "dragging",
			selectionRect: null,
			selectedCommandIds: new Set(["cmd-1"]),
			commandMap,
			previewTransform: preview.transformMatrix,
			currentPageId: 0,
			getCommandBoundingBox: getBox,
		});
		expect(finishDrag.transformPayload?.targets.length).toBe(1);

		const finishBox = ctrl.finishCursorInteraction({
			interactionMode: "box-selecting",
			selectionRect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
			selectedCommandIds: new Set(),
			commandMap,
			previewTransform: null,
			currentPageId: 0,
			getCommandBoundingBox: getBox,
		});
		expect(finishBox.selectedIds).toEqual(["cmd-1"]);

		for (const handle of ["tl", "tm", "tr", "mr", "br", "bm", "bl", "ml"] as const) {
			const mat = ctrl.getTransformMatrix({
				currentPos: { x: 0.5, y: 0.5 },
				startPos: { x: 0.3, y: 0.3 },
				handle,
				initialBox: cmd.box!,
			});
			expect(mat.length).toBe(6);
		}
		const transformedPts = ctrl.transformPoints({
			currentPos: { x: 0.5, y: 0.5 },
			startPos: { x: 0.4, y: 0.4 },
			handle: "body",
			initialBox: cmd.box!,
			points: cmd.points!,
		});
		expect(transformedPts[0]!.x).toBeCloseTo(0.3);
	});
});
