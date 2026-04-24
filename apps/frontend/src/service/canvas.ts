// File role: shared canvas refs plus low-level drawing helpers used by render paths.
import { ref } from "vue";
import type { Command, FlatPoint, LastWidthInfo, Point } from "@collaborative-whiteboard/shared";
import { useLamportStore } from "../store/lamportStore";
import { useCommandStore } from "../store/commandStore";
import {
	isRuntimeDebugLoggingEnabled,
	recordIncrementalRenderEnd,
	recordIncrementalRenderStart,
	recordRenderEnd,
	recordRenderStart,
} from "../instrumentation/runtimeInstrumentation";
import {
	createStrokeStateFromSample,
	getNextStrokeWidth,
	paintStrokeSample,
	type StrokeState,
} from "./strokeRasterizer";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const uiCanvasRef = ref<HTMLCanvasElement | null>(null);

const ctx = ref<CanvasRenderingContext2D | null>(null);
const uiCtx = ref<CanvasRenderingContext2D | null>(null);

const lastWidths: Record<string, LastWidthInfo> = {};

interface DirtyRect {
	minX: number;
	minY: number;
	width: number;
	height: number;
	candidateCommandIds?: string[];
}

interface DirtySegmentRange {
	start: number;
	end: number;
}

const renderIncrementPoint = (
	cmd: Command,
	points: Point[],
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	skipQueue = false,
	source: "local" | "remote" = "remote"
) => {
	if (cmd.type !== "path" || points.length === 0) {
		return;
	}

	const incrementalStart = recordIncrementalRenderStart(cmd.id, points.length, source);
	const baseSize = cmd.size || 3;
	const startIndex = (cmd.points?.length || 0) - points.length;

	let previousState: StrokeState | null = null;
	if (startIndex > 0 && cmd.points) {
		const prevPoint = cmd.points[startIndex - 1];
		if (!prevPoint) return;
		previousState = createStrokeStateFromSample({
			sample: prevPoint,
			tool: cmd.tool,
			baseSize,
			logicalWidth: width,
			logicalHeight: height,
			widthOverride: cmd.id ? lastWidths[cmd.id]?.lastWidth : undefined,
		});
	}

	points.forEach((point) => {
		previousState = paintStrokeSample({
			ctx,
			sample: point,
			previousState,
			tool: cmd.tool,
			color: cmd.color,
			baseSize,
			logicalWidth: width,
			logicalHeight: height,
			onBeforeDrawSegment: ({ x, y, previousState, nextWidth }) => {
				if (skipQueue) return;
				useLamportStore().pushToQueue({
					x,
					y,
					p: point.p,
					lamport: point.lamport,
					lastX: previousState.x,
					lastY: previousState.y,
					cmdId: cmd.id,
					userId: cmd.userId,
					tool: cmd.tool ?? "pen",
					color: cmd.color || "",
					size: cmd.tool === "eraser" ? baseSize : nextWidth,
					isDeleted: cmd.isDeleted,
					lastWidth: previousState.width,
				});
			},
		});

		if (cmd.id) {
			lastWidths[cmd.id] = { lastWidth: previousState.width };
		}
	});

	recordIncrementalRenderEnd(cmd.id, points.length, source, performance.now() - incrementalStart);
};

const renderPointSequence = (
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	points: FlatPoint[],
	isDirtyRender = false,
	startTime?: number
) => {
	const renderStart =
		startTime ||
		recordRenderStart(isDirtyRender ? "dirty" : "full", Array.isArray(points) ? points.length : 0);
	if (!points) return;

	const lastPointsMap: Record<string, StrokeState> = {};

	points.forEach((point) => {
		if (point.isDeleted) return;
		lastPointsMap[point.cmdId] = paintStrokeSample({
			ctx,
			sample: point,
			previousState: lastPointsMap[point.cmdId] ?? null,
			tool: point.tool,
			color: point.color,
			baseSize: point.size,
			logicalWidth: width,
			logicalHeight: height,
		});
	});

	const renderEnd = performance.now();
	recordRenderEnd(isDirtyRender ? "dirty" : "full", points.length, renderEnd - renderStart);
	if (isRuntimeDebugLoggingEnabled()) {
		const logPrefix = isDirtyRender ? "[dirty-redraw]" : "[full-render]";
		console.log(
			`${logPrefix} points=${points.length} duration=${(renderEnd - renderStart).toFixed(2)}ms`
		);
	}
};

