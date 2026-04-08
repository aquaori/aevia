// File role: request-response bridge between the main thread and canvas worker.
import type { Command, FlatPoint } from "../utils/type";

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

interface MergeDirtyRectsRequest {
	rects: Array<{
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	}>;
}

export const createRenderWorkerBridge = (options: RenderWorkerBridgeOptions) => {
	let worker: Worker | null = null;
	const pendingRequests = new Map<string, (points: FlatPoint[]) => void>();

	const init = () => {
		if (worker) return;

		worker = new Worker(new URL("../workers/canvasWorker.ts", import.meta.url), {
			type: "module",
		});

		worker.onmessage = (event) => {
			const { type, points, rects, requestId } = event.data;

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
			}
		};
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
			data: JSON.parse(JSON.stringify(payload)),
		});
	};

	const requestMergeDirtyRects = (payload: MergeDirtyRectsRequest) => {
		if (!worker) return;
		worker.postMessage({
			type: "merge-dirty-rects",
			data: JSON.parse(JSON.stringify(payload)),
		});
	};

	const dispose = () => {
		pendingRequests.clear();
		worker?.terminate();
		worker = null;
	};

	return {
		init,
		dispose,
		requestFlatPoints,
		requestMergeDirtyRects,
	};
};

