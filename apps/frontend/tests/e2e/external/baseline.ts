import fs from "fs";
import path from "path";
import type {
	BaselineCaseSnapshot,
	BaselineFile,
	BaselineRecommendation,
	BudgetFile,
	CaseRegression,
	CaseResult,
	ExternalConfig,
	ExternalReport,
	CaseLearning,
	LearningSummary,
	RegressionCheck,
} from "./types";

const exists = (filePath: string) => fs.existsSync(filePath);

const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const candidatePaths = (inputPath: string) => {
	const normalized = inputPath.trim().replace(/[\\/]+/g, path.sep);
	const candidates = new Set<string>();
	if (path.isAbsolute(normalized)) {
		candidates.add(path.normalize(normalized));
		return Array.from(candidates);
	}

	let currentDir = process.cwd();
	while (true) {
		candidates.add(path.resolve(currentDir, normalized));
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	candidates.add(path.resolve(normalized));
	return Array.from(candidates);
};

export const resolveResultsFile = (inputPath: string) => {
	if (!inputPath) throw new Error("baseline source is required");
	const resolved = candidatePaths(inputPath).find((candidate) => exists(candidate));
	if (!resolved) {
		throw new Error(
			`baseline source not found. tried: ${candidatePaths(inputPath).join(" | ")}`
		);
	}
	if (fs.statSync(resolved).isDirectory()) {
		const flat = fs
			.readdirSync(resolved)
			.map((entry) => path.join(resolved, entry))
			.filter((filePath) => fs.statSync(filePath).isFile())
			.filter((filePath) => path.basename(filePath).endsWith("-external-results.json"))
			.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
		if (flat[0]) return flat[0];
		const nested = path.join(resolved, "external-results.json");
		if (!exists(nested)) throw new Error(`external-results.json not found in: ${resolved}`);
		return nested;
	}
	return resolved;
};

export const caseKeyOf = (result: { environment?: string; id: string }) =>
	`${result.environment || "default"}::${result.id}`;

const extractResultsArray = (raw: unknown): CaseResult[] => {
	if (Array.isArray(raw)) return raw as CaseResult[];
	if (isRecord(raw) && Array.isArray(raw.results)) return raw.results as CaseResult[];
	throw new Error("unsupported results payload: expected array or { results: [] }");
};

export const loadReportResults = (inputPath: string) => {
	const filePath = resolveResultsFile(inputPath);
	const raw = readJson<unknown>(filePath);
	return {
		filePath,
		results: extractResultsArray(raw),
	};
};

export const createBaselineFromResults = (
	results: CaseResult[],
	sourceReport?: string,
	suite?: string
): BaselineFile => {
	const cases: Record<string, BaselineCaseSnapshot> = {};
	for (const result of results) {
		cases[caseKeyOf(result)] = {
			id: result.id,
			environment: result.environment,
			runMode: result.runMode,
			scale: result.scale,
			metrics: result.metrics,
		};
	}
	return {
		version: 1,
		createdAt: new Date().toISOString(),
		sourceReport,
		suite: suite as BaselineFile["suite"],
		cases,
	};
};

export const writeBaselineFile = (filePath: string, baseline: BaselineFile) => {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf-8");
};

export const loadBaselineFile = (filePath: string): BaselineFile | null => {
	if (!filePath || !exists(filePath)) return null;
	return readJson<BaselineFile>(filePath);
};

export const loadBudgetFile = (filePath: string | undefined): BudgetFile | null => {
	if (!filePath || !exists(filePath)) return null;
	return readJson<BudgetFile>(filePath);
};

const caseRegressionMetrics = (result: CaseResult) => {
	if (result.id.startsWith("full-render-")) {
		return ["firstNonBlankMsMedian", "visuallyStableMsMedian"];
	}
	if (result.id === "incremental-remote-first-pixel") {
		return ["remoteFirstPixelMsMedian", "framesToFirstPixelMedian"];
	}
	if (result.id === "local-realtime-first-pixel") {
		return ["inputToFirstPixelMsMedian", "inputToFirstPixelFramesMedian"];
	}
	return [];
};

const metricLabel = (metric: string) => {
	const map: Record<string, string> = {
		firstNonBlankMsMedian: "首个非空画面中位数",
		visuallyStableMsMedian: "视觉稳定时间中位数",
		remoteFirstPixelMsMedian: "远端首像素中位数",
		framesToFirstPixelMedian: "首像素帧数中位数",
		inputToFirstPixelMsMedian: "本地首像素中位数",
		inputToFirstPixelFramesMedian: "本地首像素帧数中位数",
	};
	return map[metric] || metric;
};

const classifyTrend = (delta: number, deltaPercent: number, noisePercent: number) => {
	if (Math.abs(deltaPercent) <= noisePercent) return "unchanged" as const;
	return delta < 0 ? "improved" : delta > 0 ? "regressed" : "unchanged";
};

const evaluateBaselineCheck = (
	config: ExternalConfig,
	result: CaseResult,
	metric: string,
	baselineValue: number
): RegressionCheck | null => {
	const current = result.metrics[metric];
	if (typeof current !== "number" || !Number.isFinite(current)) return null;
	const delta = current - baselineValue;
	const deltaPercent = baselineValue === 0 ? 0 : (delta / baselineValue) * 100;
	const absoluteAllowance = metric.includes("Frames") ? 1 : config.regressionAbsoluteMs;
	const allowedMax = baselineValue + Math.max(absoluteAllowance, baselineValue * (config.regressionPercent / 100));
	const passed = current <= allowedMax;
	const trend = classifyTrend(delta, deltaPercent, config.noisePercent);
	return {
		metric,
		label: metricLabel(metric),
		source: "baseline",
		status: passed ? "passed" : "failed",
		trend,
		current,
		baseline: baselineValue,
		allowedMax,
		delta,
		deltaPercent,
		thresholdPercent: config.regressionPercent,
		thresholdAbsoluteMs: absoluteAllowance,
		message: passed
			? trend === "unchanged"
				? `${metricLabel(metric)} 变化在 ±${config.noisePercent}% 波动带内`
				: `${metricLabel(metric)} 未超过基线容忍范围`
			: `${metricLabel(metric)} 从 ${baselineValue.toFixed(1)} 增长到 ${current.toFixed(1)}，超过允许上限 ${allowedMax.toFixed(1)}`,
	};
};

const evaluateBudgetCheck = (
	config: ExternalConfig,
	result: CaseResult,
	metric: string,
	max: number
): RegressionCheck | null => {
	const current = result.metrics[metric];
	if (typeof current !== "number" || !Number.isFinite(current)) return null;
	const passed = current <= max;
	const delta = current - max;
	const deltaPercent = max === 0 ? 0 : (delta / max) * 100;
	return {
		metric,
		label: metricLabel(metric),
		source: "budget",
		status: passed ? "passed" : "failed",
		trend: classifyTrend(delta, deltaPercent, config.noisePercent),
		current,
		allowedMax: max,
		delta,
		deltaPercent,
		message: passed
			? `${metricLabel(metric)} 未超过预算`
			: `${metricLabel(metric)} 为 ${current.toFixed(1)}，超过预算 ${max.toFixed(1)}`,
	};
};

export const applyPerformanceRegressions = (
	config: ExternalConfig,
	results: CaseResult[],
	baseline: BaselineFile | null,
	budgets: BudgetFile | null
) => {
	const regressions: CaseRegression[] = [];
	for (const result of results) {
		if (result.category !== "performance" || result.status !== "passed") continue;
		const metrics = caseRegressionMetrics(result);
		if (metrics.length === 0) continue;

		const key = caseKeyOf(result);
		const checks: RegressionCheck[] = [];
		const baselineSnapshot = baseline?.cases[key];
		for (const metric of metrics) {
			if (baselineSnapshot && typeof baselineSnapshot.metrics[metric] === "number") {
				const check = evaluateBaselineCheck(config, result, metric, baselineSnapshot.metrics[metric] as number);
				if (check) checks.push(check);
			}
			const budgetRule = budgets?.cases[key]?.metrics?.[metric];
			if (budgetRule?.max !== undefined) {
				const check = evaluateBudgetCheck(config, result, metric, budgetRule.max);
				if (check) checks.push(check);
			}
		}

		if (checks.length === 0) continue;
		const failedChecks = checks.filter((check) => check.status === "failed");
		const regression: CaseRegression = {
			caseKey: key,
			id: result.id,
			environment: result.environment,
			status: failedChecks.length > 0 ? "failed" : "passed",
			checks,
		};
		result.regression = regression;
		regressions.push(regression);
	}
	return regressions;
};

export const buildExternalReport = (
	config: ExternalConfig,
	results: CaseResult[],
	regressions: CaseRegression[],
	learning: LearningSummary,
	learnedRegressions: CaseLearning[],
	baselineRecommendations: BaselineRecommendation[]
): ExternalReport => {
	const performanceRegressionFailures = regressions.filter((item) => item.status === "failed").length;
	const hardBoundaryCount = results.filter((result) => result.metrics.boundaryKind === "hard-boundary").length;
	const softBoundaryCount = results.filter((result) => result.metrics.boundaryKind === "soft-freeze-boundary").length;
	const summary = {
		total: results.length,
		passed: results.filter((result) => result.status === "passed").length,
		failed: results.filter((result) => result.status === "failed").length,
		performanceRegressionFailures,
		baselineComparisons: regressions.reduce(
			(sum, item) => sum + item.checks.filter((check) => check.source === "baseline").length,
			0
		),
		budgetComparisons: regressions.reduce(
			(sum, item) => sum + item.checks.filter((check) => check.source === "budget").length,
			0
		),
		learningSuspected: learning.suspected,
		learningConfirmed: learning.confirmed,
		learningRecurringAnomalies: learning.anomalyRecurring,
		learningRuleSuspected: learning.ruleSuspected,
		baselineRecommendations: baselineRecommendations.length,
		hardBoundaryCount,
		softBoundaryCount,
	};
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		config: {
			action: config.action,
			reportFormat: config.reportFormat,
			mode: config.mode,
			suite: config.suite,
			caseSet: config.caseSet,
			scales: config.scales,
			boundaryScales: config.boundaryScales,
			concurrencyLevels: config.concurrencyLevels,
			latencies: config.latencies,
			runs: config.runs,
			warmup: config.warmup,
			matrix: config.matrix,
			environment: config.environment,
			cpuThrottle: config.cpuThrottle,
			gpu: config.gpu,
			baselineFile: config.baselineFile,
			budgetsFile: config.budgetsFile,
			historyFile: config.historyFile,
			noisePercent: config.noisePercent,
			regressionPercent: config.regressionPercent,
			regressionAbsoluteMs: config.regressionAbsoluteMs,
			learnWindow: config.learnWindow,
			learnMinSamples: config.learnMinSamples,
			learnZScore: config.learnZScore,
			confirmWindow: config.confirmWindow,
			confirmMinFailures: config.confirmMinFailures,
			stableImprovementRuns: config.stableImprovementRuns,
			failOnPerformance: config.failOnPerformance,
			importCurrentToHistory: config.importCurrentToHistory,
			caseTimeoutMs: config.caseTimeoutMs,
			seedTimeoutMs: config.seedTimeoutMs,
			boundaryPointsPerStroke: config.boundaryPointsPerStroke,
			freezeMs: config.freezeMs,
			heapSnapshot: config.heapSnapshot,
		},
		summary,
		results,
		regressions,
		learning,
		learnedRegressions,
		baselineRecommendations,
	};
};

