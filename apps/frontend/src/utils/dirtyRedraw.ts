// File role: utility helpers for dirty-rect based redraw calculations.
import { useCommandStore } from "../store/commandStore";
import { renderClippedPointSequence } from "../service/canvas";
import {
	recordDirtyRedrawEnd,
	recordDirtyRedrawStart,
} from "../instrumentation/runtimeInstrumentation";

const reRenderDirtyRect = (
	dirtyRect: any,
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
	const dirtyStart = recordDirtyRedrawStart(dirtyRectSnapshot);
	const dpr = window.devicePixelRatio || 1;
	const canvasW = canvasRef.width / dpr;
	const canvasH = canvasRef.height / dpr;
	const pointCount = renderClippedPointSequence(
		ctx,
		canvasW,
		canvasH,
		useCommandStore().lastSortedPoints,
		dirtyRectSnapshot,
		transformingCmdIds
	);

	recordDirtyRedrawEnd(dirtyRectSnapshot, performance.now() - dirtyStart, pointCount);
};

export { reRenderDirtyRect };
