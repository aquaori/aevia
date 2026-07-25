import { describe, expect, it } from "vitest";
import {
	createStrokeInputSampler,
	resolveStrokeStartPressure,
	simplifyStrokeSamples,
	type RawPointerSample,
	type StrokeInputSample,
} from "./strokeInputSampler";

const raw = (x: number, timeStamp: number, pressure = 0.5): RawPointerSample => ({
	x,
	y: 0,
	pressure,
	pointerType: "mouse",
	timeStamp,
});

const sample = (x: number, y: number, pressure = 0.5): StrokeInputSample => ({
	x,
	y,
	pressure,
	timeStamp: x,
});

describe("strokeInputSampler", () => {
	it("resamples raw movement at a stable spatial interval", () => {
		const sampler = createStrokeInputSampler({ spacingPx: 1.75 });
		sampler.start(raw(0, 0));
		const points = sampler.add(raw(7, 7), true);

		expect(points.map((point) => point.x)).toEqual([1.75, 3.5, 5.25, 7]);
	});

	it("produces the same mouse pressure for equivalent motion split into different events", () => {
		const singleEvent = createStrokeInputSampler({ spacingPx: 2 });
		singleEvent.start(raw(0, 0));
		const singlePoints = singleEvent.add(raw(20, 20), true);

		const splitEvents = createStrokeInputSampler({ spacingPx: 2 });
		splitEvents.start(raw(0, 0));
		const splitPoints = [
			...splitEvents.add(raw(10, 10)),
			...splitEvents.add(raw(20, 20), true),
		];

		expect(splitPoints.map((point) => point.x)).toEqual(singlePoints.map((point) => point.x));
		expect(splitPoints.at(-1)?.pressure).toBeCloseTo(singlePoints.at(-1)!.pressure, 6);
	});

	it("keeps the exact endpoint once when movement does not end on the sampling interval", () => {
		const sampler = createStrokeInputSampler({ spacingPx: 2 });
		sampler.start(raw(0, 0));
		const points = sampler.add(raw(5, 5), true);

		expect(points.map((point) => point.x)).toEqual([2, 4, 5]);
		expect(points.filter((point) => point.x === 5)).toHaveLength(1);
	});

	it("keeps a visible pressure difference between slow and fast mouse movement", () => {
		const slowSampler = createStrokeInputSampler({ spacingPx: 2 });
		slowSampler.start(raw(0, 0));
		let slow: StrokeInputSample[] = [];
		for (let index = 1; index <= 20; index += 1) {
			slow = slowSampler.add(raw(index * 5, index * 25), index === 20);
		}

		const fastSampler = createStrokeInputSampler({ spacingPx: 2 });
		fastSampler.start(raw(0, 0));
		const fast = fastSampler.add(raw(100, 40), true);

		expect(slow.at(-1)!.pressure - fast.at(-1)!.pressure).toBeGreaterThan(0.3);
	});

	it("does not turn an idle pause into an immediate pressure spike", () => {
		const sampler = createStrokeInputSampler({ spacingPx: 2 });
		sampler.start(raw(0, 0));
		const fast = sampler.add(raw(40, 20), true);
		const pressureBeforePause = fast.at(-1)!.pressure;
		const resumed = sampler.add(raw(44, 520), true);

		expect(resumed.at(-1)!.pressure - pressureBeforePause).toBeLessThan(0.08);

		let sustainedSlow = resumed;
		for (let index = 1; index <= 8; index += 1) {
			sustainedSlow = sampler.add(raw(44 + index * 4, 520 + index * 32), index === 8);
		}
		expect(sustainedSlow.at(-1)!.pressure).toBeGreaterThan(resumed.at(-1)!.pressure + 0.15);
	});

	it("responds to pen pressure without collapsing its useful range", () => {
		const sampler = createStrokeInputSampler({ spacingPx: 2 });
		const start = sampler.start({ ...raw(0, 0, 0.1), pointerType: "pen" });
		const points = sampler.add({ ...raw(40, 100, 1), pointerType: "pen" }, true);

		expect(start.pressure).toBe(0.1);
		expect(points.at(-1)!.pressure).toBeGreaterThan(0.8);
	});

	it("backfills mouse start pressure from early movement", () => {
		const earlySamples = [sample(1, 0, 0.35), sample(2, 0, 0.45)];

		expect(resolveStrokeStartPressure(0.82, earlySamples, "mouse")).toBeCloseTo(0.375);
		expect(resolveStrokeStartPressure(0.2, earlySamples, "pen")).toBe(0.2);
	});
});

describe("simplifyStrokeSamples", () => {
	it("removes redundant straight samples while preserving the endpoint", () => {
		const anchor = sample(0, 0);
		const simplified = simplifyStrokeSamples(
			[sample(1, 0), sample(2, 0), sample(3, 0)],
			anchor,
			0.4
		);

		expect(simplified).toEqual([sample(3, 0)]);
	});

	it("preserves corners and meaningful pressure changes", () => {
		const anchor = sample(0, 0);
		const corner = sample(1, 1);
		const endpoint = sample(2, 1);
		expect(simplifyStrokeSamples([corner, endpoint], anchor, 0.4)).toEqual([
			corner,
			endpoint,
		]);

		const pressurePeak = sample(1, 0, 0.9);
		expect(
			simplifyStrokeSamples([pressurePeak, sample(2, 0, 0.5)], anchor, 0.4)
		).toEqual([pressurePeak, sample(2, 0, 0.5)]);
	});
});
