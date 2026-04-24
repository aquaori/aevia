import type { Browser, Page } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import {
	bootstrapRoomPage,
	compareCanvasDataUrls,
	createContextAndPage,
	createRoomWithUsers,
	getCanvasDataUrls,
	readBenchmarkRuntime,
	sampleHeap,
} from "./suite-helpers";
import { WebSocketInjector, joinRoom } from "./utils";

export interface StressReport {
	avgFps: number;
	minFps: number;
	p95FrameTimeMs: number;
	maxFrameGapMs: number;
	longTaskCount: number;
	longTaskTotalMs: number;
	peakHeapMb: number;
	heapEndMb: number;
	totalPointsInjected: number;
	isStateConsistent: boolean;
	isVisualConsistent: boolean;
}

type StressProfile = "uniform" | "bursty" | "mixed-tools";

const installStressStats = async (page: Page) => {
	await page.addInitScript(() => {
		(window as any).__stressStats = {
			frameTimes: [] as number[],
			maxFrameGapMs: 0,
			minFps: Number.POSITIVE_INFINITY,
			frameCount: 0,
			startTs: 0,
			longTaskCount: 0,
			longTaskTotalMs: 0,
		};

		let last = performance.now();
		(window as any).__stressStats.startTs = last;
		const loop = (now: number) => {
			const delta = now - last;
			last = now;
			(window as any).__stressStats.frameTimes.push(delta);
			(window as any).__stressStats.maxFrameGapMs = Math.max(
				(window as any).__stressStats.maxFrameGapMs,
				delta
			);
			(window as any).__stressStats.frameCount += 1;
			const fps = delta > 0 ? 1000 / delta : 0;
			(window as any).__stressStats.minFps = Math.min(
				(window as any).__stressStats.minFps,
				fps
			);
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);

		if ("PerformanceObserver" in window) {
			try {
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						(window as any).__stressStats.longTaskCount += 1;
						(window as any).__stressStats.longTaskTotalMs += entry.duration;
					}
				});
				observer.observe({ type: "longtask", buffered: true } as any);
			} catch {}
		}
	});
};

const runProfile = async (
	injectors: WebSocketInjector[],
	profile: StressProfile,
	durationMs: number
) => {
	switch (profile) {
		case "bursty":
			return Promise.all(
				injectors.map((injector, index) =>
					injector.injectRealtimeStrokes(index % 2 === 0 ? 90 : 45, durationMs, 350)
				)
			);
		case "mixed-tools":
			return Promise.all(
				injectors.map(async (injector, index) => {
					if (index % 3 === 0) {
						// @ts-ignore testing only
						injector["userName"] = `${injector.userName}_eraser`;
					}
					return injector.injectRealtimeStrokes(60, durationMs, 280);
				})
			);
		case "uniform":
		default:
			return Promise.all(injectors.map((injector) => injector.injectRealtimeStrokes(60, durationMs, 500)));
	}
};

const percentile = (values: number[], p: number) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
};

export const runStressSuite = async (
	browser: Browser,
	throttleCpu = false,
	profile: StressProfile = "uniform"
): Promise<StressReport> => {
	const { roomId, creds } = await createRoomWithUsers("StressRoom", ["Observer1", "Observer2"]);
	const { context: context1, page: page1 } = await createContextAndPage(browser, throttleCpu);
	const { context: context2, page: page2 } = await createContextAndPage(browser, throttleCpu);

	await installStressStats(page1);
	await installStressStats(page2);
	await Promise.all([
		bootstrapRoomPage(page1, { token: creds[0]!.token, userName: "Observer1" }),
		bootstrapRoomPage(page2, { token: creds[1]!.token, userName: "Observer2" }),
	]);

	const injectors: WebSocketInjector[] = [];
	for (let i = 0; i < 20; i += 1) {
		const cred = await joinRoom(roomId, `StressBot_${i}`);
		if (!cred) throw new Error(`missing stress bot ${i}`);
		const injector = new WebSocketInjector(roomId, `StressBot_${i}`, cred.token, cred.userId);
		await injector.connect();
		injectors.push(injector);
	}

	const counts = await runProfile(injectors, profile, 10000);
	const totalPointsInjected = counts.reduce((sum, count) => sum + count, 0);
	await page1.waitForTimeout(2500);
	await page2.waitForTimeout(2500);

	const [stats1, stats2, runtime1, runtime2, heap1] = await Promise.all([
		page1.evaluate(() => (window as any).__stressStats),
		page2.evaluate(() => (window as any).__stressStats),
		readBenchmarkRuntime(page1),
		readBenchmarkRuntime(page2),
		sampleHeap(page1),
	]);

	const [canvasA] = await getCanvasDataUrls(page1);
	const [canvasB] = await getCanvasDataUrls(page2);
	const diff = canvasA && canvasB ? compareCanvasDataUrls(canvasA, canvasB) : null;

	injectors.forEach((injector) => injector.close());
	await context1.close();
	await context2.close();

	const frameTimes = [...(stats1?.frameTimes || []), ...(stats2?.frameTimes || [])];
	const totalRuntimeMs = Math.max(1, (frameTimes || []).reduce((sum, value) => sum + value, 0));
	const avgFps = frameTimes.length > 0 ? frameTimes.length / (totalRuntimeMs / 1000) : 0;
	const digest1 = runtime1?.lastCommandDigest || "";
	const digest2 = runtime2?.lastCommandDigest || "";

	return {
		avgFps,
		minFps: Math.min(stats1?.minFps || 0, stats2?.minFps || 0),
		p95FrameTimeMs: percentile(frameTimes, 95),
		maxFrameGapMs: Math.max(stats1?.maxFrameGapMs || 0, stats2?.maxFrameGapMs || 0),
		longTaskCount: (stats1?.longTaskCount || 0) + (stats2?.longTaskCount || 0),
		longTaskTotalMs: (stats1?.longTaskTotalMs || 0) + (stats2?.longTaskTotalMs || 0),
		peakHeapMb: Number(heap1?.peakUsedMb || 0),
		heapEndMb: Number(heap1?.endUsedMb || 0),
		totalPointsInjected,
		isStateConsistent: Boolean(digest1) && digest1 === digest2,
		isVisualConsistent: diff ? diff.diffRatio < diff.passThreshold : false,
	};
};

export const collectStressSample = async (
	browser: Browser,
	throttleCpu = false,
	profile: StressProfile = "uniform"
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runStressSuite(browser, throttleCpu, profile);
		return {
			status: "passed",
			durationMs: performance.now() - startedAt,
			metrics: { ...report, profile },
		};
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: { profile },
			error: error?.message || "stress suite failed",
		};
	}
};
