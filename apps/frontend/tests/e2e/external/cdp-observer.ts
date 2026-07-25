import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { PNG } from "pngjs";
import type { Roi } from "./types";

export interface CdpMetrics {
	usedHeapMb?: number;
	totalHeapMb?: number;
	jsHeapUsedMb?: number;
	jsHeapTotalMb?: number;
	nodeCount?: number;
	documentCount?: number;
	layoutCount?: number;
	recalcStyleCount?: number;
}

export interface CrashState {
	pageCrashed: boolean;
	pageClosed: boolean;
	browserDisconnected: boolean;
	cdpDetached: boolean;
	error?: string;
}

export interface BoundaryProbe {
	page: Page;
	context: BrowserContext;
	client: CDPSession;
	crash: CrashState;
	readMetrics: () => Promise<CdpMetrics>;
	collectGarbage: () => Promise<void>;
	close: () => Promise<void>;
}

const bytesToMb = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value)
		? Number((value / 1024 / 1024).toFixed(2))
		: undefined;

const metricValue = (metrics: Array<{ name: string; value: number }>, name: string) =>
	metrics.find((metric) => metric.name === name)?.value;

export const createBoundaryProbe = async (
	browser: Browser,
	options: { viewport?: { width: number; height: number }; cpuThrottle?: number } = {}
): Promise<BoundaryProbe> => {
	const context = await browser.newContext({
		viewport: options.viewport || { width: 1280, height: 720 },
	});
	const page = await context.newPage();
	const client = await context.newCDPSession(page);
	const crash: CrashState = {
		pageCrashed: false,
		pageClosed: false,
		browserDisconnected: false,
		cdpDetached: false,
	};
	const markBrowserDisconnected = () => {
		crash.browserDisconnected = true;
	};

	page.on("crash", () => {
		crash.pageCrashed = true;
	});
	page.on("close", () => {
		crash.pageClosed = true;
	});
	browser.on("disconnected", markBrowserDisconnected);
	(client as CDPSession & { on(event: "Detached", handler: () => void): void }).on("Detached", () => {
		crash.cdpDetached = true;
	});

	await client.send("Performance.enable").catch(() => undefined);
	if (options.cpuThrottle && options.cpuThrottle > 1) {
		await client.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle }).catch(() => undefined);
	}

	const readMetrics = async (): Promise<CdpMetrics> => {
		const metrics: CdpMetrics = {};
		try {
			const heap = await client.send("Runtime.getHeapUsage");
			metrics.usedHeapMb = bytesToMb(heap.usedSize);
			metrics.totalHeapMb = bytesToMb(heap.totalSize);
		} catch (error: unknown) {
			crash.error = crash.error || (error instanceof Error ? error.message : String(error));
		}

		try {
			const perf = await client.send("Performance.getMetrics");
			metrics.jsHeapUsedMb = bytesToMb(metricValue(perf.metrics, "JSHeapUsedSize"));
			metrics.jsHeapTotalMb = bytesToMb(metricValue(perf.metrics, "JSHeapTotalSize"));
			metrics.nodeCount = metricValue(perf.metrics, "Nodes");
			metrics.documentCount = metricValue(perf.metrics, "Documents");
			metrics.layoutCount = metricValue(perf.metrics, "LayoutCount");
			metrics.recalcStyleCount = metricValue(perf.metrics, "RecalcStyleCount");
		} catch (error: unknown) {
			crash.error = crash.error || (error instanceof Error ? error.message : String(error));
		}

		try {
			const counters = await client.send("Memory.getDOMCounters");
			metrics.nodeCount = counters.nodes ?? metrics.nodeCount;
			metrics.documentCount = counters.documents ?? metrics.documentCount;
		} catch {
			// Memory.getDOMCounters is not always available; Performance metrics are enough.
		}

		return metrics;
	};

	const collectGarbage = async () => {
		await client.send("HeapProfiler.collectGarbage").catch(() => undefined);
	};

	return {
		page,
		context,
		client,
		crash,
		readMetrics,
		collectGarbage,
		close: async () => {
			browser.off("disconnected", markBrowserDisconnected);
			await client.detach().catch(() => undefined);
			await context.close().catch(() => undefined);
		},
	};
};

export const classifyCrash = (crash: CrashState) => {
	if (crash.browserDisconnected) return "browser-disconnected";
	if (crash.pageCrashed) return "page-crash";
	if (crash.cdpDetached) return "cdp-detached";
	if (crash.pageClosed) return "page-closed";
	return crash.error ? "cdp-error" : "none";
};

const diffRatio = (left: PNG, right: PNG, threshold = 12) => {
	const width = Math.min(left.width, right.width);
	const height = Math.min(left.height, right.height);
	if (width === 0 || height === 0) return 0;
	let changed = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const leftIndex = (left.width * y + x) << 2;
			const rightIndex = (right.width * y + x) << 2;
			const delta =
				Math.abs((left.data[leftIndex] ?? 0) - (right.data[rightIndex] ?? 0)) +
				Math.abs((left.data[leftIndex + 1] ?? 0) - (right.data[rightIndex + 1] ?? 0)) +
				Math.abs((left.data[leftIndex + 2] ?? 0) - (right.data[rightIndex + 2] ?? 0)) +
				Math.abs((left.data[leftIndex + 3] ?? 0) - (right.data[rightIndex + 3] ?? 0));
			if (delta > threshold) changed += 1;
		}
	}
	return changed / Math.max(1, width * height);
};

export const capturePagePng = async (page: Page, roi?: Roi) => {
	const buffer = await page.screenshot({
		clip: roi
			? {
					x: roi.x,
					y: roi.y,
					width: roi.width,
					height: roi.height,
				}
			: undefined,
	});
	return PNG.sync.read(buffer);
};

export const waitForScreenshotChange = async (
	page: Page,
	baseline: PNG,
	options: { roi?: Roi; timeoutMs: number; minDiffRatio: number; pollMs?: number }
) => {
	const startedAt = performance.now();
	let frames = 0;
	while (performance.now() - startedAt < options.timeoutMs) {
		await page.waitForTimeout(options.pollMs ?? 100);
		frames += 1;
		const current = await capturePagePng(page, options.roi);
		const ratio = diffRatio(baseline, current);
		if (ratio >= options.minDiffRatio) {
			return {
				elapsedMs: performance.now() - startedAt,
				frames,
				diffRatio: ratio,
			};
		}
	}
	throw new Error("screenshot change timeout");
};
