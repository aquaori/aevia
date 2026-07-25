import path from "path";
import type { CaseCategory, CaseResult, CaseSample, MetricMap, MetricStats, SuiteContext } from "./types";
import {
	assertFrontendReachable,
	createLinePoints,
	createDistributedStrokePoints,
	createRoomWithUsers,
	joinRoom,
	ProtocolClient,
} from "./protocol-driver";
import {
	compareCanvasPages,
	captureCanvasSample,
	roiAround,
	saveCanvasPng,
	waitForCanvasChange,
	waitForNonBlankCanvas,
} from "./canvas-observer";
import { drawLine, drawLineLowLatency, openMeasuredRoomPage, openRoomPage, pressRedo, pressUndo } from "./ui-driver";
import { readPerformanceObserver } from "./performance-observer";
import { ensureDir } from "./reporter";
import {
	capturePagePng,
	classifyCrash,
	createBoundaryProbe,
	waitForScreenshotChange,
} from "./cdp-observer";
import { logCaseEnd, logCaseStart, logStep } from "./cli-progress";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const CASE_META: Record<string, { title: string; description: string; category: CaseCategory }> = {
	"harness-health": {
		title: "Harness health",
		description: "验证前端可访问、后端 create/join、WebSocket 握手、协议驱动远端绘制和 canvas ROI 外部观测链路。",
		category: "harness",
	},
	"correctness-smoke": {
		title: "Correctness smoke",
		description: "双端真实绘制互相可见，撤销/重做后最终 canvas 截图一致，并覆盖基础翻页返回。",
		category: "correctness",
	},
	"concurrent-crossing-visual-consistency": {
		title: "Concurrent crossing consistency",
		description: "两个浏览器同时交叉绘制，最终只用 canvas 截图和 pixel diff 验证视觉一致性。",
		category: "correctness",
	},
	"late-joiner-visual-consistency": {
		title: "Late joiner consistency",
		description: "后加入用户加载已有历史内容后，与原用户最终 canvas 截图保持一致。",
		category: "correctness",
	},
	"protocol-multipage-isolation": {
		title: "Protocol multipage isolation",
		description: "通过公开协议制造多页历史，验证 late observer 切页后不同页内容可见且可返回。",
		category: "correctness",
	},
	"full-render": {
		title: "Full render late joiner",
		description: "公开 WebSocket 协议制造大量历史点，测量 late joiner 首个非空画面和视觉稳定时间。",
		category: "performance",
	},
	"incremental-remote-first-pixel": {
		title: "Incremental remote first pixel",
		description: "从测试侧发送公开 WebSocket 远端笔画，到 observer 目标 ROI 首次出现像素变化。",
		category: "performance",
	},
	"local-realtime-first-pixel": {
		title: "Local realtime first pixel",
		description: "Playwright 真实 pointer 绘制后，目标 ROI 首次出现像素变化的耗时和帧数。",
		category: "performance",
	},
	"boundary-full-render-until-crash": {
		title: "Boundary full render until crash",
		description: "外部协议制造阶梯历史数据，用 Playwright/CDP 硬指标寻找全量初始化的 renderer/page/browser 边界。",
		category: "boundary",
	},
	"boundary-same-page-heap-growth": {
		title: "Boundary same-page heap growth",
		description: "同一页多轮注入和重载后，通过 CDP JS heap 与 DOM counter 观察内存增长边界。",
		category: "boundary",
	},
	"boundary-incremental-redraw-freeze": {
		title: "Boundary incremental redraw freeze",
		description: "多协议客户端并发局部重绘，用外部截图、CDP heap 和输入耗时观察软卡死边界。",
		category: "boundary",
	},
	"resilience-network-recovery": {
		title: "Network latency recovery",
		description: "通过 CDP 网络模拟长延迟和离线恢复，观测页面恢复到可绘制状态的时间。",
		category: "performance",
	},
};

const withMeta = (context: SuiteContext, id: string, result: CaseResult): CaseResult => {
	const key = id.startsWith("full-render-") ? "full-render" : id;
	const meta = CASE_META[key];
	return {
		...result,
		title: result.title || meta?.title,
		description: result.description || meta?.description,
		category: result.category || meta?.category,
		environment: context.config.environment,
		runMode: context.config.mode,
	};
};

const runCase = async (
	context: SuiteContext,
	id: string,
	fn: () => Promise<Omit<CaseResult, "id" | "durationMs">>
): Promise<CaseResult> => {
	const startedAt = performance.now();
	const meta = CASE_META[id.startsWith("full-render-") ? "full-render" : id];
	logCaseStart(id, meta?.title || id, meta?.description);
	try {
		const result = await fn();
		const finalResult = withMeta(context, id, { id, durationMs: performance.now() - startedAt, ...result });
		logCaseEnd(finalResult);
		return finalResult;
	} catch (error: unknown) {
		const message = errorMessage(error);
		const failureType = message.includes("unreachable") ||
			message.includes("create-room") ||
			message.includes("join-room") ||
			message.includes("websocket") ||
			message.includes("protocol")
			? "harness"
			: message.includes("timeout")
				? "timeout"
				: "correctness";
		const finalResult = withMeta(context, id, {
			id,
			status: "failed",
			failureType,
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: message,
		});
		logCaseEnd(finalResult);
		return finalResult;
	}
};

const percentile = (values: number[], p: number) => {
	if (values.length === 0) return 0;
	const index = Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1);
	return values[index]!;
};

