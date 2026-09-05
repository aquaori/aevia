// File role: batches dirty-rect redraw requests to keep incremental rendering stable.
import { reRenderDirtyRect } from "../utils/dirtyRedraw";

interface DirtyRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
	candidateCommandIds?: string[];
}

export const createDirtyRenderQueue = (
	renderer: (rect: DirtyRect) => void = (rect) => {
		reRenderDirtyRect(
			rect,
			// caller can override renderer to avoid these placeholders
			undefined as never,
			undefined as never
		);
	},
	renderFull: () => void = () => undefined,
	renderBatch?: (rects: DirtyRect[]) => void
) => {
	let pendingDirtyRects: DirtyRect[] = [];
	let fullRenderPending = false;
	let dirtyRafId: number | null = null;

	const enqueue = (rect: DirtyRect) => {
		let next = { ...rect };
		for (let index = pendingDirtyRects.length - 1; index >= 0; index -= 1) {
			const pending = pendingDirtyRects[index]!;
			if (next.maxX < pending.minX || next.minX > pending.maxX || next.maxY < pending.minY || next.minY > pending.maxY) continue;
			pendingDirtyRects.splice(index, 1);
			const newMinX = Math.min(pending.minX, next.minX);
			const newMinY = Math.min(pending.minY, next.minY);
			const newMaxX = Math.max(
				pending.maxX,
				next.maxX
			);
			const newMaxY = Math.max(
				pending.maxY,
				next.maxY
			);
			next = {
				minX: newMinX,
				minY: newMinY,
				maxX: newMaxX,
				maxY: newMaxY,
				width: newMaxX - newMinX,
				height: newMaxY - newMinY,
				candidateCommandIds: Array.from(
					new Set([
						...(pending.candidateCommandIds ?? []),
						...(next.candidateCommandIds ?? []),
					])
				),
			};
		}
		pendingDirtyRects.push(next);
		if (pendingDirtyRects.length > 8) fullRenderPending = true;

		if (!dirtyRafId) {
			dirtyRafId = requestAnimationFrame(() => {
				if (fullRenderPending) renderFull();
				else if (renderBatch) renderBatch(pendingDirtyRects.map((pending) => ({ ...pending })));
				else pendingDirtyRects.forEach((pending) => renderer(pending));
				pendingDirtyRects = [];
				fullRenderPending = false;
				dirtyRafId = null;
			});
		}
	};

	const dispose = () => {
		if (dirtyRafId) {
			cancelAnimationFrame(dirtyRafId);
			dirtyRafId = null;
		}
		pendingDirtyRects = [];
		fullRenderPending = false;
	};

	return {
		enqueue,
		dispose,
	};
};

