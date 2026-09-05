// File role: compiles stateful samples once into independently renderable stroke atoms.
import type {
	Point,
	RenderOrderKey,
	SceneElementDescriptor,
} from "@collaborative-whiteboard/shared";
import { getInitialStrokeWidth, getNextStrokeWidth } from "../service/strokeRasterizer";
import type { DotAtom, QuadraticAtom } from "./sceneTypes";

type CompiledStrokeAtom = Omit<DotAtom, "ref"> | Omit<QuadraticAtom, "ref">;

export interface StrokeCompilerState {
	x: number;
	y: number;
	midpointX: number;
	midpointY: number;
	width: number;
	pointCount: number;
	distance: number;
	lastOrder: RenderOrderKey;
	lastSourceIndex: number;
	finished: boolean;
}

interface CompileStrokeInput {
	elementId: string;
	elementRevision: number;
	pageId: number;
	descriptor: SceneElementDescriptor;
	point: Point;
	order: RenderOrderKey;
	sourceIndex: number;
	previousState?: StrokeCompilerState | null;
}

const boundsOf = (...coordinates: number[]) => {
	let minX = coordinates[0] ?? 0;
	let maxX = minX;
	let minY = coordinates[1] ?? 0;
	let maxY = minY;
	for (let index = 2; index < coordinates.length; index += 2) {
		const x = coordinates[index] ?? 0;
		const y = coordinates[index + 1] ?? 0;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

const baseAtom = (
	input: CompileStrokeInput,
	atomId: string,
	bounds: ReturnType<typeof boundsOf>
) => ({
	atomId,
	elementId: input.elementId,
	elementRevision: input.elementRevision,
	pageId: input.pageId,
	order: input.order,
	recipeId: "stroke" as const,
	toolId: input.descriptor.toolId,
	style: input.descriptor.style,
	bounds,
});

export const compileStrokeSample = (input: CompileStrokeInput) => {
	const baseSize = input.descriptor.style.size;
	const tool = input.descriptor.toolId === "eraser" ? "eraser" : "pen";
	if (!input.previousState) {
		const width = getInitialStrokeWidth(tool, baseSize, input.point.p);
		const atom: Omit<DotAtom, "ref"> = {
			...baseAtom(
				input,
				`${input.elementId}:${input.sourceIndex}:0`,
				boundsOf(input.point.x, input.point.y)
			),
			primitive: "dot",
			x: input.point.x,
			y: input.point.y,
			width,
			dashOffset: 0,
		};
		const state: StrokeCompilerState = {
			x: input.point.x,
			y: input.point.y,
			midpointX: input.point.x,
			midpointY: input.point.y,
			width,
			pointCount: 1,
			distance: 0,
			lastOrder: input.order,
			lastSourceIndex: input.sourceIndex,
			finished: false,
		};
		return { state, atoms: [atom] as CompiledStrokeAtom[] };
	}

	const previous = input.previousState;
	const nextWidth = getNextStrokeWidth({
		tool,
		baseSize,
		pressure: input.point.p,
		previousState: previous,
		x: input.point.x,
		y: input.point.y,
		logicalWidth: 1,
	});
	const midpointX = (previous.x + input.point.x) / 2;
	const midpointY = (previous.y + input.point.y) / 2;
	const segmentWidth = tool === "eraser" ? baseSize : (previous.width + nextWidth) / 2;
	const segmentLength = Math.hypot(input.point.x - previous.x, input.point.y - previous.y);
	const atom: Omit<QuadraticAtom, "ref"> = {
		...baseAtom(
			input,
			`${input.elementId}:${input.sourceIndex}:0`,
			boundsOf(previous.midpointX, previous.midpointY, previous.x, previous.y, midpointX, midpointY)
		),
		primitive: "quadratic",
		fromX: previous.midpointX,
		fromY: previous.midpointY,
		viaX: previous.x,
		viaY: previous.y,
		toX: midpointX,
		toY: midpointY,
		width: segmentWidth,
		dashOffset: previous.distance,
	};
	previous.x = input.point.x;
	previous.y = input.point.y;
	previous.midpointX = midpointX;
	previous.midpointY = midpointY;
	previous.width = nextWidth;
	previous.pointCount += 1;
	previous.distance += segmentLength;
	previous.lastOrder = input.order;
	previous.lastSourceIndex = input.sourceIndex;
	return { state: previous, atoms: [atom] as CompiledStrokeAtom[] };
};

export const finishCompiledStroke = (input: {
	elementId: string;
	elementRevision: number;
	pageId: number;
	descriptor: SceneElementDescriptor;
	state: StrokeCompilerState | null | undefined;
}) => {
	const state = input.state;
	if (!state || state.finished || state.pointCount <= 1) return [] as CompiledStrokeAtom[];
	state.finished = true;
	const order = { ...state.lastOrder, subIndex: state.lastOrder.subIndex + 1 };
	const atom: Omit<QuadraticAtom, "ref"> = {
		atomId: `${input.elementId}:${state.lastSourceIndex}:1`,
		elementId: input.elementId,
		elementRevision: input.elementRevision,
		pageId: input.pageId,
		order,
		recipeId: "stroke",
		toolId: input.descriptor.toolId,
		style: input.descriptor.style,
		bounds: boundsOf(state.midpointX, state.midpointY, state.x, state.y, state.x, state.y),
		primitive: "quadratic",
		fromX: state.midpointX,
		fromY: state.midpointY,
		viaX: state.x,
		viaY: state.y,
		toX: state.x,
		toY: state.y,
		width: input.descriptor.toolId === "eraser" ? input.descriptor.style.size : state.width,
		dashOffset: state.distance,
	};
	return [atom] as CompiledStrokeAtom[];
};
