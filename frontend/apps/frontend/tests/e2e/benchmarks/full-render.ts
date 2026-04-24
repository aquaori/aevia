import type { Browser, Page } from "playwright";
import type { BenchmarkRunSample, DatasetShape } from "./core-types";
import { createContextAndPage, readBenchmarkRuntime, sampleHeap } from "./suite-helpers";
import { CONFIG, WebSocketInjector, joinRoom, createRoom } from "./utils";

export interface FullRenderReport {
	scale: number;
	shape: DatasetShape;
	injectTimeMs: number;
	navToCanvasReadyMs: number;
	initPayloadBytes: number;
	initMetaPayloadBytes: number;
	initChunkPayloadBytes: number;
	initReceiveMs: number;
	initParseMs: number;
	initChunkParseMs: number;
	initChunkHandleMs: number;
	initChunkCount: number;
	initChunkCommandCount: number;
	initChunkFlatPointCount: number;
	hydrateCommandsMs: number;
	initStreamTotalMs: number;
	sortAndFlattenMs: number;
	canvasClearMs: number;
	appRenderMs: number;
	appRenderSource: "worker-full-render" | "init-visible-paint" | "none";
	workerFullRenderMs: number;
	visiblePaintMs: number;
	visiblePaintSource: "worker-full-render" | "init-visible-paint" | "none";
	firstInteractiveMs: number;
	canvasReadyToVisibleMs: number;
	totalVisibleMs: number;
	estimatedResidualMs: number;
	renderThroughputPointsPerSec: number;
	fullRenderSignalPresent: boolean;
	heapUsedMb: number;
	peakHeapMb: number;
	heapGrowthMb: number;
}

const shapeToStrokeSize = (shape: DatasetShape) => {
	switch (shape) {
		case "few-long-strokes":
			return 1000;
		case "dense-overlap":
			return 400;
		case "sparse-fullscreen":
			return 250;
		case "mixed-tool-history":
			return 180;
		case "many-short-strokes":
		default:
			return 120;
	}
};

const injectHistory = async (roomId: string, scale: number, shape: DatasetShape) => {
	const injectors: WebSocketInjector[] = [];
	const wsClientCount = 5;
	const pointsPerClient = Math.ceil(scale / wsClientCount);
	const pointsPerStroke = shapeToStrokeSize(shape);

	for (let i = 0; i < wsClientCount; i += 1) {
		const user = await joinRoom(roomId, `FullRenderBot_${i}`);
		if (!user) throw new Error("failed to join injector");
		const injector = new WebSocketInjector(roomId, `FullRenderBot_${i}`, user.token, user.userId);
		await injector.connect();
		injectors.push(injector);
	}

	const injectStart = performance.now();
	const injectCounts = await Promise.all(
		injectors.map((injector) => injector.injectPoints(pointsPerClient, pointsPerStroke))
	);
	const injectTimeMs = performance.now() - injectStart;
	await new Promise((resolve) => setTimeout(resolve, 1500));
	injectors.forEach((injector) => injector.close());
	const injectedPoints = injectCounts.reduce((sum, count) => sum + Number(count || 0), 0);

	return {
		injectTimeMs,
		injectedPoints,
	};
};

