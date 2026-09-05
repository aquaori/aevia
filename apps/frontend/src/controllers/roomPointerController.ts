// File role: pointer-event orchestration that ties interaction state, commands, transport, and rendering together.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import { canvasRef, ctx } from "../service/canvas";
import {
	SCENE_SCHEMA_VERSION,
	type AffineMatrix,
	type Command,
	type EditorTool,
	type EraseTarget,
	type Point,
	type SceneElementDescriptor,
	type SceneElementStyle,
	type StrokePattern,
	type TextPatch,
	type aabbBox,
} from "@collaborative-whiteboard/shared";
import { builtinToolRegistry } from "../scene/toolRegistry";
import { splitGraphemes } from "../scene/graphemes";
import {
	getInitialStrokeWidth,
	getNextStrokeWidth,
	resolveStrokeStyle,
} from "../service/strokeRasterizer";
import type { PointerHotState, ProductPreviewState } from "../states/roomInteractionState";
import { getCollabPressurePolicy, shouldFlushCommandUpdate } from "../service/collabPressurePolicy";
import {
	createStrokeInputSampler,
	resolveStrokeStartPressure,
	simplifyStrokeSamples,
	type RawPointerSample,
	type StrokeInputSample,
} from "../service/strokeInputSampler";

type Tool = EditorTool;
type InteractionMode = "none" | "box-selecting" | "dragging" | "resizing" | "rotating";
type HandleType = "tl" | "tm" | "tr" | "mr" | "br" | "bm" | "bl" | "ml" | "rotate" | "body" | null;

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
	currentStrokePattern: Ref<StrokePattern>;
	currentSticker: Ref<string>;
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
	previewTransform: Ref<AffineMatrix | null>;
	initialGroupBox: Ref<aabbBox | null>;
	selectedSceneBounds: Ref<aabbBox | null>;
	productPreview: Ref<ProductPreviewState | null>;
	canvasCursor: Ref<string>;
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
	waitForSceneOperationRender?: (opId: string) => Promise<void>;
	send: (type: string, data: unknown) => boolean;
	pushCommand: (cmdPartial: Partial<Command>) =>
		| { ok: boolean; error?: string; command?: Command }
		| undefined;
	renderCanvas: () => void;
	hydrateCommandPoints?: (cmdIds: string[]) => Promise<void>;
	computeEraseTargets: (
		points: Point[],
		size: number,
		wholeObjects: boolean
	) => Promise<EraseTarget[]>;
	hitTestScene: (x: number, y: number) => Promise<{ elementId: string | null; bounds: aabbBox | null }>;
	querySceneElements: (rect: aabbBox) => Promise<{ elementIds: string[]; bounds: aabbBox | null }>;
	requestTextInput: (input: {
		kind: "text" | "sticky";
		elementId: string;
		box: aabbBox;
		initialText?: string;
		onChange?: (value: string, reason: "input" | "ime") => void;
		initialStyle?: Partial<SceneElementStyle>;
		onStyleChange?: (style: Partial<SceneElementStyle>) => void;
		onGroupBoundary?: () => void;
	}) => Promise<string | null>;
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
	let productGestureStart: { x: number; y: number } | null = null;
	let currentStrokeSourceIndex = 0;
	let eraseHistoryGroupId: string | null = null;
	let eraseProcessedPointCount = 0;
	let eraseFlushRequested = false;
	let eraseFlushPromise: Promise<void> | null = null;
	const rasterTool = (tool: EditorTool) =>
		tool === "pencil" || tool === "highlighter" ? tool : tool === "eraser" ? "eraser" : "pen";

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

	const normalizedRoomId = () =>
		Array.isArray(options.roomId.value) ? options.roomId.value[0] || "" : options.roomId.value;

	const pushSceneCreate = (
		elementId: string,
		descriptor: SceneElementDescriptor,
		points: Point[] = [],
		isComplete = false
	) => {
		const opId = elementId;
		const lamport = useLamportStore().getNextLamport();
		const payload = descriptor.elementKind === "path"
			? { descriptor, points, isComplete }
			: { descriptor, isComplete };
		return options.pushCommand({
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId(),
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: descriptor.box ?? { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId,
				actorId: options.userId.value,
				roomId: normalizedRoomId(),
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId: opId,
				kind: "element.create",
				payload,
			},
		});
	};

	const pushSceneAppend = (
		elementId: string,
		points: Point[],
		sourceStart: number,
		isComplete = false
	) => {
		const opId = uuidv4();
		const lamport = points[points.length - 1]?.lamport ?? useLamportStore().getNextLamport();
		return options.pushCommand({
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId(),
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId,
				actorId: options.userId.value,
				roomId: normalizedRoomId(),
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId: elementId,
				kind: "element.append",
				payload: { points, sourceStart, isComplete },
			},
		});
	};

	const pushSceneErase = (targets: EraseTarget[], historyGroupId = uuidv4()) => {
		if (targets.length === 0) return;
		const opId = uuidv4();
		const lamport = useLamportStore().getNextLamport();
		options.pushCommand({
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId(),
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId: targets[0]!.elementId,
				actorId: options.userId.value,
				roomId: normalizedRoomId(),
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId,
				kind: "element.erase",
				payload: { targets },
			},
		});
	};

	const flushEraserTargets = () => {
		eraseFlushRequested = true;
		if (eraseFlushPromise) return eraseFlushPromise;
		eraseFlushPromise = (async () => {
			while (eraseFlushRequested && eraseHistoryGroupId) {
				eraseFlushRequested = false;
				const path = options.pointerHotState.currentPathPoints;
				if (path.length <= eraseProcessedPointCount) continue;
				const start = eraseProcessedPointCount === 0 ? 0 : eraseProcessedPointCount - 1;
				const segment = path.slice(start).map((point) => ({ ...point }));
				eraseProcessedPointCount = path.length;
				const targets = await options.computeEraseTargets(
					segment,
					options.currentSize.value,
					options.currentTool.value === "object-eraser"
				);
				pushSceneErase(targets, eraseHistoryGroupId);
				if (options.pointerHotState.currentPathPoints.length > eraseProcessedPointCount) {
					eraseFlushRequested = true;
				}
			}
		})().finally(() => {
			eraseFlushPromise = null;
		});
		return eraseFlushPromise;
	};

	const pushSceneTextPatch = (elementId: string, patches: TextPatch[], historyGroupId: string) => {
		if (patches.length === 0) return;
		const opId = uuidv4();
		const lamport = useLamportStore().getNextLamport();
		return options.pushCommand({
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId(),
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId,
				actorId: options.userId.value,
				roomId: normalizedRoomId(),
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId,
				kind: "text.patch",
				payload: { patches },
			},
		});
	};

	const pushSceneStyle = (elementId: string, style: Partial<SceneElementStyle>, historyGroupId: string) => {
		const opId = uuidv4();
		const lamport = useLamportStore().getNextLamport();
		return options.pushCommand({
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId(),
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId,
				actorId: options.userId.value,
				roomId: normalizedRoomId(),
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId,
				kind: "element.style",
				payload: { style },
			},
		});
	};

	const pushSceneHistoryToggle = (elementId: string, targetHistoryGroupId: string, enabled: boolean) => {
		const opId = uuidv4();
		const lamport = useLamportStore().getNextLamport();
		return options.pushCommand({
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId(),
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId,
				actorId: options.userId.value,
				roomId: normalizedRoomId(),
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId: opId,
				kind: "history.toggle",
				payload: { targetHistoryGroupId, enabled },
			},
		});
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
		const tool = options.currentTool.value === "pencil" || options.currentTool.value === "highlighter"
			? options.currentTool.value
			: "pen";
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
		options.pointerHotState.currentPathPoints = [p0];
		options.pointerHotState.pendingPoints = [];

		const descriptor = builtinToolRegistry.descriptor(tool, {
			color: options.currentColor.value,
			size: options.currentSize.value,
			strokePattern: "solid",
		});
		const startResult = pushSceneCreate(id, descriptor, [p0]);
		if (!startResult?.ok) {
			pendingStrokeStart = null;
			pendingStrokeSamples = [];
			strokeInputSampler.reset();
			lastCanonicalSample = null;
			currentStrokeSourceIndex = 0;
			options.pointerHotState.currentPathPoints = [];
			options.pointerHotState.pendingPoints = [];
			options.currentDrawingId.value = null;
			options.isDrawing.value = false;
			options.activePointerId.value = null;
			return false;
		}
		currentStrokeSourceIndex = 1;
		lastCommandUpdateSentAt = performance.now();
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
					tool: rasterTool(options.currentTool.value),
					color: options.currentColor.value,
					size: options.currentSize.value,
					strokePattern: "solid",
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
							tool: rasterTool(options.currentTool.value),
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
			const pendingPoints = options.pointerHotState.pendingPoints;
			const result = pushSceneAppend(localCmdId, pendingPoints, currentStrokeSourceIndex);
			if (result?.ok) {
				currentStrokeSourceIndex += pendingPoints.length;
				options.pointerHotState.pendingPoints = [];
				lastCommandUpdateSentAt = now;
			}
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
		options.previewTransform.value = null;
		options.transformAnim.value = null;
		options.renderCanvas();
	};

	const setTool = (tool: Tool) => {
		options.currentTool.value = tool;
		options.canvasCursor.value = "default";

		if (tool !== "cursor") {
			options.selectedCommandIds.value.clear();
			options.selectionRect.value = null;
			options.interactionMode.value = "none";
		}

		if (ctx.value) {
			const style = resolveStrokeStyle(rasterTool(tool), options.currentColor.value);
			ctx.value.globalCompositeOperation = style.compositeOperation;
			ctx.value.strokeStyle = style.color;
			ctx.value.fillStyle = style.color;
		}

		options.activeMenu.value = null;
		options.onToolStateUpdated?.();
	};

	const setColor = (color: string) => {
		options.currentColor.value = color;
		if (options.currentTool.value === "eraser" || options.currentTool.value === "object-eraser") setTool("pen");
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
			options.previewTransform.value = null;
			const coordinates = options.interactionController.getCoordinates(canvasRef.value, e);
			const sceneHit = await options.hitTestScene(coordinates.x, coordinates.y);
			const preferredHit = sceneHit.elementId
				? { elementId: sceneHit.elementId, bounds: sceneHit.bounds }
				: null;
			const cursorAction = options.interactionController.beginCursorInteraction({
				canvas: canvasRef.value,
				event: e,
				commands: options.commands.value,
				commandMap: options.commandMap,
				selectedCommandIds: options.selectedCommandIds.value,
				currentPageId: options.currentPageId.value,
				getCommandBoundingBox: options.getCommandBoundingBox,
				getGroupBoundingBox: options.getGroupBoundingBox,
				preferredHit,
			});

			options.activeTransformHandle.value = cursorAction.handle as HandleType;
			options.interactionMode.value = cursorAction.mode;
			options.selectedSceneBounds.value = cursorAction.groupBox;
			if (cursorAction.mode === "rotating") options.canvasCursor.value = "grabbing";
			else if (cursorAction.mode === "dragging") options.canvasCursor.value = "grabbing";

			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			options.isDrawing.value = true;
			options.activePointerId.value = e.pointerId;

			if (cursorAction.mode === "dragging" || cursorAction.mode === "resizing" || cursorAction.mode === "rotating") {
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

		const toolDefinition = builtinToolRegistry.get(options.currentTool.value);
		if (toolDefinition && toolDefinition.inputMode !== "freehand") {
			const coordinates = options.interactionController.getCoordinates(canvasRef.value, e);
			const normalized = options.interactionController.normalizeCoordinates(canvasRef.value, coordinates);
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			options.isDrawing.value = true;
			options.activePointerId.value = e.pointerId;
			options.currentDrawingId.value = uuidv4();
			options.activeMenu.value = null;
			productGestureStart = normalized;
			options.pointerHotState.currentPathPoints = toolDefinition.inputMode === "eraser"
				? [{ ...normalized, p: 1, lamport: 0 }]
				: [];
			options.productPreview.value = {
				tool: options.currentTool.value,
				start: { ...normalized },
				end: { ...normalized },
				points: [{ ...normalized }],
			};
			if (toolDefinition.inputMode === "eraser") {
				eraseHistoryGroupId = options.currentDrawingId.value;
				eraseProcessedPointCount = 0;
				eraseFlushRequested = false;
			}
			options.selectionRect.value = toolDefinition.inputMode === "shape"
				? { x: normalized.x, y: normalized.y, w: 0, h: 0 }
				: null;
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

		if (options.currentTool.value === "cursor" && !options.isDrawing.value && canvasRef.value) {
			const normalized = options.interactionController.normalizeCoordinates(canvasRef.value, { x, y });
			const dpr = window.devicePixelRatio || 1;
			const groupBox = options.selectedSceneBounds.value ?? options.getGroupBoundingBox(
				options.selectedCommandIds.value,
				options.commands.value,
				options.currentPageId.value
			);
			options.canvasCursor.value = options.interactionController.resolveSelectionCursor(
				normalized,
				groupBox,
				{ width: canvasRef.value.width / dpr, height: canvasRef.value.height / dpr }
			);
		}

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
			options.previewTransform.value = preview.transformMatrix;
			if (options.isOffscreenMainCanvas?.()) {
				options.renderCanvas();
			}
			return;
		}

		const toolDefinition = builtinToolRegistry.get(options.currentTool.value);
		if (toolDefinition?.inputMode === "eraser") {
			const normalized = options.interactionController.normalizeCoordinates(canvasRef.value!, { x, y });
			const previous = options.pointerHotState.currentPathPoints[options.pointerHotState.currentPathPoints.length - 1];
			if (!previous || Math.hypot(normalized.x - previous.x, normalized.y - previous.y) > 0.0005) {
				options.pointerHotState.currentPathPoints.push({ ...normalized, p: 1, lamport: 0 });
				options.productPreview.value = {
					tool: options.currentTool.value,
					start: options.productPreview.value?.start ?? normalized,
					end: normalized,
					points: options.pointerHotState.currentPathPoints.map((point) => ({ x: point.x, y: point.y })),
				};
				void flushEraserTargets();
			}
			return;
		}
		if (toolDefinition && toolDefinition.inputMode !== "freehand" && productGestureStart) {
			const normalized = options.interactionController.normalizeCoordinates(canvasRef.value!, { x, y });
			options.productPreview.value = {
				tool: options.currentTool.value,
				start: { ...productGestureStart },
				end: { ...normalized },
				points: [],
			};
			if (toolDefinition.inputMode === "shape") {
				options.selectionRect.value = options.interactionController.createSelectionRect({
					startPos: productGestureStart,
					currentPos: normalized,
				});
			}
			return;
		}
		if (toolDefinition && toolDefinition.inputMode !== "freehand") return;

		const canvasOffset = { left: e.clientX - x, top: e.clientY - y };
		for (const pointerEvent of getCoalescedPointerEvents(e)) {
			pendingStrokeSamples.push(
				...strokeInputSampler.add(toRawPointerSample(pointerEvent, canvasOffset))
			);
		}
		scheduleFrameFlush();
	};

	const stopDrawing = async (e: PointerEvent) => {
		if (!options.isDrawing.value) return;
		if (e.pointerId !== options.activePointerId.value) return;
		const toolDefinition = builtinToolRegistry.get(options.currentTool.value);
		if (options.currentTool.value !== "cursor" && toolDefinition && toolDefinition.inputMode !== "freehand") {
			const coordinates = options.interactionController.getCoordinates(canvasRef.value, e);
			const end = canvasRef.value
				? options.interactionController.normalizeCoordinates(canvasRef.value, coordinates)
				: productGestureStart;
			if (toolDefinition.inputMode === "eraser" && end) {
				options.pointerHotState.currentPathPoints.push({ ...end, p: 1, lamport: 0 });
				options.productPreview.value = {
					tool: options.currentTool.value,
					start: options.productPreview.value?.start ?? end,
					end,
					points: options.pointerHotState.currentPathPoints.map((point) => ({ x: point.x, y: point.y })),
				};
				await flushEraserTargets();
			} else if (productGestureStart && end && options.currentDrawingId.value) {
				let minX = Math.min(productGestureStart.x, end.x);
				let minY = Math.min(productGestureStart.y, end.y);
				let maxX = Math.max(productGestureStart.x, end.x);
				let maxY = Math.max(productGestureStart.y, end.y);
				if (toolDefinition.inputMode === "text" && maxX - minX < 0.02) maxX = Math.min(1, minX + (options.currentTool.value === "sticky" ? 0.22 : 0.32));
				if (toolDefinition.inputMode === "text" && maxY - minY < 0.02) maxY = Math.min(1, minY + (options.currentTool.value === "sticky" ? 0.22 : 0.12));
				if (toolDefinition.inputMode === "sticker" && maxX - minX < 0.02 && maxY - minY < 0.02 && canvasRef.value) {
					const dpr = window.devicePixelRatio || 1;
					const halfWidth = 32 / Math.max(1, canvasRef.value.width / dpr);
					const halfHeight = 32 / Math.max(1, canvasRef.value.height / dpr);
					minX = Math.max(0, end.x - halfWidth);
					maxX = Math.min(1, end.x + halfWidth);
					minY = Math.max(0, end.y - halfHeight);
					maxY = Math.min(1, end.y + halfHeight);
				}
				const box = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
				if (box.width > 0.001 || box.height > 0.001) {
					const descriptor = builtinToolRegistry.descriptor(options.currentTool.value, {
						color: options.currentColor.value,
						size: options.currentSize.value,
						strokePattern: options.currentStrokePattern.value,
						fontFamily: "Aevia Sans, Inter, sans-serif",
						fontSize: 20,
					});
					descriptor.box = box;
					if (toolDefinition.inputMode === "shape") {
						descriptor.shapeStart = productGestureStart;
						descriptor.shapeEnd = end;
					}
					if (toolDefinition.inputMode === "text") {
						descriptor.text = "";
						const elementId = options.currentDrawingId.value;
						let created = false;
						let createdStyle = { ...descriptor.style };
						let draftStyle = { ...descriptor.style };
						let currentCharacters: Array<{ charId: string; grapheme: string }> = [];
						let historyGroupId = elementId;
						let lastInputAt = performance.now();
						const historyGroups = new Set<string>();
						const applyText = (value: string, reason: "input" | "ime") => {
							const graphemes = splitGraphemes(value);
							if (
								graphemes.length === currentCharacters.length &&
								graphemes.every((grapheme, index) => grapheme === currentCharacters[index]?.grapheme)
							) return;
							if (!created) {
								const result = pushSceneCreate(elementId, {
									...descriptor,
									style: { ...draftStyle },
								});
								if (!result?.ok) return;
								created = true;
								createdStyle = { ...draftStyle };
								options.productPreview.value = null;
								historyGroups.add(elementId);
							}
							const now = performance.now();
							if (now - lastInputAt > 750) historyGroupId = uuidv4();
							let commonPrefix = 0;
							while (
								commonPrefix < currentCharacters.length &&
								commonPrefix < graphemes.length &&
								currentCharacters[commonPrefix]!.grapheme === graphemes[commonPrefix]
							) commonPrefix += 1;
							const patches: TextPatch[] = [];
							let nextCharacters: Array<{ charId: string; grapheme: string }>;
							if (commonPrefix === currentCharacters.length) {
								nextCharacters = [...currentCharacters];
								let afterId = nextCharacters[nextCharacters.length - 1]?.charId ?? null;
								for (const grapheme of graphemes.slice(commonPrefix)) {
									const charId = uuidv4();
									patches.push({ type: "insert", charId, afterId, grapheme });
									nextCharacters.push({ charId, grapheme });
									afterId = charId;
								}
							} else if (commonPrefix === graphemes.length) {
								for (const character of currentCharacters.slice(commonPrefix)) patches.push({ type: "delete", charId: character.charId });
								nextCharacters = currentCharacters.slice(0, commonPrefix);
							} else {
								for (const character of currentCharacters) patches.push({ type: "delete", charId: character.charId });
								nextCharacters = [];
								let afterId: string | null = null;
								for (const grapheme of graphemes) {
									const charId = uuidv4();
									patches.push({ type: "insert", charId, afterId, grapheme });
									nextCharacters.push({ charId, grapheme });
									afterId = charId;
								}
							}
							const result = pushSceneTextPatch(elementId, patches, historyGroupId);
							if (result?.ok) {
								currentCharacters = nextCharacters;
								historyGroups.add(historyGroupId);
								lastInputAt = now;
								if (reason === "ime") historyGroupId = uuidv4();
							}
						};
						options.productPreview.value = null;
						options.isDrawing.value = false;
						if (e.target && (e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
							(e.target as HTMLElement).releasePointerCapture(e.pointerId);
						}
						const text = await options.requestTextInput({
							kind: options.currentTool.value === "sticky" ? "sticky" : "text",
							elementId,
							box,
							initialStyle: draftStyle,
							onChange: applyText,
							onStyleChange: (style) => {
								draftStyle = { ...draftStyle, ...style };
							},
							onGroupBoundary: () => {
								historyGroupId = uuidv4();
								lastInputAt = performance.now();
							},
						});
						if (text === null) {
							for (const groupId of historyGroups) pushSceneHistoryToggle(elementId, groupId, false);
						} else {
							applyText(text, "input");
							if (created && JSON.stringify(draftStyle) !== JSON.stringify(createdStyle)) {
								pushSceneStyle(elementId, draftStyle, elementId);
							}
						}
						if (!created) descriptor.text = "";
					}
					if (toolDefinition.inputMode === "sticker") descriptor.sticker = options.currentSticker.value;
					if (toolDefinition.inputMode !== "text") {
						pushSceneCreate(options.currentDrawingId.value, descriptor);
					}
				}
			}

			options.pointerHotState.currentPathPoints = [];
			options.pointerHotState.pendingPoints = [];
			options.productPreview.value = null;
			options.selectionRect.value = null;
			productGestureStart = null;
			eraseHistoryGroupId = null;
			eraseProcessedPointCount = 0;
			eraseFlushRequested = false;
			options.currentDrawingId.value = null;
			options.isDrawing.value = false;
			options.activePointerId.value = null;
			cancelFrameFlush();
			if (e.target && (e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
				(e.target as HTMLElement).releasePointerCapture(e.pointerId);
			}
			return;
		}
		if (options.currentTool.value !== "cursor") {
			pendingStrokeSamples.push(...strokeInputSampler.add(toRawPointerSample(e), true));
		}

		flushFrameWork(true);
		cancelFrameFlush();
		clearPendingCommandUpdateTimer();

		if (options.currentTool.value === "cursor") {
			let sceneSelection: { elementIds: string[]; bounds: aabbBox | null } | null = null;
			if (options.interactionMode.value === "box-selecting" && options.selectionRect.value && canvasRef.value) {
				const selection = options.selectionRect.value;
				const dpr = window.devicePixelRatio || 1;
				const width = canvasRef.value.width / dpr;
				const height = canvasRef.value.height / dpr;
				const minX = Math.min(selection.x, selection.x + selection.w) * width;
				const minY = Math.min(selection.y, selection.y + selection.h) * height;
				const maxX = Math.max(selection.x, selection.x + selection.w) * width;
				const maxY = Math.max(selection.y, selection.y + selection.h) * height;
				sceneSelection = await options.querySceneElements({
					minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY,
				});
			}
			const cursorStopResult = options.interactionController.finishCursorInteraction({
				interactionMode: options.interactionMode.value,
				selectionRect: options.selectionRect.value,
				selectedCommandIds: options.selectedCommandIds.value,
				commandMap: options.commandMap,
				previewTransform: options.previewTransform.value,
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
				options.selectedCommandIds.value = new Set(sceneSelection?.elementIds ?? cursorStopResult.selectedIds);
				options.selectedSceneBounds.value = sceneSelection?.bounds ?? null;
			} else if (cursorStopResult.transformPayload && options.dragStartPos.value) {
				const { targets } = cursorStopResult.transformPayload;
				if (targets.length > 0) {
					const committedBounds = options.initialGroupBox.value && options.previewTransform.value
						? options.interactionController.transformBox(options.initialGroupBox.value, options.previewTransform.value)
						: options.selectedSceneBounds.value;
					const opId = uuidv4();
					const renderFinished = options.waitForSceneOperationRender?.(opId);
					const lamport = useLamportStore().getNextLamport();
					const normalizedRoomId = Array.isArray(options.roomId.value)
						? options.roomId.value[0] || ""
						: options.roomId.value;
					const result = options.pushCommand({
						id: opId,
						type: "scene-op",
						timestamp: Date.now(),
						userId: options.userId.value,
						roomId: normalizedRoomId,
						pageId: options.currentPageId.value,
						isDeleted: false,
						lamport,
						box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
						schemaVersion: SCENE_SCHEMA_VERSION,
						sceneOperation: {
							schemaVersion: SCENE_SCHEMA_VERSION,
							opId,
							elementId: targets[0]!.elementId,
							actorId: options.userId.value,
							roomId: normalizedRoomId,
							pageId: options.currentPageId.value,
							lamport,
							historyGroupId: opId,
							kind: "element.transform",
							payload: { targets },
						},
					});
					if (result?.ok && renderFinished) await renderFinished;
					options.selectedSceneBounds.value = committedBounds;
				}

				finalizeDrop();
			}

			const cursorStopState = cursorStopResult.nextState;
			options.isDrawing.value = false;
			options.activePointerId.value = cursorStopState.activePointerId;
			options.dragStartPos.value = cursorStopState.dragStartPos;
			options.activeTransformHandle.value = cursorStopState.activeTransformHandle;
			options.interactionMode.value = cursorStopState.interactionMode;
			options.selectionRect.value = cursorStopState.selectionRect;
			options.initialCmdsState.value.clear();
			if (!options.transformAnim.value) {
				options.previewTransform.value = null;
			}
			options.initialGroupBox.value = cursorStopState.initialGroupBox;
			options.canvasCursor.value = "default";
			if (e.target && (e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
				(e.target as HTMLElement).releasePointerCapture(e.pointerId);
			}
			return;
		}
		if (!options.isDrawing.value || !options.currentDrawingId.value) {
			if (e.target && (e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
				(e.target as HTMLElement).releasePointerCapture(e.pointerId);
			}
			return;
		}

		const cmdId = options.currentDrawingId.value;
		pushSceneAppend(cmdId, [], currentStrokeSourceIndex, true);
		options.pointerHotState.pendingPoints = [];

		options.pointerHotState.currentPathPoints = [];
		pendingStrokeStart = null;
		strokeInputSampler.reset();
		lastCanonicalSample = null;
		currentStrokeSourceIndex = 0;
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
			currentStrokeSourceIndex = 0;
			hasPendingPointerSync = false;
			hasPendingCursorFrame = false;
			cancelFrameFlush();
			clearPendingCommandUpdateTimer();
			options.pointerHotState.currentPathPoints = [];
			options.pointerHotState.pendingPoints = [];
			options.productPreview.value = null;
			productGestureStart = null;
			eraseHistoryGroupId = null;
			eraseProcessedPointCount = 0;
			eraseFlushRequested = false;
			options.currentDrawingId.value = null;
			options.isDrawing.value = false;
			options.activePointerId.value = null;
		},
	};
};
