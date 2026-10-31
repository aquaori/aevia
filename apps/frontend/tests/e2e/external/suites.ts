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
	waitForVisibleScreenshotContent,
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
import { EXTERNAL_CASES } from "../../../../../tests/catalog/external-cases";
import {
	aggregateMedians,
	deriveInstrumentedMetrics,
	deriveWitness,
} from "./lab/contracts";
import { evaluateCase, labScenarioKey, neutralCaseEvaluation } from "./lab/evaluate";
import { beginLabScope, collectLabSnapshots, endLabScope, waitForLabSentinel } from "./lab/install";
import { resolveLabPolicy } from "./lab/policy";
import type { LabCaseEvaluation, LabPageSnapshot, LabPolicy, LabSpanViolation } from "./lab/types";
import { caseKeyOf, isCaseSelected } from "./lab/select";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Canvas-readback version of "this region is blank". Visible-page screenshots include UI overlays
 * (remote cursor, hover rings, selection chrome), so a region that is genuinely empty on the canvas
 * can still report a small non-blank ratio and time out. Readback inspects the canvas pixels only.
 */
const waitForCanvasRegionBlank = async (
	page: Parameters<typeof captureCanvasSample>[0],
	region: ReturnType<typeof roiAround>,
	timeoutMs = 12000
) => {
	const startedAt = Date.now();
	let sample = await captureCanvasSample(page, region);
	while (Date.now() - startedAt < timeoutMs) {
		if (sample.nonBlankRatio <= 0.002) return sample;
		await page.waitForTimeout(120);
		sample = await captureCanvasSample(page, region);
	}
	throw new Error(`canvas region still not blank after ${timeoutMs}ms: ratio=${sample.nonBlankRatio}`);
};

const LAB_POLICY: LabPolicy = resolveLabPolicy();

/** Lab evidence collected for one case (or one sample of a sampled case). */
type LabCaseEvidence = {
	snapshots: LabPageSnapshot[];
	instrumented: MetricMap;
	witnessDeltaMs: MetricMap;
	violations: LabSpanViolation[];
	pageErrors: string[];
	invalidSampleCount: number;
};

const deriveCaseEvidence = (
	caseId: string,
	snapshots: LabPageSnapshot[],
	externalMetrics: MetricMap,
	invalidSampleCount = 0
): LabCaseEvidence => {
	const instrumented: MetricMap = {};
	const violations: LabSpanViolation[] = [];
	for (const snapshot of snapshots) {
		const derived = deriveInstrumentedMetrics(caseId, snapshot.marks, LAB_POLICY);
		for (const [key, value] of Object.entries(derived.instrumented)) {
			if (!(key in instrumented)) instrumented[key] = value;
		}
		violations.push(...derived.violations);
	}
	const witness = deriveWitness(caseId, instrumented, externalMetrics, LAB_POLICY);
	violations.push(...witness.violations);
	const pageErrors: string[] = [];
	for (const snapshot of snapshots) {
		for (const error of snapshot.pageErrors) {
			if (!pageErrors.includes(error.message)) pageErrors.push(error.message);
		}
	}
	return {
		snapshots,
		instrumented,
		witnessDeltaMs: witness.witnessDeltaMs,
		violations,
		pageErrors,
		invalidSampleCount,
	};
};

const scenarioKeyOf = (context: SuiteContext) => labScenarioKey(context.config.suite, context.config.caseSet);

const caseKeyOfCase = (context: SuiteContext, id: string, scale?: number) =>
	caseKeyOf(id, context.config.environment, scale);

/**
 * Runs the measurement gate for a finished case and applies the harness-failure
 * policy: an invalid measurement becomes a `harness` case failure (never a
 * product failure) and is reported immediately on stderr.
 */