const waitForFullRender = async (page: Page, timeoutMs: number, expectedPoints: number) => {
	try {
		await page.waitForFunction(
			(minPoints) => {
				const runtime = (window as any).__benchmarkRuntime;
				if (!runtime) return false;

				const fullRender = runtime.lastFullRender;
				const hasFullRender =
					Number(fullRender?.durationMs || 0) > 0 &&
					Number(fullRender?.visiblePaintMs || 0) > 0 &&
					typeof fullRender?.canvasSignature === "string" &&
					fullRender.canvasSignature.length > 0;

				const renderedPoints = Number(fullRender?.points || 0);
				const meetsPointFloor = renderedPoints >= Math.max(1, Number(minPoints || 0));

				const init = runtime.lastInit;
				const hasInitSignal =
					Number(init?.commandCount || 0) > 0 ||
					Number(init?.chunkCommandCount || 0) > 0 ||
					Number(init?.chunkFlatPointCount || 0) > 0 ||
					Number(init?.chunkCount || 0) > 0 ||
					Number(init?.hydrateDurationMs || 0) > 0 ||
					Number(init?.totalDurationMs || 0) > 0;
				const hasCompleteInit =
					hasInitSignal &&
					Number(init?.totalDurationMs || 0) > 0 &&
					(Number(init?.chunkCount || 0) > 0 || Number(init?.commandCount || 0) > 0);

				// 兼容新 init 流程：若 init 指标未落盘，也允许通过 full render 的充足点数来判定完成。
				if (hasFullRender && meetsPointFloor) {
					return true;
				}
				if (hasCompleteInit) {
					return true;
				}

				return hasInitSignal ? meetsPointFloor : renderedPoints >= Math.max(1, Math.floor(minPoints * 1.25));
			},
			expectedPoints,
			{ timeout: timeoutMs }
		);
	} catch (error: any) {
		const snapshot = await page.evaluate(() => {
			const runtime = (window as any).__benchmarkRuntime || {};
			return {
				hasRuntime: Boolean((window as any).__benchmarkRuntime),
				lastFullRender: runtime.lastFullRender
					? {
						points: runtime.lastFullRender.points ?? 0,
						durationMs: runtime.lastFullRender.durationMs ?? 0,
						visiblePaintMs: runtime.lastFullRender.visiblePaintMs ?? 0,
						hasSignature: Boolean(runtime.lastFullRender.canvasSignature),
					}
					: null,
				lastInit: runtime.lastInit
					? {
						commandCount: runtime.lastInit.commandCount ?? 0,
						chunkCount: runtime.lastInit.chunkCount ?? 0,
						chunkCommandCount: runtime.lastInit.chunkCommandCount ?? 0,
						chunkFlatPointCount: runtime.lastInit.chunkFlatPointCount ?? 0,
						hydrateDurationMs: runtime.lastInit.hydrateDurationMs ?? 0,
						totalDurationMs: runtime.lastInit.totalDurationMs ?? 0,
					}
					: null,
			};
		});

		throw new Error(
			`full render wait timeout: expectedPoints=${expectedPoints}; snapshot=${JSON.stringify(snapshot)}; reason=${error?.message || "unknown"}`
		);
	}
};

const BENCHMARK_NAV_START_KEY = "__benchmark_room_nav_start_pending__";

const preparePageSideNavStart = async (page: Page) => {
	await page.addInitScript((storageKey: string) => {
		if (sessionStorage.getItem(storageKey) !== "1") return;
		(window as any).__benchmarkRoomNavStartTs = performance.now();
		sessionStorage.removeItem(storageKey);
	}, BENCHMARK_NAV_START_KEY);
};

