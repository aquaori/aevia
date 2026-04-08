// File role: main canvas runtime for resize, dirty renders, and render scheduling.
import { reRenderDirtyRect } from "../utils/dirtyRedraw";
import { canvasRef, ctx, uiCanvasRef, uiCtx } from "./canvas";
import { createDirtyRenderQueue } from "./dirtyRenderQueue";
import { onDirtyPointAdded } from "./dirtyPointBus";
import type { QueuePoint } from "../utils/type";

interface DirtyRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

interface CanvasRuntimeOptions {
	requestRender: () => void;
	syncToolState: () => void;
	requestMergeDirtyRects: (payload: {
		rects: Array<{ minX: number; minY: number; maxX: number; maxY: number }>;
	}) => void;
}

export const createCanvasRuntime = (options: CanvasRuntimeOptions) => {
	const dirtyRenderQueue = createDirtyRenderQueue((rect) => {
		if (!ctx.value || !canvasRef.value) return;
		reRenderDirtyRect(rect, ctx.value, canvasRef.value);
	});

	let dirtyPointBuffer: QueuePoint[] = [];
	let dirtyBufferTimer: number | null = null;
	const unsubscribeDirtyPoints = onDirtyPointAdded((point) => {
		dirtyPointBuffer.push(point);
		if (dirtyBufferTimer) return;
		dirtyBufferTimer = window.setTimeout(() => {
			processDirtyPointBuffer();
			dirtyBufferTimer = null;
		}, 16);
	});

	const resize = () => {
		if (!canvasRef.value || !ctx.value) return;

		const dpr = window.devicePixelRatio || 1;
		const width = window.innerWidth;
		const height = window.innerHeight;

		canvasRef.value.width = width * dpr;
		canvasRef.value.height = height * dpr;
		canvasRef.value.style.width = width + "px";
		canvasRef.value.style.height = height + "px";

		if (uiCanvasRef.value) {
			uiCanvasRef.value.width = width * dpr;
			uiCanvasRef.value.height = height * dpr;
			uiCanvasRef.value.style.width = width + "px";
			uiCanvasRef.value.style.height = height + "px";
		}

		ctx.value.setTransform(1, 0, 0, 1, 0, 0);
		ctx.value.scale(dpr, dpr);
		ctx.value.lineCap = "round";
		ctx.value.lineJoin = "round";

		if (uiCtx.value) {
			uiCtx.value.setTransform(1, 0, 0, 1, 0, 0);
			uiCtx.value.scale(dpr, dpr);
		}

		options.requestRender();
		options.syncToolState();
	};

	const requestDirtyRender = (rect: unknown) => {
		dirtyRenderQueue.enqueue(rect as DirtyRect);
	};

	const eraseDirtyRect = (rect: DirtyRect, transformingCmdIds?: Set<string>) => {
		if (!ctx.value || !canvasRef.value) return;
		reRenderDirtyRect(rect, ctx.value, canvasRef.value, transformingCmdIds);
	};

	const handleMergedDirtyRects = (rects: DirtyRect[]) => {
		rects.forEach((rect) => dirtyRenderQueue.enqueue(rect));
	};

	const processDirtyPointBuffer = () => {
		if (dirtyPointBuffer.length === 0) return;

		const rects = dirtyPointBuffer.map((point) => {
			const maxThickness = Math.max(point.size, point.lastWidth || point.size);
			const padding = maxThickness / 2;
			const minX = Math.min(point.lastX || point.x, point.x);
			const maxX = Math.max(point.lastX || point.x, point.x);
			const minY = Math.min(point.lastY || point.y, point.y);
			const maxY = Math.max(point.lastY || point.y, point.y);

			return {
				minX: minX - padding,
				minY: minY - padding,
				maxX: maxX + padding,
				maxY: maxY + padding,
			};
		});

		options.requestMergeDirtyRects({ rects });
		dirtyPointBuffer = [];
	};

	const dispose = () => {
		if (dirtyBufferTimer) {
			clearTimeout(dirtyBufferTimer);
			dirtyBufferTimer = null;
		}
		dirtyPointBuffer = [];
		unsubscribeDirtyPoints();
		dirtyRenderQueue.dispose();
	};

	return {
		resize,
		requestDirtyRender,
		handleMergedDirtyRects,
		eraseDirtyRect,
		dispose,
	};
};