const pointIntersectsDirtyRect = (
	point: Pick<Point, "x" | "y">,
	dirtyRect: DirtyRect,
	width: number,
	height: number,
	padding = 20
) => {
	const x = point.x * width;
	const y = point.y * height;
	return (
		x >= dirtyRect.minX - padding &&
		x <= dirtyRect.minX + dirtyRect.width + padding &&
		y >= dirtyRect.minY - padding &&
		y <= dirtyRect.minY + dirtyRect.height + padding
	);
};

const segmentIntersectsDirtyRect = (
	from: Point,
	to: Point,
	dirtyRect: DirtyRect,
	width: number,
	height: number,
	padding = 20
) => {
	const x1 = from.x * width;
	const y1 = from.y * height;
	const x2 = to.x * width;
	const y2 = to.y * height;
	const minX = Math.min(x1, x2) - padding;
	const maxX = Math.max(x1, x2) + padding;
	const minY = Math.min(y1, y2) - padding;
	const maxY = Math.max(y1, y2) + padding;

	return !(
		maxX < dirtyRect.minX ||
		minX > dirtyRect.minX + dirtyRect.width ||
		maxY < dirtyRect.minY ||
		minY > dirtyRect.minY + dirtyRect.height
	);
};

const mergeSegmentRanges = (ranges: DirtySegmentRange[]) => {
	if (ranges.length <= 1) return ranges;

	ranges.sort((a, b) => a.start - b.start);
	const merged: DirtySegmentRange[] = [{ ...ranges[0]! }];

	for (let i = 1; i < ranges.length; i += 1) {
		const current = ranges[i];
		const previous = merged[merged.length - 1];
		if (!current || !previous) continue;

		if (current.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, current.end);
			continue;
		}

		merged.push({ ...current });
	}

	return merged;
};

const collectDirtySegments = (
	points: Point[],
	dirtyRect: DirtyRect,
	width: number,
	height: number,
	padding = 20
) => {
	if (points.length === 0) return [] as DirtySegmentRange[];

	const ranges: DirtySegmentRange[] = [];
	let activeStart: number | null = null;

	for (let index = 0; index < points.length; index += 1) {
		const current = points[index];
		if (!current) continue;

		const intersects =
			(index === 0 && pointIntersectsDirtyRect(current, dirtyRect, width, height, padding)) ||
			(index > 0 &&
				segmentIntersectsDirtyRect(
					points[index - 1]!,
					current,
					dirtyRect,
					width,
					height,
					padding
				));

		if (intersects) {
			if (activeStart === null) {
				activeStart = Math.max(0, index - 1);
			}
			continue;
		}

		if (activeStart !== null) {
			ranges.push({
				start: activeStart,
				end: Math.min(points.length - 1, index),
			});
			activeStart = null;
		}
	}

	if (activeStart !== null) {
		ranges.push({
			start: activeStart,
			end: points.length - 1,
		});
	}

	return mergeSegmentRanges(ranges);
};

const renderCommandPointRange = (
	ctx: CanvasRenderingContext2D,
	command: Command,
	range: DirtySegmentRange,
	width: number,
	height: number
) => {
	if (command.type !== "path" || !command.points?.length) {
		return 0;
	}

	const baseSize = command.size || 3;
	let previousState: StrokeState | null = null;

	if (range.start > 0) {
		const firstPoint = command.points[0];
		if (firstPoint) {
			previousState = createStrokeStateFromSample({
				sample: firstPoint,
				tool: command.tool,
				baseSize,
				logicalWidth: width,
				logicalHeight: height,
			});
			for (let index = 1; index < range.start; index += 1) {
				const point = command.points[index];
				if (!point || !previousState) continue;
				const x = point.x * width;
				const y = point.y * height;
				previousState = {
					x,
					y,
					width: getNextStrokeWidth({
						tool: command.tool,
						baseSize,
						pressure: point.p,
						previousState,
						x,
						y,
						logicalWidth: width,
					}),
				};
			}
		}
	}

	let renderedPoints = 0;
	for (let index = range.start; index <= range.end; index += 1) {
		const point = command.points[index];
		if (!point) continue;
		previousState = paintStrokeSample({
			ctx,
			sample: point,
			previousState,
			tool: command.tool,
			color: command.color,
			baseSize,
			logicalWidth: width,
			logicalHeight: height,
		});
		renderedPoints += 1;
	}

	return renderedPoints;
};