export const runFullRenderSuite = async (
	scale: number,
	browser: Browser,
	throttleCpu = false,
	shape: DatasetShape = "many-short-strokes"
): Promise<FullRenderReport> => {
	const roomId = String(Math.floor(100000 + Math.random() * 900000));
	await createRoom(roomId, `FullRender_${scale}_${shape}`);
	const { injectTimeMs, injectedPoints } = await injectHistory(roomId, scale, shape);

	const observer = await joinRoom(roomId, "Observer");
	if (!observer) throw new Error("observer join failed");

	const { context, page } = await createContextAndPage(browser, throttleCpu);
	let initPayloadBytes = 0;
	let initPayloadDone = false;

	page.on("websocket", (ws) => {
		ws.on("framereceived", (frame) => {
			const payload =
				typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
			let msg: { type?: string } | null = null;
			try {
				msg = JSON.parse(payload);
			} catch {
				return;
			}
			const type = msg?.type;
			if (!type?.startsWith("init-") || initPayloadDone) return;
			initPayloadBytes += Buffer.byteLength(payload, "utf8");
			if (type === "init-complete") {
				initPayloadDone = true;
			}
		});
	});

	await page.goto(CONFIG.FRONTEND_URL);
	await page.evaluate(
		({ token, userName }: { token: string; userName: string }) => {
			sessionStorage.setItem("user", JSON.stringify({ token, userId: "", username: userName }));
			localStorage.setItem("wb_username", userName);
		},
		{ token: observer.token, userName: "Observer" }
	);
	await preparePageSideNavStart(page);
	await page.evaluate((storageKey: string) => {
		sessionStorage.setItem(storageKey, "1");
	}, BENCHMARK_NAV_START_KEY);

	const navStart = performance.now();
	await page.goto(`${CONFIG.FRONTEND_URL}/room`);
	await page.waitForSelector("canvas", { timeout: 30000 });
	const canvasReadyTs = performance.now();
	const expectedRenderedPoints = Math.max(1, Math.floor(injectedPoints * 0.9));
	await waitForFullRender(page, throttleCpu ? 120000 : 60000, expectedRenderedPoints);
	const doneTs = performance.now();

	const runtime = await readBenchmarkRuntime(page);
	const heap = await sampleHeap(page);

	await context.close();

	const workerFullRenderMs = Number(runtime?.lastFullRender?.durationMs || 0);
	const workerVisiblePaintMs = Number(runtime?.lastFullRender?.visiblePaintMs || 0);
	const initVisiblePaintMs = Number(runtime?.lastInit?.visiblePaintMs || 0);
	const initParseMs = Number(runtime?.lastInit?.parseDurationMs || 0);
	const initHydrateMs = Number(runtime?.lastInit?.hydrateDurationMs || 0);
	const initStreamTotalMs = Number(runtime?.lastInit?.totalDurationMs || 0);
	const fullRenderSignalPresent = workerFullRenderMs > 0;
	const appRenderMs = fullRenderSignalPresent
		? workerFullRenderMs
		: initVisiblePaintMs > 0
			? initVisiblePaintMs
			: 0;
	const appRenderSource = fullRenderSignalPresent
		? "worker-full-render"
		: initVisiblePaintMs > 0
			? "init-visible-paint"
			: "none";
	const visiblePaintMs = fullRenderSignalPresent
		? workerVisiblePaintMs
		: initVisiblePaintMs > 0
			? initVisiblePaintMs
			: 0;
	const visiblePaintSource = fullRenderSignalPresent
		? "worker-full-render"
		: initVisiblePaintMs > 0
			? "init-visible-paint"
			: "none";
	const sortAndFlattenMs = 0;
	const canvasClearMs = 0;
	const initMetaPayloadBytes = Number(runtime?.lastInit?.metaPayloadBytes || 0);
	const initChunkPayloadBytes = Number(runtime?.lastInit?.chunkPayloadBytes || 0);
	const normalizedInitMetaPayloadBytes =
		initMetaPayloadBytes > 0
			? initMetaPayloadBytes
			: initPayloadBytes > 0 && initChunkPayloadBytes <= 0
				? initPayloadBytes
				: 0;
	const normalizedInitChunkPayloadBytes =
		initChunkPayloadBytes > 0
			? initChunkPayloadBytes
			: initPayloadBytes > normalizedInitMetaPayloadBytes
				? initPayloadBytes - normalizedInitMetaPayloadBytes
				: 0;
	const totalVisibleMs =
		(runtime?.lastFullRender?.visiblePaintTs || 0) > 0 &&
		typeof (runtime as any)?.roomNavStartTs === "number"
			? Number(runtime.lastFullRender.visiblePaintTs) - Number((runtime as any).roomNavStartTs)
			: doneTs - navStart;
	const navToCanvasReadyMs = canvasReadyTs - navStart;
	const canvasReadyToVisibleMs = Math.max(0, totalVisibleMs - navToCanvasReadyMs);
	const estimatedResidualMs = Math.max(
		0,
		totalVisibleMs -
			appRenderMs -
			initParseMs -
			initHydrateMs
	);

	const heapStartMb = Number(heap?.startUsedMb || 0);
	const heapEndMb = Number(heap?.endUsedMb || 0);
	const normalizedHeapGrowthMb = heapStartMb > 0 ? heapEndMb - heapStartMb : 0;

	return {
		scale,
		shape,
		injectTimeMs,
		navToCanvasReadyMs,
		initPayloadBytes,
		initMetaPayloadBytes: normalizedInitMetaPayloadBytes,
		initChunkPayloadBytes: normalizedInitChunkPayloadBytes,
		initReceiveMs:
			(runtime?.lastInit?.receiveTs || 0) > 0 ? runtime.lastInit.receiveTs - navStart : 0,
		initParseMs,
		initChunkParseMs: Number(runtime?.lastInit?.chunkParseDurationMs || 0),
		initChunkHandleMs: Number(runtime?.lastInit?.chunkHandleDurationMs || 0),
		initChunkCount: Number(runtime?.lastInit?.chunkCount || 0),
		initChunkCommandCount: Number(runtime?.lastInit?.chunkCommandCount || 0),
		initChunkFlatPointCount: Number(runtime?.lastInit?.chunkFlatPointCount || 0),
		hydrateCommandsMs: initHydrateMs,
		initStreamTotalMs,
		sortAndFlattenMs,
		canvasClearMs,
		appRenderMs,
		appRenderSource,
		workerFullRenderMs,
		visiblePaintMs,
		visiblePaintSource,
		firstInteractiveMs: navToCanvasReadyMs,
		canvasReadyToVisibleMs,
		totalVisibleMs,
		estimatedResidualMs,
		renderThroughputPointsPerSec:
			fullRenderSignalPresent && appRenderMs > 0 ? scale / (appRenderMs / 1000) : 0,
		fullRenderSignalPresent,
		heapUsedMb: Number(heap?.lastUsedMb || 0),
		peakHeapMb: Number(heap?.peakUsedMb || heap?.lastUsedMb || 0),
		heapGrowthMb: Number(normalizedHeapGrowthMb),
	};
};

