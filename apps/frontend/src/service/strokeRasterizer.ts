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
	/**
	 * When supplied, geometry is accumulated into the batch instead of being
	 * stroked immediately. Only useful for full-scene replay; live drawing should
	 * omit it so each sample reaches the canvas with no added latency.
	 */
	batch?: StrokeBatch | null;
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
	batch?: StrokeBatch | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Canvas2D applies `lineWidth` per `stroke()` call, so a stroke whose width
 * varies per segment forces one draw call per point. Rounding widths onto a
 * shared ladder lets many segments share a single call.
 *
 * The ladder is geometric, not a fixed pixel grid: it bounds the *relative*
 * error, so a 0.6px hairline and a 6px stroke are equally faithful. A fixed
 * 1/4px grid would distort a hairline by 40% while barely touching a thick
 * stroke. At 96 steps the worst-case width error is ~0.5% (0.016px on a 3px
 * stroke), which is far below the rasterizer's own antialiasing resolution.
 */
const WIDTH_LADDER_STEPS = 96;

const quantizeStrokeWidth = (width: number) =>
	Math.exp(Math.round(Math.log(Math.max(width, 0.05)) * WIDTH_LADDER_STEPS) / WIDTH_LADDER_STEPS);

interface BatchEntry {
	path: Path2D;
	width: number;
	fill: boolean;
}

/**
 * Accumulates same-style geometry so it can be drawn with one call per width.
 *
 * Correctness rests on opaque `source-over` being commutative for a single
 * colour (alpha composes as a1+a2-a1*a2, which is symmetric) and
 * `destination-out` being commutative with itself. Reordering *within* one style
 * therefore cannot change a pixel. Order *between* styles is preserved by
 * flushing whenever the style changes.
 *
 * Batching only pays off when the point stream has long same-style runs. An
 * interleaved multi-user scene flushes on nearly every point, where the
 * bookkeeping is pure overhead and measurably slower than drawing directly, so
 * the batch samples its own flush rate and disables itself when locality is
 * poor.
 */
export interface StrokeBatch {
	readonly active: boolean;
	addSegment: (
		style: StrokeStyle,
		width: number,
		fromX: number,
		fromY: number,
		viaX: number,
		viaY: number,
		toX: number,
		toY: number
	) => boolean;
	addDot: (style: StrokeStyle, width: number, x: number, y: number) => boolean;
	flush: () => void;
	stats: () => { points: number; drawCalls: number };
}

const BATCH_PROBE_POINTS = 4096;
const BATCH_MIN_POINTS_PER_FLUSH = 16;

/**
 * Upper bound on segments buffered before an automatic flush.
 *
 * Without it the whole page accumulates into a handful of enormous Path2D
 * objects and is drawn by a few giant `stroke()` calls. On a GPU-accelerated but
 * CPU-throttled machine that traded many cheap draw calls for one expensive
 * path build — measurably slower, and it turned the replay into a single long
 * task. Flushing in windows keeps each path small while still collapsing
 * thousands of segments per call.
 */
const BATCH_MAX_BUFFERED_SEGMENTS = 8192;

export const createStrokeBatch = (ctx: CanvasRenderingContext2D): StrokeBatch => {
	const entries = new Map<string, BatchEntry>();
	let style: StrokeStyle | null = null;
	let points = 0;
	let flushes = 0;
	let drawCalls = 0;
	let active = true;
	let buffered = 0;

	const flush = () => {
		if (!style || entries.size === 0) {
			entries.clear();
			return;
		}
		ctx.globalCompositeOperation = style.compositeOperation;
		ctx.strokeStyle = style.color;
		ctx.fillStyle = style.color;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		for (const entry of entries.values()) {
			if (entry.fill) {
				ctx.fill(entry.path);
			} else {
				ctx.lineWidth = entry.width;
				ctx.stroke(entry.path);
			}
			drawCalls += 1;
		}
		entries.clear();
		buffered = 0;
	};

	const useStyle = (next: StrokeStyle) => {
		if (style && style.color === next.color && style.compositeOperation === next.compositeOperation) {
			return;
		}
		flush();
		flushes += 1;
		style = next;
	};

	// Disable once it is clear the stream lacks same-style runs; drawing directly
	// is cheaper than buffering that gets flushed immediately.
	const reconsider = () => {
		points += 1;
		if (active && points === BATCH_PROBE_POINTS && flushes * BATCH_MIN_POINTS_PER_FLUSH > points) {
			flush();
			active = false;
		}
		return active;
	};

	const entryFor = (key: string, width: number, fill: boolean) => {
		let entry = entries.get(key);
		if (!entry) {
			entry = { path: new Path2D(), width, fill };
			entries.set(key, entry);
		}
		return entry;
	};

	// Called after appending; keeps each flush window bounded.
	const noteBuffered = () => {
		buffered += 1;
		if (buffered >= BATCH_MAX_BUFFERED_SEGMENTS) {
			flush();
		}
	};

	return {
		get active() {
			return active;
		},
		addSegment: (next, width, fromX, fromY, viaX, viaY, toX, toY) => {
			if (!active) return false;
			useStyle(next);
			if (!reconsider()) return false;
			const quantized = quantizeStrokeWidth(width);
			const entry = entryFor(`s${quantized}`, quantized, false);
			entry.path.moveTo(fromX, fromY);
			entry.path.quadraticCurveTo(viaX, viaY, toX, toY);
			noteBuffered();
			return true;
		},
		addDot: (next, width, x, y) => {
			if (!active) return false;
			useStyle(next);
			if (!reconsider()) return false;
			const quantized = quantizeStrokeWidth(width);
			const entry = entryFor(`d${quantized}`, quantized, true);
			entry.path.moveTo(x + quantized / 2, y);
			entry.path.arc(x, y, quantized / 2, 0, Math.PI * 2);
			noteBuffered();
			return true;
		},
		flush,
		stats: () => ({ points, drawCalls }),
	};
};