const median = (values: number[]) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const medianAbsoluteDeviation = (values: number[], center: number) => {
	if (values.length === 0) return 0;
	return median(values.map((value) => Math.abs(value - center)));
};

const aggregateSamples = (samples: CaseSample[]): Record<string, MetricStats> => {
	const keys = new Set<string>();
	for (const sample of samples) {
		for (const [key, value] of Object.entries(sample.metrics)) {
			if (typeof value === "number" && Number.isFinite(value)) keys.add(key);
		}
	}
	const aggregate: Record<string, MetricStats> = {};
	for (const key of keys) {
		const values = samples
			.map((sample) => sample.metrics[key])
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
			.sort((a, b) => a - b);
		aggregate[key] = {
			min: values[0]!,
			median: percentile(values, 50),
			mean: values.reduce((sum, value) => sum + value, 0) / values.length,
			p95: percentile(values, 95),
			max: values[values.length - 1]!,
		};
	}
	return aggregate;
};

const medianMetrics = (aggregate: Record<string, MetricStats>): MetricMap => {
	const metrics: MetricMap = {};
	for (const [key, stats] of Object.entries(aggregate)) {
		metrics[`${key}Median`] = stats.median;
	}
	return metrics;
};

const assessSampleQuality = (id: string, samples: CaseSample[]) => {
	const measuredPassed = samples.filter((sample) => !sample.warmup && sample.status === "passed");
	for (const sample of measuredPassed) {
		sample.qualityStatus = "valid";
	}

	if (id.startsWith("full-render-")) {
		const ratios = measuredPassed
			.map((sample) => sample.metrics.nonBlankRatio)
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		const ratioMedian = median(ratios);
		const ratioFloor = Math.max(0.02, ratioMedian * 0.6);
		for (const sample of measuredPassed) {
			const ratio = sample.metrics.nonBlankRatio;
			if (typeof ratio === "number" && ratio < ratioFloor) {
				sample.qualityStatus = "invalid_quality";
				sample.qualityReason = `nonBlankRatio ${ratio.toFixed(4)} 低于质量下限 ${ratioFloor.toFixed(4)}`;
			}
		}
	}

	const validMeasured = measuredPassed.filter((sample) => sample.qualityStatus === "valid");
	if (validMeasured.length < 3) return;

	const outlierMetrics = id.startsWith("full-render-")
		? ["firstNonBlankMs", "visuallyStableMs"]
		: id === "incremental-remote-first-pixel"
			? ["remoteFirstPixelMs"]
			: id === "local-realtime-first-pixel"
				? ["inputToFirstPixelMs"]
				: [];

	for (const metric of outlierMetrics) {
		const values = validMeasured
			.map((sample) => sample.metrics[metric])
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
		if (values.length < 3) continue;
		const logs = values.map((value) => Math.log(value));
		const center = median(logs);
		const mad = medianAbsoluteDeviation(logs, center);
		if (mad === 0) continue;
		const sigma = 1.4826 * mad;
		for (const sample of validMeasured) {
			const value = sample.metrics[metric];
			if (typeof value !== "number" || value <= 0) continue;
			const zScore = Math.abs((Math.log(value) - center) / sigma);
			if (zScore > 3) {
				sample.qualityStatus = "outlier";
				sample.qualityReason = `${metric} 偏离同组样本中位数过大 (robust z=${zScore.toFixed(2)})`;
			}
		}
	}
};

const runSampledCase = async (
	context: SuiteContext,
	id: string,
	fn: (sampleIndex: number, warmup: boolean) => Promise<MetricMap>,
	options: { scale?: number } = {}
): Promise<CaseResult> => {
	const startedAt = performance.now();
	const samples: CaseSample[] = [];
	const meta = CASE_META[id.startsWith("full-render-") ? "full-render" : id];
	logCaseStart(
		id,
		meta?.title || id,
		meta?.description,
		[
			options.scale ? `scale=${options.scale}` : "",
			`runs=${context.config.runs}`,
			`warmup=${context.config.warmup}`,
		].filter(Boolean).join(" ")
	);
	for (let index = 0; index < context.config.warmup + context.config.runs; index += 1) {
		const warmup = index < context.config.warmup;
		const run = warmup ? index + 1 : index - context.config.warmup + 1;
		const sampleStartedAt = performance.now();
		logStep(`${id}: ${warmup ? "warmup" : "run"} ${run}/${warmup ? context.config.warmup : context.config.runs}`);
		try {
			const metrics = await fn(run, warmup);
			samples.push({
				run,
				warmup,
				status: "passed",
				durationMs: performance.now() - sampleStartedAt,
				metrics,
			});
		} catch (error: unknown) {
			samples.push({
				run,
				warmup,
				status: "failed",
				durationMs: performance.now() - sampleStartedAt,
				metrics: {},
				error: errorMessage(error),
			});
		}
	}
	assessSampleQuality(id, samples);
	const measuredSamples = samples.filter((sample) => !sample.warmup);
	const failedSample = measuredSamples.find((sample) => sample.status === "failed");
	const validSamples = measuredSamples.filter(
		(sample) => sample.status === "passed" && (sample.qualityStatus === undefined || sample.qualityStatus === "valid")
	);
	const invalidSamples = measuredSamples.filter(
		(sample) => sample.status === "passed" && sample.qualityStatus && sample.qualityStatus !== "valid"
	);
	if (!failedSample && validSamples.length === 0) {
		const finalResult = withMeta(context, id, {
			id,
			scale: options.scale,
			status: "failed",
			failureType: "performance",
			durationMs: performance.now() - startedAt,
			metrics: {
				environment: context.config.environment,
				runMode: context.config.mode,
				runs: context.config.runs,
				warmup: context.config.warmup,
				validSampleCount: 0,
				invalidSampleCount: invalidSamples.length,
			},
			samples,
			aggregate: {},
			error: invalidSamples.map((sample) => sample.qualityReason || "invalid sample").join("；"),
		});
		logCaseEnd(finalResult);
		return finalResult;
	}
	const aggregate = aggregateSamples(validSamples);
	const finalResult = withMeta(context, id, {
		id,
		scale: options.scale,
		status: failedSample ? "failed" : "passed",
		failureType: failedSample ? "performance" : "none",
		durationMs: performance.now() - startedAt,
		metrics: {
			environment: context.config.environment,
			runMode: context.config.mode,
			runs: context.config.runs,
			warmup: context.config.warmup,
			validSampleCount: validSamples.length,
			invalidSampleCount: invalidSamples.length,
			...medianMetrics(aggregate),
		},
		samples,
		aggregate,
		error: failedSample?.error,
	});
	logCaseEnd(finalResult);
	return finalResult;
};

