import { describe, expect, it } from "vitest";
import type { Point } from "@collaborative-whiteboard/shared";
import type { DotAtom, QuadraticAtom, RenderAtomBase } from "./sceneTypes";
import {
	cutIntervalsForStrokeAtom,
	ERASE_PARAMETER_MAX,
	mergeQuantizedIntervals,
	quantizeInterval,
} from "./eraseGeometry";

const baseAtom = (): RenderAtomBase => ({
	ref: 0,
	atomId: "atom-1",
	elementId: "element-1",
	elementRevision: 0,
	pageId: 0,
	order: { lamport: 1, opId: "op-1", sourceIndex: 0, subIndex: 0 },
	recipeId: "stroke",
	toolId: "pen",
	style: { color: "#111111", size: 2 },
	bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
});

const dotAtom = (x: number, y: number, width = 2): DotAtom => ({
	...baseAtom(),
	primitive: "dot",
	recipeId: "stroke",
	x,
	y,
	width,
	dashOffset: 0,
});

const quadraticAtom = (
	fromX: number,
	fromY: number,
	viaX: number,
	viaY: number,
	toX: number,
	toY: number,
	width = 2
): QuadraticAtom => ({
	...baseAtom(),
	primitive: "quadratic",
	recipeId: "stroke",
	fromX,
	fromY,
	viaX,
	viaY,
	toX,
	toY,
	width,
	dashOffset: 0,
});

const eraserPoint = (x: number, y: number): Point => ({ x, y, p: 0.5, lamport: 1 });

describe("eraseGeometry", () => {
	it("quantizes parameter intervals into the transport range", () => {
		expect(quantizeInterval(0, 1)).toEqual({ start: 0, end: ERASE_PARAMETER_MAX });
		expect(quantizeInterval(-0.5, 2)).toEqual({ start: 0, end: ERASE_PARAMETER_MAX });
		expect(quantizeInterval(0.25, 0.5)).toEqual({
			start: Math.round(0.25 * ERASE_PARAMETER_MAX),
			end: Math.round(0.5 * ERASE_PARAMETER_MAX),
		});
	});

	it("merges overlapping, adjacent and unsorted intervals", () => {
		expect(
			mergeQuantizedIntervals([
				{ start: 10, end: 20 },
				{ start: 0, end: 5 },
				{ start: 21, end: 30 },
				{ start: 12, end: 15 },
			])
		).toEqual([
			{ start: 0, end: 5 },
			{ start: 10, end: 30 },
		]);

		// Inverted intervals are dropped rather than normalized.
		expect(mergeQuantizedIntervals([{ start: 9, end: 2 }])).toEqual([]);
		// Values are clamped to the transport range before merging.
		expect(mergeQuantizedIntervals([{ start: -4, end: 999999 }])).toEqual([
			{ start: 0, end: ERASE_PARAMETER_MAX },
		]);
	});

	it("erases a whole dot atom when the eraser touches it", () => {
		const atom = dotAtom(0.5, 0.5);
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.5, 0.5)], 20, 100, 100)).toEqual([
			{ start: 0, end: ERASE_PARAMETER_MAX },
		]);
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.1, 0.1)], 20, 100, 100)).toEqual([]);
		// No eraser samples means nothing is erased.
		expect(cutIntervalsForStrokeAtom(atom, [], 20, 100, 100)).toEqual([]);
	});

	it("accounts for eraser radius and stroke width in canvas units", () => {
		const atom = dotAtom(0.5, 0.5, 2);
		// Distance is 0.1 * 100 = 10 px; eraser radius 4 + stroke 1 = 5 px.
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.6, 0.5)], 8, 100, 100)).toEqual([]);
		// A 20 px eraser reaches 11 px, so the same sample now hits.
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.6, 0.5)], 20, 100, 100)).toEqual([
			{ start: 0, end: ERASE_PARAMETER_MAX },
		]);
	});

	it("applies the atom transform before hit-testing", () => {
		const atom = dotAtom(0.5, 0.5);
		const movedAway = (x: number, y: number) => ({ x: x - 0.5 + 0.05, y });
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.5, 0.5)], 10, 100, 100, movedAway)).toEqual([]);
	});

	it("returns no intervals for a quadratic far from the eraser", () => {
		const atom = quadraticAtom(0.1, 0.1, 0.1, 0.5, 0.1, 0.9);
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.9, 0.9)], 20, 100, 100)).toEqual([]);
	});

	it("cuts only the hit parameter range out of a quadratic", () => {
		const atom = quadraticAtom(0.1, 0.5, 0.5, 0.5, 0.9, 0.5);
		const intervals = cutIntervalsForStrokeAtom(atom, [eraserPoint(0.5, 0.5)], 12, 100, 100);

		expect(intervals).toHaveLength(1);
		const [interval] = intervals;
		expect(interval!.start).toBeGreaterThan(0);
		expect(interval!.end).toBeLessThan(ERASE_PARAMETER_MAX);
		expect(interval!.end).toBeGreaterThan(interval!.start);
	});

	it("erases the full quadratic when one sample covers the whole curve", () => {
		// Eraser large enough to cover every sampled point of a tiny curve.
		const atom = quadraticAtom(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
		expect(cutIntervalsForStrokeAtom(atom, [eraserPoint(0.5, 0.5)], 100, 100, 100)).toEqual([
			{ start: 0, end: ERASE_PARAMETER_MAX },
		]);
	});
});