const applyLabEvidence = (
	context: SuiteContext,
	id: string,
	result: CaseResult,
	evidence: LabCaseEvidence,
	sampleCount: number,
	expectedSampleCount: number,
	scale?: number
): CaseResult => {
	if (!context.config.labEnabled) return result;
	if (result.status !== "passed") {
		// A product failure already fails the run; the measurement gate only
		// certifies collection, so it stays neutral instead of masking the cause.
		result.lab = neutralCaseEvaluation({
			caseId: id,
			caseKey: caseKeyOfCase(context, id, scale),
			scenarioKey: scenarioKeyOf(context),
			detail: "case failed before the measurement gate judged collection",
		});
		return result;
	}
	const evaluation: LabCaseEvaluation = evaluateCase({
		caseId: id,
		caseKey: caseKeyOfCase(context, id, scale),
		scenarioKey: scenarioKeyOf(context),
		snapshots: evidence.snapshots,
		instrumented: evidence.instrumented,
		external: result.metrics,
		sampleCount,
		expectedSampleCount,
		invalidSampleCount: evidence.invalidSampleCount,
		sampleViolations: evidence.violations,
		witnessDeltaMs: evidence.witnessDeltaMs,
		pageErrors: evidence.pageErrors,
		policy: LAB_POLICY,
		labEnabled: true,
	});
	result.lab = evaluation;
	if (Object.keys(evidence.instrumented).length > 0) {
		result.instrumented = evidence.instrumented;
		result.measurementSource = evaluation.measurementSource;
		result.witnessDeltaMs = evidence.witnessDeltaMs;
	}
	if (evaluation.status === "invalid") {
		const codes = evaluation.codes.join(",");
		const detail = evaluation.details.join("; ").slice(0, 800);
		console.error(
			`[lab][invalid-case] scenario=${evaluation.scenarioKey} case=${evaluation.caseKey} codes=${codes} detail=${detail}`
		);
		if (result.status === "passed") {
			result.status = "failed";
			result.failureType = "harness";
			result.error = `[lab] invalid measurement (${codes}): ${detail}`;
		} else {
			result.error = `${result.error ? `${result.error}; ` : ""}[lab] invalid measurement (${codes}): ${detail}`;
		}
	}
	return result;
};

const isSelected = (context: SuiteContext, id: string, scale?: number) =>
	isCaseSelected(context.config, id, context.config.environment, scale ?? null);

const optionalCase = async (
	context: SuiteContext,
	id: string,
	fn: () => Promise<Omit<CaseResult, "id" | "durationMs">>
): Promise<CaseResult[]> => (isSelected(context, id) ? [await runCase(context, id, fn)] : []);

const optionalSampledCase = async (
	context: SuiteContext,
	id: string,
	fn: (sampleIndex: number, warmup: boolean) => Promise<MetricMap>,
	options: { scale?: number } = {}
): Promise<CaseResult[]> =>
	isSelected(context, id, options.scale) ? [await runSampledCase(context, id, fn, options)] : [];

