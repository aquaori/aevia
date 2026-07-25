import { describe, expect, it } from "vitest";
import type { Point } from "@collaborative-whiteboard/shared";
import {
	finishStroke,
	getInitialStrokeWidth,
	getNextStrokeWidth,
	paintStrokeSample,
	type StrokeState,
} from "./strokeRasterizer";

interface DrawOperation {
	name: string;
	args: number[];
}

const createRecordingContext = () => {
	const operations: DrawOperation[] = [];
	const record = (name: string, ...args: number[]) => operations.push({ name, args });
	const context = {
		globalCompositeOperation: "source-over",
		strokeStyle: "#000000",
		fillStyle: "#000000",
		lineCap: "butt",
		lineJoin: "miter",
		lineWidth: 1,
		beginPath: () => record("beginPath"),
		arc: (...args: number[]) => record("arc", ...args),
		fill: () => record("fill"),
		moveTo: (...args: number[]) => record("moveTo", ...args),
		quadraticCurveTo: (...args: number[]) => record("quadraticCurveTo", ...args),
		stroke: () => record("stroke"),
	} as unknown as CanvasRenderingContext2D;

	return { context, operations };
};

const points: Point[] = [
	{ x: 0, y: 0, p: 0.5, lamport: 1 },
	{ x: 0.1, y: 0.1, p: 0.5, lamport: 2 },
	{ x: 0.2, y: 0, p: 0.5, lamport: 3 },
];

const renderBatches = (batches: Point[][]) => {
	const { context, operations } = createRecordingContext();
	let state: StrokeState | null = null;
	batches.forEach((batch) => {
		batch.forEach((sample) => {
			state = paintStrokeSample({
				ctx: context,
				sample,
				previousState: state,
				tool: "pen",
				baseSize: 4,
				logicalWidth: 100,
				logicalHeight: 100,
			});
		});
	});
	state = finishStroke({
		ctx: context,
		state,
		tool: "pen",
		baseSize: 4,
		logicalWidth: 100,
		logicalHeight: 100,
	});
	return { operations, state, context };
};

describe("strokeRasterizer", () => {
	it("uses the previous sample as the control point between adjacent midpoints", () => {
		const { operations } = renderBatches([points]);
		const curves = operations.filter((operation) => operation.name === "quadraticCurveTo");

		expect(curves.map((operation) => operation.args)).toEqual([
			[0, 0, 5, 5],
			[10, 10, 15, 5],
			[20, 0, 20, 0],
		]);
	});

	it("produces identical geometry when samples arrive in different batches", () => {
		const singleBatch = renderBatches([points]);
		const splitBatches = renderBatches([[points[0]!], [points[1]!], [points[2]!]]);

		expect(splitBatches.operations).toEqual(singleBatch.operations);
	});

	it("finishes a stroke once without repainting a single-point stroke", () => {
		const { context, operations } = createRecordingContext();
		let state = paintStrokeSample({
			ctx: context,
			sample: points[0]!,
			tool: "pen",
			baseSize: 4,
			logicalWidth: 100,
			logicalHeight: 100,
		});
		const operationCount = operations.length;
		state = finishStroke({
			ctx: context,
			state,
			tool: "pen",
			baseSize: 4,
			logicalWidth: 100,
			logicalHeight: 100,
		})!;
		finishStroke({
			ctx: context,
			state,
			tool: "pen",
			baseSize: 4,
			logicalWidth: 100,
			logicalHeight: 100,
		});

		expect(state.finished).toBe(true);
		expect(operations).toHaveLength(operationCount);
	});

	it("uses the same smooth geometry for the eraser", () => {
		const { context, operations } = createRecordingContext();
		let state: StrokeState | null = null;
		points.slice(0, 2).forEach((sample) => {
			state = paintStrokeSample({
				ctx: context,
				sample,
				previousState: state,
				tool: "eraser",
				baseSize: 12,
				logicalWidth: 100,
				logicalHeight: 100,
			});
		});

		expect(operations.some((operation) => operation.name === "quadraticCurveTo")).toBe(true);
		expect(context.globalCompositeOperation).toBe("destination-out");
		expect(context.lineWidth).toBe(12);
	});

	it("derives width from normalized pressure instead of point distance", () => {
		const previousState = { x: 0, y: 0, width: 4 };
		const near = getNextStrokeWidth({
			tool: "pen",
			baseSize: 4,
			pressure: 0.5,
			previousState,
			x: 2,
			y: 0,
			logicalWidth: 1000,
		});
		const far = getNextStrokeWidth({
			tool: "pen",
			baseSize: 4,
			pressure: 0.5,
			previousState,
			x: 200,
			y: 0,
			logicalWidth: 1000,
		});

		expect(far).toBe(near);
		expect(
			getNextStrokeWidth({
				tool: "pen",
				baseSize: 4,
				pressure: 0.5,
				previousState,
				x: 2,
				y: 0,
				logicalWidth: 320,
			})
		).toBe(near);
	});

	it("limits width changes between adjacent samples", () => {
		const initialWidth = getInitialStrokeWidth("pen", 10, 0.1);
		const nextWidth = getNextStrokeWidth({
			tool: "pen",
			baseSize: 10,
			pressure: 1,
			previousState: { x: 0, y: 0, width: initialWidth },
			x: 10,
			y: 0,
			logicalWidth: 1000,
		});

		expect(nextWidth - initialWidth).toBeCloseTo(0.8, 8);

		const thinnerWidth = getNextStrokeWidth({
			tool: "pen",
			baseSize: 10,
			pressure: 0.1,
			previousState: { x: 0, y: 0, width: 20 },
			x: 10,
			y: 0,
			logicalWidth: 1000,
		});
		expect(20 - thinnerWidth).toBeCloseTo(1.2, 8);
	});

	it("preserves the full relative pressure range for large brushes", () => {
		expect(getInitialStrokeWidth("pen", 10, 0.1)).toBe(2);
		expect(getInitialStrokeWidth("pen", 10, 1)).toBe(20);
	});
});
