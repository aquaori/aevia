import { describe, expect, it, vi } from "vitest";
import { renderClippedPointSequence } from "../service/canvas";
import { reRenderDirtyRect } from "./dirtyRedraw";

vi.mock("../service/canvas", () => ({
	renderClippedPointSequence: vi.fn(),
}));

describe("reRenderDirtyRect", () => {
	it("ignores missing inputs and forwards cloned dirty rects scaled by dpr", () => {
		const ctx = {} as CanvasRenderingContext2D;
		const canvas = { width: 400, height: 200 } as HTMLCanvasElement;

		reRenderDirtyRect(undefined as never, ctx, canvas);
		expect(renderClippedPointSequence).not.toHaveBeenCalled();

		Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
		const transforming = new Set(["cmd-1"]);
		const rect = {
			minX: 10,
			minY: 20,
			maxX: 60,
			maxY: 60,
			width: 50,
			height: 40,
			candidateCommandIds: ["c1"],
		};
		reRenderDirtyRect(rect, ctx, canvas, transforming);

		expect(renderClippedPointSequence).toHaveBeenCalledWith(
			ctx,
			200,
			100,
			{
				minX: 10,
				minY: 20,
				width: 50,
				height: 40,
				candidateCommandIds: ["c1"],
			},
			transforming,
		);
	});
});