const artifactDir = (context: SuiteContext, name: string) => {
	const dir = path.join(context.artifactRoot, name);
	ensureDir(dir);
	return dir;
};

const openBoundaryRoomPage = async (context: SuiteContext, user: { token: string; userName: string }) => {
	const probe = await createBoundaryProbe(context.browser, { cpuThrottle: context.config.cpuThrottle });
	const loadStartedAt = performance.now();
	await probe.page.goto(context.config.frontendUrl);
	await probe.page.evaluate(({ token, userName }: { token: string; userName: string }) => {
		sessionStorage.setItem("user", JSON.stringify({ token, userId: "", username: userName }));
		localStorage.setItem("wb_username", userName);
	}, { token: user.token, userName: user.userName });
	await probe.page.goto(`${context.config.frontendUrl}/room`, {
		waitUntil: "domcontentloaded",
		timeout: context.config.caseTimeoutMs,
	});
	await probe.page.locator("canvas").first().waitFor({ timeout: context.config.caseTimeoutMs });
	return {
		probe,
		roomLoadMs: performance.now() - loadStartedAt,
	};
};

const seedRoomPoints = async (
	context: SuiteContext,
	pointCount: number,
	options: {
		roomId?: string;
		userName?: string;
		pointsPerStroke?: number;
		deadlineAt?: number;
		progressLabel?: string;
	} = {}
) => {
	const roomId = options.roomId || await createRoomWithUsers(context.config, []).then((room) => room.roomId);
	const user = await joinRoom(context.config, roomId, options.userName || `BoundaryBot${pointCount}`);
	const bot = new ProtocolClient(context.config, user);
	await bot.connect();
	const pointsPerStroke = options.pointsPerStroke || context.config.boundaryPointsPerStroke;
	const strokes = Math.max(1, Math.ceil(pointCount / pointsPerStroke));
	let nextProgressPercent = 10;
	try {
		for (let index = 0; index < strokes; index += 1) {
			if (options.deadlineAt && Date.now() > options.deadlineAt) {
				throw new Error(`${options.progressLabel || "seed"} exceeded ${context.config.seedTimeoutMs}ms while injecting ${pointCount} points`);
			}
			await bot.sendCommittedStroke({
				points: createDistributedStrokePoints(
					Math.min(pointsPerStroke, pointCount - index * pointsPerStroke),
					index,
					strokes
				),
				color: index % 2 === 0 ? "#111827" : "#2563eb",
				size: 2 + (index % 2),
			});
			const progressPercent = Math.floor(((index + 1) / strokes) * 100);
			if (progressPercent >= nextProgressPercent) {
				logStep(`${options.progressLabel || "seed"}: injected ${progressPercent}% (${Math.min(pointCount, (index + 1) * pointsPerStroke)}/${pointCount} points)`);
				nextProgressPercent += 10;
			}
		}
	} finally {
		bot.close();
	}
	return { roomId, user };
};

const maxNumber = (...values: Array<number | undefined>) =>
	Math.max(0, ...values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)));

type BoundaryFullRenderSeed = {
	roomId: string;
	seedDurationMs: number;
};

let boundaryFullRenderSeedCache:
	| {
			key: string;
			rooms: Map<number, BoundaryFullRenderSeed>;
	  }
	| null = null;

const boundarySeedCacheKey = (context: SuiteContext) =>
	[
		context.config.apiUrl,
		context.config.wsUrl,
		context.config.boundaryScales.join(","),
		context.config.boundaryPointsPerStroke,
	].join("|");

const prepareBoundaryFullRenderRooms = async (context: SuiteContext) => {
	const key = boundarySeedCacheKey(context);
	if (boundaryFullRenderSeedCache?.key === key) {
		logStep(`boundary full render: reusing ${boundaryFullRenderSeedCache.rooms.size} preseeded rooms`);
		return boundaryFullRenderSeedCache.rooms;
	}

	const rooms = new Map<number, BoundaryFullRenderSeed>();
	boundaryFullRenderSeedCache = { key, rooms };
	logStep(`boundary full render: preseed ${context.config.boundaryScales.length} reusable rooms`);
	for (const scale of context.config.boundaryScales) {
		const startedAt = performance.now();
		const deadlineAt = Date.now() + context.config.seedTimeoutMs;
		logStep(`boundary full render preseed: scale=${scale}`);
		const { roomId } = await seedRoomPoints(context, scale, {
			deadlineAt,
			progressLabel: `boundary full render preseed scale=${scale}`,
		});
		rooms.set(scale, {
			roomId,
			seedDurationMs: performance.now() - startedAt,
		});
	}
	return rooms;
};

