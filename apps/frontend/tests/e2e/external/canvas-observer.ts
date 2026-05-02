import fs from "fs";
import path from "path";
import type { Page } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CanvasSample, Roi } from "./types";
import { ensureDir } from "./reporter";

type ReadbackOptions = {
	roi?: Roi;
	sampleSize?: number;
	includeOverlay?: boolean;
};

type BrowserCanvasSample = {
	signature: string;
	nonBlankRatio: number;
	width: number;
	height: number;
	pixels: number[];
};

declare global {
	interface Window {
		__externalCanvasObserver?: {
			sample(options?: ReadbackOptions): BrowserCanvasSample;
			diffRatio(left: number[], right: number[], threshold?: number): number;
		};
	}
}

const decodePng = (buffer: Buffer) => PNG.sync.read(buffer);

export const CANVAS_OBSERVER_INIT_SCRIPT = String.raw`
(() => {
	if (window.__externalCanvasObserver) return;
	const state = { canvas: document.createElement("canvas") };
	const ctx = state.canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("external canvas observer context unavailable");

	const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
	const getCanvases = () =>
		Array.from(document.querySelectorAll("canvas"))
			.map((canvas, index) => {
				const rect = canvas.getBoundingClientRect();
				const style = window.getComputedStyle(canvas);
				const zIndex = Number.parseInt(style.zIndex || "", 10);
				return {
					canvas,
					index,
					rect,
					zIndex: Number.isFinite(zIndex) ? zIndex : index,
				};
			})
			.filter(({ rect }) => rect.width > 0 && rect.height > 0)
			.sort((left, right) => left.zIndex - right.zIndex || left.index - right.index);
	const getPrimaryCanvas = () => {
		const canvases = getCanvases();
		if (canvases.length === 0) throw new Error("canvas observer could not find any canvas");
		return canvases[0];
	};
	const diffRatio = (left, right, threshold = 12) => {
		const length = Math.min(left.length, right.length);
		if (length === 0) return 0;
		let changed = 0;
		for (let index = 0; index < length; index += 4) {
			const delta =
				Math.abs((left[index] ?? 0) - (right[index] ?? 0)) +
				Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)) +
				Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0)) +
				Math.abs((left[index + 3] ?? 0) - (right[index + 3] ?? 0));
			if (delta > threshold) changed += 1;
		}
		return changed / Math.max(1, Math.floor(length / 4));
	};
	const sample = (options = {}) => {
		const primary = getPrimaryCanvas();
		const canvases = options.includeOverlay ? getCanvases() : [primary];
		const sourceRect = primary.rect;
		const cssX = clamp(Math.floor(options.roi?.x ?? 0), 0, Math.max(0, Math.floor(sourceRect.width) - 1));
		const cssY = clamp(Math.floor(options.roi?.y ?? 0), 0, Math.max(0, Math.floor(sourceRect.height) - 1));
		const cssWidth = clamp(
			Math.floor(options.roi?.width ?? sourceRect.width),
			1,
			Math.max(1, Math.floor(sourceRect.width - cssX))
		);
		const cssHeight = clamp(
			Math.floor(options.roi?.height ?? sourceRect.height),
			1,
			Math.max(1, Math.floor(sourceRect.height - cssY))
		);
		const maxEdge = Math.max(16, Math.floor(options.sampleSize ?? 96));
		const scale = Math.min(1, maxEdge / Math.max(cssWidth, cssHeight));
		const width = Math.max(1, Math.round(cssWidth * scale));
		const height = Math.max(1, Math.round(cssHeight * scale));

		state.canvas.width = width;
		state.canvas.height = height;
		ctx.clearRect(0, 0, width, height);

		const viewportX = sourceRect.left + cssX;
		const viewportY = sourceRect.top + cssY;
		for (const entry of canvases) {
			const rect = entry.rect;
			const overlapLeft = Math.max(viewportX, rect.left);
			const overlapTop = Math.max(viewportY, rect.top);
			const overlapRight = Math.min(viewportX + cssWidth, rect.left + rect.width);
			const overlapBottom = Math.min(viewportY + cssHeight, rect.top + rect.height);
			if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) continue;
			const sxScale = entry.canvas.width / rect.width;
			const syScale = entry.canvas.height / rect.height;
			const sourceX = (overlapLeft - rect.left) * sxScale;
			const sourceY = (overlapTop - rect.top) * syScale;
			const sourceWidth = (overlapRight - overlapLeft) * sxScale;
			const sourceHeight = (overlapBottom - overlapTop) * syScale;
			const destX = (overlapLeft - viewportX) * scale;
			const destY = (overlapTop - viewportY) * scale;
			const destWidth = (overlapRight - overlapLeft) * scale;
			const destHeight = (overlapBottom - overlapTop) * scale;
			ctx.drawImage(entry.canvas, sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight);
		}

		const image = ctx.getImageData(0, 0, width, height);
		const pixels = Array.from(image.data);
		let nonBlank = 0;
		let hash = 2166136261;
		for (let index = 0; index < pixels.length; index += 4) {
			const r = pixels[index] ?? 255;
			const g = pixels[index + 1] ?? 255;
			const b = pixels[index + 2] ?? 255;
			const a = pixels[index + 3] ?? 255;
			if (a > 0 && (r < 245 || g < 245 || b < 245)) nonBlank += 1;
			hash ^= r;
			hash = Math.imul(hash, 16777619);
			hash ^= g;
			hash = Math.imul(hash, 16777619);
			hash ^= b;
			hash = Math.imul(hash, 16777619);
			hash ^= a;
			hash = Math.imul(hash, 16777619);
		}

		return {
			signature: String(hash >>> 0),
			nonBlankRatio: nonBlank / Math.max(1, width * height),
			width,
			height,
			pixels,
		};
	};

	window.__externalCanvasObserver = { sample, diffRatio };
})();
`;