const CASE_META: Record<string, { title: string; description: string; category: CaseCategory }> = {
	[EXTERNAL_CASES.harnessHealth.id]: {
		title: "Harness health",
		description: "验证前端可访问、后端 create/join、WebSocket 握手、协议驱动远端绘制和 canvas ROI 外部观测链路。",
		category: "harness",
	},
	[EXTERNAL_CASES.correctnessSmoke.id]: {
		title: "Correctness smoke",
		description: "双端绘制互相可见；撤销时目标区域消失且其他笔画保留，重做后恢复；分页返回用可见截图断言内容隔离。",
		category: "correctness",
	},
	[EXTERNAL_CASES.concurrentCrossing.id]: {
		title: "Concurrent crossing consistency",
		description: "两个浏览器同时交叉绘制，最终只用 canvas 截图和 pixel diff 验证视觉一致性。",
		category: "correctness",
	},
	[EXTERNAL_CASES.lateJoiner.id]: {
		title: "Late joiner consistency",
		description: "后加入用户加载已有历史内容后，与原用户最终 canvas 截图保持一致。",
		category: "correctness",
	},
	[EXTERNAL_CASES.multipageIsolation.id]: {
		title: "Protocol multipage isolation",
		description: "通过公开协议制造多页历史，验证 late observer 切页后不同页内容可见且可返回。",
		category: "correctness",
	},
	[EXTERNAL_CASES.fullRenderPerformance.id]: {
		title: "Full render late joiner",
		description: "公开 WebSocket 协议制造大量历史点，测量 late joiner 首个非空画面和视觉稳定时间。",
		category: "performance",
	},
	[EXTERNAL_CASES.remoteFirstPixelPerformance.id]: {
		title: "Incremental remote first pixel",
		description: "从测试侧发送公开 WebSocket 远端笔画，到 observer 目标 ROI 首次出现像素变化。",
		category: "performance",
	},
	[EXTERNAL_CASES.localFirstPixelPerformance.id]: {
		title: "Local realtime first pixel",
		description: "Playwright 真实 pointer 绘制后，目标 ROI 首次出现像素变化的耗时和帧数。",
		category: "performance",
	},
	[EXTERNAL_CASES.fullRenderBoundary.id]: {
		title: "Boundary full render until crash",
		description: "外部协议制造阶梯历史数据，用 Playwright/CDP 硬指标寻找全量初始化的 renderer/page/browser 边界。",
		category: "boundary",
	},
	[EXTERNAL_CASES.heapGrowthBoundary.id]: {
		title: "Boundary same-page heap growth",
		description: "同一页多轮注入和重载后，通过 CDP JS heap 与 DOM counter 观察内存增长边界。",
		category: "boundary",
	},
	[EXTERNAL_CASES.redrawFreezeBoundary.id]: {
		title: "Boundary incremental redraw freeze",
		description: "多协议客户端并发局部重绘，用外部截图、CDP heap 和输入耗时观察软卡死边界。",
		category: "boundary",
	},
	[EXTERNAL_CASES.networkRecovery.id]: {
		title: "Network latency recovery",
		description: "通过 CDP 网络模拟长延迟和离线恢复，观测页面恢复到可绘制状态的时间。",
		category: "performance",
	},
};