export const createMarkdownSummary = (report: ExternalReport) => {
	const lines = [
		`# 外部观测测试结果`,
		"",
		`- 套件：\`${report.config.suite}\``,
		`- case-set：\`${report.config.caseSet}\``,
		`- 通过：\`${report.summary.passed}\` / \`${report.summary.total}\``,
		`- 失败：\`${report.summary.failed}\``,
		`- 性能回归失败：\`${report.summary.performanceRegressionFailures}\``,
		`- 学习确认回归：\`${report.summary.learningConfirmed}\``,
		`- 学习疑似回归：\`${report.summary.learningSuspected}\``,
		`- 重复异常：\`${report.summary.learningRecurringAnomalies}\``,
		`- 规则疑似过严：\`${report.summary.learningRuleSuspected}\``,
		`- baseline 建议：\`${report.summary.baselineRecommendations}\``,
		`- hard boundary：\`${report.summary.hardBoundaryCount}\``,
		`- soft boundary：\`${report.summary.softBoundaryCount}\``,
		`- 基线对比项：\`${report.summary.baselineComparisons}\``,
		`- 预算对比项：\`${report.summary.budgetComparisons}\``,
		"",
	];

	const failed = report.results.filter((result) => result.status === "failed");
	if (failed.length > 0) {
		lines.push("## 失败用例", "");
		for (const result of failed) {
			lines.push(`- \`${caseKeyOf(result)}\`：${result.failureType}，${result.error || "无错误详情"}`);
		}
		lines.push("");
	}

	const regressionFailures = report.regressions.filter((item) => item.status === "failed");
	if (regressionFailures.length > 0) {
		lines.push("## 性能回归", "");
		for (const item of regressionFailures) {
			for (const check of item.checks.filter((entry) => entry.status === "failed")) {
				lines.push(`- \`${item.caseKey}\` / \`${check.metric}\`：${check.message}`);
			}
		}
		lines.push("");
	}

	const learnedFailures = report.learnedRegressions.filter(
		(item) => item.status === "confirmed" || item.status === "suspected"
	);
	if (learnedFailures.length > 0) {
		lines.push("## 学习判定", "");
		for (const item of learnedFailures) {
			for (const check of item.checks.filter((entry) => entry.status !== "normal" && entry.status !== "insufficient_history")) {
				lines.push(`- \`${item.caseKey}\` / \`${check.metric}\`：${check.message}`);
			}
		}
		lines.push("");
	}

	const anomalyFindings = report.learnedRegressions.filter((item) =>
		item.anomalyChecks.some((check) => check.status === "recurring" || check.status === "rule_suspected")
	);
	if (anomalyFindings.length > 0) {
		lines.push("## 异常学习", "");
		for (const item of anomalyFindings) {
			for (const check of item.anomalyChecks.filter(
				(entry) => entry.status === "recurring" || entry.status === "rule_suspected"
			)) {
				lines.push(`- \`${item.caseKey}\` / \`${check.metric}\`：${check.message}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
};
