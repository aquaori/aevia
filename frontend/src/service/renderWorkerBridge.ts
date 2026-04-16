// File role: bridge between the main thread and render worker, with OffscreenCanvas main-canvas support.
import {
	recordWorkerFullRender,
	recordWorkerIncrementalRender,
} from "../instrumentation/runtimeInstrumentation";
import type { Command, FlatPoint, Point } from "../utils/type";

interface RenderWorkerBridgeOptions {
	onMainPoints: (points: FlatPoint[]) => void;
	onDirtyRects?: (rects: any[]) => void;
}

interface FlatPointRequest {
	commands: Command[];
	pageId: number;
	transformingCmdIds: string[];
	requestId: string;
}

interface MainCanvasRenderRequest extends FlatPointRequest {}

interface DirtyRectRequest {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width?: number;
	height?: number;
	candidateCommandIds?: string[];
}

interface MergeDirtyRectsRequest {
	rects: DirtyRectRequest[];
}

interface ViewportPayload {
	width: number;
	height: number;
	dpr: number;
}

interface PendingIncrement {
	cmd: Command;
	pageId: number;
	points: Point[];
	source: "local" | "remote";
}

const clonePoint = (point: Point): Point => ({
	x: point.x,
	y: point.y,
	p: point.p,
	lamport: point.lamport,
});

const cloneCommand = (cmd: Command): Command => ({
	...cmd,
	points: cmd.points ? cmd.points.map(clonePoint) : [],
	box: { ...cmd.box },
});

const cloneRect = (rect: DirtyRectRequest): DirtyRectRequest => ({
	minX: rect.minX,
	minY: rect.minY,
	maxX: rect.maxX,
	maxY: rect.maxY,
	width: rect.width ?? rect.maxX - rect.minX,
	height: rect.height ?? rect.maxY - rect.minY,
	candidateCommandIds: rect.candidateCommandIds ? [...rect.candidateCommandIds] : undefined,
});