const runBoundaryFullRender = async (context: SuiteContext) =>
	runCase(context, "boundary-full-render-until-crash", async () => {
		const preseededRooms = await prepareBoundaryFullRenderRooms(context);
		const records: MetricMap[] = [];
		let lastSurvivedScale = 0;
		let firstCrashScale = 0;
		let crashType = "none";
		let peakJsHeapMb = 0;
		let peakTotalHeapMb = 0;

		for (const scale of context.config.boundaryScales) {
			logStep(`boundary full render: scale=${scale}`);
			const scaleStartedAt = performance.now();
			let probe: Awaited<ReturnType<typeof createBoundaryProbe>> | null = null;
			try {
				const seed = preseededRooms.get(scale);
				if (!seed) {
					throw new Error(`boundary full render scale=${scale} has no preseeded room`);
				}
				const { roomId } = seed;
				const observerUser = await joinRoom(context.config, roomId, `BoundaryObserver${scale}`);
				const opened = await openBoundaryRoomPage(context, observerUser);
				probe = opened.probe;
				await probe.page.waitForTimeout(300);
				const metrics = await probe.readMetrics();
				await probe.collectGarbage();
				const postGc = await probe.readMetrics();
				const scaleCrashType = classifyCrash(probe.crash);
				peakJsHeapMb = maxNumber(peakJsHeapMb, metrics.usedHeapMb, metrics.jsHeapUsedMb);
				peakTotalHeapMb = maxNumber(peakTotalHeapMb, metrics.totalHeapMb, metrics.jsHeapTotalMb);
				records.push({
					scale,
					status: scaleCrashType === "none" ? "survived" : "crashed",
					crashType: scaleCrashType,
					roomLoadMs: opened.roomLoadMs,
					usedHeapMb: metrics.usedHeapMb,
					jsHeapUsedMb: metrics.jsHeapUsedMb,
					totalHeapMb: metrics.totalHeapMb,
					jsHeapTotalMb: metrics.jsHeapTotalMb,
					postGcHeapMb: postGc.usedHeapMb ?? postGc.jsHeapUsedMb,
					nodeCount: metrics.nodeCount,
					documentCount: metrics.documentCount,
					seedDurationMs: seed.seedDurationMs,
					durationMs: performance.now() - scaleStartedAt,
				});
				if (scaleCrashType !== "none") {
					firstCrashScale = scale;
					crashType = scaleCrashType;
					break;
				}
				lastSurvivedScale = scale;
			} catch (error: unknown) {
				firstCrashScale = scale;
				const message = errorMessage(error);
				crashType = message.includes("exceeded") ? "scale-timeout" : message.includes("crash") ? "page-crash" : "harness-or-cdp-error";
				records.push({
					scale,
					status: "crashed",
					crashType,
					error: message,
					durationMs: performance.now() - scaleStartedAt,
				});
				break;
			} finally {
				await probe?.close();
			}
		}

		return {
			status: "passed",
			failureType: "none",
			metrics: {
				boundaryKind: "hard-boundary",
				lastSurvivedScale,
				firstCrashScale,
				crashType,
				peakJsHeapMb,
				peakTotalHeapMb,
				scaleRecords: JSON.stringify(records),
			},
		};
	});

const runBoundaryHeapGrowth = async (context: SuiteContext) =>
	runCase(context, "boundary-same-page-heap-growth", async () => {
		const scale = context.config.boundaryScales[0] || context.config.scales[0] || 100000;
		const records: MetricMap[] = [];
		let roomId: string | null = null;
		let baselinePostGcHeapMb = 0;
		let latestPostGcHeapMb = 0;
		let peakJsHeapMb = 0;
		let crashType = "none";

		for (let round = 1; round <= 3; round += 1) {
			logStep(`same-page heap growth: round=${round}/3 inject=${scale} points`);
			const deadlineAt = Date.now() + context.config.seedTimeoutMs;
			let probe: Awaited<ReturnType<typeof createBoundaryProbe>> | null = null;
			try {
				const seeded = await seedRoomPoints(context, scale, {
					roomId: roomId || undefined,
					userName: `HeapBot${round}`,
					deadlineAt,
					progressLabel: `same-page heap round=${round}`,
				});
				roomId = seeded.roomId;
				const observerUser = await joinRoom(context.config, roomId, `HeapObserver${round}`);
				const opened = await openBoundaryRoomPage(context, observerUser);
				probe = opened.probe;
				await probe.page.waitForTimeout(300);
				const metrics = await probe.readMetrics();
				await probe.collectGarbage();
				const postGc = await probe.readMetrics();
				const postGcHeapMb = postGc.usedHeapMb ?? postGc.jsHeapUsedMb ?? 0;
				if (round === 1) baselinePostGcHeapMb = postGcHeapMb;
				latestPostGcHeapMb = postGcHeapMb;
				peakJsHeapMb = maxNumber(peakJsHeapMb, metrics.usedHeapMb, metrics.jsHeapUsedMb);
				const scaleCrashType = classifyCrash(probe.crash);
				records.push({
					round,
					scale,
					totalInjectedPoints: scale * round,
					roomLoadMs: opened.roomLoadMs,
					usedHeapMb: metrics.usedHeapMb,
					jsHeapUsedMb: metrics.jsHeapUsedMb,
					postGcHeapMb,
					heapGrowthMb: Number((postGcHeapMb - baselinePostGcHeapMb).toFixed(2)),
					nodeCount: metrics.nodeCount,
					documentCount: metrics.documentCount,
					crashType: scaleCrashType,
				});
				if (scaleCrashType !== "none") {
					crashType = scaleCrashType;
					break;
				}
			} catch (error: unknown) {
				crashType = "harness-or-cdp-error";
				records.push({ round, scale, error: errorMessage(error), crashType });
				break;
			} finally {
				await probe?.close();
			}
		}

		return {
			status: "passed",
			failureType: "none",
			metrics: {
				boundaryKind: "hard-boundary",
				scale,
				crashType,
				peakJsHeapMb,
				baselinePostGcHeapMb,
				latestPostGcHeapMb,
				heapGrowthMb: Number((latestPostGcHeapMb - baselinePostGcHeapMb).toFixed(2)),
				scaleRecords: JSON.stringify(records),
			},
		};
	});

