// File role: pointer-event orchestration that ties interaction state, commands, transport, and rendering together.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import { canvasRef, ctx } from "./canvas";
import type { Command, Point, aabbBox } from "../utils/type";

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
	mouseMoveCD: Ref<boolean>;
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
	lastXRef: Ref<number>;
	lastYRef: Ref<number>;
	lastWidthRef: Ref<number>;
	lastSentPosRef: Ref<{ x: number; y: number }>;
	currentPathPointsRef: Ref<Point[]>;
	pendingPointsRef: Ref<Point[]>;
	interactionController: ReturnType<typeof import("./interactionController").createInteractionController>;
	canvasRuntime: {
		eraseDirtyRect: (rect: aabbBox, transformingCmdIds?: Set<string>) => void;
	};
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
			if (tool === "eraser") {
				ctx.value.globalCompositeOperation = "destination-out";
			} else if (tool === "pen") {
				ctx.value.globalCompositeOperation = "source-over";
				ctx.value.strokeStyle = options.currentColor.value;
			}
		}

		options.activeMenu.value = null;
		options.onToolStateUpdated?.();
	};

	const setColor = (color: string) => {
		options.currentColor.value = color;
		if (options.currentTool.value === "eraser") setTool("pen");
		if (ctx.value) {
			ctx.value.strokeStyle = color;
			ctx.value.globalCompositeOperation = "source-over";
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
				options.lastSentPosRef.value = cursorAction.normalizedPoint;
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
		options.cursorX.value = x;
		options.cursorY.value = y;
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
		options.currentPathPointsRef.value = [p0];
		options.pendingPointsRef.value = [];

		const id = uuidv4();
		options.currentDrawingId.value = id;

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

		options.pushCommand(
			{
				id,
				type: "path",
				points: options.currentPathPointsRef.value,
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
	};

	const draw = (e: PointerEvent) => {
		const { x, y, pressure } = options.interactionController.getCoordinates(canvasRef.value, e);
		options.cursorX.value = x;
		options.cursorY.value = y;

		if (!options.mouseMoveCD.value) {
			options.mouseMoveCD.value = true;
			options.lastSentPosRef.value = options.interactionController.syncPointerPosition({
				canvas: canvasRef.value,
				cursorX: options.cursorX.value,
				cursorY: options.cursorY.value,
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
				lastSentPos: options.lastSentPosRef.value,
				send: options.send,
			});
		} else {
			setTimeout(() => {
				options.mouseMoveCD.value = false;
			}, 30);
		}

		if (!options.isDrawing.value || !ctx.value) return;
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
				const cmd = options.commands.value.find((candidate) => candidate.id === cmdId);
				if (cmd) cmd.points = points;
			});
			return;
		}

		const dist = Math.hypot(x - options.lastXRef.value, y - options.lastYRef.value);
		if (dist < 2) return;

		const clamp = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);
		const velocityFactor = Math.max(0.4, 1 - dist / 120);
		const simulatedPressure =
			e.pointerType === "pen" ? pressure : clamp(1 - dist / 100, 0.3, 1);
		const usedPressure = e.pointerType === "pen" ? pressure : simulatedPressure;

		const targetWidth = options.currentSize.value * (usedPressure * 2) * velocityFactor;
		const newWidth = clamp(
			options.lastWidthRef.value * 0.7 + targetWidth * 0.3,
			1,
			options.currentSize.value + 2
		);

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value!.width / dpr;
		const height = canvasRef.value!.height / dpr;

		ctx.value.globalCompositeOperation =
			options.currentTool.value === "eraser" ? "destination-out" : "source-over";
		ctx.value.lineCap = "round";
		ctx.value.lineJoin = "round";

		const lamport = useLamportStore().getNextLamport();
		useLamportStore().pushToQueue({
			x,
			y,
			p: usedPressure,
			lamport,
			lastX: options.lastXRef.value,
			lastY: options.lastYRef.value,
			lastWidth: options.lastWidthRef.value,
			cmdId: options.currentDrawingId.value || "",
			userId: options.userId.value,
			tool: options.currentTool.value,
			color: options.currentColor.value,
			size: options.currentSize.value,
			isDeleted: false,
		});

		if (options.currentTool.value === "eraser") {
			ctx.value.beginPath();
			ctx.value.moveTo(options.lastXRef.value, options.lastYRef.value);
			ctx.value.lineTo(x, y);
			ctx.value.strokeStyle = "#ffffff";
			ctx.value.lineWidth = options.currentSize.value;
			ctx.value.stroke();
		} else {
			const midX = (options.lastXRef.value + x) / 2;
			const midY = (options.lastYRef.value + y) / 2;
			ctx.value.beginPath();
			ctx.value.moveTo(options.lastXRef.value, options.lastYRef.value);
			ctx.value.quadraticCurveTo(midX, midY, x, y);
			ctx.value.lineWidth = newWidth;
			ctx.value.strokeStyle = options.currentColor.value;
			ctx.value.stroke();
		}

		if (typeof window !== "undefined" && (window as any).__benchmarkHook) {
			(window as any).__benchmarkHook(null, options.currentDrawingId.value || "");
		}

		options.lastXRef.value = x;
		options.lastYRef.value = y;
		options.lastWidthRef.value = newWidth;

		const newPoint = { x: x / width, y: y / height, p: usedPressure, lamport };
		options.currentPathPointsRef.value.push(newPoint);
		options.pendingPointsRef.value.push(newPoint);

		if (options.pendingPointsRef.value.length >= 1) {
			options.pushCommand(
				{
					id: options.currentDrawingId.value || undefined,
					points: options.pendingPointsRef.value,
				},
				"update"
			);
			options.pendingPointsRef.value = [];
		}
	};

	const stopDrawing = (e: PointerEvent) => {
		if (!options.isDrawing.value) return;
		if (e.pointerId !== options.activePointerId.value) return;

		const cmdId = options.currentDrawingId.value;
		const cmd = options.commands.value.find((candidate) => candidate.id === cmdId);
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
				points: options.pendingPointsRef.value || [],
				box: cmd?.box,
			},
			"stop"
		);
		options.pendingPointsRef.value = [];

		if (options.currentTool.value === "cursor") {
			const cursorStopResult = options.interactionController.finishCursorInteraction({
				interactionMode: options.interactionMode.value,
				selectionRect: options.selectionRect.value,
				selectedCommandIds: options.selectedCommandIds.value,
				commands: options.commands.value,
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

		if (options.currentPathPointsRef.value.length === 1 && ctx.value && canvasRef.value) {
			const dpr = window.devicePixelRatio || 1;
			const p0 = options.currentPathPointsRef.value[0] || { x: 0, y: 0, p: 0.5, lamport: 0 };
			const width = canvasRef.value.width / dpr;
			const height = canvasRef.value.height / dpr;
			const x = p0.x * width;
			const y = p0.y * height;
			let w = options.currentSize.value * (p0.p * 2);
			if (options.currentTool.value === "eraser") w = options.currentSize.value;

			ctx.value.beginPath();
			const color =
				options.currentTool.value === "eraser" ? "#ffffff" : options.currentColor.value;
			ctx.value.globalCompositeOperation =
				options.currentTool.value === "eraser" ? "destination-out" : "source-over";
			ctx.value.fillStyle = color;
			ctx.value.arc(x, y, w / 2, 0, Math.PI * 2);
			ctx.value.fill();
		}

		if (options.pendingPointsRef.value.length > 0) {
			options.pushCommand(
				{
					id: options.currentDrawingId.value || undefined,
					points: options.pendingPointsRef.value,
				},
				"update"
			);
			options.pendingPointsRef.value = [];
		}

		options.currentPathPointsRef.value = [];
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
	};
};