export const createRenderWorkerBridge = (options: RenderWorkerBridgeOptions) => {
	let worker: Worker | null = null;
	let offscreenEnabled = false;
	let canvasTransferred = false;
	let pendingMainCanvasRequest: MainCanvasRenderRequest | null = null;
	let pendingMainCanvasRafId: number | null = null;
	let pendingIncrementFlushRafId: number | null = null;
	const pendingRequests = new Map<string, (points: FlatPoint[]) => void>();
	const pendingIncrements = new Map<string, PendingIncrement>();

	const flushMainCanvasRequest = () => {
		pendingMainCanvasRafId = null;
		if (!worker || !pendingMainCanvasRequest) return;

		const payload = pendingMainCanvasRequest;
		pendingMainCanvasRequest = null;
		const data = {
			commands: payload.commands.map(cloneCommand),
			pageId: payload.pageId,
			transformingCmdIds: [...payload.transformingCmdIds],
			requestId: payload.requestId,
		};

		if (offscreenEnabled) {
			worker.postMessage({
				type: "render-full",
				data,
			});
			return;
		}

		worker.postMessage({
			type: "flat-points",
			data,
		});
	};

	const scheduleMainCanvasRequest = (payload: MainCanvasRenderRequest) => {
		pendingMainCanvasRequest = payload;
		if (pendingMainCanvasRafId !== null) return;
		pendingMainCanvasRafId = requestAnimationFrame(flushMainCanvasRequest);
	};

	const flushIncrementalCommands = () => {
		pendingIncrementFlushRafId = null;
		if (!worker || !offscreenEnabled || pendingIncrements.size === 0) return;

		const batch = Array.from(pendingIncrements.values()).map((entry) => ({
			cmd: cloneCommand({
				...entry.cmd,
				points: entry.points,
			}),
			points: entry.points.map(clonePoint),
			pageId: entry.pageId,
			source: entry.source,
		}));

		pendingIncrements.clear();
		worker.postMessage({
			type: "render-increment-batch",
			data: batch,
		});
	};

	const scheduleIncrementFlush = () => {
		if (pendingIncrementFlushRafId !== null) return;
		pendingIncrementFlushRafId = requestAnimationFrame(flushIncrementalCommands);
	};

	const queueIncrementalCommand = (
		cmd: Command,
		points: Point[],
		pageId: number,
		source: "local" | "remote"
	) => {
		if (!worker || !offscreenEnabled || cmd.pageId !== pageId || points.length === 0) return;

		const existing = pendingIncrements.get(cmd.id);
		if (existing) {
			existing.cmd = cmd;
			existing.pageId = pageId;
			existing.source = source;
			existing.points.push(...points);
		} else {
			pendingIncrements.set(cmd.id, {
				cmd,
				pageId,
				points: [...points],
				source,
			});
		}

		scheduleIncrementFlush();
	};

	const init = () => {
		if (worker) return;

		worker = new Worker(new URL("../workers/canvasWorker.ts", import.meta.url), {
			type: "module",
		});

		worker.onmessage = (event) => {
			const { type, points, rects, requestId, durationMs, commandId, source } = event.data;

			if (type === "flat-points-result") {
				if (requestId && pendingRequests.has(requestId)) {
					const callback = pendingRequests.get(requestId);
					pendingRequests.delete(requestId);
					callback?.(points);
					return;
				}

				options.onMainPoints(points);
				return;
			}

			if (type === "merge-dirty-rects-result") {
				options.onDirtyRects?.(rects ?? []);
				return;
			}

			if (type === "benchmark-render-full-complete") {
				recordWorkerFullRender(Number(points || 0), Number(durationMs || 0));
				return;
			}

			if (type === "benchmark-incremental-complete") {
				recordWorkerIncrementalRender(
					commandId,
					Number(points || 0),
					source === "local" ? "local" : "remote",
					Number(durationMs || 0)
				);
			}
		};
	};

	const bindMainCanvas = (canvas: HTMLCanvasElement, viewport: ViewportPayload) => {
		if (!worker || canvasTransferred || typeof canvas.transferControlToOffscreen !== "function") {
			return false;
		}

		const offscreen = canvas.transferControlToOffscreen();
		worker.postMessage(
			{
				type: "init-canvas",
				data: {
					canvas: offscreen,
					...viewport,
				},
			},
			[offscreen]
		);
		canvasTransferred = true;
		offscreenEnabled = true;
		return true;
	};

	const syncViewport = (viewport: ViewportPayload) => {
		if (!worker || !offscreenEnabled) return;
		worker.postMessage({
			type: "resize",
			data: viewport,
		});
	};

	const requestFlatPoints = (
		payload: FlatPointRequest,
		onResult?: (points: FlatPoint[]) => void
	) => {
		if (!worker) return;
		if (onResult) {
			pendingRequests.set(payload.requestId, onResult);
		}
		worker.postMessage({
			type: "flat-points",
			data: {
				commands: payload.commands.map(cloneCommand),
				pageId: payload.pageId,
				transformingCmdIds: [...payload.transformingCmdIds],
				requestId: payload.requestId,
			},
		});
	};

	const renderMainCanvas = (payload: MainCanvasRenderRequest) => {
		if (!worker) return;
		scheduleMainCanvasRequest(payload);
	};

	const renderIncrementalCommand = (
		cmd: Command,
		points: Point[],
		pageId: number,
		source: "local" | "remote" = "remote"
	) => {
		queueIncrementalCommand(cmd, points, pageId, source);
	};

	const renderSinglePointCommand = (
		cmd: Command,
		pageId: number,
		source: "local" | "remote" = "remote"
	) => {
		const point = cmd.points?.[0];
		if (!point) return;
		queueIncrementalCommand(cmd, [point], pageId, source);
	};

	const renderDirtyRect = (
		rect: DirtyRectRequest,
		pageId: number,
		transformingCmdIds: string[] = []
	) => {
		if (!worker || !offscreenEnabled) return;
		worker.postMessage({
			type: "render-dirty",
			data: {
				rect: cloneRect(rect),
				pageId,
				transformingCmdIds: [...transformingCmdIds],
			},
		});
	};

	const syncCommandState = (cmd: Command) => {
		if (!worker || !offscreenEnabled) return;
		worker.postMessage({
			type: "update-command-state",
			data: {
				cmd: cloneCommand(cmd),
			},
		});
	};

	const rerenderScene = (pageId: number, transformingCmdIds: string[] = []) => {
		if (!worker || !offscreenEnabled) return;
		worker.postMessage({
			type: "rerender-scene",
			data: {
				pageId,
				transformingCmdIds: [...transformingCmdIds],
			},
		});
	};

	const requestMergeDirtyRects = (payload: MergeDirtyRectsRequest) => {
		if (!worker) return;
		worker.postMessage({
			type: "merge-dirty-rects",
			data: {
				rects: payload.rects.map(cloneRect),
			},
		});
	};

	const dispose = () => {
		pendingRequests.clear();
		pendingIncrements.clear();
		pendingMainCanvasRequest = null;
		if (pendingMainCanvasRafId !== null) {
			cancelAnimationFrame(pendingMainCanvasRafId);
			pendingMainCanvasRafId = null;
		}
		if (pendingIncrementFlushRafId !== null) {
			cancelAnimationFrame(pendingIncrementFlushRafId);
			pendingIncrementFlushRafId = null;
		}
		worker?.postMessage({ type: "dispose" });
		worker?.terminate();
		worker = null;
		offscreenEnabled = false;
		canvasTransferred = false;
	};

	return {
		init,
		dispose,
		bindMainCanvas,
		syncViewport,
		isOffscreenEnabled: () => offscreenEnabled,
		requestFlatPoints,
		requestMergeDirtyRects,
		renderMainCanvas,
		renderIncrementalCommand,
		renderSinglePointCommand,
		renderDirtyRect,
		syncCommandState,
		rerenderScene,
	};
};
