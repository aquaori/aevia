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
});