export const collectFullRenderSample = async (
	scale: number,
	browser: Browser,
	throttleCpu = false,
	shape: DatasetShape = "many-short-strokes"
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runFullRenderSuite(scale, browser, throttleCpu, shape);
		return {
			status: "passed",
			durationMs: performance.now() - startedAt,
			metrics: {
				scale: report.scale,
				navToCanvasReadyMs: report.navToCanvasReadyMs,
				initPayloadBytes: report.initPayloadBytes,
				initMetaPayloadBytes: report.initMetaPayloadBytes,
				initChunkPayloadBytes: report.initChunkPayloadBytes,
				initParseMs: report.initParseMs,
				initChunkParseMs: report.initChunkParseMs,
				initChunkHandleMs: report.initChunkHandleMs,
				initChunkCount: report.initChunkCount,
				initChunkCommandCount: report.initChunkCommandCount,
				initChunkFlatPointCount: report.initChunkFlatPointCount,
				hydrateCommandsMs: report.hydrateCommandsMs,
				initStreamTotalMs: report.initStreamTotalMs,
				sortAndFlattenMs: report.sortAndFlattenMs,
				canvasClearMs: report.canvasClearMs,
				appRenderMs: report.appRenderMs,
				appRenderSource: report.appRenderSource,
				workerFullRenderMs: report.workerFullRenderMs,
				visiblePaintMs: report.visiblePaintMs,
				visiblePaintSource: report.visiblePaintSource,
				firstInteractiveMs: report.firstInteractiveMs,
				canvasReadyToVisibleMs: report.canvasReadyToVisibleMs,
				totalVisibleMs: report.totalVisibleMs,
				estimatedResidualMs: report.estimatedResidualMs,
				renderThroughputPointsPerSec: report.renderThroughputPointsPerSec,
				fullRenderSignalPresent: report.fullRenderSignalPresent,
				heapUsedMb: report.heapUsedMb,
				peakHeapMb: report.peakHeapMb,
				heapGrowthMb: report.heapGrowthMb,
			},
		};
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: { scale },
			error: error?.message || "full render failed",
		};
	}
};
