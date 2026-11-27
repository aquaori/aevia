import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitDirtyPointAdded } from "./dirtyPointBus";
import { canvasRef, ctx, uiCanvasRef, uiCtx } from "./canvas";
import { reRenderDirtyRect } from "../utils/dirtyRedraw";
import { createCanvasRuntime } from "./canvasRuntime";

vi.mock("../utils/dirtyRedraw", () => ({
	reRenderDirtyRect: vi.fn(),
}));

describe("createCanvasRuntime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		canvasRef.value = { style: {}, width: 0, height: 0 } as HTMLCanvasElement;
		uiCanvasRef.value = { style: {}, width: 0, height: 0 } as HTMLCanvasElement;
		ctx.value = { setTransform: vi.fn(), scale: vi.fn(), lineCap: "", lineJoin: "" } as unknown as CanvasRenderingContext2D;
		uiCtx.value = { setTransform: vi.fn(), scale: vi.fn() } as unknown as CanvasRenderingContext2D;
	});

	afterEach(() => {
		vi.useRealTimers();
		canvasRef.value = null;
		uiCanvasRef.value = null;
		ctx.value = null;
		uiCtx.value = null;
	});

	it("resizes canvases, batches dirty points into merge requests, and routes dirty renders for both modes", () => {
		let offscreen = false;
		const options = {
			requestRender: vi.fn(),
			requestWorkerDirtyRender: vi.fn(),
			requestWorkerDirtyRenderBatch: vi.fn(),
			syncToolState: vi.fn(),
			isOffscreenEnabled: () => offscreen,
			hasRenderableScene: () => true,
			syncMainCanvasViewport: vi.fn(),
			requestMergeDirtyRects: vi.fn(),
		};

		const runtime = createCanvasRuntime(options);
		runtime.resize();
		expect(options.syncMainCanvasViewport).toHaveBeenCalled();
		expect(options.requestRender).toHaveBeenCalled();
		expect(options.syncToolState).toHaveBeenCalled();

		// Dirty point bus aggregation
		emitDirtyPointAdded({
			cmdId: "c1",
			x: 10,
			y: 20,
			lastX: 5,
			lastY: 15,
			size: 4,
			lastWidth: 6,
			tool: "pen",
			color: "#000",
			p: 0.5,
			pageId: 0,
			userId: "u1",
		});
		vi.advanceTimersByTime(20);
		expect(options.requestMergeDirtyRects).toHaveBeenCalledTimes(1);

		const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 };
		runtime.eraseDirtyRect(rect, new Set(["c1"]));
		expect(reRenderDirtyRect).toHaveBeenCalled();

		runtime.handleMergedDirtyRects([rect]);
		vi.advanceTimersByTime(32);

		offscreen = true;
		runtime.eraseDirtyRect(rect, new Set(["c2"]));
		expect(options.requestWorkerDirtyRender).toHaveBeenCalled();
		runtime.requestDirtyRender(rect);
		vi.advanceTimersByTime(32);

		runtime.dispose();
	});
});