const getDirtyRectCommandIds = (
	points: FlatPoint[],
	dirtyRect: DirtyRect,
	width: number,
	height: number,
	padding = 20
) => {
	const intersectingCmdIds = new Set<string>();

	points.forEach((point) => {
		const x = point.x * width;
		const y = point.y * height;
		if (
			x >= dirtyRect.minX - padding &&
			x <= dirtyRect.minX + dirtyRect.width + padding &&
			y >= dirtyRect.minY - padding &&
			y <= dirtyRect.minY + dirtyRect.height + padding
		) {
			intersectingCmdIds.add(point.cmdId);
		}
	});

	return intersectingCmdIds;
};

const filterDirtyRenderPoints = (
	points: FlatPoint[],
	dirtyRect: DirtyRect,
	width: number,
	height: number,
	transformingCmdIds?: Set<string>,
	padding = 20
) => {
	const intersectingCmdIds = getDirtyRectCommandIds(points, dirtyRect, width, height, padding);
	return points.filter((point) => {
		if (point.isDeleted) return false;
		if (transformingCmdIds?.has(point.cmdId)) return false;
		return intersectingCmdIds.has(point.cmdId);
	});
};

const renderClippedPointSequence = (
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	points: FlatPoint[],
	dirtyRect: DirtyRect,
	transformingCmdIds?: Set<string>
) => {
	const padding = 20;
	const commandStore = useCommandStore();
	let renderedPointCount = 0;

	ctx.save();
	ctx.beginPath();
	ctx.clearRect(
		dirtyRect.minX - padding,
		dirtyRect.minY - padding,
		dirtyRect.width + padding * 2,
		dirtyRect.height + padding * 2
	);
	ctx.rect(
		dirtyRect.minX - padding,
		dirtyRect.minY - padding,
		dirtyRect.width + padding * 2,
		dirtyRect.height + padding * 2
	);
	ctx.clip();

	const candidateCommandIds =
		dirtyRect.candidateCommandIds && dirtyRect.candidateCommandIds.length > 0
			? Array.from(new Set(dirtyRect.candidateCommandIds))
			: [];

	if (candidateCommandIds.length > 0) {
		const intersectingCommandIds = getDirtyRectCommandIds(points, dirtyRect, width, height, padding);
		candidateCommandIds.forEach((commandId) => {
			intersectingCommandIds.add(commandId);
		});

		intersectingCommandIds.forEach((commandId) => {
			if (transformingCmdIds?.has(commandId)) return;
			const command = commandStore.commandMap.get(commandId);
			if (!command || command.isDeleted || command.type !== "path" || !command.points?.length) return;

			const ranges = collectDirtySegments(command.points, dirtyRect, width, height, padding);
			ranges.forEach((range) => {
				renderedPointCount += renderCommandPointRange(ctx, command, range, width, height);
			});
		});
	} else {
		const filteredPoints = filterDirtyRenderPoints(
			points,
			dirtyRect,
			width,
			height,
			transformingCmdIds,
			padding
		);
		renderPointSequence(ctx, width, height, filteredPoints, true);
		renderedPointCount = filteredPoints.length;
	}

	ctx.restore();

	return renderedPointCount;
};

const renderWithPoints = (sortedPoints: FlatPoint[]) => {
	if (!canvasRef.value || !ctx.value) return;

	const renderStart = recordRenderStart("full", sortedPoints.length);
	const dpr = window.devicePixelRatio || 1;
	const physicalWidth = canvasRef.value.width;
	const physicalHeight = canvasRef.value.height;
	const logicalWidth = physicalWidth / dpr;
	const logicalHeight = physicalHeight / dpr;

	ctx.value.save();
	ctx.value.setTransform(1, 0, 0, 1, 0, 0);
	ctx.value.clearRect(0, 0, physicalWidth, physicalHeight);
	ctx.value.restore();

	renderPointSequence(
		ctx.value,
		logicalWidth,
		logicalHeight,
		sortedPoints,
		false,
		renderStart
	);
};

export {
	canvasRef,
	uiCanvasRef,
	ctx,
	uiCtx,
	lastWidths,
	filterDirtyRenderPoints,
	renderClippedPointSequence,
	renderPointSequence as renderPageContentFromPoints,
	renderPointSequence,
	renderWithPoints,
	renderIncrementPoint,
};
