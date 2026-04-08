// File role: pure interaction calculations for coordinates, selection, hit testing, and transforms.
import type { Command, Point, aabbBox } from "../utils/type";

interface PointerCoordinates {
	x: number;
	y: number;
	pressure: number;
}

interface SelectionRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface PointerSyncInput {
	canvas: HTMLCanvasElement | null;
	cursorX: number;
	cursorY: number;
	userId: string;
	userName: string;
	currentPageId: number;
	interactionMode: string;
	selectedCommandIds: Set<string>;
	dragStartPos: { x: number; y: number } | null;
	selectionRect: { x: number; y: number; w: number; h: number } | null;
	lastSentPos: { x: number; y: number };
	send: (type: string, data: unknown) => void;
}

interface BoxSelectionInput {
	startPos: { x: number; y: number };
	currentPos: { x: number; y: number };
}

interface ResolveSelectionInput {
	rect: SelectionRect;
	commands: Command[];
	currentPageId: number;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
}

interface TransformPreviewInput {
	currentPos: { x: number; y: number };
	startPos: { x: number; y: number };
	handle: "tl" | "tr" | "bl" | "br" | "body";
	initialBox: aabbBox;
}

interface DirtyRectInput {
	box: aabbBox;
	canvas: HTMLCanvasElement;
}

interface ResolveCursorActionInput {
	normalizedPoint: { x: number; y: number };
	canvasSize: { width: number; height: number };
	commands: Command[];
	selectedCommandIds: Set<string>;
	currentPageId: number;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
	getGroupBoundingBox: (
		cmdIds: Set<string>,
		commands: Command[],
		currentPageId: number
	) => aabbBox | null;
}

interface ResolveCursorActionResult {
	action: "group" | "box-selecting";
	mode: "dragging" | "resizing" | "box-selecting";
	handle: "tl" | "tr" | "bl" | "br" | "body" | null;
	selectedIds: string[];
	groupBox: aabbBox | null;
	selectionRect: SelectionRect | null;
}

interface BeginCursorInteractionInput {
	canvas: HTMLCanvasElement;
	event: PointerEvent;
	commands: Command[];
	selectedCommandIds: Set<string>;
	currentPageId: number;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
	getGroupBoundingBox: (
		cmdIds: Set<string>,
		commands: Command[],
		currentPageId: number
	) => aabbBox | null;
}

interface BeginCursorInteractionResult {
	x: number;
	y: number;
	normalizedPoint: { x: number; y: number };
	handle: ResolveCursorActionResult["handle"];
	mode: ResolveCursorActionResult["mode"];
	selectedIds: string[];
	groupBox: aabbBox | null;
	selectionRect: SelectionRect | null;
	initialCmdsState: Map<string, Point[]>;
}

interface TransformStopPayloadInput {
	selectedCommandIds: Set<string>;
	commands: Command[];
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
}

interface TransformStopPayload {
	updates: Array<{ cmdId: string; points: Point[] | undefined }>;
	boxes: Array<{ cmdId: string; box: aabbBox }>;
}

interface FinishCursorInteractionInput {
	interactionMode: "none" | "box-selecting" | "dragging" | "resizing";
	selectionRect: SelectionRect | null;
	selectedCommandIds: Set<string>;
	commands: Command[];
	currentPageId: number;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
}

interface FinishCursorInteractionResult {
	remoteSelectionRect: null | undefined;
	selectedIds: string[];
	transformPayload: TransformStopPayload | null;
	nextState: CursorStopState;
}

interface PreviewCursorInteractionInput {
	canvas: HTMLCanvasElement;
	interactionMode: "none" | "box-selecting" | "dragging" | "resizing";
	x: number;
	y: number;
	dragStartPos: { x: number; y: number } | null;
	selectedCommandIds: Set<string>;
	activeTransformHandle: "tl" | "tr" | "bl" | "br" | "body" | null;
	initialGroupBox: aabbBox | null;
	transformingCmdIds: Set<string>;
	initialCmdsState: Map<string, Point[]>;
	commands: Command[];
}

interface PreviewCursorInteractionResult {
	normalizedPoint: { x: number; y: number };
	selectionRect: SelectionRect | null;
	transformingIds: string[] | null;
	shouldPromote: boolean;
	nextTransformAnim: { progress: number; phase: "entering"; initialBox: aabbBox } | null;
	dirtyRect: aabbBox | null;
	transformedCommands: Array<{ cmdId: string; points: Point[] }>;
}

