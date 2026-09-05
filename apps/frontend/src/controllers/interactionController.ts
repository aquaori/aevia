// File role: pure interaction calculations for coordinates, selection, hit testing, and transforms.
import type {
	AffineMatrix,
	Command,
	Point,
	TransformTarget,
	aabbBox,
} from "@collaborative-whiteboard/shared";

type TransformHandle = "tl" | "tm" | "tr" | "mr" | "br" | "bm" | "bl" | "ml" | "rotate" | "body";
type CursorInteractionMode = "none" | "box-selecting" | "dragging" | "resizing" | "rotating";

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
	handle: TransformHandle;
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
	preferredHit?: { elementId: string; bounds: aabbBox | null } | null;
}

interface ResolveCursorActionResult {
	action: "group" | "box-selecting";
	mode: "dragging" | "resizing" | "rotating" | "box-selecting";
	handle: TransformHandle | null;
	selectedIds: string[];
	groupBox: aabbBox | null;
	selectionRect: SelectionRect | null;
}

interface BeginCursorInteractionInput {
	canvas: HTMLCanvasElement;
	event: PointerEvent;
	commands: Command[];
	commandMap: Map<string, Command>;
	selectedCommandIds: Set<string>;
	currentPageId: number;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
	getGroupBoundingBox: (
		cmdIds: Set<string>,
		commands: Command[],
		currentPageId: number
	) => aabbBox | null;
	preferredHit?: { elementId: string; bounds: aabbBox | null } | null;
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
	commandMap: Map<string, Command>;
	deltaMatrix: AffineMatrix;
	getCommandBoundingBox: (cmd: Command) => aabbBox | null;
}

interface TransformStopPayload {
	targets: TransformTarget[];
	dirtyBoxes: aabbBox[];
}

interface FinishCursorInteractionInput {
	interactionMode: CursorInteractionMode;
	selectionRect: SelectionRect | null;
	selectedCommandIds: Set<string>;
	commandMap: Map<string, Command>;
	previewTransform: AffineMatrix | null;
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
	interactionMode: CursorInteractionMode;
	x: number;
	y: number;
	dragStartPos: { x: number; y: number } | null;
	selectedCommandIds: Set<string>;
	activeTransformHandle: TransformHandle | null;
	initialGroupBox: aabbBox | null;
	transformingCmdIds: Set<string>;
}

interface PreviewCursorInteractionResult {
	normalizedPoint: { x: number; y: number };
	selectionRect: SelectionRect | null;
	transformingIds: string[] | null;
	shouldPromote: boolean;
	nextTransformAnim: { progress: number; phase: "entering"; initialBox: aabbBox } | null;
	dirtyRect: aabbBox | null;
	transformMatrix: AffineMatrix | null;
}

interface CursorStopState {
	activePointerId: number | null;
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
		const threshold = handle === "body" ? 0.003 : 0.001;

