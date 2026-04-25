// File role: mutable interaction state for drawing, selection, dragging, resizing, and transform previews.
import { ref } from "vue";
import type { Point } from "@collaborative-whiteboard/shared";

export type InteractionMode = "none" | "box-selecting" | "dragging" | "resizing";
export type HandleType = "tl" | "tr" | "bl" | "br" | "body" | null;

export interface GroupBoxState {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

export interface TransformAnimState {
	progress: number;
	phase: "entering" | "dragging" | "exiting";
	initialBox: GroupBoxState | null;
}

export interface PointerHotState {
	currentPathPoints: Point[];
	pendingPoints: Point[];
	lastSentPos: { x: number; y: number };
}

export const createRoomInteractionState = () => {
	const cursorX = ref(0);
	const cursorY = ref(0);
	const isDrawing = ref(false);
	const activePointerId = ref<number | null>(null);
	const currentDrawingId = ref<string | null>(null);
	const selectedCommandIds = ref<Set<string>>(new Set());
	const transformingCmdIds = ref<Set<string>>(new Set());
	const transformAnim = ref<TransformAnimState | null>(null);
	const selectionRect = ref<{ x: number; y: number; w: number; h: number } | null>(null);
	const remoteSelectionRects = ref<Map<string, { x: number; y: number; w: number; h: number }>>(
		new Map()
	);
	const dragStartPos = ref<{ x: number; y: number } | null>(null);
	const interactionMode = ref<InteractionMode>("none");
	const activeTransformHandle = ref<HandleType>(null);
	const initialCmdsState = ref<Map<string, Point[]>>(new Map());
	const initialGroupBox = ref<GroupBoxState | null>(null);
	const lastX = ref(0);
	const lastY = ref(0);
	const lastWidth = ref(0);
	const pointerHotState: PointerHotState = {
		currentPathPoints: [],
		pendingPoints: [],
		lastSentPos: { x: 0, y: 0 },
	};

	return {
		cursorX,
		cursorY,
		isDrawing,
		activePointerId,
		currentDrawingId,
		selectedCommandIds,
		transformingCmdIds,
		transformAnim,
		selectionRect,
		remoteSelectionRects,
		dragStartPos,
		interactionMode,
		activeTransformHandle,
		initialCmdsState,
		initialGroupBox,
		lastX,
		lastY,
		lastWidth,
		pointerHotState,
	};
};

