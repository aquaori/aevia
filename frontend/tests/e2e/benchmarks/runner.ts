import fs from "fs";
import path from "path";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { findBaselineEntry, updateBaselineFile } from "./baseline";
import { parseCliOptions } from "./cli";
import { aggregateSamples, compareWithBaseline, ensureDir, formatDateTag, writeJson } from "./core-utils";
import type {
	BenchmarkCase,
	BenchmarkCaseResult,
	BenchmarkCategory,
	BenchmarkCliOptions,
	BenchmarkContext,
	BenchmarkEnvironmentId,
	BenchmarkRunMode,
	DatasetShape,
} from "./core-types";
import { collectChaosSample } from "./chaos-network";
import { collectCollisionSample } from "./collision";
import { collectEraserSample } from "./eraser";
import { collectFullRenderSample } from "./full-render";
import { collectIncrementalRenderSample } from "./incremental-render";
import { collectLatencySample } from "./latency";
import { collectMicroRenderSample } from "./micro-render";
import { collectMultiPageSample } from "./multi-page";
import { collectStressSample } from "./stress-concurrent";
import { collectUndoRedoSample } from "./undo-redo";
import { collectVisualConsistencySample } from "./visual-consistency";
import { generateHtmlReport } from "./html-reporter";
import { getEnvironmentMatrix } from "./suite-helpers";

const CASE_LABELS: Record<string, string> = {
	"micro-render": "微基准渲染",
	"full-render": "全量渲染",
	latency: "交互延迟",
	"stress-uniform": "持续压测-均匀模型",
	"stress-bursty": "持续压测-突发模型",
	"stress-mixed-tools": "持续压测-混合工具",
	collision: "碰撞自愈",
	"chaos-latency": "弱网恢复-高延迟",
	"chaos-latency-bandwidth": "弱网恢复-高延迟低带宽",
	"chaos-offline-recover": "弱网恢复-断网重连",
	"chaos-hide-resume": "弱网恢复-隐藏恢复",
	"visual-consistency": "视觉一致性",
	"incremental-render": "增量渲染",
	"undo-redo": "撤销重做",
	"multi-page": "多页切换",
	eraser: "橡皮擦专项",
};

const MODE_LABELS: Record<BenchmarkRunMode, string> = {
	headless: "无头浏览器",
	headed: "有界面浏览器",
};

const ENV_LABELS: Record<BenchmarkEnvironmentId, string> = {
	gpu_cpuHigh: "GPU开启 + CPU正常",
	gpu_cpuLow: "GPU开启 + CPU降速4x",
	noGpu_cpuHigh: "GPU关闭 + CPU正常",
	noGpu_cpuLow: "GPU关闭 + CPU降速4x",
};

const SHAPE_LABELS: Record<DatasetShape, string> = {
	"many-short-strokes": "大量短笔迹",
	"few-long-strokes": "少量长笔迹",
	"dense-overlap": "高密度重叠",
	"sparse-fullscreen": "全屏稀疏分布",
	"mixed-tool-history": "混合工具历史",
};

const STATUS_LABELS = {
	ok: "通过",
	warn: "警告",
	fail: "失败",
	"no-baseline": "无基线",
} as const;

