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
	initReceiveMs: number;
	initParseMs: number;
	hydrateCommandsMs: number;
	sortAndFlattenMs: number;
	canvasClearMs: number;
	pureRenderMs: number;
	firstInteractiveMs: number;
	totalPerceivedMs: number;
	estimatedResidualMs: number;
	renderThroughputPointsPerSec: number;
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
	await Promise.all(injectors.map((injector) => injector.injectPoints(pointsPerClient, pointsPerStroke)));
	const injectTimeMs = performance.now() - injectStart;
	await new Promise((resolve) => setTimeout(resolve, 1500));
	injectors.forEach((injector) => injector.close());

	return injectTimeMs;
};

const waitForFullRender = async (page: Page, timeoutMs: number) =>
	page.waitForFunction(
		() => {
			const runtime = (window as any).__benchmarkRuntime;
			return runtime?.lastFullRender?.durationMs > 0 && runtime?.lastInit?.commandCount > 0;
		},
		undefined,
		{ timeout: timeoutMs }
	);

export const runFullRenderSuite = async (
	scale: number,
	browser: Browser,
	throttleCpu = false,
	shape: DatasetShape = "many-short-strokes"
): Promise<FullRenderReport> => {
	const roomId = String(Math.floor(100000 + Math.random() * 900000));
	await createRoom(roomId, `FullRender_${scale}_${shape}`);
	const injectTimeMs = await injectHistory(roomId, scale, shape);

	const observer = await joinRoom(roomId, "Observer");
	if (!observer) throw new Error("observer join failed");

	const { context, page } = await createContextAndPage(browser, throttleCpu);
	let initPayloadBytes = 0;

	page.on("websocket", (ws) => {
		ws.on("framereceived", (frame) => {
			const payload =
				typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
			if (payload.includes('"type":"init"')) {
				initPayloadBytes = Buffer.byteLength(payload, "utf8");
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

	const navStart = performance.now();
	await page.goto(`${CONFIG.FRONTEND_URL}/room`);
	await page.waitForSelector("canvas", { timeout: 30000 });
	const canvasReadyTs = performance.now();
	await waitForFullRender(page, throttleCpu ? 120000 : 60000);
	await page.waitForTimeout(250);
	const doneTs = performance.now();

	const runtime = await readBenchmarkRuntime(page);
	const heap = await sampleHeap(page);

	await context.close();

	const pureRenderMs = Number(runtime?.lastFullRender?.durationMs || 0);
	const sortAndFlattenMs = 0;
	const canvasClearMs = 0;
	const totalPerceivedMs = doneTs - navStart;
	const estimatedResidualMs = Math.max(
		0,
		totalPerceivedMs -
			pureRenderMs -
			(runtime?.lastInit?.parseDurationMs || 0) -
			(runtime?.lastInit?.hydrateDurationMs || 0)
	);

	return {
		scale,
		shape,
		injectTimeMs,
		navToCanvasReadyMs: canvasReadyTs - navStart,
		initPayloadBytes,
		initReceiveMs:
			(runtime?.lastInit?.receiveTs || 0) > 0 ? runtime.lastInit.receiveTs - navStart : 0,
		initParseMs: Number(runtime?.lastInit?.parseDurationMs || 0),
		hydrateCommandsMs: Number(runtime?.lastInit?.hydrateDurationMs || 0),
		sortAndFlattenMs,
		canvasClearMs,
		pureRenderMs,
		firstInteractiveMs: canvasReadyTs - navStart,
		totalPerceivedMs,
		estimatedResidualMs,
		renderThroughputPointsPerSec: pureRenderMs > 0 ? scale / (pureRenderMs / 1000) : 0,
		heapUsedMb: Number(heap?.lastUsedMb || 0),
		peakHeapMb: Number(heap?.peakUsedMb || heap?.lastUsedMb || 0),
		heapGrowthMb: Number((heap?.endUsedMb || 0) - (heap?.startUsedMb || 0)),
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
				initParseMs: report.initParseMs,
				hydrateCommandsMs: report.hydrateCommandsMs,
				sortAndFlattenMs: report.sortAndFlattenMs,
				canvasClearMs: report.canvasClearMs,
				pureRenderMs: report.pureRenderMs,
				firstInteractiveMs: report.firstInteractiveMs,
				totalPerceivedMs: report.totalPerceivedMs,
				estimatedResidualMs: report.estimatedResidualMs,
				renderThroughputPointsPerSec: report.renderThroughputPointsPerSec,
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
