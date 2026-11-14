// File role: deterministic, quantized path-erasure interval generation.
import type { Point, QuantizedInterval } from "@collaborative-whiteboard/shared";
import type { DotAtom, QuadraticAtom } from "./sceneTypes";

export const ERASE_PARAMETER_MAX = 0xffff;
const CURVE_STEPS = 32;

const distanceToSegmentSquared = (
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
) => {
	const dx = bx - ax;
	const dy = by - ay;
	if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2;
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
	const x = ax + t * dx;
	const y = ay + t * dy;
	return (px - x) ** 2 + (py - y) ** 2;
};

const quadraticPoint = (atom: QuadraticAtom, t: number) => {
	const inverse = 1 - t;
	return {
		x: inverse * inverse * atom.fromX + 2 * inverse * t * atom.viaX + t * t * atom.toX,
		y: inverse * inverse * atom.fromY + 2 * inverse * t * atom.viaY + t * t * atom.toY,
	};
};

const touchesEraser = (
	x: number,
	y: number,
	eraser: Point[],
	radius: number,
	width: number,
	height: number
) => {
	const px = x * width;
	const py = y * height;
	const radiusSquared = radius * radius;
	if (eraser.length === 1) {
		return (px - eraser[0]!.x * width) ** 2 + (py - eraser[0]!.y * height) ** 2 <= radiusSquared;
	}
	for (let index = 1; index < eraser.length; index += 1) {
		const previous = eraser[index - 1]!;
		const current = eraser[index]!;
		if (
			distanceToSegmentSquared(
				px,
				py,
				previous.x * width,
				previous.y * height,
				current.x * width,
				current.y * height
			) <= radiusSquared
		) {
			return true;
		}
	}
	return false;
};

export const quantizeInterval = (start: number, end: number): QuantizedInterval => ({
	start: Math.max(0, Math.min(ERASE_PARAMETER_MAX, Math.round(start * ERASE_PARAMETER_MAX))),
	end: Math.max(0, Math.min(ERASE_PARAMETER_MAX, Math.round(end * ERASE_PARAMETER_MAX))),
});

export const mergeQuantizedIntervals = (intervals: QuantizedInterval[]) => {
	const ordered = intervals
		.map((interval) => ({
			start: Math.max(0, Math.min(ERASE_PARAMETER_MAX, Math.trunc(interval.start))),
			end: Math.max(0, Math.min(ERASE_PARAMETER_MAX, Math.trunc(interval.end))),
		}))
		.filter((interval) => interval.end >= interval.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: QuantizedInterval[] = [];
	for (const interval of ordered) {
		const previous = merged[merged.length - 1];
		if (previous && interval.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, interval.end);
		} else {
			merged.push({ ...interval });
		}
	}
	return merged;
};

export const cutIntervalsForStrokeAtom = (
	atom: DotAtom | QuadraticAtom,
	eraser: Point[],
	eraserSize: number,
	width: number,
	height: number,
	transform: (x: number, y: number) => { x: number; y: number } = (x, y) => ({ x, y }),
	strokeWidthScale = 1
) => {
	if (eraser.length === 0) return [];
	const radius = eraserSize / 2 + (atom.width * strokeWidthScale) / 2;
	if (atom.primitive === "dot") {
		const point = transform(atom.x, atom.y);
		return touchesEraser(point.x, point.y, eraser, radius, width, height)
			? [{ start: 0, end: ERASE_PARAMETER_MAX }]
			: [];
	}
	const from = transform(atom.fromX, atom.fromY);
	const via = transform(atom.viaX, atom.viaY);
	const to = transform(atom.toX, atom.toY);
	const length = Math.hypot((via.x - from.x) * width, (via.y - from.y) * height) + Math.hypot((to.x - via.x) * width, (to.y - via.y) * height);
	const steps = Math.max(CURVE_STEPS, Math.min(2048, Math.ceil(length / Math.max(1, eraserSize / 4))));
	const hitAt = (t: number) => {
		const local = quadraticPoint(atom, t);
		const point = transform(local.x, local.y);
		return touchesEraser(point.x, point.y, eraser, radius, width, height);
	};
	const boundary = (left: number, right: number, leftHit: boolean) => {
		for (let iteration = 0; iteration < 8; iteration += 1) {
			const middle = (left + right) / 2;
			if (hitAt(middle) === leftHit) left = middle;
			else right = middle;
		}
		return (left + right) / 2;
	};
	const intervals: QuantizedInterval[] = [];
	let previousHit = hitAt(0);
	let runStart: number | null = previousHit ? 0 : null;
	for (let step = 1; step <= steps; step += 1) {
		const t = step / steps;
		const hit = hitAt(t);
		if (hit !== previousHit) {
			const edge = boundary((step - 1) / steps, t, previousHit);
			if (hit) runStart = edge;
			else if (runStart !== null) { intervals.push(quantizeInterval(runStart, edge)); runStart = null; }
		}
		previousHit = hit;
	}
	if (runStart !== null) intervals.push(quantizeInterval(runStart, 1));
	return mergeQuantizedIntervals(intervals);
};
