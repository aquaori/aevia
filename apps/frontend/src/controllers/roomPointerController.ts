// File role: pointer-event orchestration that ties interaction state, commands, transport, and rendering together.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import { canvasRef, ctx } from "../service/canvas";
import type { Command, Point, aabbBox } from "@collaborative-whiteboard/shared";
import {
	getInitialStrokeWidth,
	getNextStrokeWidth,
	resolveStrokeStyle,
} from "../service/strokeRasterizer";
import type { PointerHotState } from "../states/roomInteractionState";
import { getCollabPressurePolicy, shouldFlushCommandUpdate } from "../service/collabPressurePolicy";
import {
	createStrokeInputSampler,
	resolveStrokeStartPressure,
	simplifyStrokeSamples,
	type RawPointerSample,
	type StrokeInputSample,
} from "../service/strokeInputSampler";

type Tool = "pen" | "eraser" | "cursor";
type InteractionMode = "none" | "box-selecting" | "dragging" | "resizing";
type HandleType = "tl" | "tr" | "bl" | "br" | "body" | null;

interface TransformAnimState {
	progress: number;
	phase: "entering" | "dragging" | "exiting";
	initialBox: aabbBox | null;
}

interface PendingStrokeStart {
	id: string;
	initialSample: StrokeInputSample;
	pointerType: string;
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
	finishIncrementalCommand?: (cmd: Command) => void;
	isOffscreenMainCanvas?: () => boolean;
	syncCommandState?: (cmd: Command) => void;
	send: (type: string, data: unknown) => boolean;
	pushCommand: (
		cmdPartial: Partial<Command>,
		type?: "normal" | "start" | "update" | "stop"
	) => { ok: boolean; error?: string; command?: Command } | undefined;
	renderCanvas: () => void;
	hydrateCommandPoints?: (cmdIds: string[]) => Promise<void>;
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
	let pendingStrokeSamples: StrokeInputSample[] = [];
	let pendingStrokeStart: PendingStrokeStart | null = null;
	let lastCanonicalSample: StrokeInputSample | null = null;
	let lastPointerSyncAt = 0;
	let lastCommandUpdateSentAt = 0;
	let pendingCommandUpdateTimer: ReturnType<typeof setTimeout> | null = null;
	const strokeInputSampler = createStrokeInputSampler();

	const toRawPointerSample = (
		event: PointerEvent,
		canvasOffset?: { left: number; top: number }
	): RawPointerSample => {
		const coordinates = canvasOffset
			? {
					x: event.clientX - canvasOffset.left,
					y: event.clientY - canvasOffset.top,
					pressure: event.pressure || 0.5,
				}
			: options.interactionController.getCoordinates(canvasRef.value, event);
		return {
			x: coordinates.x,
			y: coordinates.y,
			pressure: coordinates.pressure,
			pointerType: event.pointerType,
			timeStamp: event.timeStamp,
		};
	};

	const getCoalescedPointerEvents = (event: PointerEvent) => {
		const coalesced = event.getCoalescedEvents?.() ?? [];
		if (coalesced.length === 0) return [event];
		const events = [...coalesced];
		const last = events[events.length - 1];
		if (
			!last ||
			last.timeStamp !== event.timeStamp ||
			last.clientX !== event.clientX ||
			last.clientY !== event.clientY
		) {
			events.push(event);
		}
		return events;
	};

