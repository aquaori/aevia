// File role: utility helpers for dirty-rect based redraw calculations.
import { useCommandStore } from "../store/commandStore";
import { renderClippedPointSequence } from "../service/canvas";
import type { aabbBox } from "./type";

type DirtyRect = aabbBox & {
	candidateCommandIds?: string[];
};

const reRenderDirtyRect = (
	dirtyRect: DirtyRect,
	ctx: CanvasRenderingContext2D,
	canvasRef: HTMLCanvasElement,
	transformingCmdIds?: Set<string>
) => {
	if (!ctx || !canvasRef || !dirtyRect || typeof dirtyRect.minX === "undefined") {
		return;
	}

	const dirtyRectSnapshot = {
		minX: dirtyRect.minX,
		minY: dirtyRect.minY,
		width: dirtyRect.width,
		height: dirtyRect.height,
		candidateCommandIds: Array.isArray(dirtyRect.candidateCommandIds)
			? [...dirtyRect.candidateCommandIds]
			: undefined,
	};
	const dpr = window.devicePixelRatio || 1;
	const canvasW = canvasRef.width / dpr;
	const canvasH = canvasRef.height / dpr;
	renderClippedPointSequence(
		ctx,
		canvasW,
		canvasH,
		useCommandStore().lastSortedPoints,
		dirtyRectSnapshot,
		transformingCmdIds
	);
};

export { reRenderDirtyRect };