const withMeta = (context: SuiteContext, id: string, result: CaseResult): CaseResult => {
	const fullRenderPrefix = `${EXTERNAL_CASES.fullRenderPerformance.id}-`;
	const key = id.startsWith(fullRenderPrefix) ? EXTERNAL_CASES.fullRenderPerformance.id : id;
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
	const fullRenderPrefix = `${EXTERNAL_CASES.fullRenderPerformance.id}-`;
	const meta = CASE_META[id.startsWith(fullRenderPrefix) ? EXTERNAL_CASES.fullRenderPerformance.id : id];
	logCaseStart(id, meta?.title || id, meta?.description);
	const labOn = context.config.labEnabled;
	if (labOn) beginLabScope();
	try {
		const result = await fn();
		let finalResult = withMeta(context, id, { id, durationMs: performance.now() - startedAt, ...result });
		if (labOn) {
			const snapshots = await collectLabSnapshots();
			const evidence = deriveCaseEvidence(id, snapshots, finalResult.metrics);
			finalResult = applyLabEvidence(context, id, finalResult, evidence, 1, 1);
		}
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
	} finally {
		if (labOn) endLabScope();
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

	if (id.startsWith(`${EXTERNAL_CASES.fullRenderPerformance.id}-`)) {
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

	const outlierMetrics = id.startsWith(`${EXTERNAL_CASES.fullRenderPerformance.id}-`)
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
	const fullRenderPrefix = `${EXTERNAL_CASES.fullRenderPerformance.id}-`;
	const meta = CASE_META[id.startsWith(fullRenderPrefix) ? EXTERNAL_CASES.fullRenderPerformance.id : id];
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
	const labOn = context.config.labEnabled;
	const measuredLabEvidence: LabCaseEvidence[] = [];
	for (let index = 0; index < context.config.warmup + context.config.runs; index += 1) {
		const warmup = index < context.config.warmup;
		const run = warmup ? index + 1 : index - context.config.warmup + 1;
		const sampleStartedAt = performance.now();
		logStep(`${id}: ${warmup ? "warmup" : "run"} ${run}/${warmup ? context.config.warmup : context.config.runs}`);
		if (labOn) beginLabScope();
		try {
			const metrics = await fn(run, warmup);
			const snapshots = labOn ? await collectLabSnapshots() : [];
			const sample: CaseSample = {
				run,
				warmup,
				status: "passed",
				durationMs: performance.now() - sampleStartedAt,
				metrics,
			};
			if (labOn && !warmup) {
				const evidence = deriveCaseEvidence(id, snapshots, metrics);
				sample.instrumented = evidence.instrumented;
				sample.witnessDeltaMs = evidence.witnessDeltaMs;
				sample.measurementSource = Object.keys(evidence.instrumented).length > 0 ? "hybrid" : "external";
				sample.labCodes = [...new Set(evidence.violations.map((violation) => violation.code))];
				sample.pageErrors = evidence.pageErrors;
				measuredLabEvidence.push(evidence);
			}
			samples.push(sample);
		} catch (error: unknown) {
			samples.push({
				run,
				warmup,
				status: "failed",
				durationMs: performance.now() - sampleStartedAt,
				metrics: {},
				error: errorMessage(error),
			});
		} finally {
			if (labOn) endLabScope();
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
	const caseEvidence: LabCaseEvidence = {
		snapshots: measuredLabEvidence.flatMap((evidence) => evidence.snapshots),
		instrumented: aggregateMedians(measuredLabEvidence.map((evidence) => evidence.instrumented)),
		witnessDeltaMs: aggregateMedians(measuredLabEvidence.map((evidence) => evidence.witnessDeltaMs)),
		violations: measuredLabEvidence.flatMap((evidence) => evidence.violations),
		pageErrors: [...new Set(measuredLabEvidence.flatMap((evidence) => evidence.pageErrors))],
		invalidSampleCount: measuredLabEvidence.filter(
			(evidence) => evidence.violations.length > 0 || evidence.pageErrors.length > 0
		).length,
	};
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
		const gatedResult = applyLabEvidence(
			context,
			id,
			finalResult,
			caseEvidence,
			measuredSamples.length,
			context.config.runs,
			options.scale
		);
		logCaseEnd(gatedResult);
		return gatedResult;
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
	const gatedResult = applyLabEvidence(
		context,
		id,
		finalResult,
		caseEvidence,
		measuredSamples.length,
		context.config.runs,
		options.scale
	);
	logCaseEnd(gatedResult);
	return gatedResult;
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
	runCase(context, EXTERNAL_CASES.fullRenderBoundary.id, async () => {
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
	runCase(context, EXTERNAL_CASES.heapGrowthBoundary.id, async () => {
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
	runCase(context, EXTERNAL_CASES.redrawFreezeBoundary.id, async () => {
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
	runCase(context, EXTERNAL_CASES.networkRecovery.id, async () => {
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

export const runHarnessHealth = async (context: SuiteContext): Promise<CaseResult[]> =>
	optionalCase(context, EXTERNAL_CASES.harnessHealth.id, async () => {
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
		if (context.config.labEnabled) {
			// Sentinel round-trip: proves the product instrumentation is alive on this
			// document before the gate certifies the external measurement.
			await waitForLabSentinel(observer.page);
		}
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
	});

export const runCorrectnessSmoke = async (context: SuiteContext): Promise<CaseResult[]> => [
	...(await runHarnessHealth(context)),
	...(await optionalCase(context, EXTERNAL_CASES.correctnessSmoke.id, async () => {
		const dir = artifactDir(context, EXTERNAL_CASES.correctnessSmoke.id);
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

		const firstStrokeRegion = roiAround(320, 290);
		const secondStrokeRegion = roiAround(730, 350);
		await pressUndo(pageB.page);
		const [undoneA, undoneB, preservedA, preservedB] = await Promise.all([
			waitForCanvasRegionBlank(pageA.page, secondStrokeRegion),
			waitForCanvasRegionBlank(pageB.page, secondStrokeRegion),
			waitForVisibleScreenshotContent(pageA.page, { roi: firstStrokeRegion, timeoutMs: 3000 }),
			waitForVisibleScreenshotContent(pageB.page, { roi: firstStrokeRegion, timeoutMs: 3000 }),
		]);
		const undoBlankPath = await saveCanvasPng(pageA.page, path.join(dir, "undo-target-blank.png"), secondStrokeRegion);
		const undoPreservedPath = await saveCanvasPng(pageA.page, path.join(dir, "undo-other-stroke-retained.png"), firstStrokeRegion);
		await pressRedo(pageB.page);
		const [redoneA, redoneB] = await Promise.all([
			waitForVisibleScreenshotContent(pageA.page, { roi: secondStrokeRegion, timeoutMs: 12000 }),
			waitForVisibleScreenshotContent(pageB.page, { roi: secondStrokeRegion, timeoutMs: 12000 }),
		]);
		const redoVisiblePath = await saveCanvasPng(pageA.page, path.join(dir, "redo-target-visible.png"), secondStrokeRegion);

		const waitForPageIndicator = (page: typeof pageA.page, expected: string) => page.waitForFunction(
			(pageNumber) => document.querySelector('button[title="页面概览"]')?.textContent?.replace(/\s+/g, "") === pageNumber,
			expected,
			{ timeout: 5000 }
		);
		await pageA.page.locator('button[title="新建页面"]').click();
		await waitForPageIndicator(pageA.page, "2/2");
		await drawLine(pageA.page, 260, 460, 460, 500, 10);
		const newPageRegion = roiAround(360, 480);
		await waitForVisibleScreenshotContent(pageA.page, { roi: newPageRegion, timeoutMs: 5000 });
		await pageA.page.locator('button[title="上一页"]').click();
		await waitForPageIndicator(pageA.page, "1/2");
		const revisit = await waitForVisibleScreenshotContent(pageA.page, { roi: firstStrokeRegion, timeoutMs: 5000 });
		const pageIsolation = await waitForCanvasRegionBlank(pageA.page, newPageRegion, 5000);
		const diff = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "final-diff.png"),
			threshold: 0.01,
		});
		const artifacts = [
			await saveCanvasPng(pageA.page, path.join(dir, "page-a.png")),
			await saveCanvasPng(pageB.page, path.join(dir, "page-b.png")),
			undoBlankPath,
			undoPreservedPath,
			redoVisiblePath,
			await saveCanvasPng(pageA.page, path.join(dir, "returned-page-isolated.png")),
			path.join(dir, "final-diff.png"),
		];

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
				undoTargetBlankRatioA: undoneA.nonBlankRatio,
				undoTargetBlankRatioB: undoneB.nonBlankRatio,
				undoOtherStrokeRatioA: preservedA.sample.nonBlankRatio,
				undoOtherStrokeRatioB: preservedB.sample.nonBlankRatio,
				redoTargetVisibleRatioA: redoneA.sample.nonBlankRatio,
				redoTargetVisibleRatioB: redoneB.sample.nonBlankRatio,
				pageReturnVisibleRatio: revisit.sample.nonBlankRatio,
				pageTwoLeakRatioAfterReturn: pageIsolation.nonBlankRatio,
				visibleScreenshotOracle: true,
			},
			artifacts,
		};
	})),
];

export const runCorrectnessFull = async (context: SuiteContext): Promise<CaseResult[]> => [
	...(await runCorrectnessSmoke(context)),
	...(await optionalCase(context, EXTERNAL_CASES.concurrentCrossing.id, async () => {
		const dir = artifactDir(context, EXTERNAL_CASES.concurrentCrossing.id);
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
	})),
	...(await optionalCase(context, EXTERNAL_CASES.lateJoiner.id, async () => {
		const dir = artifactDir(context, EXTERNAL_CASES.lateJoiner.id);
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
	})),
	...(await optionalCase(context, EXTERNAL_CASES.multipageIsolation.id, async () => {
		const dir = artifactDir(context, EXTERNAL_CASES.multipageIsolation.id);
		const { roomId, users } = await createRoomWithUsers(context.config, ["PageObserver", "PageBot"]);
		const bot = new ProtocolClient(context.config, users[1]!);
		await bot.connect();
		await bot.sendRawAndWaitFor("cmd-page-add", {
			userId: users[1]!.userId,
			username: users[1]!.userName,
			totalPages: 2,
		}, "ack.committed", (message) => typeof message.data?.roomSeq === "number" && message.data.roomSeq > 0);
		await bot.sendCommittedStroke({
			pageId: 0,
			points: createLinePoints(36, { x: 0.18, y: 0.28 }, { x: 0.006, y: 0.003 }),
			color: "#111827",
			size: 5,
			waitForCommit: true,
		});
		await bot.sendCommittedStroke({
			pageId: 1,
			points: createLinePoints(36, { x: 0.62, y: 0.32 }, { x: -0.005, y: 0.004 }),
			color: "#2563eb",
			size: 5,
			waitForCommit: true,
		});

		const observerUser = await joinRoom(context.config, roomId, "PageLateObserver");
		const observer = await openRoomPage(context.browser, context.config, observerUser);
		const waitForPageIndicator = (expected: string) => observer.page.waitForFunction(
			(pageNumber) => document.querySelector('button[title="页面概览"]')?.textContent?.replace(/\s+/g, "") === pageNumber,
			expected,
			{ timeout: 5000 }
		);
		await waitForPageIndicator("1/2");
		const canvasBounds = await observer.page.locator("canvas").first().boundingBox();
		if (!canvasBounds) throw new Error("multipage canvas bounds unavailable");
		const regionSize = Math.max(96, Math.min(canvasBounds.width * 0.16, canvasBounds.height * 0.28));
		const page0Region = roiAround(canvasBounds.width * 0.285, canvasBounds.height * 0.33, regionSize);
		const page1Region = roiAround(canvasBounds.width * 0.53, canvasBounds.height * 0.39, regionSize);
		logStep(`multipage regions: canvas=${canvasBounds.width}x${canvasBounds.height} p0=${JSON.stringify(page0Region)} p1=${JSON.stringify(page1Region)}`);
		const page0Path = await saveCanvasPng(observer.page, path.join(dir, "page-0.png"));
		const page0Own = await waitForVisibleScreenshotContent(observer.page, { timeoutMs: 15000, roi: page0Region });
		const page0Leak = await waitForCanvasRegionBlank(observer.page, page1Region, 1500);
		await saveCanvasPng(observer.page, page0Path);
		const pageSwitchStartedAt = performance.now();
		await observer.page.locator('button[title="下一页"]').click();
		await waitForPageIndicator("2/2");
		const page1Path = await saveCanvasPng(observer.page, path.join(dir, "page-1.png"));
		const page1 = await waitForVisibleScreenshotContent(observer.page, { timeoutMs: 15000, roi: page1Region });
		const page1ClickToObservedScreenshotMs = performance.now() - pageSwitchStartedAt;
		const page1Leak = await waitForCanvasRegionBlank(observer.page, page0Region, 1500);
		await saveCanvasPng(observer.page, path.join(dir, "page-1.png"));
		await observer.page.locator('button[title="上一页"]').click();
		await waitForPageIndicator("1/2");
		await waitForVisibleScreenshotContent(observer.page, { timeoutMs: 15000, roi: page0Region });
		const page0ReturnPath = await saveCanvasPng(observer.page, path.join(dir, "page-0-return.png"));
		bot.close();
		await observer.close();
		return {
			status: "passed",
			failureType: "none",
			metrics: {
				page0ExpectedRegionRatio: page0Own.sample.nonBlankRatio,
				page0OtherPageRegionRatio: page0Leak.nonBlankRatio,
				page1ClickToObservedScreenshotMs,
				page1ExpectedRegionRatio: page1.sample.nonBlankRatio,
				page1OtherPageRegionRatio: page1Leak.nonBlankRatio,
				pixelOracleSource: "canvas-readback-leak+visible-content",
			},
			artifacts: [page0Path, page1Path, page0ReturnPath],
		};
	})),
	...(await optionalCase(context, EXTERNAL_CASES.undoRedoConvergence.id, async () => {
		const dir = artifactDir(context, EXTERNAL_CASES.undoRedoConvergence.id);
		const { users } = await createRoomWithUsers(context.config, ["UndoA", "UndoB"]);
		const pageA = await openRoomPage(context.browser, context.config, users[0]!);
		const pageB = await openRoomPage(context.browser, context.config, users[1]!);
		const firstRegion = roiAround(320, 290);
		const secondRegion = roiAround(730, 350);
		await drawLine(pageA.page, 220, 220, 420, 360, 16);
		await drawLine(pageA.page, 640, 260, 820, 440, 16);
		await pageA.page.waitForTimeout(1800);
		await pageB.page.waitForTimeout(1800);
		const beforeUndo = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "before-undo-diff.png"),
			threshold: 0.012,
		});

		// Undo the second stroke first: the history.toggle soft delete must reach both peers.
		await pressUndo(pageA.page);
		const [secondBlankA, secondBlankB] = await Promise.all([
			waitForCanvasRegionBlank(pageA.page, secondRegion),
			waitForCanvasRegionBlank(pageB.page, secondRegion),
		]);
		const [firstKeptA] = await Promise.all([
			waitForVisibleScreenshotContent(pageA.page, { roi: firstRegion, timeoutMs: 5000 }),
		]);
		const afterFirstUndo = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "after-first-undo-diff.png"),
			threshold: 0.012,
		});

		// Undo the first stroke too: both peers must converge on an empty page.
		await pressUndo(pageA.page);
		const [firstBlankA, firstBlankB] = await Promise.all([
			waitForCanvasRegionBlank(pageA.page, firstRegion),
			waitForCanvasRegionBlank(pageB.page, firstRegion),
		]);
		const afterSecondUndo = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "after-second-undo-diff.png"),
			threshold: 0.012,
		});

		// Redo both strokes in order; convergence must hold again.
		await pressRedo(pageA.page);
		await waitForVisibleScreenshotContent(pageA.page, { roi: firstRegion, timeoutMs: 12000 });
		await waitForVisibleScreenshotContent(pageB.page, { roi: firstRegion, timeoutMs: 12000 });
		await pressRedo(pageA.page);
		await waitForVisibleScreenshotContent(pageA.page, { roi: secondRegion, timeoutMs: 12000 });
		const [secondRestoredB] = await Promise.all([
			waitForVisibleScreenshotContent(pageB.page, { roi: secondRegion, timeoutMs: 12000 }),
		]);
		const afterRedo = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "after-redo-diff.png"),
			threshold: 0.012,
		});
		const artifacts = [
			await saveCanvasPng(pageA.page, path.join(dir, "page-a.png")),
			await saveCanvasPng(pageB.page, path.join(dir, "page-b.png")),
			path.join(dir, "before-undo-diff.png"),
			path.join(dir, "after-first-undo-diff.png"),
			path.join(dir, "after-second-undo-diff.png"),
			path.join(dir, "after-redo-diff.png"),
		];
		await pageA.close();
		await pageB.close();
		const diffs = [beforeUndo, afterFirstUndo, afterSecondUndo, afterRedo];
		const failedDiff = diffs.find((diff) => diff.diffRatio > diff.passThreshold);
		if (failedDiff) {
			return {
				status: "failed",
				failureType: "correctness",
				metrics: { finalDiffRatio: failedDiff.diffRatio, passThreshold: failedDiff.passThreshold },
				error: `undo/redo canvas divergence: diffRatio=${failedDiff.diffRatio}`,
				artifacts,
			};
		}
		return {
			status: "passed",
			failureType: "none",
			metrics: {
				beforeUndoDiffRatio: beforeUndo.diffRatio,
				afterFirstUndoDiffRatio: afterFirstUndo.diffRatio,
				afterSecondUndoDiffRatio: afterSecondUndo.diffRatio,
				afterRedoDiffRatio: afterRedo.diffRatio,
				undoneSecondStrokeRatioA: secondBlankA.nonBlankRatio,
				undoneSecondStrokeRatioB: secondBlankB.nonBlankRatio,
				retainedFirstStrokeRatioA: firstKeptA.sample.nonBlankRatio,
				undoneFirstStrokeRatioA: firstBlankA.nonBlankRatio,
				undoneFirstStrokeRatioB: firstBlankB.nonBlankRatio,
				restoredSecondStrokeRatioB: secondRestoredB.sample.nonBlankRatio,
			},
			artifacts,
		};
	})),
	...(await optionalCase(context, EXTERNAL_CASES.lateJoinerUndoConsistency.id, async () => {
		const dir = artifactDir(context, EXTERNAL_CASES.lateJoinerUndoConsistency.id);
		const { roomId, users } = await createRoomWithUsers(context.config, ["LateUndoA"]);
		const pageA = await openRoomPage(context.browser, context.config, users[0]!);
		const keptRegion = roiAround(300, 280);
		const undoneRegion = roiAround(730, 350);
		await drawLine(pageA.page, 220, 220, 400, 360, 22);
		await drawLine(pageA.page, 640, 260, 820, 440, 22);
		await pageA.page.waitForTimeout(1200);
		await pressUndo(pageA.page);
		const undoneOnA = await waitForCanvasRegionBlank(pageA.page, undoneRegion);
		await waitForVisibleScreenshotContent(pageA.page, { roi: keptRegion, timeoutMs: 5000 });

		const lateUser = await joinRoom(context.config, roomId, "LateUndoB");
		const pageB = await openRoomPage(context.browser, context.config, lateUser);
		// One retained stroke covers well under 1% of the canvas, so wait for that
		// region instead of the generic whole-canvas non-blank threshold.
		const keptOnB = await waitForVisibleScreenshotContent(pageB.page, { roi: keptRegion, timeoutMs: 15000 });
		const undoneOnB = await waitForCanvasRegionBlank(pageB.page, undoneRegion);
		const diff = await compareCanvasPages(pageA.page, pageB.page, {
			diffPath: path.join(dir, "late-undo-diff.png"),
			threshold: 0.01,
		});
		const artifacts = [
			await saveCanvasPng(pageA.page, path.join(dir, "page-a.png")),
			await saveCanvasPng(pageB.page, path.join(dir, "page-b.png")),
			path.join(dir, "late-undo-diff.png"),
		];
		await pageA.close();
		await pageB.close();
		if (diff.diffRatio > diff.passThreshold) {
			return {
				status: "failed",
				failureType: "correctness",
				metrics: { diffRatio: diff.diffRatio, passThreshold: diff.passThreshold },
				error: `late joiner replay after undo diverged: diffRatio=${diff.diffRatio}`,
				artifacts,
			};
		}
		return {
			status: "passed",
			failureType: "none",
			metrics: {
				diffRatio: diff.diffRatio,
				passThreshold: diff.passThreshold,
				undoneRegionRatioOnA: undoneOnA.nonBlankRatio,
				undoneRegionRatioOnB: undoneOnB.nonBlankRatio,
				keptRegionRatioOnB: keptOnB.sample.nonBlankRatio,
			},
			artifacts,
		};
	})),
];