const runBoundaryIncrementalFreeze = async (context: SuiteContext) =>
	runCase(context, "boundary-incremental-redraw-freeze", async () => {
		const records: MetricMap[] = [];
		let lastSurvivedConcurrency = 0;
		let firstCrashConcurrency = 0;
		let crashType = "none";
		let peakJsHeapMb = 0;

		for (const concurrency of context.config.concurrencyLevels) {
			logStep(`incremental redraw flood: concurrency=${concurrency}`);
			let observerProbe: Awaited<ReturnType<typeof createBoundaryProbe>> | null = null;
			const bots: ProtocolClient[] = [];
			try {
				const { roomId } = await createRoomWithUsers(context.config, ["IncBoundarySeed"]);
				const observerUser = await joinRoom(context.config, roomId, `IncObserver${concurrency}`);
				const opened = await openBoundaryRoomPage(context, observerUser);
				observerProbe = opened.probe;
				const roi = roiAround(480, 330, 260);
				const baseline = await capturePagePng(observerProbe.page, roi);
				const users = await Promise.all(
					Array.from({ length: concurrency }, (_, index) =>
						joinRoom(context.config, roomId, `IncBot${concurrency}_${index}`)
					)
				);
				for (const user of users) {
					const bot = new ProtocolClient(context.config, user);
					await bot.connect();
					bots.push(bot);
				}
				const startedAt = performance.now();
				await Promise.all(
					bots.map((bot, index) =>
						bot.sendCommittedStroke({
							points: createLinePoints(32, { x: 0.12 + (index % 12) * 0.05, y: 0.25 }, { x: 0.003, y: 0.002 }),
							color: index % 2 === 0 ? "#dc2626" : "#2563eb",
							size: 4,
						})
					)
				);
				const changed = await waitForScreenshotChange(observerProbe.page, baseline, {
					roi,
					timeoutMs: context.config.freezeMs,
					minDiffRatio: 0.003,
				}).catch((error: unknown) => ({
					elapsedMs: context.config.freezeMs,
					frames: 0,
					diffRatio: 0,
					error: errorMessage(error),
				}));
				const metrics = await observerProbe.readMetrics();
				const scaleCrashType = classifyCrash(observerProbe.crash);
				peakJsHeapMb = maxNumber(peakJsHeapMb, metrics.usedHeapMb, metrics.jsHeapUsedMb);
				records.push({
					concurrency,
					dispatchMs: performance.now() - startedAt,
					firstScreenshotChangeMs: changed.elapsedMs,
					screenshotPolls: changed.frames,
					roiDiffRatio: changed.diffRatio,
					softFreeze: changed.elapsedMs >= context.config.freezeMs,
					crashType: scaleCrashType,
					usedHeapMb: metrics.usedHeapMb,
					jsHeapUsedMb: metrics.jsHeapUsedMb,
				});
				if (scaleCrashType !== "none") {
					firstCrashConcurrency = concurrency;
					crashType = scaleCrashType;
					break;
				}
				lastSurvivedConcurrency = concurrency;
			} finally {
				bots.forEach((bot) => bot.close());
				await observerProbe?.close();
			}
		}

		return {
			status: "passed",
			failureType: "none",
			metrics: {
				boundaryKind: "soft-freeze-boundary",
				lastSurvivedConcurrency,
				firstCrashConcurrency,
				crashType,
				peakJsHeapMb,
				scaleRecords: JSON.stringify(records),
			},
		};
	});

