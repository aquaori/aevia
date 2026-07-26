import { beforeAll, describe, expect, it } from "vitest";
import { createStrokeBatch, resolveStrokeStyle } from "./strokeRasterizer";

// happy-dom has no Path2D; the batch only accumulates into it, so a recorder
// stub is enough to exercise the bookkeeping under test.
beforeAll(() => {
	if (typeof globalThis.Path2D === "undefined") {
		(globalThis as { Path2D?: unknown }).Path2D = class {
			ops = 0;
			moveTo() {
				this.ops += 1;
			}
			quadraticCurveTo() {
				this.ops += 1;
			}
			arc() {
				this.ops += 1;
			}
		};
	}
});

// Minimal 2D-context stand-in: records the calls the batch makes.
const fakeCtx = () => {
	const calls: string[] = [];
	const ctx = {
		globalCompositeOperation: "",
		strokeStyle: "",
		fillStyle: "",
		lineCap: "",
		lineJoin: "",
		lineWidth: 0,
		fill: () => calls.push("fill"),
		stroke: () => calls.push(`stroke:${ctx.lineWidth}`),
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
};

const pen = resolveStrokeStyle("pen", "#000000");
const red = resolveStrokeStyle("pen", "#ef4444");
const eraser = resolveStrokeStyle("eraser");

describe("createStrokeBatch", () => {
	it("collapses many same-style segments into one draw call per width", () => {
		const { ctx, calls } = fakeCtx();
		const batch = createStrokeBatch(ctx);
		for (let i = 0; i < 500; i += 1) {
			expect(batch.addSegment(pen, 3, i, 0, i + 0.5, 1, i + 1, 0)).toBe(true);
		}
		expect(calls).toHaveLength(0); // nothing drawn until flushed
		batch.flush();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/^stroke:/);
		expect(batch.stats().drawCalls).toBe(1);
	});

	it("keeps widths within half a percent of the requested value", () => {
		const { ctx, calls } = fakeCtx();
		const batch = createStrokeBatch(ctx);
		const widths = [0.5, 0.61, 1.0, 2.37, 3.0, 4.19, 6.0, 12.0];
		for (const width of widths) batch.addSegment(pen, width, 0, 0, 1, 1, 2, 2);
		batch.flush();

		const drawn = calls.map((call) => Number(call.split(":")[1])).sort((a, b) => a - b);
		const requested = [...widths].sort((a, b) => a - b);
		expect(drawn).toHaveLength(requested.length);
		requested.forEach((want, index) => {
			const got = drawn[index]!;
			expect(Math.abs(got - want) / want).toBeLessThan(0.006);
		});
	});

	it("flushes on style change so cross-style paint order is preserved", () => {
		const { ctx, calls } = fakeCtx();
		const batch = createStrokeBatch(ctx);
		batch.addSegment(pen, 3, 0, 0, 1, 1, 2, 2);
		batch.addSegment(red, 3, 0, 0, 1, 1, 2, 2);
		// The black segment must already be on the canvas before red is buffered.
		expect(calls).toHaveLength(1);
		batch.addSegment(eraser, 3, 0, 0, 1, 1, 2, 2);
		expect(calls).toHaveLength(2);
		batch.flush();
		expect(calls).toHaveLength(3);
	});

	it("disables itself when the stream has no same-style runs", () => {
		const { ctx } = fakeCtx();
		const batch = createStrokeBatch(ctx);
		// Alternate styles every point: buffering can never pay off here.
		for (let i = 0; i < 5000; i += 1) {
			batch.addSegment(i % 2 ? pen : red, 3, i, 0, i, 1, i, 2);
		}
		expect(batch.active).toBe(false);
		// Once disabled it declines work so the caller draws directly.
		expect(batch.addSegment(pen, 3, 0, 0, 1, 1, 2, 2)).toBe(false);
		expect(batch.addDot(pen, 3, 0, 0)).toBe(false);
	});

	it("stays enabled for long same-style runs", () => {
		const { ctx } = fakeCtx();
		const batch = createStrokeBatch(ctx);
		for (let i = 0; i < 5000; i += 1) batch.addSegment(pen, 3 + (i % 5) * 0.1, i, 0, i, 1, i, 2);
		expect(batch.active).toBe(true);
	});
});
