import { describe, expect, it } from "vitest";
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
