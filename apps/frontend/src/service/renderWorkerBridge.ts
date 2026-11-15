// File role: bridge between the main thread and render worker, with OffscreenCanvas main-canvas support.
import type { Command, EraseTarget, FlatPoint, Point, aabbBox } from "@collaborative-whiteboard/shared";
import { SceneBatchRing } from "../workers/sceneBatchRing";
import { applyRenderIRDelta, type RenderIRFrame } from "../scene/renderIR";
import { decodeRenderIR } from "../scene/renderIRCodec";
import type {
	InitRenderChunkCommandDictionaryEntry,
	InitRenderChunkMetaPayload,
} from "./collabDispatcherTypes";
import { labEnabled, labMark, mergeWorkerMarks, type LabMark } from "../instrumentation/labMarks";
import {
	LAB_MARK_FRAME_FIRST_PAINT,
	LAB_MARK_FRAME_RENDER_COMPLETE,
	LAB_MARK_WORKER_ACK,
	LAB_MARK_WORKER_FIRST_PAINT,
	LAB_MARK_WORKER_RENDER_COMPLETE,
} from "../instrumentation/labMarkNames";

interface RenderWorkerBridgeOptions {
	onMainPoints: (points: FlatPoint[]) => void;
	onDirtyRects?: (rects: aabbBox[]) => void;
	onSceneResyncRequired?: () => void;
	onWorkerFailure?: () => void;
}

interface FlatPointRequest {
	commands: Command[];
	pageId: number;
	transformingCmdIds: string[];
	requestId: string;
}

type MainCanvasRenderRequest = FlatPointRequest;

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

interface InitRenderBinaryChunkRequest {
	epoch: number;
	snapshotVersion: number;
	chunkIndex: number;
	isLastChunk: boolean;
	pointCount: number;
	commands: InitRenderChunkCommandDictionaryEntry[];
	lamportStart?: number;
	lamportEnd?: number;
	buffer: ArrayBuffer;
}

interface ViewportPayload {
	width: number;
	height: number;
	dpr: number;
}

export interface RenderWatermarks {
	epoch: number;
	submittedDispatchSeq: number;
	processedDispatchSeq: number;
	sceneRevision: number;
	presentedRevision: number | null;
	queue: { reliableBatches: number; oldestReliableAgeMs: number; replaceableRenderPending: boolean };
}

interface PendingIncrement {
	cmd: Command;
	pageId: number;
	points: Point[];
	source: "local" | "remote";
}

interface CommandPointsResult {
	cmdId: string;
	points: Point[];
}

const clonePoint = (point: Point): Point => ({
	x: point.x,
	y: point.y,
	p: point.p,
	lamport: point.lamport,
});

const cloneSceneOperation = (operation: Command["sceneOperation"]) =>
	operation ? JSON.parse(JSON.stringify(operation)) as NonNullable<Command["sceneOperation"]> : undefined;

const cloneCommand = (cmd: Command): Command => ({
	...cmd,
	points: cmd.points ? cmd.points.map(clonePoint) : [],
	box: { ...cmd.box },
	sceneOperation: cloneSceneOperation(cmd.sceneOperation),
});