const translateError = (value: string) => {
	const normalized = value.replace(/\u001b\[[0-9;]*m/g, "").trim();
	if (normalized.includes("ERR_CONNECTION_REFUSED")) {
		return "无法连接到前端页面 `http://localhost:5173`，前端开发服务未启动或端口不可达。";
	}
	if (normalized.includes("fetch failed")) {
		return "请求失败，通常表示前端或后端基准测试依赖服务未启动。";
	}
	return normalized;
};

const formatMetricKey = (key: string) =>
	key
		.replace(/([A-Z])/g, " $1")
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const buildCases = (options: BenchmarkCliOptions): BenchmarkCase[] => {
	const cases: BenchmarkCase[] = [
		{
			id: "micro-render",
			category: "micro",
			tags: ["micro", "render"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectMicroRenderSample(context.browser, context.throttleCpu),
		},
		{
			id: "full-render",
			category: "full-render",
			tags: ["render", "history"],
			defaultScale: 10000,
			supportedShapes: options.shapes,
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) =>
				collectFullRenderSample(
					context.scale || 10000,
					context.browser,
					context.throttleCpu,
					context.shape
				),
		},
		{
			id: "latency",
			category: "latency",
			tags: ["interactive", "sync"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectLatencySample(context.browser, context.throttleCpu),
		},
		{
			id: "stress-uniform",
			category: "stress",
			tags: ["stress", "uniform"],
			defaultScale: null,
			supportedShapes: options.shapes,
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectStressSample(context.browser, context.throttleCpu, "uniform"),
		},
		{
			id: "stress-bursty",
			category: "stress",
			tags: ["stress", "bursty"],
			defaultScale: null,
			supportedShapes: options.shapes,
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectStressSample(context.browser, context.throttleCpu, "bursty"),
		},
		{
			id: "stress-mixed-tools",
			category: "stress",
			tags: ["stress", "mixed-tools"],
			defaultScale: null,
			supportedShapes: ["mixed-tool-history"],
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectStressSample(context.browser, context.throttleCpu, "mixed-tools"),
		},
		{
			id: "collision",
			category: "collision",
			tags: ["correctness", "dirty-redraw"],
			defaultScale: null,
			supportedShapes: ["dense-overlap"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) => collectCollisionSample(context.browser, context.throttleCpu),
		},
		{
			id: "chaos-latency",
			category: "chaos",
			tags: ["network", "latency"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) => collectChaosSample(context.browser, context.throttleCpu, "latency"),
		},
		{
			id: "chaos-latency-bandwidth",
			category: "chaos",
			tags: ["network", "bandwidth"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) =>
				collectChaosSample(context.browser, context.throttleCpu, "latency-bandwidth"),
		},
		{
			id: "chaos-offline-recover",
			category: "chaos",
			tags: ["network", "offline"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) => collectChaosSample(context.browser, context.throttleCpu, "offline-recover"),
		},
		{
			id: "chaos-hide-resume",
			category: "chaos",
			tags: ["network", "visibility"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) => collectChaosSample(context.browser, context.throttleCpu, "hide-resume"),
		},
		{
			id: "visual-consistency",
			category: "visual",
			tags: ["visual", "correctness"],
			defaultScale: null,
			supportedShapes: ["dense-overlap"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) =>
				collectVisualConsistencySample(
					context.browser,
					context.throttleCpu,
					path.join(context.artifactDir, "visual")
				),
		},
		{
			id: "incremental-render",
			category: "incremental",
			tags: ["incremental", "dirty-redraw"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectIncrementalRenderSample(context.browser, context.throttleCpu),
		},
		{
			id: "undo-redo",
			category: "undo-redo",
			tags: ["history", "correctness"],
			defaultScale: null,
			supportedShapes: ["many-short-strokes"],
			warmupRuns: 0,
			sampleRuns: Math.max(1, options.runs),
			collect: (context) => collectUndoRedoSample(context.browser, context.throttleCpu),
		},
		{
			id: "multi-page",
			category: "multi-page",
			tags: ["pages", "navigation"],
			defaultScale: null,
			supportedShapes: ["sparse-fullscreen"],
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectMultiPageSample(context.browser, context.throttleCpu),
		},
		{
			id: "eraser",
			category: "eraser",
			tags: ["eraser", "dirty-redraw"],
			defaultScale: null,
			supportedShapes: ["mixed-tool-history"],
			warmupRuns: options.warmup,
			sampleRuns: options.runs,
			collect: (context) => collectEraserSample(context.browser, context.throttleCpu),
		},
	];

	if (options.smoke) {
		return cases.filter((item) =>
			["micro-render", "full-render", "latency", "incremental-render"].includes(item.id)
		);
	}
	if (!options.suites || options.suites.length === 0) return cases;
	return cases.filter((item) => options.suites!.includes(item.id) || options.suites!.includes(item.category));
};

const launchBrowser = async (runMode: BenchmarkRunMode, gpuEnabled: boolean): Promise<Browser> => {
	const launchOptions: LaunchOptions = {
		headless: runMode === "headless",
		channel: "chrome",
	};
	if (!gpuEnabled) {
		launchOptions.args = [
			"--disable-gpu",
			"--disable-gpu-compositing",
			"--disable-gpu-rasterization",
			"--disable-accelerated-2d-canvas",
		];
	}
	return chromium.launch(launchOptions);
};

const shouldUseScale = (category: BenchmarkCategory) => category === "full-render";

const buildMarkdownReport = (results: BenchmarkCaseResult[], reportDir: string) => {
	const lines = [
		"# Benchmark 测试摘要",
		"",
		`生成时间：${new Date().toLocaleString()}`,
		"",
		"| 测试项 | 浏览器模式 | 环境矩阵 | 数据形态 | 规模 | 结果 | 关键指标 | 失败原因/说明 |",
		"| --- | --- | --- | --- | ---: | --- | --- | --- |",
	];

	for (const result of results) {
		const status = STATUS_LABELS[result.diff.status] || result.diff.status;
		const metrics = Object.entries(result.aggregate.numeric)
			.slice(0, 3)
			.map(([key, value]) => `${formatMetricKey(key)}: ${value.median.toFixed(2)}`)
			.join("；");
		const reasons = result.diff.reasons.map(translateError).join("；");
		lines.push(
			`| ${CASE_LABELS[result.id] || result.id} | ${MODE_LABELS[result.runMode] || result.runMode} | ${
				ENV_LABELS[result.environment] || result.environment
			} | ${SHAPE_LABELS[result.shape] || result.shape} | ${
				result.scale ?? 0
			} | ${status} | ${metrics || "无有效指标"} | ${reasons || "无"} |`
		);
	}

	const filePath = path.join(reportDir, "benchmark-summary.md");
	fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
	return filePath;
};

const executeCase = async (
	benchmarkCase: BenchmarkCase,
	context: BenchmarkContext
): Promise<BenchmarkCaseResult> => {
	for (let run = 0; run < benchmarkCase.warmupRuns; run += 1) {
		await benchmarkCase.collect(context);
	}

	const samples = [];
	for (let run = 0; run < benchmarkCase.sampleRuns; run += 1) {
		samples.push(await benchmarkCase.collect(context));
	}

	const aggregate = aggregateSamples(samples);
	const baseline = findBaselineEntry({
		id: benchmarkCase.id,
		category: benchmarkCase.category,
		runMode: context.runMode,
		environment: context.environment,
		shape: context.shape,
		scale: context.scale,
		tags: benchmarkCase.tags,
		samples: [],
		aggregate,
		diff: { status: "no-baseline", reasons: [], metricDiffPct: {} },
	});
	const diff = compareWithBaseline(aggregate, baseline);
	if (aggregate.sampleCount === 0 && aggregate.failureCount > 0) {
		diff.status = "fail";
		diff.reasons = [
			`样本执行失败：${samples
				.filter((sample) => sample.status === "failed")
				.map((sample) => sample.error || "unknown error")
				.join("; ")}`,
		];
	}

	return {
		id: benchmarkCase.id,
		category: benchmarkCase.category,
		runMode: context.runMode,
		environment: context.environment,
		shape: context.shape,
		scale: context.scale,
		tags: benchmarkCase.tags,
		samples,
		aggregate,
		diff,
	};
};

const runModeMatrix = (mode: BenchmarkCliOptions["mode"]): BenchmarkRunMode[] =>
	mode === "both" ? ["headless", "headed"] : [mode];

const run = async () => {
	const options = parseCliOptions(process.argv.slice(2));
	const reportRoot = path.join(options.reportDir, formatDateTag());
	const artifactDir = path.join(reportRoot, "artifacts");
	ensureDir(reportRoot);
	ensureDir(artifactDir);

	const benchmarkCases = buildCases(options);
	const results: BenchmarkCaseResult[] = [];

	for (const runMode of runModeMatrix(options.mode)) {
		const environments = getEnvironmentMatrix(runMode);
		for (const gpuEnabled of [true, false]) {
			const browser = await launchBrowser(runMode, gpuEnabled);
			try {
				for (const env of environments.filter((item) => item.gpuEnabled === gpuEnabled)) {
					for (const benchmarkCase of benchmarkCases) {
						const shapes = benchmarkCase.supportedShapes.filter((shape) =>
							options.shapes.includes(shape)
						);
						for (const shape of shapes) {
							const scales = shouldUseScale(benchmarkCase.category) ? options.scales : [null];
							for (const scale of scales) {
								const context: BenchmarkContext = {
									browser,
									runMode,
									environment: env.id as BenchmarkEnvironmentId,
									throttleCpu: env.throttleCpu,
									gpuEnabled: env.gpuEnabled,
									headless: env.headless,
									shape: shape as DatasetShape,
									scale,
									artifactDir: path.join(artifactDir, runMode, env.id, benchmarkCase.id, shape),
									reportDir: reportRoot,
								};
								console.log(
									`[基准测试] 测试项=${CASE_LABELS[benchmarkCase.id] || benchmarkCase.id} 模式=${
										MODE_LABELS[runMode]
									} 环境=${ENV_LABELS[env.id as BenchmarkEnvironmentId]} 数据形态=${
										SHAPE_LABELS[shape as DatasetShape]
									} 规模=${scale ?? "不适用"}`
								);
								results.push(await executeCase(benchmarkCase, context));
							}
						}
					}
				}
			} finally {
				await browser.close();
			}
		}
	}

	writeJson(path.join(reportRoot, "benchmark-results.json"), results);
	const summaryPath = buildMarkdownReport(results, reportRoot);
	generateHtmlReport(results, reportRoot);

	if (options.updateBaseline) {
		updateBaselineFile(results, options);
	}

	console.log(`[基准测试] 已写入结果 JSON：${path.join(reportRoot, "benchmark-results.json")}`);
	console.log(`[基准测试] 已写入摘要 Markdown：${summaryPath}`);
};

run().catch((error) => {
	console.error("[基准测试] Runner 执行失败", error);
	process.exit(1);
});