export const runPerformanceExternal = async (context: SuiteContext): Promise<CaseResult[]> => {
	const results: CaseResult[] = [];
	if (context.config.caseSet === "standard" || context.config.caseSet === "all") {
		for (const scale of context.config.scales) {
			results.push(...(await optionalSampledCase(context, `${EXTERNAL_CASES.fullRenderPerformance.id}-${scale}`, async (run, warmup) => {
				const dir = artifactDir(
					context,
					`${EXTERNAL_CASES.fullRenderPerformance.id}-${scale}-${context.config.environment}-${warmup ? "warmup" : "run"}-${run}`
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
			}, { scale })));
		}

		results.push(...(await optionalSampledCase(context, EXTERNAL_CASES.remoteFirstPixelPerformance.id, async () => {
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
		})));

		results.push(...(await optionalSampledCase(context, EXTERNAL_CASES.localFirstPixelPerformance.id, async () => {
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
		})));
	}

	if (context.config.caseSet === "resilience" || context.config.caseSet === "all") {
		if (isSelected(context, EXTERNAL_CASES.networkRecovery.id)) results.push(await runNetworkRecovery(context));
	}

	if (context.config.caseSet === "boundary" || context.config.caseSet === "all") {
		if (isSelected(context, EXTERNAL_CASES.fullRenderBoundary.id)) results.push(await runBoundaryFullRender(context));
		if (isSelected(context, EXTERNAL_CASES.heapGrowthBoundary.id)) results.push(await runBoundaryHeapGrowth(context));
		if (isSelected(context, EXTERNAL_CASES.redrawFreezeBoundary.id)) results.push(await runBoundaryIncrementalFreeze(context));
	}

	return results;
};