interface CursorStopState {
	activePointerId: number;
	dragStartPos: null;
	activeTransformHandle: null;
	interactionMode: "none";
	initialGroupBox: null;
	selectionRect: null;
}

export const createInteractionController = () => {
	const getCoordinates = (
		canvas: HTMLCanvasElement | null,
		event: PointerEvent
	): PointerCoordinates => {
		if (!canvas) {
			return {
				x: 0,
				y: 0,
				pressure: event.pressure || 0.5,
			};
		}

		const rect = canvas.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			pressure: event.pressure || 0.5,
		};
	};

	const normalizeCoordinates = (canvas: HTMLCanvasElement, point: { x: number; y: number }) => {
		const dpr = window.devicePixelRatio || 1;
		const width = canvas.width / dpr;
		const height = canvas.height / dpr;

		return {
			x: width > 0 ? point.x / width : 0,
			y: height > 0 ? point.y / height : 0,
		};
	};

	const syncPointerPosition = (input: PointerSyncInput) => {
		if (!input.canvas) {
			return input.lastSentPos;
		}

		const dpr = window.devicePixelRatio || 1;
		const logicalWidth = input.canvas.width / dpr;
		const logicalHeight = input.canvas.height / dpr;
		const nx = logicalWidth > 0 ? input.cursorX / logicalWidth : 0;
		const ny = logicalHeight > 0 ? input.cursorY / logicalHeight : 0;

		input.send("mouseMove", {
			userId: input.userId,
			userName: input.userName,
			x: nx,
			y: ny,
			pageId: input.currentPageId,
		});

		if (
			input.interactionMode === "dragging" &&
			input.selectedCommandIds.size > 0 &&
			input.dragStartPos
		) {
			const dx = nx - input.lastSentPos.x;
			const dy = ny - input.lastSentPos.y;

			if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
				input.send("cmd-batch-move", {
					userId: input.userId,
					cmdIds: Array.from(input.selectedCommandIds),
					dx,
					dy,
					isRealtime: true,
				});

				return { x: nx, y: ny };
			}
		}

		if (input.interactionMode === "box-selecting" && input.selectionRect) {
			input.send("box-selection", {
				userId: input.userId,
				rect: input.selectionRect,
			});
		}

		return input.lastSentPos;
	};

	const notifyPointerLeave = (
		send: (type: string, data: unknown) => void,
		payload: { userId: string; userName: string }
	) => {
		send("mouseLeave", payload);
	};

	const createSelectionRect = ({ startPos, currentPos }: BoxSelectionInput): SelectionRect => ({
		x: Math.min(startPos.x, currentPos.x),
		y: Math.min(startPos.y, currentPos.y),
		w: Math.abs(currentPos.x - startPos.x),
		h: Math.abs(currentPos.y - startPos.y),
	});

	const resolveSelectedCommandIds = ({
		rect,
		commands,
		currentPageId,
		getCommandBoundingBox,
	}: ResolveSelectionInput) => {
		const rectMinX = Math.min(rect.x, rect.x + rect.w);
		const rectMaxX = Math.max(rect.x, rect.x + rect.w);
		const rectMinY = Math.min(rect.y, rect.y + rect.h);
		const rectMaxY = Math.max(rect.y, rect.y + rect.h);

		return commands.reduce<string[]>((selectedIds, cmd) => {
			if (cmd.isDeleted || cmd.pageId !== currentPageId || cmd.type !== "path") {
				return selectedIds;
			}

			const box = getCommandBoundingBox(cmd);
			if (!box) {
				return selectedIds;
			}

			if (
				box.minX < rectMaxX &&
				box.maxX > rectMinX &&
				box.minY < rectMaxY &&
				box.maxY > rectMinY &&
				cmd.tool === "pen"
			) {
				selectedIds.push(cmd.id);
			}

			return selectedIds;
		}, []);
	};

	const shouldPromoteTransformLayer = ({
		currentPos,
		startPos,
		handle,
	}: TransformPreviewInput) => {
		const dx = currentPos.x - startPos.x;
		const dy = currentPos.y - startPos.y;

		return Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001 || handle !== "body";
	};

	const getTransformDirtyRect = ({ box, canvas }: DirtyRectInput): aabbBox => {
		const dpr = window.devicePixelRatio || 1;
		const logicalWidth = canvas.width / dpr;
		const logicalHeight = canvas.height / dpr;

		return {
			minX: box.minX * logicalWidth,
			minY: box.minY * logicalHeight,
			maxX: box.maxX * logicalWidth,
			maxY: box.maxY * logicalHeight,
			width: box.width * logicalWidth,
			height: box.height * logicalHeight,
		};
	};

	const transformPoints = ({
		currentPos,
		startPos,
		handle,
		initialBox,
		points,
	}: TransformPreviewInput & { points: Command["points"] extends infer T ? Exclude<T, undefined> : never }) => {
		if (handle === "body") {
			const dx = currentPos.x - startPos.x;
			const dy = currentPos.y - startPos.y;

			return points.map((p) => ({
				...p,
				x: p.x + dx,
				y: p.y + dy,
			}));
		}

		let anchorX = 0;
		let anchorY = 0;
		switch (handle) {
			case "tl":
				anchorX = initialBox.maxX;
				anchorY = initialBox.maxY;
				break;
			case "tr":
				anchorX = initialBox.minX;
				anchorY = initialBox.maxY;
				break;
			case "bl":
				anchorX = initialBox.maxX;
				anchorY = initialBox.minY;
				break;
			case "br":
				anchorX = initialBox.minX;
				anchorY = initialBox.minY;
				break;
		}

		const currentW = currentPos.x - anchorX;
		const currentH = currentPos.y - anchorY;

		let originalW = 0;
		let originalH = 0;
		switch (handle) {
			case "tl":
				originalW = initialBox.minX - initialBox.maxX;
				originalH = initialBox.minY - initialBox.maxY;
				break;
			case "tr":
				originalW = initialBox.maxX - initialBox.minX;
				originalH = initialBox.minY - initialBox.maxY;
				break;
			case "bl":
				originalW = initialBox.minX - initialBox.maxX;
				originalH = initialBox.maxY - initialBox.minY;
				break;
			case "br":
				originalW = initialBox.maxX - initialBox.minX;
				originalH = initialBox.maxY - initialBox.minY;
				break;
		}

		if (originalW === 0 || originalH === 0) {
			return points;
		}

		const scaleX = currentW / originalW;
		const scaleY = currentH / originalH;

		return points.map((p) => ({
			...p,
			x: anchorX + (p.x - anchorX) * scaleX,
			y: anchorY + (p.y - anchorY) * scaleY,
		}));
	};

	const resolveCursorAction = ({
		normalizedPoint,
		canvasSize,
		commands,
		selectedCommandIds,
		currentPageId,
		getCommandBoundingBox,
		getGroupBoundingBox,
	}: ResolveCursorActionInput): ResolveCursorActionResult => {
		let handle: ResolveCursorActionResult["handle"] = null;
		let action: ResolveCursorActionResult["action"] = "box-selecting";
		let mode: ResolveCursorActionResult["mode"] = "box-selecting";
		let nextSelectedIds = Array.from(selectedCommandIds);
		let groupBox = getGroupBoundingBox(selectedCommandIds, commands, currentPageId);

		if (groupBox && selectedCommandIds.size > 0) {
			const handleSize = 8 / canvasSize.width;
			const corners: Record<string, { x: number; y: number }> = {
				tl: { x: groupBox.minX, y: groupBox.minY },
				tr: { x: groupBox.maxX, y: groupBox.minY },
				br: { x: groupBox.maxX, y: groupBox.maxY },
				bl: { x: groupBox.minX, y: groupBox.maxY },
			};

			for (const [key, point] of Object.entries(corners)) {
				if (
					Math.abs(normalizedPoint.x - point.x) <= handleSize &&
					Math.abs(normalizedPoint.y - point.y) <= handleSize * (canvasSize.width / canvasSize.height)
				) {
					handle = key as ResolveCursorActionResult["handle"];
					action = "group";
					mode = "resizing";
					break;
				}
			}

			if (
				!handle &&
				normalizedPoint.x >= groupBox.minX &&
				normalizedPoint.x <= groupBox.maxX &&
				normalizedPoint.y >= groupBox.minY &&
				normalizedPoint.y <= groupBox.maxY
			) {
				handle = "body";
				action = "group";
				mode = "dragging";
			}
		}

		if (action !== "group" || handle === "body") {
			let hitCmdId: string | null = null;
			const buffer = 10 / canvasSize.width;

			for (let index = commands.length - 1; index >= 0; index -= 1) {
				const cmd = commands[index];
				if (!cmd || cmd.isDeleted || cmd.pageId !== currentPageId || cmd.type !== "path") {
					continue;
				}

				const box = getCommandBoundingBox(cmd);
				if (!box) {
					continue;
				}

				if (
					normalizedPoint.x >= box.minX - buffer &&
					normalizedPoint.x <= box.maxX + buffer &&
					normalizedPoint.y >= box.minY - buffer &&
					normalizedPoint.y <= box.maxY + buffer
				) {
					hitCmdId = cmd.id;
					break;
				}
			}

			if (hitCmdId) {
				handle = "body";
				action = "group";
				mode = "dragging";
				nextSelectedIds = selectedCommandIds.has(hitCmdId) ? nextSelectedIds : [hitCmdId];
				groupBox = getGroupBoundingBox(new Set(nextSelectedIds), commands, currentPageId);
			}
		}

		return {
			action,
			mode,
			handle,
			selectedIds: nextSelectedIds,
			groupBox,
			selectionRect:
				action === "box-selecting"
					? {
							x: normalizedPoint.x,
							y: normalizedPoint.y,
							w: 0,
							h: 0,
					  }
					: null,
		};
	};

	const beginCursorInteraction = ({
		canvas,
		event,
		commands,
		selectedCommandIds,
		currentPageId,
		getCommandBoundingBox,
		getGroupBoundingBox,
	}: BeginCursorInteractionInput): BeginCursorInteractionResult => {
		const { x, y } = getCoordinates(canvas, event);
		const dpr = window.devicePixelRatio || 1;
		const width = canvas.width / dpr;
		const height = canvas.height / dpr;
		const normalizedPoint = {
			x: width > 0 ? x / width : 0,
			y: height > 0 ? y / height : 0,
		};

		const cursorAction = resolveCursorAction({
			normalizedPoint,
			canvasSize: { width, height },
			commands,
			selectedCommandIds,
			currentPageId,
			getCommandBoundingBox,
			getGroupBoundingBox,
		});

		const initialCmdsState = new Map<string, Point[]>();
		if (cursorAction.action === "group") {
			cursorAction.selectedIds.forEach((id) => {
				const cmd = commands.find((candidate) => candidate.id === id);
				if (cmd?.points) {
					initialCmdsState.set(id, JSON.parse(JSON.stringify(cmd.points)));
				}
			});
		}

		return {
			x,
			y,
			normalizedPoint,
			handle: cursorAction.handle,
			mode: cursorAction.mode,
			selectedIds: cursorAction.selectedIds,
			groupBox: cursorAction.groupBox,
			selectionRect: cursorAction.selectionRect,
			initialCmdsState,
		};
	};

	const buildTransformStopPayload = ({
		selectedCommandIds,
		commands,
		getCommandBoundingBox,
	}: TransformStopPayloadInput): TransformStopPayload => {
		const updates = Array.from(selectedCommandIds)
			.map((id) => {
				const cmd = commands.find((candidate) => candidate.id === id);
				return cmd ? { cmdId: id, points: cmd.points } : null;
			})
			.filter((update): update is { cmdId: string; points: Point[] | undefined } => Boolean(update));

		const boxes = updates.reduce<Array<{ cmdId: string; box: aabbBox }>>((result, update) => {
			const cmd = commands.find((candidate) => candidate.id === update.cmdId);
			if (!cmd) {
				return result;
			}

			cmd.box = getCommandBoundingBox(cmd) ?? {
				minX: 0,
				minY: 0,
				maxX: 0,
				maxY: 0,
				width: 0,
				height: 0,
			};

			result.push({
				cmdId: cmd.id,
				box: cmd.box,
			});

			return result;
		}, []);

		return { updates, boxes };
	};

	const resolveBoxSelectionStop = (input: ResolveSelectionInput) =>
		resolveSelectedCommandIds(input);

	const finishCursorInteraction = ({
		interactionMode,
		selectionRect,
		selectedCommandIds,
		commands,
		currentPageId,
		getCommandBoundingBox,
	}: FinishCursorInteractionInput): FinishCursorInteractionResult => {
		if (interactionMode === "box-selecting" && selectionRect) {
			return {
				remoteSelectionRect: null,
				selectedIds: resolveBoxSelectionStop({
					rect: selectionRect,
					commands,
					currentPageId,
					getCommandBoundingBox,
				}),
				transformPayload: null,
				nextState: getCursorStopState(),
			};
		}

		if (
			(interactionMode === "dragging" || interactionMode === "resizing") &&
			selectedCommandIds.size > 0
		) {
			return {
				remoteSelectionRect: undefined,
				selectedIds: Array.from(selectedCommandIds),
				transformPayload: buildTransformStopPayload({
					selectedCommandIds,
					commands,
					getCommandBoundingBox,
				}),
				nextState: getCursorStopState(),
			};
		}

		return {
			remoteSelectionRect: undefined,
			selectedIds: Array.from(selectedCommandIds),
			transformPayload: null,
			nextState: getCursorStopState(),
		};
	};

	const previewCursorInteraction = ({
		canvas,
		interactionMode,
		x,
		y,
		dragStartPos,
		selectedCommandIds,
		activeTransformHandle,
		initialGroupBox,
		transformingCmdIds,
		initialCmdsState,
		commands,
	}: PreviewCursorInteractionInput): PreviewCursorInteractionResult => {
		const normalizedPoint = normalizeCoordinates(canvas, { x, y });

		if (interactionMode === "box-selecting" && dragStartPos) {
			return {
				normalizedPoint,
				selectionRect: createSelectionRect({
					startPos: dragStartPos,
					currentPos: normalizedPoint,
				}),
				transformingIds: null,
				shouldPromote: false,
				nextTransformAnim: null,
				dirtyRect: null,
				transformedCommands: [],
			};
		}

		if (
			selectedCommandIds.size === 0 ||
			!activeTransformHandle ||
			!dragStartPos ||
			!initialGroupBox
		) {
			return {
				normalizedPoint,
				selectionRect: null,
				transformingIds: null,
				shouldPromote: false,
				nextTransformAnim: null,
				dirtyRect: null,
				transformedCommands: [],
			};
		}

		const shouldPromote =
			transformingCmdIds.size === 0 &&
			shouldPromoteTransformLayer({
				currentPos: normalizedPoint,
				startPos: dragStartPos,
				handle: activeTransformHandle,
				initialBox: initialGroupBox,
			});

		if (transformingCmdIds.size === 0 && !shouldPromote) {
			return {
				normalizedPoint,
				selectionRect: null,
				transformingIds: null,
				shouldPromote: false,
				nextTransformAnim: null,
				dirtyRect: null,
				transformedCommands: [],
			};
		}

		const transformedCommands = Array.from(selectedCommandIds)
			.map((cmdId) => {
				const initialPoints = initialCmdsState.get(cmdId);
				if (!initialPoints) return null;

				return {
					cmdId,
					points: transformPoints({
						currentPos: normalizedPoint,
						startPos: dragStartPos,
						handle: activeTransformHandle,
						initialBox: initialGroupBox,
						points: initialPoints,
					}),
				};
			})
			.filter((item): item is { cmdId: string; points: Point[] } => Boolean(item));

		return {
			normalizedPoint,
			selectionRect: null,
			transformingIds: shouldPromote ? Array.from(selectedCommandIds) : null,
			shouldPromote,
			nextTransformAnim: shouldPromote
				? {
						progress: 0,
						phase: "entering",
						initialBox: initialGroupBox,
				  }
				: null,
			dirtyRect: shouldPromote
				? getTransformDirtyRect({
						box: initialGroupBox,
						canvas,
				  })
				: null,
			transformedCommands,
		};
	};

	const getCursorStopState = (): CursorStopState => ({
		activePointerId: -1,
		dragStartPos: null,
		activeTransformHandle: null,
		interactionMode: "none",
		initialGroupBox: null,
		selectionRect: null,
	});

	return {
		getCoordinates,
		syncPointerPosition,
		notifyPointerLeave,
		createSelectionRect,
		resolveSelectedCommandIds,
		shouldPromoteTransformLayer,
		getTransformDirtyRect,
		transformPoints,
		resolveCursorAction,
		beginCursorInteraction,
		buildTransformStopPayload,
		resolveBoxSelectionStop,
		finishCursorInteraction,
		normalizeCoordinates,
		previewCursorInteraction,
		getCursorStopState,
	};
};

