import { describe, expect, it } from "vitest";
import type { AabbBox, AffineMatrix } from "@collaborative-whiteboard/shared";
import {
	cloneMatrix,
	invertMatrix,
	matrixScale,
	multiplyMatrices,
	transformBounds,
	transformPoint,
	unionBounds,
} from "./matrix";

const translation = (x: number, y: number): AffineMatrix => [1, 0, 0, 1, x, y];
const scaling = (x: number, y: number): AffineMatrix => [x, 0, 0, y, 0, 0];
const rotation = (radians: number): AffineMatrix => {
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return [cos, sin, -sin, cos, 0, 0];
};

const bounds = (minX: number, minY: number, maxX: number, maxY: number): AabbBox => ({
	minX,
	minY,
	maxX,
	maxY,
	width: maxX - minX,
	height: maxY - minY,
});

describe("affine matrix helpers", () => {
	it("clones matrices and defaults to the identity", () => {
		const identity = cloneMatrix();
		expect(identity).toEqual([1, 0, 0, 1, 0, 0]);
		const source: AffineMatrix = [2, 0, 0, 2, 5, 5];
		const copy = cloneMatrix(source);
		expect(copy).toEqual(source);
		expect(copy).not.toBe(source);
	});

	it("multiplies matrices so that applying the product matches applying each in turn", () => {
		const product = multiplyMatrices(translation(10, 20), scaling(2, 3));
		const direct = transformPoint(product, 4, 5);
		const point = transformPoint(scaling(2, 3), 4, 5);
		const staged = transformPoint(translation(10, 20), point.x, point.y);
		expect(direct.x).toBeCloseTo(staged.x, 10);
		expect(direct.y).toBeCloseTo(staged.y, 10);
		expect(direct).toEqual({ x: 18, y: 35 });
	});

	it("inverts a matrix back to the identity", () => {
		const matrix: AffineMatrix = multiplyMatrices(rotation(Math.PI / 5), scaling(2, 3));
		const inverse = invertMatrix(matrix);
		expect(inverse).not.toBeNull();
		const roundTrip = multiplyMatrices(inverse!, matrix);
		for (let i = 0; i < roundTrip.length; i += 1) {
			const expected = i === 0 || i === 3 ? 1 : 0;
			expect(roundTrip[i]!).toBeCloseTo(expected, 10);
		}

		const translated = invertMatrix(translation(7, -3));
		expect(transformPoint(translated!, 7, -3)).toEqual({ x: 0, y: 0 });
	});

	it("returns null for singular matrices", () => {
		expect(invertMatrix([0, 0, 0, 0, 0, 0])).toBeNull();
		expect(invertMatrix(scaling(0, 5))).toBeNull();
	});

	it("transforms bounds into their axis-aligned envelope", () => {
		const identity = bounds(1, 2, 3, 4);
		// Identity short-circuits and returns the input unchanged.
		expect(transformBounds([1, 0, 0, 1, 0, 0], identity)).toBe(identity);

		const rotated = transformBounds(rotation(Math.PI / 2), bounds(-1, -1, 1, 1));
		expect(rotated.minX).toBeCloseTo(-1, 10);
		expect(rotated.maxX).toBeCloseTo(1, 10);
		expect(rotated.minY).toBeCloseTo(-1, 10);
		expect(rotated.maxY).toBeCloseTo(1, 10);
		expect(rotated.width).toBeCloseTo(2, 10);
		expect(rotated.height).toBeCloseTo(2, 10);

		const scaled = transformBounds(scaling(2, 3), bounds(1, 2, 3, 4));
		expect(scaled).toEqual({ minX: 2, minY: 6, maxX: 6, maxY: 12, width: 4, height: 6 });
	});

	it("unions bounds and copies when there is no previous bound", () => {
		const right = bounds(1, 2, 3, 4);
		const copy = unionBounds(null, right);
		expect(copy).toEqual(right);
		expect(copy).not.toBe(right);

		expect(unionBounds(bounds(0, 0, 2, 2), bounds(1, -1, 4, 1))).toEqual({
			minX: 0,
			minY: -1,
			maxX: 4,
			maxY: 2,
			width: 4,
			height: 3,
		});
	});

	it("reports the matrix scale including mirrors", () => {
		expect(matrixScale([2, 0, 0, 3, 0, 0])).toBeCloseTo(Math.sqrt(6), 10);
		expect(matrixScale([-2, 0, 0, 3, 0, 0])).toBeCloseTo(Math.sqrt(6), 10);
		// A degenerate matrix still yields a finite, non-zero scale.
		expect(matrixScale([0, 0, 0, 0, 0, 0])).toBeCloseTo(Math.sqrt(1e-12), 10);
	});
});
