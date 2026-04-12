// File role: shared stroke rasterization helpers used by full, incremental, and live drawing paths.
import type { Command, FlatPoint, Point } from "../utils/type";

type StrokeTool = "pen" | "eraser" | "cursor";
type StrokeSample = Pick<Point, "x" | "y" | "p"> | Pick<FlatPoint, "x" | "y" | "p">;

export interface StrokeState {
	x: number;
	y: number;
	width: number;
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

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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
	return baseSize * (pressure * 2);
};

export const getNextStrokeWidth = ({
	tool,
	baseSize,
	pressure,
	previousState,
	x,
	y,
	logicalWidth,
}: {
	tool: StrokeTool | undefined;
	baseSize: number;
	pressure: number;
	previousState: StrokeState;
	x: number;
	y: number;
	logicalWidth: number;
}) => {
	if (tool === "eraser") {
		return baseSize;
	}

	const dist = Math.hypot(x - previousState.x, y - previousState.y);
	const velocityFactor = Math.max(0.4, 1 - dist / 120);
	let targetWidth = baseSize * (pressure * 2) * velocityFactor;

	if (logicalWidth < 500) {
		targetWidth *= Math.max(0.2, logicalWidth / 1000);
	}

	return clamp(previousState.width * 0.7 + targetWidth * 0.3, 1, baseSize + 2);
};

export const createStrokeStateFromSample = ({
	sample,
	tool,
	baseSize = 3,
	logicalWidth,
	logicalHeight,
	widthOverride,
}: CreateStrokeStateOptions): StrokeState => {
	return {
		x: sample.x * logicalWidth,
		y: sample.y * logicalHeight,
		width: widthOverride ?? getInitialStrokeWidth(tool, baseSize, sample.p),
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
		return { x, y, width: initialWidth };
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
	ctx.moveTo(previousState.x, previousState.y);

	if (tool === "eraser") {
		ctx.lineTo(x, y);
		ctx.lineWidth = baseSize;
	} else {
		const midX = (previousState.x + x) / 2;
		const midY = (previousState.y + y) / 2;
		ctx.quadraticCurveTo(midX, midY, x, y);
		ctx.lineWidth = nextWidth;
	}

	ctx.stroke();

	return { x, y, width: nextWidth };
};
