// File role: deterministic affine helpers over normalized scene coordinates.
import { IDENTITY_MATRIX, type AabbBox, type AffineMatrix } from "@collaborative-whiteboard/shared";

export const cloneMatrix = (matrix: AffineMatrix = IDENTITY_MATRIX): AffineMatrix => [...matrix];

export const multiplyMatrices = (next: AffineMatrix, current: AffineMatrix): AffineMatrix => {
	const [a1, b1, c1, d1, e1, f1] = next;
	const [a2, b2, c2, d2, e2, f2] = current;
	return [
		a1 * a2 + c1 * b2,
		b1 * a2 + d1 * b2,
		a1 * c2 + c1 * d2,
		b1 * c2 + d1 * d2,
		a1 * e2 + c1 * f2 + e1,
		b1 * e2 + d1 * f2 + f1,
	];
};

export const transformPoint = (matrix: AffineMatrix, x: number, y: number) => ({
	x: matrix[0] * x + matrix[2] * y + matrix[4],
	y: matrix[1] * x + matrix[3] * y + matrix[5],
});

export const invertMatrix = (matrix: AffineMatrix): AffineMatrix | null => {
	const [a, b, c, d, e, f] = matrix;
	const determinant = a * d - b * c;
	if (Math.abs(determinant) < 1e-12) return null;
	const inverse = 1 / determinant;
	return [
		d * inverse,
		-b * inverse,
		-c * inverse,
		a * inverse,
		(c * f - d * e) * inverse,
		(b * e - a * f) * inverse,
	];
};

export const transformBounds = (matrix: AffineMatrix, bounds: AabbBox): AabbBox => {
	if (
		matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 &&
		matrix[3] === 1 && matrix[4] === 0 && matrix[5] === 0
	) return bounds;
	const points = [
		transformPoint(matrix, bounds.minX, bounds.minY),
		transformPoint(matrix, bounds.maxX, bounds.minY),
		transformPoint(matrix, bounds.maxX, bounds.maxY),
		transformPoint(matrix, bounds.minX, bounds.maxY),
	];
	const minX = Math.min(...points.map((point) => point.x));
	const minY = Math.min(...points.map((point) => point.y));
	const maxX = Math.max(...points.map((point) => point.x));
	const maxY = Math.max(...points.map((point) => point.y));
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

export const unionBounds = (left: AabbBox | null, right: AabbBox): AabbBox => {
	if (!left) return { ...right };
	const minX = Math.min(left.minX, right.minX);
	const minY = Math.min(left.minY, right.minY);
	const maxX = Math.max(left.maxX, right.maxX);
	const maxY = Math.max(left.maxY, right.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

export const matrixScale = (matrix: AffineMatrix) =>
	Math.sqrt(Math.max(1e-12, Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])));
