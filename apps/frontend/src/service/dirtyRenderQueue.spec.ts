import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirtyRenderQueue } from "./dirtyRenderQueue";

describe("dirty render queue", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("merges dirty rects before the next frame", () => {
		let frame: FrameRequestCallback | undefined;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frame = callback;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const renderer = vi.fn();
		const queue = createDirtyRenderQueue(renderer);

		queue.enqueue({ minX: 10, minY: 10, maxX: 20, maxY: 20, width: 10, height: 10, candidateCommandIds: ["a"] });
		queue.enqueue({ minX: 5, minY: 12, maxX: 13, maxY: 20, width: 8, height: 8, candidateCommandIds: ["b", "a"] });
		expect(frame).toEqual(expect.any(Function));
		frame!(performance.now());

		expect(renderer).toHaveBeenCalledWith({
			minX: 5,
			minY: 10,
			maxX: 20,
			maxY: 20,
			width: 15,
			height: 10,
			candidateCommandIds: ["a", "b"],
		});
	});

	it("cancels pending work on dispose", () => {
		vi.stubGlobal("requestAnimationFrame", () => 7);
		const cancelAnimationFrame = vi.fn();
		vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

		const queue = createDirtyRenderQueue(vi.fn());
		queue.enqueue({ minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 });
		queue.dispose();

		expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
	});

	it("keeps disjoint dirty rects separate", () => {
		let frame: FrameRequestCallback | undefined;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frame = callback;
			return 1;
		});
		const renderer = vi.fn();
		const queue = createDirtyRenderQueue(renderer);

		queue.enqueue({ minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 });
		queue.enqueue({ minX: 90, minY: 90, maxX: 100, maxY: 100, width: 10, height: 10 });
		frame!(performance.now());

		expect(renderer).toHaveBeenCalledTimes(2);
	});

	it("falls back to a full render when more than eight regions accumulate", () => {
		let frame: FrameRequestCallback | undefined;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frame = callback;
			return 1;
		});
		const renderer = vi.fn();
		const renderFull = vi.fn();
		const queue = createDirtyRenderQueue(renderer, renderFull);

		for (let index = 0; index < 9; index += 1) {
			const minX = index * 20;
			queue.enqueue({ minX, minY: 0, maxX: minX + 10, maxY: 10, width: 10, height: 10 });
		}
		frame!(performance.now());

		expect(renderFull).toHaveBeenCalledOnce();
		expect(renderer).not.toHaveBeenCalled();
	});
});