const runNetworkRecovery = async (context: SuiteContext) =>
	runCase(context, "resilience-network-recovery", async () => {
		const records: MetricMap[] = [];
		let worstRecoveryMs = 0;
		for (const latencyMs of context.config.latencies) {
			logStep(`network recovery: latency=${latencyMs}ms`);
			let probe: Awaited<ReturnType<typeof createBoundaryProbe>> | null = null;
			try {
				const { users } = await createRoomWithUsers(context.config, ["NetworkObserver", "NetworkBot"]);
				const opened = await openBoundaryRoomPage(context, users[0]!);
				probe = opened.probe;
				await probe.client.send("Network.enable").catch(() => undefined);
				await probe.client.send("Network.emulateNetworkConditions", {
					offline: false,
					latency: latencyMs,
					downloadThroughput: 64 * 1024,
					uploadThroughput: 64 * 1024,
				}).catch(() => undefined);
				await probe.client.send("Network.emulateNetworkConditions", {
					offline: true,
					latency: 0,
					downloadThroughput: 0,
					uploadThroughput: 0,
				}).catch(() => undefined);
				await probe.page.waitForTimeout(500);
				const recoveryStartedAt = performance.now();
				await probe.client.send("Network.emulateNetworkConditions", {
					offline: false,
					latency: latencyMs,
					downloadThroughput: 64 * 1024,
					uploadThroughput: 64 * 1024,
				}).catch(() => undefined);
				const bot = new ProtocolClient(context.config, users[1]!);
				await bot.connect();
				const roi = roiAround(520, 330, 260);
				const baseline = await capturePagePng(probe.page, roi);
				bot.sendStroke({
					points: createLinePoints(32, { x: 0.35, y: 0.35 }, { x: 0.004, y: 0.002 }),
					color: "#111827",
					size: 5,
				});
				const changed = await waitForScreenshotChange(probe.page, baseline, {
					roi,
					timeoutMs: context.config.caseTimeoutMs,
					minDiffRatio: 0.003,
				});
				bot.close();
				const recoveryMs = performance.now() - recoveryStartedAt;
				worstRecoveryMs = Math.max(worstRecoveryMs, recoveryMs);
				const metrics = await probe.readMetrics();
				records.push({
					latencyMs,
					recoveryMs,
					firstScreenshotChangeMs: changed.elapsedMs,
					roiDiffRatio: changed.diffRatio,
					crashType: classifyCrash(probe.crash),
					usedHeapMb: metrics.usedHeapMb,
					jsHeapUsedMb: metrics.jsHeapUsedMb,
				});
			} finally {
				await probe?.close();
			}
		}

		return {
			status: "passed",
			failureType: "none",
			metrics: {
				worstRecoveryMs,
				latencyRecords: JSON.stringify(records),
			},
		};
	});

export const runHarnessHealth = async (context: SuiteContext): Promise<CaseResult[]> => [
	await runCase(context, "harness-health", async () => {
		await assertFrontendReachable(context.config);
		const { users } = await createRoomWithUsers(context.config, ["HealthObserver", "HealthBot"]);
		const observer = await openRoomPage(context.browser, context.config, users[0]!);
		const bot = new ProtocolClient(context.config, users[1]!);
		await bot.connect();
		const baseline = await captureCanvasSample(observer.page, roiAround(320, 260));
		bot.sendStroke({
			points: createLinePoints(24, { x: 0.18, y: 0.28 }, { x: 0.006, y: 0.004 }),
			color: "#111111",
			size: 6,
		});
		const changed = await waitForCanvasChange(observer.page, baseline, {
			roi: roiAround(320, 260),
			timeoutMs: 12000,
			minDiffRatio: 0.005,
			sampleSize: 72,
		});
		bot.close();
		await observer.close();
		return {
			status: "passed",
			failureType: "none",
			metrics: {
				remoteFirstPixelMs: changed.elapsedMs,
				framesToFirstPixel: changed.frames,
				roiDiffRatio: changed.diffRatio,
			},
		};
	}),
];

export const runCorrectnessSmoke = async (context: SuiteContext): Promise<CaseResult[]> => [
	...(await runHarnessHealth(context)),
	await runCase(context, "correctness-smoke", async () => {
		const dir = artifactDir(context, "correctness-smoke");
		const { users } = await createRoomWithUsers(context.config, ["SmokeA", "SmokeB"]);
		const pageA = await openRoomPage(context.browser, context.config, users[0]!);
		const pageB = await openRoomPage(context.browser, context.config, users[1]!);

		const bBaseline = await captureCanvasSample(pageB.page, roiAround(300, 300));
		const localDrawMs = await drawLine(pageA.page, 220, 220, 420, 360, 16);
		const bChanged = await waitForCanvasChange(pageB.page, bBaseline, {
			roi: roiAround(320, 290),
			timeoutMs: 12000,
			minDiffRatio: 0.005,
			sampleSize: 72,
		});

		const aBaseline = await captureCanvasSample(pageA.page, roiAround(720, 360));
		await drawLine(pageB.page, 640, 260, 820, 440, 16);
		const aChanged = await waitForCanvasChange(pageA.page, aBaseline, {
			roi: roiAround(730, 350),
			timeoutMs: 12000,
			minDiffRatio: 0.005,
			sampleSize: 72,
		});

		await pressUndo(pageA.page);
		await pageB.page.waitForTimeout(900);
		await pressRedo(pageA.page);
		await pageB.page.waitForTimeout(1200);
		const diff = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "final-diff.png"),
			threshold: 0.01,
		});
		const artifacts = [
			await saveCanvasPng(pageA.page, path.join(dir, "page-a.png")),
			await saveCanvasPng(pageB.page, path.join(dir, "page-b.png")),
			path.join(dir, "final-diff.png"),
		];

		await pageA.page.keyboard.press("ArrowRight");
		await drawLine(pageA.page, 260, 460, 460, 500, 10);
		await pageA.page.keyboard.press("ArrowLeft");
		await pageA.page.waitForTimeout(500);
		const revisit = await captureCanvasSample(pageA.page);

		await pageA.close();
		await pageB.close();

		if (diff.diffRatio > diff.passThreshold) {
			return {
				status: "failed",
				failureType: "correctness",
				metrics: { finalConsistencyDiffRatio: diff.diffRatio, passThreshold: diff.passThreshold },
				error: `canvas mismatch: diffRatio=${diff.diffRatio}`,
				artifacts,
			};
		}

		return {
			status: "passed",
			failureType: "none",
			metrics: {
				inputToFirstPixelMs: localDrawMs,
				remoteFirstPixelMsAtoB: bChanged.elapsedMs,
				framesToFirstPixelAtoB: bChanged.frames,
				remoteFirstPixelMsBtoA: aChanged.elapsedMs,
				framesToFirstPixelBtoA: aChanged.frames,
				finalConsistencyDiffRatio: diff.diffRatio,
				revisitNonBlankRatio: revisit.nonBlankRatio,
			},
			artifacts,
		};
	}),
];