		return Math.hypot(dx, dy) > threshold;
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
		const matrix = getTransformMatrix({ currentPos, startPos, handle, initialBox });
		return points.map((point) => ({
			...point,
			x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
			y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
		}));
	};

	const getTransformMatrix = ({
		currentPos,
		startPos,
		handle,
		initialBox,
	}: TransformPreviewInput): AffineMatrix => {
		if (handle === "body") {
			return [1, 0, 0, 1, currentPos.x - startPos.x, currentPos.y - startPos.y];
		}
		if (handle === "rotate") {
			const centerX = (initialBox.minX + initialBox.maxX) / 2;
			const centerY = (initialBox.minY + initialBox.maxY) / 2;
			const angle = Math.atan2(currentPos.y - centerY, currentPos.x - centerX) -
				Math.atan2(startPos.y - centerY, startPos.x - centerX);
			const cosine = Math.cos(angle);
			const sine = Math.sin(angle);
			return [
				cosine,
				sine,
				-sine,
				cosine,
				centerX - cosine * centerX + sine * centerY,
				centerY - sine * centerX - cosine * centerY,
			];
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
			case "tm":
				anchorX = (initialBox.minX + initialBox.maxX) / 2;
				anchorY = initialBox.maxY;
				break;
			case "mr":
				anchorX = initialBox.minX;
				anchorY = (initialBox.minY + initialBox.maxY) / 2;
				break;
			case "bl":
				anchorX = initialBox.maxX;
				anchorY = initialBox.minY;
				break;
			case "br":
				anchorX = initialBox.minX;
				anchorY = initialBox.minY;
				break;
			case "bm":
				anchorX = (initialBox.minX + initialBox.maxX) / 2;
				anchorY = initialBox.minY;
				break;
			case "ml":
				anchorX = initialBox.maxX;
				anchorY = (initialBox.minY + initialBox.maxY) / 2;
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
			case "tm":
				originalW = 1;
				originalH = initialBox.minY - initialBox.maxY;
				break;
			case "mr":
				originalW = initialBox.maxX - initialBox.minX;
				originalH = 1;
				break;
			case "bl":
				originalW = initialBox.minX - initialBox.maxX;
				originalH = initialBox.maxY - initialBox.minY;
				break;
			case "br":
				originalW = initialBox.maxX - initialBox.minX;
				originalH = initialBox.maxY - initialBox.minY;
				break;
			case "bm":
				originalW = 1;
				originalH = initialBox.maxY - initialBox.minY;
				break;
			case "ml":
				originalW = initialBox.minX - initialBox.maxX;
				originalH = 1;
				break;
		}

		if (originalW === 0 || originalH === 0) {
			return [1, 0, 0, 1, 0, 0];
		}

		const scaleX = handle === "tm" || handle === "bm" ? 1 : currentW / originalW;
		const scaleY = handle === "ml" || handle === "mr" ? 1 : currentH / originalH;
		return [
			scaleX,
			0,
			0,
			scaleY,
			anchorX * (1 - scaleX),
			anchorY * (1 - scaleY),
		];
	};

	const transformBox = (box: aabbBox, matrix: AffineMatrix): aabbBox => {
		const corners = [
			{ x: box.minX, y: box.minY },
			{ x: box.maxX, y: box.minY },
			{ x: box.maxX, y: box.maxY },
			{ x: box.minX, y: box.maxY },
		].map((point) => ({
			x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
			y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
		}));
		const minX = Math.min(...corners.map((point) => point.x));
		const minY = Math.min(...corners.map((point) => point.y));
		const maxX = Math.max(...corners.map((point) => point.x));
		const maxY = Math.max(...corners.map((point) => point.y));
		return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
	};

	const getTransformHandleAt = (
		normalizedPoint: { x: number; y: number },
		groupBox: aabbBox,
		canvasSize: { width: number; height: number }
	): Exclude<TransformHandle, "body"> | null => {
		const paddingX = 5 / Math.max(1, canvasSize.width);
		const paddingY = 5 / Math.max(1, canvasSize.height);
		const hitWidth = 10 / Math.max(1, canvasSize.width);
		const hitHeight = 10 / Math.max(1, canvasSize.height);
		const left = groupBox.minX - paddingX;
		const right = groupBox.maxX + paddingX;
		const top = groupBox.minY - paddingY;
		const bottom = groupBox.maxY + paddingY;
		const handles: Record<Exclude<TransformHandle, "body">, { x: number; y: number }> = {
			tl: { x: left, y: top },
			tm: { x: (groupBox.minX + groupBox.maxX) / 2, y: top },
			tr: { x: right, y: top },
			mr: { x: right, y: (groupBox.minY + groupBox.maxY) / 2 },
			br: { x: right, y: bottom },
			bm: { x: (groupBox.minX + groupBox.maxX) / 2, y: bottom },
			bl: { x: left, y: bottom },
			ml: { x: left, y: (groupBox.minY + groupBox.maxY) / 2 },
			rotate: { x: (groupBox.minX + groupBox.maxX) / 2, y: groupBox.minY - 33 / Math.max(1, canvasSize.height) },
		};
		for (const [key, point] of Object.entries(handles)) {
			if (
				Math.abs(normalizedPoint.x - point.x) <= hitWidth &&
				Math.abs(normalizedPoint.y - point.y) <= hitHeight
			) return key as Exclude<TransformHandle, "body">;
		}
		return null;
	};

	const resolveSelectionCursor = (
		normalizedPoint: { x: number; y: number },
		groupBox: aabbBox | null,
		canvasSize: { width: number; height: number }
	) => {
		if (!groupBox) return "default";
		const handle = getTransformHandleAt(normalizedPoint, groupBox, canvasSize);
		if (handle === "rotate") return "grab";
		if (handle === "tl" || handle === "br") return "nwse-resize";
		if (handle === "tr" || handle === "bl") return "nesw-resize";
		if (handle === "tm" || handle === "bm") return "ns-resize";
		if (handle === "ml" || handle === "mr") return "ew-resize";
		if (
			normalizedPoint.x >= groupBox.minX && normalizedPoint.x <= groupBox.maxX &&
			normalizedPoint.y >= groupBox.minY && normalizedPoint.y <= groupBox.maxY
		) return "move";
		return "default";
	};

	const resolveCursorAction = ({
		normalizedPoint,
		canvasSize,
		commands,
		selectedCommandIds,
		currentPageId,
		getCommandBoundingBox,
		getGroupBoundingBox,
		preferredHit,
	}: ResolveCursorActionInput): ResolveCursorActionResult => {
		let handle: ResolveCursorActionResult["handle"] = null;
		let action: ResolveCursorActionResult["action"] = "box-selecting";
		let mode: ResolveCursorActionResult["mode"] = "box-selecting";
		let nextSelectedIds = Array.from(selectedCommandIds);
		let groupBox =
			preferredHit && selectedCommandIds.size === 1 && selectedCommandIds.has(preferredHit.elementId)
				? preferredHit.bounds
				: getGroupBoundingBox(selectedCommandIds, commands, currentPageId);

		if (groupBox && selectedCommandIds.size > 0) {
			handle = getTransformHandleAt(normalizedPoint, groupBox, canvasSize);
			if (handle) {
				action = "group";
				mode = handle === "rotate" ? "rotating" : "resizing";
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
			let hitCmdId: string | null = preferredHit?.elementId ?? null;
			const buffer = 10 / canvasSize.width;

			for (let index = commands.length - 1; index >= 0 && !hitCmdId; index -= 1) {
				const cmd = commands[index];
				if (
					!cmd ||
					cmd.isDeleted ||
					cmd.pageId !== currentPageId ||
					cmd.type !== "path"
				) {
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
				groupBox = preferredHit?.elementId === hitCmdId && nextSelectedIds.length === 1
					? preferredHit.bounds
					: getGroupBoundingBox(new Set(nextSelectedIds), commands, currentPageId);
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
		commandMap,
		selectedCommandIds,
		currentPageId,
		getCommandBoundingBox,
		getGroupBoundingBox,
		preferredHit,
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
			preferredHit,
		});

		const initialCmdsState = new Map<string, Point[]>();
		if (cursorAction.action === "group") {
			cursorAction.selectedIds.forEach((id) => {
				const cmd = commandMap.get(id);
				if (cmd?.points) {
					initialCmdsState.set(id, cmd.points.map((point) => ({ ...point })));
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
		commandMap,
		deltaMatrix,
		getCommandBoundingBox,
	}: TransformStopPayloadInput): TransformStopPayload => {
		const targets: TransformTarget[] = [];
		const dirtyBoxes: aabbBox[] = [];
		selectedCommandIds.forEach((elementId) => {
			const command = commandMap.get(elementId);
			if (!command) return;
			const oldBox = getCommandBoundingBox(command);
			targets.push({ elementId, deltaMatrix });
			if (oldBox) dirtyBoxes.push(oldBox, transformBox(oldBox, deltaMatrix));
		});
		return { targets, dirtyBoxes };
	};

	const resolveBoxSelectionStop = (input: ResolveSelectionInput) =>
		resolveSelectedCommandIds(input);

	const finishCursorInteraction = ({
		interactionMode,
		selectionRect,
		selectedCommandIds,
		commandMap,
		previewTransform,
		currentPageId,
		getCommandBoundingBox,
	}: FinishCursorInteractionInput): FinishCursorInteractionResult => {
		if (interactionMode === "box-selecting" && selectionRect) {
			return {
				remoteSelectionRect: null,
				selectedIds: resolveBoxSelectionStop({
					rect: selectionRect,
					commands: Array.from(commandMap.values()),
					currentPageId,
					getCommandBoundingBox,
				}),
				transformPayload: null,
				nextState: getCursorStopState(),
			};
		}

		if (
			(interactionMode === "dragging" || interactionMode === "resizing" || interactionMode === "rotating") &&
			selectedCommandIds.size > 0
		) {
			return {
				remoteSelectionRect: undefined,
				selectedIds: Array.from(selectedCommandIds),
				transformPayload: previewTransform ? buildTransformStopPayload({
					selectedCommandIds,
					commandMap,
					deltaMatrix: previewTransform,
					getCommandBoundingBox,
				}) : null,
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
				transformMatrix: null,
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
				transformMatrix: null,
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
				transformMatrix: null,
			};
		}

		const transformMatrix = getTransformMatrix({
			currentPos: normalizedPoint,
			startPos: dragStartPos,
			handle: activeTransformHandle,
			initialBox: initialGroupBox,
		});

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
			transformMatrix,
		};
	};

	const getCursorStopState = (): CursorStopState => ({
		activePointerId: null,
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
		getTransformMatrix,
		transformBox,
		getTransformHandleAt,
		resolveSelectionCursor,
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

