// File role: shared stroke rasterization helpers used by full, incremental, and live drawing paths.
import type { FlatPoint, Point } from "@collaborative-whiteboard/shared";

type StrokeTool = "pen" | "eraser" | "cursor";
type StrokeSample = Pick<Point, "x" | "y" | "p"> | Pick<FlatPoint, "x" | "y" | "p">;

export interface StrokeState {
	x: number;
	y: number;
	width: number;
	midpointX: number;
	midpointY: number;
	pointCount: number;
	finished: boolean;
}

interface StrokeStyle {
	color: string;
	compositeOperation: GlobalCompositeOperation;
}

interface StrokeOptions {
	tool?: StrokeTool;
	color?: string;
	baseSize?: number;
	logicalWidth: number;
	logicalHeight: number;
}

interface CreateStrokeStateOptions extends StrokeOptions {
	sample: StrokeSample;
	widthOverride?: number;
}

interface PaintStrokeSampleOptions extends StrokeOptions {
	ctx: CanvasRenderingContext2D;
	sample: StrokeSample;
	previousState?: StrokeState | null;
	onBeforeDrawSegment?: (segment: {
		x: number;
		y: number;
		previousState: StrokeState;
		nextWidth: number;
	}) => void;
}

interface FinishStrokeOptions extends StrokeOptions {
	ctx: CanvasRenderingContext2D;
	state?: StrokeState | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const getStrokeWidthBounds = (baseSize: number) => ({
	min: Math.max(baseSize * 0.2, 0.5),
	max: baseSize * 2,
});

export const resolveStrokeStyle = (
	tool: StrokeTool | undefined,
	color?: string
): StrokeStyle => {
	if (tool === "eraser") {
		return {
			color: "#ffffff",
			compositeOperation: "destination-out",
		};
	}

	return {
		color: color || "#000000",
		compositeOperation: "source-over",
	};
};

export const getInitialStrokeWidth = (
	tool: StrokeTool | undefined,
	baseSize: number,
	pressure: number
) => {
	if (tool === "eraser") return baseSize;
	const bounds = getStrokeWidthBounds(baseSize);
	return clamp(baseSize * (pressure * 2), bounds.min, bounds.max);
};

export const getNextStrokeWidth = ({
	tool,
	baseSize,
	pressure,
	previousState,
}: {
	tool: StrokeTool | undefined;
	baseSize: number;
	pressure: number;
	previousState: Pick<StrokeState, "x" | "y" | "width">;
	x: number;
	y: number;
	logicalWidth: number;
}) => {
	if (tool === "eraser") {
		return baseSize;
	}

	const targetWidth = baseSize * (pressure * 2);

	const smoothedWidth = previousState.width * 0.65 + targetWidth * 0.35;
	const widthDelta = smoothedWidth - previousState.width;
	const maxDelta = Math.max(
		baseSize * (widthDelta > 0 ? 0.08 : 0.12),
		widthDelta > 0 ? 0.1 : 0.15
	);
	const limitedWidth = previousState.width + clamp(
		widthDelta,
		-maxDelta,
		maxDelta
	);
	const bounds = getStrokeWidthBounds(baseSize);
	return clamp(limitedWidth, bounds.min, bounds.max);
};

export const createStrokeStateFromSample = ({
	sample,
	tool,
	baseSize = 3,
	logicalWidth,
	logicalHeight,
	widthOverride,
}: CreateStrokeStateOptions): StrokeState => {
	const x = sample.x * logicalWidth;
	const y = sample.y * logicalHeight;
	return {
		x,
		y,
		width: widthOverride ?? getInitialStrokeWidth(tool, baseSize, sample.p),
		midpointX: x,
		midpointY: y,
		pointCount: 1,
		finished: false,
	};
};

const toPixelPoint = (sample: StrokeSample, logicalWidth: number, logicalHeight: number) => ({
	x: sample.x * logicalWidth,
	y: sample.y * logicalHeight,
});

export const paintStrokeSample = ({
	ctx,
	sample,
	previousState = null,
	tool = "pen",
	color,
	baseSize = 3,
	logicalWidth,
	logicalHeight,
	onBeforeDrawSegment,
}: PaintStrokeSampleOptions): StrokeState => {
	const style = resolveStrokeStyle(tool, color);
	const { x, y } = toPixelPoint(sample, logicalWidth, logicalHeight);

	ctx.globalCompositeOperation = style.compositeOperation;
	ctx.strokeStyle = style.color;
	ctx.fillStyle = style.color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	if (!previousState) {
		const initialWidth = getInitialStrokeWidth(tool, baseSize, sample.p);
		ctx.beginPath();
		ctx.arc(x, y, initialWidth / 2, 0, Math.PI * 2);
		ctx.fill();
		return {
			x,
			y,
			width: initialWidth,
			midpointX: x,
			midpointY: y,
			pointCount: 1,
			finished: false,
		};
	}

	const nextWidth = getNextStrokeWidth({
		tool,
		baseSize,
		pressure: sample.p,
		previousState,
		x,
		y,
		logicalWidth,
	});

	onBeforeDrawSegment?.({
		x,
		y,
		previousState,
		nextWidth,
	});

	ctx.beginPath();
	const midpointX = (previousState.x + x) / 2;
	const midpointY = (previousState.y + y) / 2;
	ctx.moveTo(previousState.midpointX, previousState.midpointY);
	ctx.quadraticCurveTo(previousState.x, previousState.y, midpointX, midpointY);
	ctx.lineWidth = tool === "eraser" ? baseSize : (previousState.width + nextWidth) / 2;

	ctx.stroke();

	return {
		x,
		y,
		width: nextWidth,
		midpointX,
		midpointY,
		pointCount: previousState.pointCount + 1,
		finished: false,
	};
};

export const advanceStrokeState = ({
	sample,
	previousState,
	tool = "pen",
	baseSize = 3,
	logicalWidth,
	logicalHeight,
}: Omit<PaintStrokeSampleOptions, "ctx" | "color" | "onBeforeDrawSegment">): StrokeState => {
	if (!previousState) {
		return createStrokeStateFromSample({
			sample,
			tool,
			baseSize,
			logicalWidth,
			logicalHeight,
		});
	}

	const { x, y } = toPixelPoint(sample, logicalWidth, logicalHeight);
	const nextWidth = getNextStrokeWidth({
		tool,
		baseSize,
		pressure: sample.p,
		previousState,
		x,
		y,
		logicalWidth,
	});

	return {
		x,
		y,
		width: nextWidth,
		midpointX: (previousState.x + x) / 2,
		midpointY: (previousState.y + y) / 2,
		pointCount: previousState.pointCount + 1,
		finished: false,
	};
};

export const finishStroke = ({
	ctx,
	state,
	tool = "pen",
	color,
	baseSize = 3,
}: FinishStrokeOptions): StrokeState | null => {
	if (!state || state.finished) return state ?? null;
	if (state.pointCount === 1) {
		return { ...state, finished: true };
	}

	const style = resolveStrokeStyle(tool, color);
	ctx.globalCompositeOperation = style.compositeOperation;
	ctx.strokeStyle = style.color;
	ctx.fillStyle = style.color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(state.midpointX, state.midpointY);
	ctx.quadraticCurveTo(state.x, state.y, state.x, state.y);
	ctx.lineWidth = tool === "eraser" ? baseSize : state.width;
	ctx.stroke();

	return { ...state, finished: true };
};
