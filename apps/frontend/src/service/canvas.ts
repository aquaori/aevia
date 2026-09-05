// File role: shared canvas refs plus low-level drawing helpers used by render paths.
import { ref } from "vue";
import type { Command, FlatPoint, Point } from "@collaborative-whiteboard/shared";
import { useLamportStore } from "../store/lamportStore";
import {
	createStrokeBatch,
	finishStroke,
	paintStrokeSample,
	type StrokeState,
} from "./strokeRasterizer";
import { SceneEngine } from "../scene/sceneEngine";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const uiCanvasRef = ref<HTMLCanvasElement | null>(null);

const ctx = ref<CanvasRenderingContext2D | null>(null);
const uiCtx = ref<CanvasRenderingContext2D | null>(null);

const incrementalStrokeStates = new Map<string, StrokeState>();
const activeStrokeIds = new Set<string>();
const fallbackSceneEngine = new SceneEngine();

interface DirtyRect {
	minX: number;
	minY: number;
	width: number;
	height: number;
	candidateCommandIds?: string[];
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

	const baseSize = cmd.size || 3;
	let previousState = incrementalStrokeStates.get(cmd.id) ?? null;
	activeStrokeIds.add(cmd.id);

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
				if (skipQueue || source === "local") return;
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
	});

	if (previousState) {
		incrementalStrokeStates.set(cmd.id, previousState);
	}
};

const finishIncrementalStroke = (
	cmd: Command,
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number
) => {
	const state = incrementalStrokeStates.get(cmd.id);
	if (!state) return;
	finishStroke({
		ctx,
		state,
		tool: cmd.tool,
		color: cmd.color,
		baseSize: cmd.size || 3,
		logicalWidth: width,
		logicalHeight: height,
	});
	incrementalStrokeStates.delete(cmd.id);
	activeStrokeIds.delete(cmd.id);
};

const resetIncrementalStroke = (cmdId: string) => {
	incrementalStrokeStates.delete(cmdId);
	activeStrokeIds.delete(cmdId);
};

const renderPointSequence = (
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	points: FlatPoint[],
	_isDirtyRender = false,
	startTime?: number,
	unfinishedCommandIds: ReadonlySet<string> = new Set()
) => {
	const renderStart = startTime || performance.now();
	if (!points) return new Map<string, StrokeState>();

	const states = new Map<string, StrokeState>();
	const remainingPoints = new Map<string, number>();
	points.forEach((point) => {
		if (point.isDeleted) return;
		remainingPoints.set(point.cmdId, (remainingPoints.get(point.cmdId) ?? 0) + 1);
	});

	// Mirrors the worker path: batch same-style geometry during full replay.
	const batch = createStrokeBatch(ctx);
	points.forEach((point) => {
		if (point.isDeleted) return;
		let state = paintStrokeSample({
			ctx,
			sample: point,
			previousState: states.get(point.cmdId) ?? null,
			tool: point.tool,
			color: point.color,
			baseSize: point.size,
			logicalWidth: width,
			logicalHeight: height,
			batch,
		});
		const remaining = (remainingPoints.get(point.cmdId) ?? 1) - 1;
		remainingPoints.set(point.cmdId, remaining);
		if (remaining === 0 && !unfinishedCommandIds.has(point.cmdId)) {
			state =
				finishStroke({
					ctx,
					state,
					tool: point.tool,
					color: point.color,
					baseSize: point.size,
					logicalWidth: width,
					logicalHeight: height,
					batch,
				}) ?? state;
		}
		states.set(point.cmdId, state);
	});
	batch.flush();

	void renderStart;
	return states;
};

const renderClippedPointSequence = (
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	dirtyRect: DirtyRect,
	transformingCmdIds?: Set<string>
) => {
	return fallbackSceneEngine.renderDirty(
		ctx,
		{
			minX: dirtyRect.minX,
			minY: dirtyRect.minY,
			maxX: dirtyRect.minX + dirtyRect.width,
			maxY: dirtyRect.minY + dirtyRect.height,
			width: dirtyRect.width,
			height: dirtyRect.height,
		},
		width,
		height,
		transformingCmdIds
	).renderedAtoms;
};

const renderWithPoints = (sortedPoints: FlatPoint[]) => {
	if (!canvasRef.value || !ctx.value) return;

	const dpr = window.devicePixelRatio || 1;
	const physicalWidth = canvasRef.value.width;
	const physicalHeight = canvasRef.value.height;
	const logicalWidth = physicalWidth / dpr;
	const logicalHeight = physicalHeight / dpr;

	fallbackSceneEngine.reset(sortedPoints[0]?.pageId ?? 0);
	sortedPoints.forEach((point) => fallbackSceneEngine.ingestFlatPoint(point));
	fallbackSceneEngine.finishAllOpenStrokes();
	fallbackSceneEngine.renderFull(ctx.value, logicalWidth, logicalHeight);
};

const renderSceneCommands = (commands: Command[], pageId: number, transformingCmdIds: Set<string> = new Set()) => {
	if (!canvasRef.value || !ctx.value) return;
	const dpr = window.devicePixelRatio || 1;
	fallbackSceneEngine.rebuildFromCommands(commands, pageId);
	fallbackSceneEngine.renderFull(
		ctx.value,
		canvasRef.value.width / dpr,
		canvasRef.value.height / dpr,
		transformingCmdIds
	);
};

const hitTestScene = (x: number, y: number) => {
	if (!canvasRef.value) return { elementId: null, bounds: null };
	const dpr = window.devicePixelRatio || 1;
	const elementId = fallbackSceneEngine.hitTestTopmost(
		x,
		y,
		canvasRef.value.width / dpr,
		canvasRef.value.height / dpr
	);
	return { elementId, bounds: elementId ? fallbackSceneEngine.getElementBounds(elementId) : null };
};

const querySceneElements = (rect: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }) => {
	if (!canvasRef.value) return { elementIds: [] as string[], bounds: null };
	const dpr = window.devicePixelRatio || 1;
	const width = canvasRef.value.width / dpr;
	const height = canvasRef.value.height / dpr;
	const elementIds = fallbackSceneEngine.queryElements(rect, width, height);
	let bounds: ReturnType<typeof fallbackSceneEngine.getElementBounds> = null;
	for (const elementId of elementIds) {
		const current = fallbackSceneEngine.getElementBounds(elementId);
		if (!current) continue;
		if (!bounds) {
			bounds = { ...current };
			continue;
		}
		const minX = Math.min(bounds.minX, current.minX);
		const minY = Math.min(bounds.minY, current.minY);
		const maxX = Math.max(bounds.maxX, current.maxX);
		const maxY = Math.max(bounds.maxY, current.maxY);
		bounds = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
	}
	return { elementIds, bounds };
};

export {
	canvasRef,
	uiCanvasRef,
	ctx,
	uiCtx,
	finishIncrementalStroke,
	resetIncrementalStroke,
	renderClippedPointSequence,
	renderPointSequence as renderPageContentFromPoints,
	renderPointSequence,
	renderWithPoints,
	renderSceneCommands,
	hitTestScene,
	querySceneElements,
	renderIncrementPoint,
};