export const runCorrectnessFull = async (context: SuiteContext): Promise<CaseResult[]> => [
	...(await runCorrectnessSmoke(context)),
	await runCase(context, "concurrent-crossing-visual-consistency", async () => {
		const dir = artifactDir(context, "concurrent-crossing-visual-consistency");
		const { users } = await createRoomWithUsers(context.config, ["CrossA", "CrossB"]);
		const pageA = await openRoomPage(context.browser, context.config, users[0]!);
		const pageB = await openRoomPage(context.browser, context.config, users[1]!);
		await Promise.all([
			drawLine(pageA.page, 520, 260, 760, 500, 24),
			drawLine(pageB.page, 760, 260, 520, 500, 24),
		]);
		await Promise.all([
			drawLine(pageA.page, 640, 220, 640, 520, 24),
			drawLine(pageB.page, 500, 380, 780, 380, 24),
		]);
		await pageA.page.waitForTimeout(1800);
		await pageB.page.waitForTimeout(1800);
		const diff = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "crossing-diff.png"),
			threshold: 0.012,
		});
		const artifacts = [
			await saveCanvasPng(pageA.page, path.join(dir, "page-a.png")),
			await saveCanvasPng(pageB.page, path.join(dir, "page-b.png")),
			path.join(dir, "crossing-diff.png"),
		];
		await pageA.close();
		await pageB.close();
		return {
			status: diff.diffRatio <= diff.passThreshold ? "passed" : "failed",
			failureType: diff.diffRatio <= diff.passThreshold ? "none" : "correctness",
			metrics: { diffRatio: diff.diffRatio, passThreshold: diff.passThreshold },
			error: diff.diffRatio <= diff.passThreshold ? undefined : `concurrent crossing mismatch: ${diff.diffRatio}`,
			artifacts,
		};
	}),
	await runCase(context, "late-joiner-visual-consistency", async () => {
		const dir = artifactDir(context, "late-joiner-visual-consistency");
		const { roomId, users } = await createRoomWithUsers(context.config, ["LateA"]);
		const pageA = await openRoomPage(context.browser, context.config, users[0]!);
		await drawLine(pageA.page, 200, 200, 500, 380, 30);
		await drawLine(pageA.page, 200, 420, 520, 220, 30);
		await pageA.page.waitForTimeout(1000);
		const lateUser = await joinRoom(context.config, roomId, "LateB");
		const pageB = await openRoomPage(context.browser, context.config, lateUser);
		await waitForNonBlankCanvas(pageB.page, { timeoutMs: 15000 });
		const diff = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "late-diff.png"),
			threshold: 0.01,
		});
		const artifacts = [
			await saveCanvasPng(pageA.page, path.join(dir, "page-a.png")),
			await saveCanvasPng(pageB.page, path.join(dir, "page-b.png")),
			path.join(dir, "late-diff.png"),
		];
		await pageA.close();
		await pageB.close();
		return {
			status: diff.diffRatio <= diff.passThreshold ? "passed" : "failed",
			failureType: diff.diffRatio <= diff.passThreshold ? "none" : "correctness",
			metrics: { diffRatio: diff.diffRatio, passThreshold: diff.passThreshold },
			error: diff.diffRatio <= diff.passThreshold ? undefined : `late joiner mismatch: ${diff.diffRatio}`,
			artifacts,
		};
	}),
	await runCase(context, "protocol-multipage-isolation", async () => {
		const dir = artifactDir(context, "protocol-multipage-isolation");
		const { roomId, users } = await createRoomWithUsers(context.config, ["PageObserver", "PageBot"]);
		const bot = new ProtocolClient(context.config, users[1]!);
		await bot.connect();
		bot.sendRaw("cmd-page-add", {
			userId: users[1]!.userId,
			username: users[1]!.userName,
			totalPages: 2,
		});
		bot.sendStroke({
			pageId: 0,
			points: createLinePoints(36, { x: 0.18, y: 0.28 }, { x: 0.006, y: 0.003 }),
			color: "#111827",
			size: 5,
		});
		bot.sendStroke({
			pageId: 1,
			points: createLinePoints(36, { x: 0.62, y: 0.32 }, { x: -0.005, y: 0.004 }),
			color: "#2563eb",
			size: 5,
		});

		const observerUser = await joinRoom(context.config, roomId, "PageLateObserver");
		const observer = await openRoomPage(context.browser, context.config, observerUser);
		const page0 = await waitForNonBlankCanvas(observer.page, { timeoutMs: 15000 });
		const page0Path = await saveCanvasPng(observer.page, path.join(dir, "page-0.png"));
		await observer.page.keyboard.press("ArrowRight");
		const page1 = await waitForNonBlankCanvas(observer.page, { timeoutMs: 15000 });
		const page1Path = await saveCanvasPng(observer.page, path.join(dir, "page-1.png"));
		await observer.page.keyboard.press("ArrowLeft");
		await waitForNonBlankCanvas(observer.page, { timeoutMs: 15000 });
		const page0ReturnPath = await saveCanvasPng(observer.page, path.join(dir, "page-0-return.png"));
		bot.close();
		await observer.close();
		return {
			status: "passed",
			failureType: "none",
			metrics: {
				page0NonBlankRatio: page0.sample.nonBlankRatio,
				page1SwitchVisibleMs: page1.elapsedMs,
				page1FramesToFirstPixel: page1.frames,
				page1NonBlankRatio: page1.sample.nonBlankRatio,
			},
			artifacts: [page0Path, page1Path, page0ReturnPath],
		};
	}),
];

