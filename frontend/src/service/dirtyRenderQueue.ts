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
	}
) => {
	let pendingDirtyRect: DirtyRect | null = null;
	let dirtyRafId: number | null = null;

	const enqueue = (rect: DirtyRect) => {
		if (!pendingDirtyRect) {
			pendingDirtyRect = { ...rect };
		} else {
			const newMinX = Math.min(pendingDirtyRect.minX, rect.minX);
			const newMinY = Math.min(pendingDirtyRect.minY, rect.minY);
			const newMaxX = Math.max(
				pendingDirtyRect.minX + pendingDirtyRect.width,
				rect.minX + rect.width
			);
			const newMaxY = Math.max(
				pendingDirtyRect.minY + pendingDirtyRect.height,
				rect.minY + rect.height
			);
			pendingDirtyRect = {
				minX: newMinX,
				minY: newMinY,
				maxX: newMaxX,
				maxY: newMaxY,
				width: newMaxX - newMinX,
				height: newMaxY - newMinY,
				candidateCommandIds: Array.from(
					new Set([
						...(pendingDirtyRect.candidateCommandIds ?? []),
						...(rect.candidateCommandIds ?? []),
					])
				),
			};
		}

		if (!dirtyRafId) {
			dirtyRafId = requestAnimationFrame(() => {
				if (pendingDirtyRect) {
					renderer(pendingDirtyRect);
				}
				pendingDirtyRect = null;
				dirtyRafId = null;
			});
		}
	};

	const dispose = () => {
		if (dirtyRafId) {
			cancelAnimationFrame(dirtyRafId);
			dirtyRafId = null;
		}
		pendingDirtyRect = null;
	};

	return {
		enqueue,
		dispose,
	};
};