	const scheduleFrameFlush = () => {
		if (frameRequestId !== null) {
			return;
		}

		frameRequestId = window.requestAnimationFrame(() => {
			frameRequestId = null;
			flushFrameWork();
			const hasFlushableStrokeSamples =
				pendingStrokeSamples.length > 0 &&
				(!pendingStrokeStart || pendingStrokeSamples.length >= 2);
			if (
				hasPendingCursorFrame ||
				hasPendingPointerSync ||
				hasFlushableStrokeSamples
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

	const clearPendingCommandUpdateTimer = () => {
		if (pendingCommandUpdateTimer) {
			clearTimeout(pendingCommandUpdateTimer);
			pendingCommandUpdateTimer = null;
		}
	};

	const schedulePendingCommandUpdate = (delayMs: number) => {
		if (pendingCommandUpdateTimer) return;
		pendingCommandUpdateTimer = setTimeout(() => {
			pendingCommandUpdateTimer = null;
			flushStrokeSamples(true);
		}, Math.max(0, delayMs));
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
		const policy = getCollabPressurePolicy();
		const now = performance.now();
		if (now - lastPointerSyncAt < policy.cursorMinIntervalMs) {
			return;
		}
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
		lastPointerSyncAt = now;
		hasPendingPointerSync = false;
	};

	const commitPendingStrokeStart = (force = false) => {
		if (!pendingStrokeStart) return true;
		if (!force && pendingStrokeSamples.length < 2) return false;
		if (!canvasRef.value) return false;

		const { id, initialSample, pointerType } = pendingStrokeStart;
		const tool = options.currentTool.value === "eraser" ? "eraser" : "pen";
		const pressure = resolveStrokeStartPressure(
			initialSample.pressure,
			pendingStrokeSamples,
			pointerType
		);
		const correctedInitialSample = { ...initialSample, pressure };
		lastCanonicalSample = correctedInitialSample;
		options.lastWidthRef.value = getInitialStrokeWidth(
			tool,
			options.currentSize.value,
			pressure
		);

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value.width / dpr;
		const height = canvasRef.value.height / dpr;
		const lamport = useLamportStore().getNextLamport();
		const p0: Point = {
			x: correctedInitialSample.x / width,
			y: correctedInitialSample.y / height,
			p: pressure,
			lamport,
		};
		const commandPoints = [p0];
		options.pointerHotState.currentPathPoints = commandPoints;
		options.pointerHotState.pendingPoints = [];

		const command: Command = {
			id,
			type: "path",
			points: commandPoints,
			tool,
			color: options.currentColor.value,
			size: options.currentSize.value,
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: Array.isArray(options.roomId.value)
				? options.roomId.value[0] || ""
				: options.roomId.value,
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};
		const startResult = options.pushCommand(command, "start");
		if (!startResult?.ok) {
			pendingStrokeStart = null;
			pendingStrokeSamples = [];
			strokeInputSampler.reset();
			lastCanonicalSample = null;
			options.pointerHotState.currentPathPoints = [];
			options.pointerHotState.pendingPoints = [];
			options.currentDrawingId.value = null;
			options.isDrawing.value = false;
			options.activePointerId.value = null;
			return false;
		}

		if (!options.isOffscreenMainCanvas?.()) {
			useLamportStore().pushToQueue({
				x: correctedInitialSample.x,
				y: correctedInitialSample.y,
				p: pressure,
				cmdId: id,
				userId: options.userId.value,
				tool,
				color: options.currentColor.value,
				size: options.currentSize.value,
				isDeleted: false,
				lastX: correctedInitialSample.x,
				lastY: correctedInitialSample.y,
				lastWidth: options.lastWidthRef.value,
				lamport,
			});
		}

		options.renderIncrementalCommand?.(command, [p0], "local");
		pendingStrokeStart = null;
		return true;
	};

	const flushStrokeSamples = (forceUpdate = false) => {
		if (
			!options.currentDrawingId.value ||
			options.currentTool.value === "cursor" ||
			!canvasRef.value
		) {
			return;
		}
		if (!commitPendingStrokeStart(forceUpdate)) return;

		const policy = getCollabPressurePolicy();
		const samples = simplifyStrokeSamples(
			pendingStrokeSamples,
			lastCanonicalSample,
			policy.simplificationTolerancePx
		);
		pendingStrokeSamples = [];

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value.width / dpr;
		const height = canvasRef.value.height / dpr;
		const localCmdId = options.currentDrawingId.value;
		const localCommand = options.commandMap.get(localCmdId);
		if (localCommand && localCommand.points !== options.pointerHotState.currentPathPoints) {
			localCommand.points = options.pointerHotState.currentPathPoints;
		}
		let nextX = options.lastXRef.value;
		let nextY = options.lastYRef.value;
		let nextWidth = options.lastWidthRef.value;
		const normalizedPoints: Point[] = [];

		for (const sample of samples) {
			const usedPressure = sample.pressure;
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

			nextX = sample.x;
			nextY = sample.y;
		}
		if (samples.length > 0) {
			lastCanonicalSample = samples[samples.length - 1]!;
		}

		if (normalizedPoints.length === 0 && !forceUpdate) return;

		if (normalizedPoints.length > 0) {
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
		}

		options.lastXRef.value = nextX;
		options.lastYRef.value = nextY;
		options.lastWidthRef.value = nextWidth;

		const now = performance.now();
		const elapsedMs = now - lastCommandUpdateSentAt;
		if (
			shouldFlushCommandUpdate(
				policy,
				options.pointerHotState.pendingPoints.length,
				elapsedMs,
				forceUpdate
			)
		) {
			clearPendingCommandUpdateTimer();
			options.pushCommand(
				{
					id: localCmdId,
					points: options.pointerHotState.pendingPoints,
				},
				"update"
			);
			options.pointerHotState.pendingPoints = [];
			lastCommandUpdateSentAt = now;
		} else if (options.pointerHotState.pendingPoints.length > 0) {
			schedulePendingCommandUpdate(policy.updateMinIntervalMs - elapsedMs);
		}
	};

	const flushFrameWork = (forceUpdate = false) => {
		flushCursorFrame();
		flushPointerSync();
		flushStrokeSamples(forceUpdate);
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

	const startDrawing = async (e: PointerEvent) => {
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
				await options.hydrateCommandPoints?.(cursorAction.selectedIds);
				const hydratedInitialCmdsState = new Map<string, Point[]>();
				cursorAction.selectedIds.forEach((id) => {
					const cmd = options.commandMap.get(id);
					if (cmd?.points) {
						hydratedInitialCmdsState.set(id, cmd.points.map((point) => ({ ...point })));
					}
				});
				options.lastXRef.value = cursorAction.x;
				options.lastYRef.value = cursorAction.y;
				options.dragStartPos.value = cursorAction.normalizedPoint;
				options.pointerHotState.lastSentPos = cursorAction.normalizedPoint;
				options.selectedCommandIds.value = new Set(cursorAction.selectedIds);
				options.initialCmdsState.value = hydratedInitialCmdsState;
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

		const initialSample = strokeInputSampler.start(toRawPointerSample(e));
		lastCanonicalSample = initialSample;
		const { x, y } = initialSample;
		queueCursorFrame(x, y);
		options.lastXRef.value = x;
		options.lastYRef.value = y;
		options.pointerHotState.currentPathPoints = [];
		options.pointerHotState.pendingPoints = [];

		const id = uuidv4();
		options.currentDrawingId.value = id;
		pendingStrokeStart = {
			id,
			initialSample,
			pointerType: e.pointerType,
		};
	};

	const draw = (e: PointerEvent) => {
		const { x, y } = options.interactionController.getCoordinates(canvasRef.value, e);
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
				if (cmd) {
					cmd.points = points;
					options.syncCommandState?.(cmd);
				}
			});
			if (options.isOffscreenMainCanvas?.()) {
				options.renderCanvas();
			}
			return;
		}

		const canvasOffset = { left: e.clientX - x, top: e.clientY - y };
		for (const pointerEvent of getCoalescedPointerEvents(e)) {
			pendingStrokeSamples.push(
				...strokeInputSampler.add(toRawPointerSample(pointerEvent, canvasOffset))
			);
		}
		scheduleFrameFlush();
	};

	const stopDrawing = (e: PointerEvent) => {
		if (!options.isDrawing.value) return;
		if (e.pointerId !== options.activePointerId.value) return;
		if (options.currentTool.value !== "cursor") {
			pendingStrokeSamples.push(...strokeInputSampler.add(toRawPointerSample(e), true));
		}

		flushFrameWork(true);
		cancelFrameFlush();
		clearPendingCommandUpdateTimer();

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
					updates.forEach((update) => {
						const cmd = options.commandMap.get(update.cmdId);
						if (cmd && options.isOffscreenMainCanvas?.()) {
							cmd.points = undefined;
						}
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
		if (!options.isDrawing.value || !options.currentDrawingId.value) {
			if (e.target && (e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
				(e.target as HTMLElement).releasePointerCapture(e.pointerId);
			}
			return;
		}

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

		const stopResult = options.pushCommand(
			{
				id: options.currentDrawingId.value || undefined,
				points: options.pointerHotState.pendingPoints || [],
				box: cmd?.box,
			},
			"stop"
		);
		if (stopResult?.ok && cmd && options.isOffscreenMainCanvas?.()) {
			cmd.points = undefined;
			options.syncCommandState?.(cmd);
		}
		if (stopResult?.ok && cmd) {
			options.finishIncrementalCommand?.(cmd);
		}
		options.pointerHotState.pendingPoints = [];

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
		pendingStrokeStart = null;
		strokeInputSampler.reset();
		lastCanonicalSample = null;
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
			pendingStrokeStart = null;
			strokeInputSampler.reset();
			lastCanonicalSample = null;
			hasPendingPointerSync = false;
			hasPendingCursorFrame = false;
			cancelFrameFlush();
			clearPendingCommandUpdateTimer();
			options.pointerHotState.currentPathPoints = [];
			options.pointerHotState.pendingPoints = [];
			options.currentDrawingId.value = null;
			options.isDrawing.value = false;
			options.activePointerId.value = null;
		},
	};
};
