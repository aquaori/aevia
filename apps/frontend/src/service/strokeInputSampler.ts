export interface RawPointerSample {
	x: number;
	y: number;
	pressure: number;
	pointerType: string;
	timeStamp: number;
}

export interface StrokeInputSample {
	x: number;
	y: number;
	pressure: number;
	timeStamp: number;
}

interface StrokeInputSamplerOptions {
	spacingPx?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const smoothingAlpha = (elapsedMs: number, timeConstantMs: number) =>
	1 - Math.exp(-Math.max(elapsedMs, 0) / timeConstantMs);

const MAX_MOUSE_FILTER_ELAPSED_MS = 24;
const MOUSE_IDLE_THRESHOLD_MS = 48;
const MAX_RESUME_MOTION_ELAPSED_MS = 32;

const resolveMousePressure = (speed: number) => {
	const normalizedSpeed = clamp((speed - 0.08) / 1.72, 0, 1);
	const easedSpeed = normalizedSpeed * normalizedSpeed * (3 - 2 * normalizedSpeed);
	return 0.95 - easedSpeed * 0.6;
};

export const createStrokeInputSampler = ({ spacingPx = 1.75 }: StrokeInputSamplerOptions = {}) => {
	let lastRaw: RawPointerSample | null = null;
	let lastOutput: StrokeInputSample | null = null;
	let hasDerivedOutput = false;
	let distanceSinceOutput = 0;
	let filteredSpeed = 0;
	let filteredPressure = 0.82;

	const resolvePressure = (
		pointerType: string,
		rawPressure: number,
		speed: number,
		timeStamp: number
	) => {
		const elapsedMs = lastOutput ? Math.max(timeStamp - lastOutput.timeStamp, 1) : 16;
		if (hasDerivedOutput) {
			const filterElapsedMs =
				pointerType === "pen"
					? elapsedMs
					: Math.min(elapsedMs, MAX_MOUSE_FILTER_ELAPSED_MS);
			const speedTimeConstantMs = speed >= filteredSpeed ? 22 : 80;
			const speedAlpha = smoothingAlpha(filterElapsedMs, speedTimeConstantMs);
			filteredSpeed += (speed - filteredSpeed) * speedAlpha;
		} else {
			filteredSpeed = speed;
		}

		const targetPressure =
			pointerType === "pen"
				? clamp(rawPressure > 0 ? rawPressure : filteredPressure, 0.05, 1)
				: resolveMousePressure(filteredSpeed);
		if (hasDerivedOutput) {
			const filterElapsedMs =
				pointerType === "pen"
					? elapsedMs
					: Math.min(elapsedMs, MAX_MOUSE_FILTER_ELAPSED_MS);
			const pressureTimeConstantMs =
				pointerType === "pen" ? 14 : targetPressure > filteredPressure ? 85 : 24;
			const pressureAlpha = smoothingAlpha(filterElapsedMs, pressureTimeConstantMs);
			filteredPressure += (targetPressure - filteredPressure) * pressureAlpha;
		} else {
			filteredPressure = targetPressure;
			hasDerivedOutput = true;
		}
		return filteredPressure;
	};

	const start = (sample: RawPointerSample): StrokeInputSample => {
		const pressure =
			sample.pointerType === "pen"
				? clamp(sample.pressure > 0 ? sample.pressure : 0.5, 0.05, 1)
				: 0.82;
		lastRaw = sample;
		lastOutput = { x: sample.x, y: sample.y, pressure, timeStamp: sample.timeStamp };
		distanceSinceOutput = 0;
		filteredSpeed = 0;
		filteredPressure = pressure;
		hasDerivedOutput = false;
		return lastOutput;
	};

	const add = (sample: RawPointerSample, forceEndpoint = false): StrokeInputSample[] => {
		if (!lastRaw || !lastOutput) {
			return [start(sample)];
		}

		const segmentStart = lastRaw;
		const dx = sample.x - segmentStart.x;
		const dy = sample.y - segmentStart.y;
		const distance = Math.hypot(dx, dy);
		const elapsedMs = Math.max(sample.timeStamp - segmentStart.timeStamp, 1);
		const motionElapsedMs =
			sample.pointerType !== "pen" && elapsedMs > MOUSE_IDLE_THRESHOLD_MS
				? Math.min(elapsedMs, MAX_RESUME_MOTION_ELAPSED_MS)
				: elapsedMs;
		const speed = distance > 0.001 ? distance / motionElapsedMs : filteredSpeed;
		const output: StrokeInputSample[] = [];

		if (distance > 0.001) {
			let consumed = 0;
			let needed = spacingPx - distanceSinceOutput;
			while (consumed + needed <= distance + 0.0001) {
				consumed += needed;
				const ratio = clamp(consumed / distance, 0, 1);
				const timeStamp = segmentStart.timeStamp + elapsedMs * ratio;
				const rawPressure = segmentStart.pressure + (sample.pressure - segmentStart.pressure) * ratio;
				const next = {
					x: segmentStart.x + dx * ratio,
					y: segmentStart.y + dy * ratio,
					pressure: resolvePressure(sample.pointerType, rawPressure, speed, timeStamp),
					timeStamp,
				};
				output.push(next);
				lastOutput = next;
				distanceSinceOutput = 0;
				needed = spacingPx;
			}
			distanceSinceOutput += distance - consumed;
		}

		lastRaw = sample;
		if (forceEndpoint && Math.hypot(sample.x - lastOutput.x, sample.y - lastOutput.y) > 0.1) {
			const endpoint = {
				x: sample.x,
				y: sample.y,
				pressure: resolvePressure(sample.pointerType, sample.pressure, speed, sample.timeStamp),
				timeStamp: sample.timeStamp,
			};
			output.push(endpoint);
			lastOutput = endpoint;
			distanceSinceOutput = 0;
		}
		return output;
	};

	const reset = () => {
		lastRaw = null;
		lastOutput = null;
		distanceSinceOutput = 0;
		filteredSpeed = 0;
		filteredPressure = 0.82;
		hasDerivedOutput = false;
	};

	return { start, add, reset };
};

export const resolveStrokeStartPressure = (
	initialPressure: number,
	samples: StrokeInputSample[],
	pointerType: string
) => {
	if (pointerType === "pen" || samples.length === 0) return initialPressure;
	if (samples.length === 1) return samples[0]!.pressure;
	return samples[0]!.pressure * 0.75 + samples[1]!.pressure * 0.25;
};

const sampleError = (
	sample: StrokeInputSample,
	start: StrokeInputSample,
	end: StrokeInputSample
) => {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	const ratio =
		lengthSquared === 0
			? 0
			: clamp(((sample.x - start.x) * dx + (sample.y - start.y) * dy) / lengthSquared, 0, 1);
	const projectedX = start.x + dx * ratio;
	const projectedY = start.y + dy * ratio;
	const spatialError = Math.hypot(sample.x - projectedX, sample.y - projectedY);
	const expectedPressure = start.pressure + (end.pressure - start.pressure) * ratio;
	const pressureError = Math.abs(sample.pressure - expectedPressure) * 8;
	return Math.max(spatialError, pressureError);
};

export const simplifyStrokeSamples = (
	samples: StrokeInputSample[],
	anchor: StrokeInputSample | null,
	tolerancePx: number
) => {
	if (samples.length <= 1 || !anchor || tolerancePx <= 0) return samples;

	const points = [anchor, ...samples];
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const ranges: Array<[number, number]> = [[0, points.length - 1]];

	while (ranges.length > 0) {
		const [startIndex, endIndex] = ranges.pop()!;
		let maxError = tolerancePx;
		let splitIndex = -1;
		for (let index = startIndex + 1; index < endIndex; index += 1) {
			const error = sampleError(points[index]!, points[startIndex]!, points[endIndex]!);
			if (error > maxError) {
				maxError = error;
				splitIndex = index;
			}
		}
		if (splitIndex !== -1) {
			keep[splitIndex] = 1;
			ranges.push([startIndex, splitIndex], [splitIndex, endIndex]);
		}
	}

	return points.slice(1).filter((_, index) => keep[index + 1] === 1);
};