const ensureCanvasObserver = async (page: Page) => {
	await page.evaluate((script) => {
		eval(script);
	}, CANVAS_OBSERVER_INIT_SCRIPT);
};

export const primaryCanvas = (page: Page) => page.locator("canvas").first();

export const installCanvasObserver = ensureCanvasObserver;

export const captureCanvasPng = async (page: Page, roi?: Roi) => {
	const canvas = primaryCanvas(page);
	await canvas.waitFor({ timeout: 30000 });
	const box = await canvas.boundingBox();
	if (!box) {
		throw new Error("canvas bounding box unavailable");
	}
	const clip = roi
		? {
				x: box.x + roi.x,
				y: box.y + roi.y,
				width: roi.width,
				height: roi.height,
		  }
		: box;
	return page.screenshot({ clip });
};

export const captureCanvasSample = async (
	page: Page,
	roi?: Roi,
	options: Omit<ReadbackOptions, "roi"> = {}
): Promise<CanvasSample> => {
	await ensureCanvasObserver(page);
	const sample = await page.evaluate(
		(input: ReadbackOptions) => window.__externalCanvasObserver!.sample(input),
		{ roi, ...options }
	);
	return {
		...sample,
		source: "canvas-readback",
	};
};

export const saveCanvasPng = async (page: Page, filePath: string, roi?: Roi) => {
	ensureDir(path.dirname(filePath));
	const buffer = await captureCanvasPng(page, roi);
	fs.writeFileSync(filePath, buffer);
	return filePath;
};

export const waitForCanvasChange = async (
	page: Page,
	baseline: CanvasSample,
	options: {
		roi?: Roi;
		timeoutMs: number;
		minDiffRatio?: number;
		includeOverlay?: boolean;
		sampleSize?: number;
	}
) => {
	await ensureCanvasObserver(page);
	return page.evaluate(
		async ({
			baselinePixels,
			roi,
			timeoutMs,
			minDiffRatio,
			includeOverlay,
			sampleSize,
		}: {
			baselinePixels: number[];
			roi?: Roi;
			timeoutMs: number;
			minDiffRatio?: number;
			includeOverlay?: boolean;
			sampleSize?: number;
		}) => {
			const observer = window.__externalCanvasObserver!;
			const startedAt = performance.now();
			let frames = 0;
			let lastSample = observer.sample({ roi, includeOverlay, sampleSize });
			while (performance.now() - startedAt < timeoutMs) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				frames += 1;
				lastSample = observer.sample({ roi, includeOverlay, sampleSize });
				const diff = observer.diffRatio(baselinePixels, lastSample.pixels, 12);
				if (diff >= (minDiffRatio ?? 0.01)) {
					return {
						elapsedMs: performance.now() - startedAt,
						frames,
						diffRatio: diff,
						sample: lastSample,
					};
				}
			}
			throw new Error(
				`canvas change timeout: diffRatio=${observer.diffRatio(baselinePixels, lastSample.pixels, 12).toFixed(4)}`
			);
		},
		{
			baselinePixels: baseline.pixels || [],
			roi: options.roi,
			timeoutMs: options.timeoutMs,
			minDiffRatio: options.minDiffRatio,
			includeOverlay: options.includeOverlay,
			sampleSize: options.sampleSize,
		}
	);
};

