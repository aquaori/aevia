// File role: pointer-event orchestration that ties interaction state, commands, transport, and rendering together.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import { canvasRef, ctx } from "../service/canvas";
import type { Command, Point, aabbBox } from "@collaborative-whiteboard/shared";
import {
	markLocalInputStart,
	recordIncrementalRenderEnd,
	recordIncrementalRenderStart,
} from "../instrumentation/runtimeInstrumentation";
import { getNextStrokeWidth, paintStrokeSample, resolveStrokeStyle } from "../service/strokeRasterizer";
import type { PointerHotState } from "../states/roomInteractionState";

type Tool = "pen" | "eraser" | "cursor";
type InteractionMode = "none" | "box-selecting" | "dragging" | "resizing";
type HandleType = "tl" | "tr" | "bl" | "br" | "body" | null;

interface TransformAnimState {
	progress: number;
	phase: "entering" | "dragging" | "exiting";
	initialBox: aabbBox | null;
}

interface RoomPointerControllerOptions {
	currentTool: Ref<Tool>;
	currentColor: Ref<string>;
	currentSize: Ref<number>;
	currentPageId: Ref<number>;
	roomId: Ref<string>;
	userId: Ref<string>;
	username: Ref<string>;
	isDrawing: Ref<boolean>;
	activePointerId: Ref<number | null>;
	currentDrawingId: Ref<string | null>;
	cursorX: Ref<number>;
	cursorY: Ref<number>;
	interactionMode: Ref<InteractionMode>;
	activeTransformHandle: Ref<HandleType>;
	dragStartPos: Ref<{ x: number; y: number } | null>;
	selectionRect: Ref<{ x: number; y: number; w: number; h: number } | null>;
	selectedCommandIds: Ref<Set<string>>;
	transformingCmdIds: Ref<Set<string>>;
	initialCmdsState: Ref<Map<string, Point[]>>;
	initialGroupBox: Ref<aabbBox | null>;
	transformAnim: Ref<TransformAnimState | null>;
	activeMenu: Ref<"pen" | "eraser" | "color" | "more" | null>;
	commands: Ref<Command[]>;
	commandMap: Map<string, Command>;
	lastXRef: Ref<number>;
	lastYRef: Ref<number>;
	lastWidthRef: Ref<number>;
	pointerHotState: PointerHotState;
	interactionController: ReturnType<typeof import("../controllers/interactionController").createInteractionController>;
	canvasRuntime: {
		eraseDirtyRect: (rect: aabbBox, transformingCmdIds?: Set<string>) => void;
	};
	renderIncrementalCommand?: (
		cmd: Command,
		points: Point[],
		source?: "local" | "remote"
	) => void;
	renderSinglePointCommand?: (cmd: Command, source?: "local" | "remote") => void;
	isOffscreenMainCanvas?: () => boolean;
	send: (type: string, data: unknown) => boolean;
	pushCommand: (
		cmdPartial: Partial<Command>,
		type?: "normal" | "start" | "update" | "stop"
	) => void;
	renderCanvas: () => void;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
	getGroupBoundingBox: (
		cmdIds: Set<string>,
		commands: Command[],
		currentPageId: number
	) => aabbBox | null;
	onToolStateUpdated?: () => void;
}