export const cloneCommandForStateSync = (cmd: Command): Command => {
	const cloned: Command = {
		...cmd,
		box: { ...cmd.box },
		sceneOperation: cloneSceneOperation(cmd.sceneOperation),
	};
	if (cmd.points) {
		cloned.points = cmd.points.map(clonePoint);
	} else {
		delete cloned.points;
	}
	return cloned;
};

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
	let sceneBatchRing: SceneBatchRing | null = null;
	const pendingSceneBatch: { cmd: Command; epoch: number; dispatchSeq: number }[] = [];
	let sceneBatchScheduled = false;
	const flushSceneBatch = () => {
		sceneBatchScheduled = false;
		if (!worker || pendingSceneBatch.length === 0) return;
		const batch = pendingSceneBatch.splice(0);
		const encoded = new TextEncoder().encode(JSON.stringify(batch));
		if (sceneBatchRing?.write(encoded)) {
			worker.postMessage({ type: "scene-batch-ring", data: { length: encoded.length } });
		} else {
			worker.postMessage({ type: "scene-batch-transfer", data: { buffer: encoded.buffer } }, [encoded.buffer]);
		}
	};
	const postWorker = (message: unknown, transfer: Transferable[] = []) => {
		flushSceneBatch();
		worker?.postMessage(message, transfer);
	};
	let sceneEpoch = 0;
	let dispatchSeq = 0;
	let renderIRFrame: RenderIRFrame | null = null;
	let offscreenEnabled = false;
	let canvasTransferred = false;
	let pendingMainCanvasRequest: MainCanvasRenderRequest | null = null;
	let pendingMainCanvasResponseId: string | null = null;
	let pendingMainCanvasRafId: number | null = null;
	let pendingIncrementFlushScheduled = false;
	let streamedInitPoints: FlatPoint[] = [];
	const pendingRequests = new Map<string, (points: FlatPoint[]) => void>();
	const pendingInitBarriers = new Map<string, (valid: boolean) => void>();
	let initBarrierId = 0;
	const pendingCommandPointRequests = new Map<string, (result: CommandPointsResult[]) => void>();
	const pendingEraseTargetRequests = new Map<string, (result: EraseTarget[]) => void>();
	const pendingSceneHitRequests = new Map<string, (result: { elementId: string | null; bounds: aabbBox | null }) => void>();
	const pendingSceneQueryRequests = new Map<string, (result: { elementIds: string[]; bounds: aabbBox | null }) => void>();
	const pendingSceneOperationRenders = new Map<string, () => void>();
	const pendingWatermarks = new Map<string, (value: Omit<RenderWatermarks, "queue"> | null) => void>();
	const pendingRenderIR = new Map<string, (value: RenderIRFrame | null) => void>();
	const renderedSceneOperations = new Set<string>();
	const pendingIncrements: PendingIncrement[] = [];
	let pendingIncrementsSince: number | null = null;

	const settlePendingRequests = () => {
		for (const callback of pendingInitBarriers.values()) callback(false);
		for (const callback of pendingRequests.values()) callback([]);
		for (const callback of pendingCommandPointRequests.values()) callback([]);
		for (const callback of pendingEraseTargetRequests.values()) callback([]);
		for (const callback of pendingSceneHitRequests.values()) callback({ elementId: null, bounds: null });
		for (const callback of pendingSceneQueryRequests.values()) callback({ elementIds: [], bounds: null });
		for (const callback of pendingSceneOperationRenders.values()) callback();
		for (const callback of pendingWatermarks.values()) callback(null);
		for (const callback of pendingRenderIR.values()) callback(null);
		pendingInitBarriers.clear();
		pendingRequests.clear();
		pendingCommandPointRequests.clear();
		pendingEraseTargetRequests.clear();
		pendingSceneHitRequests.clear();
		pendingSceneQueryRequests.clear();
		pendingSceneOperationRenders.clear();
		pendingWatermarks.clear();
		pendingRenderIR.clear();
		renderIRFrame = null;
	};

	const cancelPendingMainCanvasRequest = () => {
		pendingMainCanvasRequest = null;
		pendingMainCanvasResponseId = null;
		if (pendingMainCanvasRafId !== null) {
			cancelAnimationFrame(pendingMainCanvasRafId);
			pendingMainCanvasRafId = null;
		}
	};

	const cancelPendingIncrementFlush = () => {
		pendingIncrements.length = 0;
		pendingIncrementsSince = null;
		pendingIncrementFlushScheduled = false;
	};

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
			postWorker({
				type: "render-full",
				data,
			});
			return;
		}

		pendingMainCanvasResponseId = payload.requestId;
		postWorker({
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
		pendingIncrementFlushScheduled = false;
		if (!worker || !offscreenEnabled || pendingIncrements.length === 0) return;

		const batch = pendingIncrements.map((entry) => ({
			cmd: cloneCommand({
				...entry.cmd,
				points: entry.points,
			}),
			points: entry.points.map(clonePoint),
			pageId: entry.pageId,
			source: entry.source,
		}));

		pendingIncrements.length = 0;
		pendingIncrementsSince = null;
		postWorker({
			type: "render-increment-batch",
			dispatchSeq: ++dispatchSeq,
			data: batch,
		});
	};

	const scheduleIncrementFlush = () => {
		if (pendingIncrementFlushScheduled) return;
		pendingIncrementFlushScheduled = true;
		queueMicrotask(() => {
			if (pendingIncrementFlushScheduled) flushIncrementalCommands();
		});
	};

	const queueIncrementalCommand = (
		cmd: Command,
		points: Point[],
		pageId: number,
		source: "local" | "remote"
	) => {
		if (!worker || !offscreenEnabled || cmd.pageId !== pageId || points.length === 0) return;
		if (pendingIncrements.length === 0) pendingIncrementsSince = performance.now();

		const existing = pendingIncrements[pendingIncrements.length - 1];
		if (existing && existing.cmd.id === cmd.id && existing.pageId === pageId && existing.source === source) {
			existing.cmd = cmd;
			existing.pageId = pageId;
			existing.source = source;
			existing.points.push(...points);
		} else {
			pendingIncrements.push({
				cmd,
				pageId,
				points: [...points],
				source,
			});
		}

		scheduleIncrementFlush();
	};

	const init = () => {
		if (worker) return true;

		try {
			worker = new Worker(new URL("../workers/canvasWorker.ts", import.meta.url), {
				type: "module",
			});
		} catch {
			return false;
		}
		const activeWorker = worker;

		if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
			sceneBatchRing = new SceneBatchRing(new SharedArrayBuffer(8 + 1024 * 1024));
			postWorker({ type: "scene-batch-ring-init", data: { buffer: sceneBatchRing.buffer } });
		}

		// Workers cannot see the harness-injected `window.__AEVIA_LAB__`; tell the
		// worker once whether lab mode is on. Message order guarantees this lands
		// before any init/render traffic.
		if (labEnabled()) {
			postWorker({ type: "lab-configure", data: { enabled: true } });
		}

		const handleWorkerFailure = () => {
			if (worker !== activeWorker) return;
			settlePendingRequests();
			options.onWorkerFailure?.();
		};
		worker.onerror = handleWorkerFailure;
		worker.onmessageerror = handleWorkerFailure;

		worker.onmessage = (event) => {
			if (worker !== activeWorker) return;
			const { type, points, rects, requestId, commands, targets, elementId, elementIds, bounds, opId } = event.data;
			if (type === "render-ir") {
				const callback = pendingRenderIR.get(requestId);
				pendingRenderIR.delete(requestId);
				if (!callback) return;
				try {
					if (event.data.epoch !== sceneEpoch || !(event.data.buffer instanceof ArrayBuffer)) throw new Error("Invalid Render IR response");
					const decoded = decodeRenderIR(new Uint8Array(event.data.buffer));
					if ("baseRevision" in decoded && !renderIRFrame) throw new Error("Missing Render IR baseline");
					renderIRFrame = "baseRevision" in decoded ? applyRenderIRDelta(renderIRFrame!, decoded) : decoded;
					callback(structuredClone(renderIRFrame));
				} catch {
					renderIRFrame = null;
					callback(null);
				}
				return;
			}
			if (type === "render-watermarks") {
				const callback = pendingWatermarks.get(requestId);
				pendingWatermarks.delete(requestId);
				if (callback) callback(event.data.epoch === sceneEpoch ? {
					epoch: sceneEpoch, submittedDispatchSeq: dispatchSeq,
					processedDispatchSeq: event.data.processedDispatchSeq,
					sceneRevision: event.data.sceneRevision, presentedRevision: event.data.presentedRevision,
				} : null);
				return;
			}
			if (type === "scene-resync-required") { options.onSceneResyncRequired?.(); return; }
			if (type === "init-scene-barrier-result") {
				const callback = pendingInitBarriers.get(requestId);
				pendingInitBarriers.delete(requestId);
				callback?.(event.data.valid === true);
				return;
			}

			if (type === "lab:marks") {
				if (labEnabled()) {
					const marks = (event.data.marks as LabMark[]) ?? [];
					// Settle worker terminal paints on the main timeline: the span end is the
					// moment the main thread learns about the paint, never a worker clock value.
					for (const mark of marks) {
						if (mark.name === LAB_MARK_WORKER_FIRST_PAINT) {
							labMark(LAB_MARK_FRAME_FIRST_PAINT, mark.detail ?? {});
						} else if (mark.name === LAB_MARK_WORKER_RENDER_COMPLETE) {
							labMark(LAB_MARK_FRAME_RENDER_COMPLETE, mark.detail ?? {});
						}
					}
					mergeWorkerMarks(marks);
				}
				return;
			}

			if (labEnabled()) {
				labMark(LAB_MARK_WORKER_ACK, {
					type: typeof type === "string" ? type : "unknown",
					opId: typeof opId === "string" ? opId : "",
				});
			}

			// Lab acknowledgements must not accumulate in business render wait state.
			if (type === "lab:operation-rendered") return;

			if (type === "scene-operation-rendered") {
				if (event.data.epoch !== sceneEpoch) return;
				const callback = typeof opId === "string" ? pendingSceneOperationRenders.get(opId) : undefined;
				if (typeof opId === "string") pendingSceneOperationRenders.delete(opId);
				if (callback) callback();
				else if (typeof opId === "string") renderedSceneOperations.add(opId);
				return;
			}

			if (type === "flat-points-result") {
				if (requestId && pendingRequests.has(requestId)) {
					const callback = pendingRequests.get(requestId);
					pendingRequests.delete(requestId);
					callback?.(points);
					return;
				}

				if (requestId && requestId === pendingMainCanvasResponseId) {
					pendingMainCanvasResponseId = null;
					options.onMainPoints(points);
				}
				return;
			}

			if (type === "merge-dirty-rects-result") {
				if (event.data.epoch !== sceneEpoch) return;
				options.onDirtyRects?.(rects ?? []);
				return;
			}

			if (type === "command-points-result") {
				if (requestId && pendingCommandPointRequests.has(requestId)) {
					const callback = pendingCommandPointRequests.get(requestId);
					pendingCommandPointRequests.delete(requestId);
					callback?.((commands as CommandPointsResult[]) ?? []);
				}
				return;
			}

			if (type === "erase-targets-result") {
				const callback = requestId ? pendingEraseTargetRequests.get(requestId) : undefined;
				if (requestId) pendingEraseTargetRequests.delete(requestId);
				callback?.((targets as EraseTarget[]) ?? []);
				return;
			}

			if (type === "scene-hit-result") {
				const callback = requestId ? pendingSceneHitRequests.get(requestId) : undefined;
				if (requestId) pendingSceneHitRequests.delete(requestId);
				callback?.({ elementId: elementId ?? null, bounds: bounds ?? null });
				return;
			}

			if (type === "scene-query-result") {
				const callback = requestId ? pendingSceneQueryRequests.get(requestId) : undefined;
				if (requestId) pendingSceneQueryRequests.delete(requestId);
				callback?.({ elementIds: Array.isArray(elementIds) ? elementIds : [], bounds: bounds ?? null });
				return;
			}

			if (type === "init-render-points-decoded") {
				if (event.data.epoch !== sceneEpoch) return;
				const decodedPoints = (event.data.points as FlatPoint[]) ?? [];
				if (decodedPoints.length === 0) return;
				streamedInitPoints.push(...decodedPoints);
				options.onMainPoints([...streamedInitPoints]);
			}
		};
		return true;
	};

	const bindMainCanvas = (canvas: HTMLCanvasElement, viewport: ViewportPayload) => {
		if (!worker || canvasTransferred || typeof canvas.transferControlToOffscreen !== "function") {
			return false;
		}

		let offscreen: OffscreenCanvas;
		try {
			offscreen = canvas.transferControlToOffscreen();
		} catch {
			return false;
		}
		postWorker(
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
		postWorker({
			type: "resize",
			data: viewport,
		});
	};

	const requestFlatPoints = (
		payload: FlatPointRequest,
		onResult?: (points: FlatPoint[]) => void
	) => {
		if (!worker) return;
		flushIncrementalCommands();
		if (onResult) {
			pendingRequests.set(payload.requestId, onResult);
		}
		postWorker({
			type: "flat-points-from-scene",
			data: {
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

	const beginInitRenderStream = (pageId?: number) => {
		flushSceneBatch();
		sceneEpoch += 1;
		renderedSceneOperations.clear();
		settlePendingRequests();
		streamedInitPoints = [];
		cancelPendingMainCanvasRequest();
		flushIncrementalCommands();
		cancelPendingIncrementFlush();
		if (!worker) return;
		postWorker({
			type: "begin-init-stream",
			data: { pageId },
		});
	};

	const appendInitRenderChunk = (points: FlatPoint[]) => {
		if (points.length === 0) return;
		if (!worker) return;

		if (offscreenEnabled) {
			postWorker({
				type: "append-init-points",
				data: {
					points,
				},
			});
			return;
		}

		streamedInitPoints.push(...points);
		options.onMainPoints([...streamedInitPoints]);
	};

	const appendInitRenderBinaryChunk = (
		meta: InitRenderChunkMetaPayload,
		buffer: ArrayBuffer
	) => {
		if (!worker) return;

		const request: InitRenderBinaryChunkRequest = {
			epoch: sceneEpoch,
			snapshotVersion: Number(meta.snapshotVersion ?? 0),
			chunkIndex: Number(meta.chunkIndex ?? 0),
			isLastChunk: meta.isLastChunk === true,
			pointCount: Number(meta.pointCount ?? 0),
			commands: Array.isArray(meta.commands) ? meta.commands : [],
			lamportStart:
				typeof meta.lamportStart === "number" ? meta.lamportStart : undefined,
			lamportEnd: typeof meta.lamportEnd === "number" ? meta.lamportEnd : undefined,
			buffer,
		};

		postWorker(
			{
				type: "append-init-binary-chunk",
				data: request,
			},
			[buffer]
		);
	};

	const finishInitRenderStream = () => {
		if (!worker) return;
		postWorker({ type: "finish-init-stream" });
	};

	const confirmInitScene = () => {
		if (!worker) return Promise.resolve(false);
		const requestId = `init-barrier-${++initBarrierId}`;
		return new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => { pendingInitBarriers.delete(requestId); resolve(false); }, 30000);
			pendingInitBarriers.set(requestId, (valid) => { clearTimeout(timeout); resolve(valid); });
			postWorker({ type: "init-scene-barrier", data: { requestId } });
		});
	};

	const syncWorkerScene = (
		commands: Command[],
		pageId: number,
		transformingCmdIds: string[] = []
	) => {
		if (!worker || !offscreenEnabled) return;
		flushSceneBatch();
		sceneEpoch += 1;
		renderedSceneOperations.clear();
		settlePendingRequests();
		cancelPendingMainCanvasRequest();
		flushIncrementalCommands();
		cancelPendingIncrementFlush();
		postWorker({
			type: "sync-scene",
			data: {
				commands: commands.map(cloneCommand),
				pageId,
				transformingCmdIds: [...transformingCmdIds],
			},
		});
	};

	const renderSceneFromFlatPoints = (points: FlatPoint[], pageId: number) => {
		flushSceneBatch();
		sceneEpoch += 1;
		renderedSceneOperations.clear();
		settlePendingRequests();
		cancelPendingMainCanvasRequest();
		flushIncrementalCommands();
		cancelPendingIncrementFlush();
		streamedInitPoints = points;
		if (!worker) return;
		if (!offscreenEnabled) {
			options.onMainPoints(streamedInitPoints);
			return;
		}
		postWorker({
			type: "render-flat-points-scene",
			data: {
				pageId,
				points: streamedInitPoints,
			},
		});
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

	const setInitSceneOperations = (commands: Command[], pageId: number) => {
		if (!worker || !offscreenEnabled) return;
		flushIncrementalCommands();
		postWorker({
			type: "set-init-scene-operations",
			data: {
				pageId,
				commands: commands
					.filter((command) => command.type === "scene-op" && command.pageId === pageId)
					.map(cloneCommand),
			},
		});
	};

	const finishCommandStroke = (cmdId: string) => {
		if (!worker || !offscreenEnabled || !cmdId) return;
		flushIncrementalCommands();
		postWorker({
			type: "finish-command-stroke",
			data: { cmdId },
		});
	};

	const renderDirtyRect = (
		rect: DirtyRectRequest,
		pageId: number,
		transformingCmdIds: string[] = []
	) => {
		if (!worker || !offscreenEnabled) return;
		flushIncrementalCommands();
		postWorker({
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
		flushIncrementalCommands();
		const data = { cmd: cloneCommandForStateSync(cmd), epoch: sceneEpoch, dispatchSeq: ++dispatchSeq };
		if (cmd.type === "scene-op" && cmd.sceneOperation?.kind === "element.append") {
			pendingSceneBatch.push(data);
			if (pendingSceneBatch.length >= 128) flushSceneBatch();
			if (!sceneBatchScheduled) {
				sceneBatchScheduled = true;
				queueMicrotask(() => { if (sceneBatchScheduled) flushSceneBatch(); });
			}
		} else postWorker({ type: "update-command-state", data });
	};

	const requestRenderWatermarks = () => new Promise<RenderWatermarks | null>((resolve) => {
		if (!worker) { resolve(null); return; }
		const queue = {
			reliableBatches: pendingIncrements.length,
			oldestReliableAgeMs: pendingIncrementsSince === null ? 0 : Math.max(0, performance.now() - pendingIncrementsSince),
			replaceableRenderPending: pendingMainCanvasRequest !== null,
		};
		flushIncrementalCommands();
		const requestId = `watermarks:${sceneEpoch}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
		const timer = setTimeout(() => { pendingWatermarks.delete(requestId); resolve(null); }, 2000);
		pendingWatermarks.set(requestId, (value) => { clearTimeout(timer); resolve(value ? { ...value, queue } : null); });
		postWorker({ type: "get-render-watermarks", data: { requestId, epoch: sceneEpoch } });
	});

	const requestRenderIR = () => new Promise<RenderIRFrame | null>((resolve) => {
		if (!worker || !offscreenEnabled) { resolve(null); return; }
		flushIncrementalCommands();
		const requestId = `render-ir:${sceneEpoch}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
		const timer = setTimeout(() => { pendingRenderIR.delete(requestId); renderIRFrame = null; resolve(null); }, 2000);
		pendingRenderIR.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
		postWorker({ type: "get-render-ir", data: { requestId, epoch: sceneEpoch, baseRevision: renderIRFrame?.revision ?? null } });
	});

	const waitForSceneOperationRender = (opId: string, timeoutMs = 800) => new Promise<void>((resolve) => {
		if (!worker || !offscreenEnabled || renderedSceneOperations.delete(opId)) {
			resolve();
			return;
		}
		const timer = window.setTimeout(() => {
			pendingSceneOperationRenders.delete(opId);
			resolve();
		}, timeoutMs);
		pendingSceneOperationRenders.set(opId, () => {
			window.clearTimeout(timer);
			resolve();
		});
	});

	const renderDirtyRects = (
		rects: DirtyRectRequest[],
		pageId: number,
		transformingCmdIds: string[] = []
	) => {
		if (!worker || !offscreenEnabled || rects.length === 0) return;
		flushIncrementalCommands();
		postWorker({
			type: "render-dirty-regions",
			data: {
				rects: rects.map(cloneRect),
				pageId,
				transformingCmdIds: [...transformingCmdIds],
			},
		});
	};

	const requestCommandPoints = (cmdIds: string[]) =>
		new Promise<CommandPointsResult[]>((resolve) => {
			if (!worker || cmdIds.length === 0) {
				resolve([]);
				return;
			}
			flushIncrementalCommands();
			const requestId = `command-points:${Date.now()}:${Math.random().toString(16).slice(2)}`;
			pendingCommandPointRequests.set(requestId, resolve);
			postWorker({
				type: "get-command-points",
				data: {
					requestId,
					cmdIds: [...cmdIds],
				},
			});
		});

	const requestEraseTargets = (payload: {
		points: Point[];
		size: number;
		wholeObjects: boolean;
		pageId: number;
		width: number;
		height: number;
		commands?: Command[];
	}) => new Promise<EraseTarget[]>((resolve) => {
		if (!worker || payload.points.length === 0) {
			resolve([]);
			return;
		}
		flushIncrementalCommands();
		const requestId = `erase-targets:${Date.now()}:${Math.random().toString(16).slice(2)}`;
		pendingEraseTargetRequests.set(requestId, resolve);
		postWorker({
			type: "compute-erase-targets",
			data: {
				...payload,
				commands: payload.commands?.map(cloneCommand),
				requestId,
			},
		});
	});

	const requestSceneHit = (x: number, y: number) =>
		new Promise<{ elementId: string | null; bounds: aabbBox | null }>((resolve) => {
			if (!worker || !offscreenEnabled) {
				resolve({ elementId: null, bounds: null });
				return;
			}
			flushIncrementalCommands();
			const requestId = `scene-hit:${Date.now()}:${Math.random().toString(16).slice(2)}`;
			pendingSceneHitRequests.set(requestId, resolve);
			postWorker({ type: "scene-hit-test", data: { x, y, requestId } });
		});

	const requestSceneQuery = (rect: aabbBox) =>
		new Promise<{ elementIds: string[]; bounds: aabbBox | null }>((resolve) => {
			if (!worker || !offscreenEnabled) {
				resolve({ elementIds: [], bounds: null });
				return;
			}
			flushIncrementalCommands();
			const requestId = `scene-query:${Date.now()}:${Math.random().toString(16).slice(2)}`;
			pendingSceneQueryRequests.set(requestId, resolve);
			postWorker({ type: "scene-query-elements", data: { rect: cloneRect(rect), requestId } });
		});

	const removeCommandState = (cmdId: string) => {
		if (!worker || !offscreenEnabled) return;
		flushIncrementalCommands();
		postWorker({
			type: "remove-command-state",
			data: { cmdId },
		});
	};

	const rerenderScene = (pageId: number, transformingCmdIds: string[] = []) => {
		if (!worker || !offscreenEnabled) return;
		flushIncrementalCommands();
		postWorker({
			type: "rerender-scene",
			data: {
				pageId,
				transformingCmdIds: [...transformingCmdIds],
			},
		});
	};

	const requestMergeDirtyRects = (payload: MergeDirtyRectsRequest) => {
		if (!worker) return;
		postWorker({
			type: "merge-dirty-rects",
			data: {
				rects: payload.rects.map(cloneRect),
				epoch: sceneEpoch,
			},
		});
	};

	const dispose = () => {
		flushSceneBatch();
		sceneEpoch += 1;
		settlePendingRequests();
		renderedSceneOperations.clear();
		cancelPendingMainCanvasRequest();
		cancelPendingIncrementFlush();
		worker?.postMessage({ type: "dispose" });
		worker?.terminate();
		worker = null;
		sceneBatchRing = null;
		pendingSceneBatch.length = 0;
		sceneBatchScheduled = false;
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
		requestCommandPoints,
		requestEraseTargets,
		requestSceneHit,
		requestSceneQuery,
		requestMergeDirtyRects,
		renderMainCanvas,
		beginInitRenderStream,
		appendInitRenderChunk,
		appendInitRenderBinaryChunk,
		finishInitRenderStream,
		confirmInitScene,
		setInitSceneOperations,
		syncWorkerScene,
		renderSceneFromFlatPoints,
		renderIncrementalCommand,
		renderSinglePointCommand,
		finishCommandStroke,
		renderDirtyRect,
		renderDirtyRects,
		syncCommandState,
		requestRenderWatermarks,
		requestRenderIR,
		waitForSceneOperationRender,
		removeCommandState,
		rerenderScene,
	};
};