export const runPerformanceExternal = async (context: SuiteContext): Promise<CaseResult[]> => {
	const results: CaseResult[] = [];
	if (context.config.caseSet === "standard" || context.config.caseSet === "all") {
		for (const scale of context.config.scales) {
			results.push(await runSampledCase(context, `full-render-${scale}`, async (run, warmup) => {
				const dir = artifactDir(
					context,
					`full-render-${scale}-${context.config.environment}-${warmup ? "warmup" : "run"}-${run}`
				);
				const { roomId, users } = await createRoomWithUsers(context.config, ["PerfBot"]);
				const bot = new ProtocolClient(context.config, users[0]!);
				await bot.connect();
				const pointsPerStroke = 64;
				const strokes = Math.max(1, Math.ceil(scale / pointsPerStroke));
				for (let index = 0; index < strokes; index += 1) {
					await bot.sendCommittedStroke({
						points: createDistributedStrokePoints(
							Math.min(pointsPerStroke, scale - index * pointsPerStroke),
							index,
							strokes
						),
						color: index % 3 === 0 ? "#111827" : index % 3 === 1 ? "#2563eb" : "#dc2626",
						size: 2 + (index % 3),
					});
				}
				await new Promise((resolve) => setTimeout(resolve, Math.min(800, 60 + strokes * 2)));
				bot.close();
				const observerUser = await joinRoom(context.config, roomId, "PerfObserver");
				const observer = await openMeasuredRoomPage(context.browser, context.config, observerUser);
				const perf = await readPerformanceObserver(observer.page);
				if (!warmup) {
					await saveCanvasPng(observer.page, path.join(dir, "final.png"));
				}
				await observer.close();
				return {
					scale,
					firstNonBlankMs: observer.initialRender.firstNonBlankMs,
					visuallyStableMs: observer.initialRender.visuallyStableMs,
					nonBlankRatio: observer.initialRender.nonBlankRatio,
					longTaskCount: perf.longTaskCount,
					longTaskTotalMs: perf.longTaskTotalMs,
				};
			}, { scale }));
		}

		results.push(await runSampledCase(context, "incremental-remote-first-pixel", async () => {
			const { users } = await createRoomWithUsers(context.config, ["IncObserver", "IncBot"]);
			const observer = await openRoomPage(context.browser, context.config, users[0]!);
			const bot = new ProtocolClient(context.config, users[1]!);
			await bot.connect();
			const roi = roiAround(480, 330, 260);
			const baseline = await captureCanvasSample(observer.page, roi);
			const sendStart = performance.now();
			bot.sendStroke({
				points: createLinePoints(32, { x: 0.32, y: 0.42 }, { x: 0.006, y: 0.002 }),
				color: "#dc2626",
				size: 5,
			});
			const changed = await waitForCanvasChange(observer.page, baseline, {
				roi,
				timeoutMs: 12000,
				minDiffRatio: 0.005,
				sampleSize: 64,
			});
			const perf = await readPerformanceObserver(observer.page);
			bot.close();
			await observer.close();
			return {
				remoteFirstPixelMs: changed.elapsedMs,
				protocolDispatchOverheadMs: Math.max(0, performance.now() - sendStart - changed.elapsedMs),
				observerPollElapsedMs: changed.elapsedMs,
				framesToFirstPixel: changed.frames,
				roiDiffRatio: changed.diffRatio,
				longTaskCount: perf.longTaskCount,
			};
		}));

		results.push(await runSampledCase(context, "local-realtime-first-pixel", async () => {
			const { users } = await createRoomWithUsers(context.config, ["RealtimeUser"]);
			const page = await openRoomPage(context.browser, context.config, users[0]!);
			const roi = roiAround(360, 330, 280);
			const baseline = await captureCanvasSample(page.page, roi);
			const waitForPixel = waitForCanvasChange(page.page, baseline, {
				roi,
				timeoutMs: 12000,
				minDiffRatio: 0.005,
				sampleSize: 64,
			});
			await drawLineLowLatency(page.page, 260, 260, 460, 400, 1);
			const changed = await waitForPixel;
			const perf = await readPerformanceObserver(page.page);
			await page.close();
			return {
				inputToFirstPixelMs: changed.elapsedMs,
				observerPollElapsedMs: changed.elapsedMs,
				inputToFirstPixelFrames: changed.frames,
				roiDiffRatio: changed.diffRatio,
				inputDelayMs: perf.eventDelayMaxMs,
				longTaskCount: perf.longTaskCount,
			};
		}));
	}

	if (context.config.caseSet === "resilience" || context.config.caseSet === "all") {
		results.push(await runNetworkRecovery(context));
	}

	if (context.config.caseSet === "boundary" || context.config.caseSet === "all") {
		results.push(await runBoundaryFullRender(context));
		results.push(await runBoundaryHeapGrowth(context));
		results.push(await runBoundaryIncrementalFreeze(context));
	}

	return results;
};