export const createRoomPointerController = (options: RoomPointerControllerOptions) => {
	let frameRequestId: number | null = null;
	let hasPendingCursorFrame = false;
	let hasPendingPointerSync = false;
	let latestCursorFrame = { x: 0, y: 0 };
	let pendingStrokeSamples: Array<{ x: number; y: number; pressure: number; pointerType: string }> = [];

	const scheduleFrameFlush = () => {
		if (frameRequestId !== null) {
			return;
		}

		frameRequestId = window.requestAnimationFrame(() => {
			frameRequestId = null;
			flushFrameWork();
			if (
				hasPendingCursorFrame ||
				hasPendingPointerSync ||
				pendingStrokeSamples.length > 0
			) {
				scheduleFrameFlush();
			}
		});
	};

	const cancelFrameFlush = () => {
		if (frameRequestId !== null) {
			window.cancelAnimationFrame(frameRequestId);
			frameRequestId = null;
		}
	};

	const queueCursorFrame = (x: number, y: number) => {
		latestCursorFrame = { x, y };
		hasPendingCursorFrame = true;
		scheduleFrameFlush();
	};

	const flushCursorFrame = () => {
		if (!hasPendingCursorFrame) return;
		options.cursorX.value = latestCursorFrame.x;
		options.cursorY.value = latestCursorFrame.y;
		hasPendingCursorFrame = false;
	};

	const flushPointerSync = () => {
		if (!hasPendingPointerSync) return;
		options.pointerHotState.lastSentPos = options.interactionController.syncPointerPosition({
			canvas: canvasRef.value,
			cursorX: latestCursorFrame.x,
			cursorY: latestCursorFrame.y,
			userId: options.userId.value,
			userName:
				(Array.isArray(options.username.value)
					? options.username.value[0]
					: options.username.value) ?? options.userId.value.split("-")[0],
			currentPageId: options.currentPageId.value,
			interactionMode: options.interactionMode.value,
			selectedCommandIds: options.selectedCommandIds.value,
			dragStartPos: options.dragStartPos.value,
			selectionRect: options.selectionRect.value,
			lastSentPos: options.pointerHotState.lastSentPos,
			send: options.send,
		});
		hasPendingPointerSync = false;
	};

	const flushStrokeSamples = () => {
		if (
			pendingStrokeSamples.length === 0 ||
			!options.currentDrawingId.value ||
			options.currentTool.value === "cursor" ||
			!canvasRef.value
		) {
			return;
		}

		const samples = pendingStrokeSamples;
		pendingStrokeSamples = [];

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value.width / dpr;
		const height = canvasRef.value.height / dpr;
		const localCmdId = options.currentDrawingId.value;
		let nextX = options.lastXRef.value;
		let nextY = options.lastYRef.value;
		let nextWidth = options.lastWidthRef.value;
		const normalizedPoints: Point[] = [];
		let incrementalStartedAt = 0;

		if (!options.isOffscreenMainCanvas?.() && ctx.value) {
			incrementalStartedAt = recordIncrementalRenderStart(localCmdId, samples.length, "local");
		}

		for (const sample of samples) {
			const dist = Math.hypot(sample.x - nextX, sample.y - nextY);
			const clamp = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);
			const simulatedPressure =
				sample.pointerType === "pen" ? sample.pressure : clamp(1 - dist / 100, 0.3, 1);
			const usedPressure = sample.pointerType === "pen" ? sample.pressure : simulatedPressure;
			const lamport = useLamportStore().getNextLamport();

			if (!options.isOffscreenMainCanvas?.()) {
				useLamportStore().pushToQueue({
					x: sample.x,
					y: sample.y,
					p: usedPressure,
					lamport,
					lastX: nextX,
					lastY: nextY,
					lastWidth: nextWidth,
					cmdId: localCmdId,
					userId: options.userId.value,
					tool: options.currentTool.value,
					color: options.currentColor.value,
					size: options.currentSize.value,
					isDeleted: false,
				});
			}

			const normalizedPoint = {
				x: sample.x / width,
				y: sample.y / height,
				p: usedPressure,
				lamport,
			};
			normalizedPoints.push(normalizedPoint);
			options.pointerHotState.currentPathPoints.push(normalizedPoint);
			options.pointerHotState.pendingPoints.push(normalizedPoint);

			if (options.isOffscreenMainCanvas?.()) {
				nextWidth =
					options.currentTool.value === "eraser"
						? options.currentSize.value
						: getNextStrokeWidth({
								tool: options.currentTool.value,
								baseSize: options.currentSize.value,
								pressure: usedPressure,
								previousState: {
									x: nextX,
									y: nextY,
									width: nextWidth,
								},
								x: sample.x,
								y: sample.y,
								logicalWidth: width,
						  });
			} else if (ctx.value) {
				const paintResult = paintStrokeSample({
					ctx: ctx.value,
					sample: normalizedPoint,
					previousState: {
						x: nextX,
						y: nextY,
						width: nextWidth,
					},
					tool: options.currentTool.value,
					color: options.currentColor.value,
					baseSize: options.currentSize.value,
					logicalWidth: width,
					logicalHeight: height,
				});
				nextWidth = paintResult.width;
			}

			nextX = sample.x;
			nextY = sample.y;
		}

		if (normalizedPoints.length === 0) return;

		if (options.isOffscreenMainCanvas?.()) {
			options.renderIncrementalCommand?.(
				{
					id: localCmdId,
					type: "path",
					tool: options.currentTool.value,
					color: options.currentColor.value,
					size: options.currentSize.value,
					timestamp: Date.now(),
					userId: options.userId.value,
					roomId: Array.isArray(options.roomId.value)
						? options.roomId.value[0] || ""
						: options.roomId.value,
					pageId: options.currentPageId.value,
					isDeleted: false,
					lamport: normalizedPoints[normalizedPoints.length - 1]?.lamport ?? useLamportStore().lamport,
					box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
				},
				normalizedPoints
			);
		} else if (ctx.value) {
			recordIncrementalRenderEnd(
				localCmdId,
				normalizedPoints.length,
				"local",
				performance.now() - incrementalStartedAt
			);
		}

		options.lastXRef.value = nextX;
		options.lastYRef.value = nextY;
		options.lastWidthRef.value = nextWidth;

		if (options.pointerHotState.pendingPoints.length > 0) {
			options.pushCommand(
				{
					id: localCmdId,
					points: options.pointerHotState.pendingPoints,
				},
				"update"
			);
			options.pointerHotState.pendingPoints = [];
		}
	};

	const flushFrameWork = () => {
		flushCursorFrame();
		flushPointerSync();
		flushStrokeSamples();
	};

	const finalizeDrop = () => {
		options.transformingCmdIds.value.clear();
		options.transformAnim.value = null;
		options.renderCanvas();
	};

	const setTool = (tool: Tool) => {
		options.currentTool.value = tool;

		if (tool !== "cursor") {
			options.selectedCommandIds.value.clear();
			options.selectionRect.value = null;
			options.interactionMode.value = "none";
		}

		if (ctx.value) {
			const style = resolveStrokeStyle(tool, options.currentColor.value);
			ctx.value.globalCompositeOperation = style.compositeOperation;
			ctx.value.strokeStyle = style.color;
			ctx.value.fillStyle = style.color;
		}

		options.activeMenu.value = null;
		options.onToolStateUpdated?.();
	};

	const setColor = (color: string) => {
		options.currentColor.value = color;
		if (options.currentTool.value === "eraser") setTool("pen");
		if (ctx.value) {
			const style = resolveStrokeStyle("pen", color);
			ctx.value.strokeStyle = style.color;
			ctx.value.fillStyle = style.color;
			ctx.value.globalCompositeOperation = style.compositeOperation;
		}
		options.activeMenu.value = null;
	};

	const startDrawing = (e: PointerEvent) => {
		if (!canvasRef.value) return;
		if (options.isDrawing.value) return;

		if (options.currentTool.value === "cursor") {
			const cursorAction = options.interactionController.beginCursorInteraction({
				canvas: canvasRef.value,
				event: e,
				commands: options.commands.value,
				commandMap: options.commandMap,
				selectedCommandIds: options.selectedCommandIds.value,
				currentPageId: options.currentPageId.value,
				getCommandBoundingBox: options.getCommandBoundingBox,
				getGroupBoundingBox: options.getGroupBoundingBox,
			});

			options.activeTransformHandle.value = cursorAction.handle as HandleType;
			options.interactionMode.value = cursorAction.mode;

			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			options.isDrawing.value = true;
			options.activePointerId.value = e.pointerId;

			if (cursorAction.mode === "dragging" || cursorAction.mode === "resizing") {
				options.lastXRef.value = cursorAction.x;
				options.lastYRef.value = cursorAction.y;
				options.dragStartPos.value = cursorAction.normalizedPoint;
				options.pointerHotState.lastSentPos = cursorAction.normalizedPoint;
				options.selectedCommandIds.value = new Set(cursorAction.selectedIds);
				options.initialCmdsState.value = cursorAction.initialCmdsState;
				options.initialGroupBox.value = cursorAction.groupBox;
			} else {
				options.selectedCommandIds.value.clear();
				options.activeTransformHandle.value = null;
				options.interactionMode.value = "box-selecting";
				options.dragStartPos.value = cursorAction.normalizedPoint;
				options.selectionRect.value = cursorAction.selectionRect;
			}
			return;
		}

		if (options.currentDrawingId.value) return;

		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		options.isDrawing.value = true;
		options.activePointerId.value = e.pointerId;
		options.activeMenu.value = null;

		const { x, y, pressure } = options.interactionController.getCoordinates(canvasRef.value, e);
		queueCursorFrame(x, y);
		options.lastXRef.value = x;
		options.lastYRef.value = y;

		const initialPressure = e.pointerType === "pen" ? pressure : 0.2;
		options.lastWidthRef.value =
			options.currentTool.value === "eraser"
				? options.currentSize.value
				: options.currentSize.value * (initialPressure * 2);

		const width = canvasRef.value.width / (window.devicePixelRatio || 1);
		const height = canvasRef.value.height / (window.devicePixelRatio || 1);
		const lamport = useLamportStore().getNextLamport();

		const p0 = { x: x / width, y: y / height, p: initialPressure, lamport };
		options.pointerHotState.currentPathPoints = [p0];
		options.pointerHotState.pendingPoints = [];

		const id = uuidv4();
		options.currentDrawingId.value = id;
		markLocalInputStart(id);

		if (!options.isOffscreenMainCanvas?.()) {
			useLamportStore().pushToQueue({
				x,
				y,
				p: initialPressure,
				cmdId: id,
				userId: options.userId.value,
				tool: options.currentTool.value,
				color: options.currentColor.value,
				size: options.currentSize.value,
				isDeleted: false,
				lastX: x,
				lastY: y,
				lastWidth: options.lastWidthRef.value,
				lamport,
			});
		}

		options.pushCommand(
			{
				id,
				type: "path",
				points: options.pointerHotState.currentPathPoints,
				tool: options.currentTool.value,
				color: options.currentColor.value,
				size: options.currentSize.value,
				timestamp: Date.now(),
				userId: options.userId.value,
				roomId: Array.isArray(options.roomId.value) ? options.roomId.value[0] : options.roomId.value,
				pageId: options.currentPageId.value,
				isDeleted: false,
				lamport,
				box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			},
			"start"
		);

		if (options.isOffscreenMainCanvas?.()) {
			options.renderIncrementalCommand?.(
				{
					id,
					type: "path",
					points: [p0],
					tool: options.currentTool.value,
					color: options.currentColor.value,
					size: options.currentSize.value,
					timestamp: Date.now(),
					userId: options.userId.value,
					roomId: Array.isArray(options.roomId.value) ? options.roomId.value[0] : options.roomId.value,
					pageId: options.currentPageId.value,
					isDeleted: false,
					lamport,
					box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
				},
				[p0],
				"local"
			);
		}
	};

	const draw = (e: PointerEvent) => {
		const { x, y, pressure } = options.interactionController.getCoordinates(canvasRef.value, e);
		queueCursorFrame(x, y);
		hasPendingPointerSync = true;
		scheduleFrameFlush();

		if (!options.isDrawing.value) return;
		if (e.pointerId !== options.activePointerId.value) return;

		if (options.currentTool.value === "cursor") {
			const preview = options.interactionController.previewCursorInteraction({
				canvas: canvasRef.value!,
				interactionMode: options.interactionMode.value,
				x,
				y,
				dragStartPos: options.dragStartPos.value,
				selectedCommandIds: options.selectedCommandIds.value,
				activeTransformHandle: options.activeTransformHandle.value,
				initialGroupBox: options.initialGroupBox.value,
				transformingCmdIds: options.transformingCmdIds.value,
				initialCmdsState: options.initialCmdsState.value,
				commands: options.commands.value,
			});

			if (preview.selectionRect) {
				options.selectionRect.value = preview.selectionRect;
				return;
			}

			if (preview.shouldPromote && preview.transformingIds && preview.dirtyRect) {
				options.transformingCmdIds.value = new Set(preview.transformingIds);
				options.transformAnim.value = preview.nextTransformAnim as TransformAnimState | null;
				options.canvasRuntime.eraseDirtyRect(
					preview.dirtyRect,
					options.transformingCmdIds.value
				);
			}

			preview.transformedCommands.forEach(({ cmdId, points }) => {
				const cmd = options.commandMap.get(cmdId);
				if (cmd) cmd.points = points;
			});
			if (options.isOffscreenMainCanvas?.()) {
				options.renderCanvas();
			}
			return;
		}

		const lastQueuedSample = pendingStrokeSamples[pendingStrokeSamples.length - 1];
		const prevX = lastQueuedSample?.x ?? options.lastXRef.value;
		const prevY = lastQueuedSample?.y ?? options.lastYRef.value;
		const dist = Math.hypot(x - prevX, y - prevY);
		if (dist < 2) return;

		pendingStrokeSamples.push({
			x,
			y,
			pressure,
			pointerType: e.pointerType,
		});
		scheduleFrameFlush();
	};

	const stopDrawing = (e: PointerEvent) => {
		if (!options.isDrawing.value) return;
		if (e.pointerId !== options.activePointerId.value) return;

		flushFrameWork();
		cancelFrameFlush();

		const cmdId = options.currentDrawingId.value;
		const cmd = cmdId ? options.commandMap.get(cmdId) : undefined;
		if (cmd?.points?.length) {
			cmd.box = options.getCommandBoundingBox(cmd) ?? {
				minX: 0,
				minY: 0,
				maxX: 0,
				maxY: 0,
				width: 0,
				height: 0,
			};
		}

		options.pushCommand(
			{
				id: options.currentDrawingId.value || undefined,
				points: options.pointerHotState.pendingPoints || [],
				box: cmd?.box,
			},
			"stop"
		);
		options.pointerHotState.pendingPoints = [];

		if (options.currentTool.value === "cursor") {
			const cursorStopResult = options.interactionController.finishCursorInteraction({
				interactionMode: options.interactionMode.value,
				selectionRect: options.selectionRect.value,
				selectedCommandIds: options.selectedCommandIds.value,
				commandMap: options.commandMap,
				currentPageId: options.currentPageId.value,
				getCommandBoundingBox: options.getCommandBoundingBox,
			});

			if (cursorStopResult.remoteSelectionRect === null) {
				options.send("box-selection", {
					userId: options.userId.value,
					rect: null,
				});
			}

			if (options.interactionMode.value === "box-selecting") {
				options.selectedCommandIds.value = new Set(cursorStopResult.selectedIds);
			} else if (cursorStopResult.transformPayload && options.dragStartPos.value) {
				const { updates, boxes } = cursorStopResult.transformPayload;
				if (updates.length > 0) {
					options.send("cmd-batch-stop", {
						userId: options.userId.value,
						updates,
						boxes,
					});
				}

				if (options.transformAnim.value) {
					options.transformAnim.value.phase = "exiting";
				} else {
					finalizeDrop();
				}
			}

			const cursorStopState = cursorStopResult.nextState;
			options.isDrawing.value = false;
			options.activePointerId.value = cursorStopState.activePointerId;
			options.dragStartPos.value = cursorStopState.dragStartPos;
			options.activeTransformHandle.value = cursorStopState.activeTransformHandle;
			options.interactionMode.value = cursorStopState.interactionMode;
			options.selectionRect.value = cursorStopState.selectionRect;
			options.initialCmdsState.value.clear();
			options.initialGroupBox.value = cursorStopState.initialGroupBox;
			return;
		}

		if (
			options.pointerHotState.currentPathPoints.length === 1 &&
			canvasRef.value &&
			!options.isOffscreenMainCanvas?.()
		) {
			const dpr = window.devicePixelRatio || 1;
			const p0 = options.pointerHotState.currentPathPoints[0] || { x: 0, y: 0, p: 0.5, lamport: 0 };
			const width = canvasRef.value.width / dpr;
			const height = canvasRef.value.height / dpr;
			if (options.isOffscreenMainCanvas?.()) {
				options.renderSinglePointCommand?.({
					id: cmdId || "",
					type: "path",
					points: [p0],
					tool: options.currentTool.value,
					color: options.currentColor.value,
					size: options.currentSize.value,
					timestamp: Date.now(),
					userId: options.userId.value,
					roomId: Array.isArray(options.roomId.value)
						? options.roomId.value[0] || ""
						: options.roomId.value,
					pageId: options.currentPageId.value,
					isDeleted: false,
					lamport: p0.lamport,
					box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
				});
			} else if (ctx.value) {
				const incrementalStartedAt = recordIncrementalRenderStart(
					options.currentDrawingId.value || undefined,
					1,
					"local"
				);
				paintStrokeSample({
					ctx: ctx.value,
					sample: p0,
					tool: options.currentTool.value,
					color: options.currentColor.value,
					baseSize: options.currentSize.value,
					logicalWidth: width,
					logicalHeight: height,
				});
				recordIncrementalRenderEnd(
					options.currentDrawingId.value || undefined,
					1,
					"local",
					performance.now() - incrementalStartedAt
				);
			}
		}

		if (options.pointerHotState.pendingPoints.length > 0) {
			options.pushCommand(
				{
					id: options.currentDrawingId.value || undefined,
					points: options.pointerHotState.pendingPoints,
				},
				"update"
			);
			options.pointerHotState.pendingPoints = [];
		}

		options.pointerHotState.currentPathPoints = [];
		options.currentDrawingId.value = null;
		options.isDrawing.value = false;
		options.activePointerId.value = null;
		if (e.target) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
	};

	return {
		setTool,
		setColor,
		startDrawing,
		draw,
		stopDrawing,
		finalizeDrop,
		cancelLocalDrawing: (cmdId?: string | null) => {
			if (cmdId && options.currentDrawingId.value !== cmdId) {
				return;
			}
			pendingStrokeSamples = [];
			hasPendingPointerSync = false;
			hasPendingCursorFrame = false;
			cancelFrameFlush();
			options.pointerHotState.currentPathPoints = [];
			options.pointerHotState.pendingPoints = [];
			options.currentDrawingId.value = null;
			options.isDrawing.value = false;
			options.activePointerId.value = null;
		},
	};
};