const getStrokeWidthBounds = (baseSize: number) => ({
	min: Math.max(baseSize * 0.2, 0.5),
	max: baseSize * 2,
});

const applyStrokeStyle = (ctx: CanvasRenderingContext2D, style: StrokeStyle) => {
	ctx.globalCompositeOperation = style.compositeOperation;
	ctx.strokeStyle = style.color;
	ctx.fillStyle = style.color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
};

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
	batch = null,
	onBeforeDrawSegment,
}: PaintStrokeSampleOptions): StrokeState => {
	const style = resolveStrokeStyle(tool, color);
	const { x, y } = toPixelPoint(sample, logicalWidth, logicalHeight);

	if (!previousState) {
		const initialWidth = getInitialStrokeWidth(tool, baseSize, sample.p);
		if (!batch?.addDot(style, initialWidth, x, y)) {
			applyStrokeStyle(ctx, style);
			ctx.beginPath();
			ctx.arc(x, y, initialWidth / 2, 0, Math.PI * 2);
			ctx.fill();
		}
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

	const midpointX = (previousState.x + x) / 2;
	const midpointY = (previousState.y + y) / 2;
	const segmentWidth = tool === "eraser" ? baseSize : (previousState.width + nextWidth) / 2;

	if (
		!batch?.addSegment(
			style,
			segmentWidth,
			previousState.midpointX,
			previousState.midpointY,
			previousState.x,
			previousState.y,
			midpointX,
			midpointY
		)
	) {
		applyStrokeStyle(ctx, style);
		ctx.beginPath();
		ctx.moveTo(previousState.midpointX, previousState.midpointY);
		ctx.quadraticCurveTo(previousState.x, previousState.y, midpointX, midpointY);
		ctx.lineWidth = segmentWidth;
		ctx.stroke();
	}

	// Advance in place. Returning a fresh object here allocated one per point,
	// which at 100k points dominated the loop's allocation traffic; every caller
	// keeps exactly one state per command and stores it back under the same key.
	previousState.x = x;
	previousState.y = y;
	previousState.width = nextWidth;
	previousState.midpointX = midpointX;
	previousState.midpointY = midpointY;
	previousState.pointCount += 1;
	return previousState;
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

	// Advance in place; see the note in paintStrokeSample.
	previousState.midpointX = (previousState.x + x) / 2;
	previousState.midpointY = (previousState.y + y) / 2;
	previousState.x = x;
	previousState.y = y;
	previousState.width = nextWidth;
	previousState.pointCount += 1;
	return previousState;
};

export const finishStroke = ({
	ctx,
	state,
	tool = "pen",
	color,
	baseSize = 3,
	batch = null,
}: FinishStrokeOptions): StrokeState | null => {
	if (!state || state.finished) return state ?? null;
	if (state.pointCount === 1) {
		state.finished = true;
		return state;
	}

	const style = resolveStrokeStyle(tool, color);
	const tailWidth = tool === "eraser" ? baseSize : state.width;
	if (
		!batch?.addSegment(
			style,
			tailWidth,
			state.midpointX,
			state.midpointY,
			state.x,
			state.y,
			state.x,
			state.y
		)
	) {
		applyStrokeStyle(ctx, style);
		ctx.beginPath();
		ctx.moveTo(state.midpointX, state.midpointY);
		ctx.quadraticCurveTo(state.x, state.y, state.x, state.y);
		ctx.lineWidth = tailWidth;
		ctx.stroke();
	}

	state.finished = true;
	return state;
};