export const waitForNonBlankCanvas = async (
	page: Page,
	options: { timeoutMs: number; minNonBlankRatio?: number; roi?: Roi; includeOverlay?: boolean; sampleSize?: number }
) => {
	await ensureCanvasObserver(page);
	return page.evaluate(
		async (input: { timeoutMs: number; minNonBlankRatio?: number; roi?: Roi; includeOverlay?: boolean; sampleSize?: number }) => {
			const observer = window.__externalCanvasObserver!;
			const startedAt = performance.now();
			let frames = 0;
			let lastSample = observer.sample(input);
			while (performance.now() - startedAt < input.timeoutMs) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				frames += 1;
				lastSample = observer.sample(input);
				if (lastSample.nonBlankRatio >= (input.minNonBlankRatio ?? 0.002)) {
					return {
						elapsedMs: performance.now() - startedAt,
						frames,
						sample: lastSample,
					};
				}
			}
			throw new Error(`non-blank canvas timeout: ratio=${lastSample.nonBlankRatio}`);
		},
		options
	);
};

export const waitForBlankCanvas = async (
	page: Page,
	options: { timeoutMs: number; maxNonBlankRatio?: number; roi?: Roi; includeOverlay?: boolean; sampleSize?: number }
) => {
	await ensureCanvasObserver(page);
	return page.evaluate(
		async (input: { timeoutMs: number; maxNonBlankRatio?: number; roi?: Roi; includeOverlay?: boolean; sampleSize?: number }) => {
			const observer = window.__externalCanvasObserver!;
			const startedAt = performance.now();
			let frames = 0;
			let lastSample = observer.sample(input);
			while (performance.now() - startedAt < input.timeoutMs) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				frames += 1;
				lastSample = observer.sample(input);
				if (lastSample.nonBlankRatio <= (input.maxNonBlankRatio ?? 0.001)) {
					return {
						elapsedMs: performance.now() - startedAt,
						frames,
						sample: lastSample,
					};
				}
			}
			throw new Error(`blank canvas timeout: ratio=${lastSample.nonBlankRatio}`);
		},
		options
	);
};

export const waitForStableCanvas = async (
	page: Page,
	options: {
		timeoutMs: number;
		stableFrames?: number;
		maxDiffRatio?: number;
		roi?: Roi;
		includeOverlay?: boolean;
		sampleSize?: number;
	}
) => {
	await ensureCanvasObserver(page);
	return page.evaluate(
		async (input: {
			timeoutMs: number;
			stableFrames?: number;
			maxDiffRatio?: number;
			roi?: Roi;
			includeOverlay?: boolean;
			sampleSize?: number;
		}) => {
			const observer = window.__externalCanvasObserver!;
			const startedAt = performance.now();
			const neededStableFrames = Math.max(2, input.stableFrames ?? 3);
			const maxDiffRatio = input.maxDiffRatio ?? 0.0005;
			let previous = observer.sample(input);
			let stableCount = 0;
			let frames = 0;
			while (performance.now() - startedAt < input.timeoutMs) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				frames += 1;
				const current = observer.sample(input);
				const diff = observer.diffRatio(previous.pixels, current.pixels, 8);
				if (diff <= maxDiffRatio) {
					stableCount += 1;
					if (stableCount >= neededStableFrames) {
						return {
							elapsedMs: performance.now() - startedAt,
							frames,
							sample: current,
						};
					}
				} else {
					stableCount = 0;
				}
				previous = current;
			}
			throw new Error("stable canvas timeout");
		},
		options
	);
};

export const compareCanvasPages = async (
	pageA: Page,
	pageB: Page,
	options: { diffPath?: string; threshold?: number } = {}
) => {
	const [aBuffer, bBuffer] = await Promise.all([
		captureCanvasPng(pageA),
		captureCanvasPng(pageB),
	]);
	const a = decodePng(aBuffer);
	const b = decodePng(bBuffer);
	if (a.width !== b.width || a.height !== b.height) {
		return { diffPixels: Number.MAX_SAFE_INTEGER, diffRatio: 1, passThreshold: options.threshold ?? 0.005 };
	}
	const diff = new PNG({ width: a.width, height: a.height });
	const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
	if (options.diffPath) {
		ensureDir(path.dirname(options.diffPath));
		fs.writeFileSync(options.diffPath, PNG.sync.write(diff));
	}
	return {
		diffPixels,
		diffRatio: diffPixels / (a.width * a.height),
		passThreshold: options.threshold ?? 0.005,
	};
};

export const signatureDiffRatio = (left: string, right: string) => {
	if (!left && !right) return 0;
	return left === right ? 0 : 1;
};

export const roiAround = (x: number, y: number, size = 220): Roi => ({
	x: Math.max(0, x - size / 2),
	y: Math.max(0, y - size / 2),
	width: size,
	height: size,
});
