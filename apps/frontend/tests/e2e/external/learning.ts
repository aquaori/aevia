import fs from "fs";
import path from "path";
import type {
	BaselineHealthCheck,
	BaselineRecommendation,
	BaselineFile,
	CaseLearning,
	CaseResult,
	CaseSample,
	ExternalConfig,
	LearnedAnomalyCheck,
	LearnedRegressionCheck,
	LearningSummary,
	PerformanceHistoryEntry,
} from "./types";

const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;

const ensureDir = (dir: string) => {
	fs.mkdirSync(dir, { recursive: true });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const historyMetricKeys = (result: CaseResult) => {
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
	const labels: Record<string, string> = {
		firstNonBlankMsMedian: "首个非空画面中位数",
		visuallyStableMsMedian: "视觉稳定时间中位数",
		remoteFirstPixelMsMedian: "远端首像素中位数",
		framesToFirstPixelMedian: "首像素帧数中位数",
		inputToFirstPixelMsMedian: "本地首像素中位数",
		inputToFirstPixelFramesMedian: "本地首像素帧数中位数",
	};
	return labels[metric] || metric;
};

const anomalyMetricLabel = (metric: string) => {
	const labels: Record<string, string> = {
		__caseFailure: "用例失败率",
		__invalidSampleRatio: "无效样本比例",
		__outlierSampleRatio: "离群样本比例",
	};
	return labels[metric] || metric;
};

const median = (values: number[]) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const mad = (values: number[], center: number) => {
	if (values.length === 0) return 0;
	return median(values.map((value) => Math.abs(value - center)));
};

const logRatio = (percent: number) => Math.log(1 + percent / 100);

const caseKeyOf = (result: { environment?: string; id: string }) => `${result.environment || "default"}::${result.id}`;

const historyKeyOf = (entry: PerformanceHistoryEntry) =>
	[
		entry.sourceReport,
		entry.reportGeneratedAt,
		entry.channel,
		entry.caseKey,
		entry.metric,
		entry.environment || "default",
	].join("::");

const extractResults = (payload: unknown): CaseResult[] => {
	if (Array.isArray(payload)) return payload as CaseResult[];
	if (isRecord(payload) && Array.isArray(payload.results)) return payload.results as CaseResult[];
	throw new Error("unsupported results payload: expected array or { results: [] }");
};

const extractGeneratedAt = (payload: unknown, filePath: string) => {
	if (isRecord(payload) && typeof payload.generatedAt === "string" && payload.generatedAt.length > 0) {
		return payload.generatedAt;
	}
	return fs.statSync(filePath).mtime.toISOString();
};

const loadReportPayload = (inputPath: string) => {
	const normalized = path.resolve(inputPath);
	const reportPath = fs.statSync(normalized).isDirectory()
		? path.join(normalized, "external-results.json")
		: normalized;
	if (!fs.existsSync(reportPath)) {
		throw new Error(`external-results.json not found: ${reportPath}`);
	}
	const payload = readJson<unknown>(reportPath);
	return {
		filePath: reportPath,
		generatedAt: extractGeneratedAt(payload, reportPath),
		results: extractResults(payload),
	};
};

const measuredSamplesOf = (result: CaseResult) =>
	(result.samples || []).filter((sample) => !sample.warmup);

const sampleRatio = (samples: CaseSample[], predicate: (sample: CaseSample) => boolean) => {
	const comparable = samples.filter((sample) => sample.status === "passed");
	if (comparable.length === 0) return 0;
	return comparable.filter(predicate).length / comparable.length;
};

const anomalyMetricCurrentValue = (result: CaseResult, metric: string) => {
	const samples = measuredSamplesOf(result);
	if (metric === "__caseFailure") {
		return result.status === "failed" ? 1 : 0;
	}
	if (metric === "__invalidSampleRatio") {
		return sampleRatio(samples, (sample) => sample.qualityStatus === "invalid_quality");
	}
	if (metric === "__outlierSampleRatio") {
		return sampleRatio(samples, (sample) => sample.qualityStatus === "outlier");
	}
	return 0;
};

const caseAnomalyEntries = (
	config: ExternalConfig,
	report: { filePath: string; generatedAt: string },
	importedAt: string,
	result: CaseResult
) => {
	const invalidSampleRatio = anomalyMetricCurrentValue(result, "__invalidSampleRatio");
	const outlierSampleRatio = anomalyMetricCurrentValue(result, "__outlierSampleRatio");
	return [
		{
			version: 1 as const,
			suite: config.suite,
			sourceReport: report.filePath,
			reportGeneratedAt: report.generatedAt,
			importedAt,
			channel: "anomaly" as const,
			caseKey: caseKeyOf(result),
			id: result.id,
			environment: result.environment,
			runMode: result.runMode,
			scale: result.scale,
			metric: "__caseFailure",
			value: result.status === "failed" ? 1 : 0,
			status: result.status,
			failureType: result.failureType,
			anomalyType: "case_failure" as const,
			qualityReason: result.error,
		},
		{
			version: 1 as const,
			suite: config.suite,
			sourceReport: report.filePath,
			reportGeneratedAt: report.generatedAt,
			importedAt,
			channel: "anomaly" as const,
			caseKey: caseKeyOf(result),
			id: result.id,
			environment: result.environment,
			runMode: result.runMode,
			scale: result.scale,
			metric: "__invalidSampleRatio",
			value: invalidSampleRatio,
			status: result.status,
			failureType: result.failureType,
			anomalyType: "invalid_sample_ratio" as const,
			qualityReason: result.error,
		},
		{
			version: 1 as const,
			suite: config.suite,
			sourceReport: report.filePath,
			reportGeneratedAt: report.generatedAt,
			importedAt,
			channel: "anomaly" as const,
			caseKey: caseKeyOf(result),
			id: result.id,
			environment: result.environment,
			runMode: result.runMode,
			scale: result.scale,
			metric: "__outlierSampleRatio",
			value: outlierSampleRatio,
			status: result.status,
			failureType: result.failureType,
			anomalyType: "outlier_sample_ratio" as const,
			qualityReason: result.error,
		},
	];
};

export const loadHistoryEntries = (filePath: string): PerformanceHistoryEntry[] => {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, "utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const entry = JSON.parse(line) as PerformanceHistoryEntry;
			if (!entry.channel) {
				entry.channel = "normal";
			}
			return entry;
		});
};

export const importHistoryFromReport = (
	config: ExternalConfig,
	sourcePath: string
): { historyFile: string; imported: number; total: number } => {
	const report = loadReportPayload(sourcePath);
	const importedAt = new Date().toISOString();
	const incoming: PerformanceHistoryEntry[] = [];

	for (const result of report.results) {
		if (result.category !== "performance") continue;
		if (result.status === "passed") {
			for (const metric of historyMetricKeys(result)) {
				const value = result.metrics[metric];
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
				incoming.push({
					version: 1,
					suite: config.suite,
					sourceReport: report.filePath,
					reportGeneratedAt: report.generatedAt,
					importedAt,
					channel: "normal",
					caseKey: caseKeyOf(result),
					id: result.id,
					environment: result.environment,
					runMode: result.runMode,
					scale: result.scale,
					metric,
					value,
					status: result.status,
					failureType: result.failureType,
				});
			}
		}
		incoming.push(...caseAnomalyEntries(config, report, importedAt, result));
	}

	const existing = loadHistoryEntries(config.historyFile);
	const seen = new Set(existing.map(historyKeyOf));
	const deduped = incoming.filter((entry) => !seen.has(historyKeyOf(entry)));
	ensureDir(path.dirname(config.historyFile));
	if (deduped.length > 0) {
		const chunk = deduped.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		fs.appendFileSync(config.historyFile, chunk, "utf-8");
	}
	return {
		historyFile: config.historyFile,
		imported: deduped.length,
		total: existing.length + deduped.length,
	};
};

const buildHistoryIndex = (entries: PerformanceHistoryEntry[], channel: PerformanceHistoryEntry["channel"]) => {
	const map = new Map<string, PerformanceHistoryEntry[]>();
	for (const entry of entries) {
		if (entry.channel !== channel) continue;
		if (channel === "normal" && entry.status !== "passed") continue;
		const key = `${entry.caseKey}::${entry.metric}`;
		const group = map.get(key) || [];
		group.push(entry);
		map.set(key, group);
	}
	for (const group of map.values()) {
		group.sort((a, b) => a.reportGeneratedAt.localeCompare(b.reportGeneratedAt));
	}
	return map;
};

const classifyLearningStatus = (
	currentLog: number,
	upperBound: number,
	recentAboveThreshold: number,
	config: ExternalConfig
) => {
	if (currentLog <= upperBound) return "normal" as const;
	return recentAboveThreshold + 1 >= config.confirmMinFailures ? "confirmed" : "suspected";
};

const classifyAnomalyStatus = (
	metric: string,
	current: number,
	upperBound: number,
	recentAboveThreshold: number,
	recentMedian: number,
	config: ExternalConfig
) => {
	if (current <= upperBound) return "stable" as const;
	if (
		metric === "__invalidSampleRatio" &&
		current >= 0.5 &&
		(recentMedian >= 0.35 || recentAboveThreshold + 1 >= config.confirmMinFailures)
	) {
		return "rule_suspected" as const;
	}
	return recentAboveThreshold + 1 >= config.confirmMinFailures ? "recurring" as const : "watch" as const;
};

const detectBaselineHealth = (
	metric: string,
	baselineValue: number | undefined,
	learnedMedian: number | undefined,
	learnedUpperBound: number | undefined,
	noiseBand: number
): BaselineHealthCheck => {
	const label = metricLabel(metric);
	if (
		baselineValue === undefined ||
		learnedMedian === undefined ||
		learnedUpperBound === undefined ||
		baselineValue <= 0
	) {
		return {
			caseKey: "",
			metric,
			label,
			status: "unknown",
			currentBaseline: baselineValue,
			message: "历史样本不足，无法判断 baseline 健康度",
		};
	}
	const baselineLog = Math.log(baselineValue);
	const lowerHealthyBound = learnedMedian - noiseBand;
	if (baselineLog < lowerHealthyBound) {
		return {
			caseKey: "",
			metric,
			label,
			status: "too_strict",
			currentBaseline: baselineValue,
			learnedMedian: Math.exp(learnedMedian),
			learnedUpperBound: Math.exp(learnedUpperBound),
			message: `${label} 的 baseline 偏严，常态样本整体慢于当前 baseline`,
		};
	}
	if (baselineLog > learnedUpperBound) {
		return {
			caseKey: "",
			metric,
			label,
			status: "too_loose",
			currentBaseline: baselineValue,
			learnedMedian: Math.exp(learnedMedian),
			learnedUpperBound: Math.exp(learnedUpperBound),
			message: `${label} 的 baseline 偏宽，当前门限高于学习到的正常上界`,
		};
	}
	return {
		caseKey: "",
		metric,
		label,
		status: "healthy",
		currentBaseline: baselineValue,
		learnedMedian: Math.exp(learnedMedian),
		learnedUpperBound: Math.exp(learnedUpperBound),
		message: `${label} 的 baseline 处于学习到的正常范围内`,
	};
};

const detectBaselineRecommendation = (
	caseKey: string,
	metric: string,
	historyValues: number[],
	baselineValue: number | undefined,
	config: ExternalConfig
): BaselineRecommendation | null => {
	const label = metricLabel(metric);
	if (historyValues.length < config.stableImprovementRuns || baselineValue === undefined || baselineValue <= 0) {
		return null;
	}
	const recentValues = historyValues.slice(-config.stableImprovementRuns);
	const recentMedian = median(recentValues);
	const improvedEnough = recentValues.every((value) => value <= baselineValue * (1 - config.noisePercent / 100));
	if (!improvedEnough) return null;
	const recentLogs = recentValues.map((value) => Math.log(value));
	const recentCenter = median(recentLogs);
	const recentSigma = 1.4826 * mad(recentLogs, recentCenter);
	const stableEnough = config.learnZScore * recentSigma <= logRatio(config.noisePercent);
	if (!stableEnough) return null;
	const improvementPercent = ((recentMedian - baselineValue) / baselineValue) * 100;
	return {
		caseKey,
		metric,
		label,
		status: "suggested",
		currentBaseline: baselineValue,
		recommendedBaseline: recentMedian,
		sampleCount: recentValues.length,
		improvementPercent,
		message: `${label} 最近 ${recentValues.length} 次持续优于 baseline，建议将 baseline 调整为 ${recentMedian.toFixed(1)}`,
	};
};

const buildAnomalyChecks = (
	config: ExternalConfig,
	result: CaseResult,
	anomalyIndex: Map<string, PerformanceHistoryEntry[]>
) => {
	const caseKey = caseKeyOf(result);
	const metrics = ["__caseFailure", "__invalidSampleRatio", "__outlierSampleRatio"];
	const checks: LearnedAnomalyCheck[] = [];

	for (const metric of metrics) {
		const current = anomalyMetricCurrentValue(result, metric);
		const history = (anomalyIndex.get(`${caseKey}::${metric}`) || []).map((entry) => entry.value);
		const recentHistory = history.slice(-config.learnWindow);
		if (recentHistory.length < config.learnMinSamples) {
			checks.push({
				caseKey,
				metric,
				label: anomalyMetricLabel(metric),
				status: "insufficient_history",
				current,
				sampleCount: recentHistory.length,
				message: `异常样本不足，当前只有 ${recentHistory.length} 个样本，至少需要 ${config.learnMinSamples} 个`,
			});
			continue;
		}

		const recentMedian = median(recentHistory);
		const recentMean = recentHistory.reduce((sum, value) => sum + value, 0) / recentHistory.length;
		const recentMad = mad(recentHistory, recentMedian);
		const recentSigma = 1.4826 * recentMad;
		const recentUpperBound = Math.min(1, recentMedian + Math.max(recentSigma * config.learnZScore, 0.08));
		const recentAboveThreshold = recentHistory
			.slice(-(config.confirmWindow - 1))
			.filter((value) => value > recentUpperBound).length;
		const status = classifyAnomalyStatus(
			metric,
			current,
			recentUpperBound,
			recentAboveThreshold,
			recentMedian,
			config
		);
		checks.push({
			caseKey,
			metric,
			label: anomalyMetricLabel(metric),
			status,
			current,
			sampleCount: recentHistory.length,
			recentMedian,
			recentMean,
			recentUpperBound,
			recentAboveThreshold,
			message:
				status === "rule_suspected"
					? `${anomalyMetricLabel(metric)} 持续偏高，更像测试规则或观测门槛过严`
					: status === "recurring"
						? `${anomalyMetricLabel(metric)} 连续多次超出历史常态，属于重复异常`
						: status === "watch"
							? `${anomalyMetricLabel(metric)} 高于历史常态，但重复证据不足，先观察`
							: `${anomalyMetricLabel(metric)} 落在历史异常波动范围内`,
		});
	}

	return checks;
};

export const buildLearningArtifacts = (
	config: ExternalConfig,
	results: CaseResult[],
	historyEntries: PerformanceHistoryEntry[],
	baseline: BaselineFile | null
): {
	learnedRegressions: CaseLearning[];
	learning: LearningSummary;
	baselineRecommendations: BaselineRecommendation[];
} => {
	const historyIndex = buildHistoryIndex(historyEntries, "normal");
	const anomalyIndex = buildHistoryIndex(historyEntries, "anomaly");
	const learnedRegressions: CaseLearning[] = [];
	const baselineRecommendations: BaselineRecommendation[] = [];

	for (const result of results) {
		if (result.category !== "performance") continue;
		const caseKey = caseKeyOf(result);
		const checks: LearnedRegressionCheck[] = [];
		const anomalyChecks = buildAnomalyChecks(config, result, anomalyIndex);
		const healthChecks: BaselineHealthCheck[] = [];
		const recommendations: BaselineRecommendation[] = [];

		for (const metric of historyMetricKeys(result)) {
			const current = result.metrics[metric];
			if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) continue;
			const history = (historyIndex.get(`${caseKey}::${metric}`) || []).map((entry) => entry.value);
			const recentHistory = history.slice(-config.learnWindow);
			if (recentHistory.length < config.learnMinSamples) {
				checks.push({
					caseKey,
					metric,
					label: metricLabel(metric),
					status: "insufficient_history",
					current,
					sampleCount: recentHistory.length,
					message: `历史样本不足，当前只有 ${recentHistory.length} 个样本，至少需要 ${config.learnMinSamples} 个`,
				});
				continue;
			}

			const historyLogs = recentHistory.map((value) => Math.log(value));
			const learnedMedian = median(historyLogs);
			const learnedMad = mad(historyLogs, learnedMedian);
			const learnedSigma = 1.4826 * learnedMad;
			const noiseBand = Math.max(config.learnZScore * learnedSigma, logRatio(config.noisePercent));
			const learnedLowerBound = learnedMedian - noiseBand;
			const learnedUpperBound = learnedMedian + noiseBand;
			const currentLog = Math.log(current);
			const delta = current - Math.exp(learnedMedian);
			const deltaPercent = ((current - Math.exp(learnedMedian)) / Math.exp(learnedMedian)) * 100;
			const recentOutliers = historyLogs
				.slice(-(config.confirmWindow - 1))
				.filter((value) => value > learnedUpperBound).length;
			const status = classifyLearningStatus(currentLog, learnedUpperBound, recentOutliers, config);
			checks.push({
				caseKey,
				metric,
				label: metricLabel(metric),
				status,
				current,
				sampleCount: recentHistory.length,
				learnedMedian: Math.exp(learnedMedian),
				learnedMad: learnedMad === 0 ? 0 : Math.exp(learnedMad) - 1,
				learnedSigma,
				learnedLowerBound: Math.exp(learnedLowerBound),
				learnedUpperBound: Math.exp(learnedUpperBound),
				delta,
				deltaPercent,
				zScore: learnedSigma > 0 ? (currentLog - learnedMedian) / learnedSigma : undefined,
				recentAboveThreshold: recentOutliers,
				message:
					status === "confirmed"
						? `${metricLabel(metric)} 超过学习上界，且最近历史中存在重复异常，判定为确认回归`
						: status === "suspected"
							? `${metricLabel(metric)} 超过学习上界，但缺少重复证据，判定为疑似回归`
							: `${metricLabel(metric)} 落在学习到的正常波动范围内`,
			});

			const baselineValue = baseline?.cases[caseKey]?.metrics?.[metric];
			const baselineHealth = detectBaselineHealth(
				metric,
				typeof baselineValue === "number" ? baselineValue : undefined,
				learnedMedian,
				learnedUpperBound,
				logRatio(config.noisePercent)
			);
			baselineHealth.caseKey = caseKey;
			healthChecks.push(baselineHealth);

			const recommendation = detectBaselineRecommendation(
				caseKey,
				metric,
				recentHistory,
				typeof baselineValue === "number" ? baselineValue : undefined,
				config
			);
			if (recommendation) {
				recommendations.push(recommendation);
				baselineRecommendations.push(recommendation);
			}
		}

		if (checks.length === 0 && anomalyChecks.length === 0) continue;
		const hasConfirmed = checks.some((check) => check.status === "confirmed");
		const hasSuspected = checks.some((check) => check.status === "suspected");
		const hasNormal = checks.some((check) => check.status === "normal");
		const learningStatus = hasConfirmed
			? "confirmed"
			: hasSuspected
				? "suspected"
				: hasNormal
					? "normal"
					: "insufficient_history";
		const learning: CaseLearning = {
			caseKey,
			id: result.id,
			environment: result.environment,
			status: learningStatus,
			checks,
			anomalyChecks,
			baselineHealth: healthChecks,
			recommendations,
		};
		result.learning = learning;
		learnedRegressions.push(learning);
	}

	const learningSummary: LearningSummary = {
		historyEntries: historyEntries.length,
		learnedChecks: learnedRegressions.reduce((sum, item) => sum + item.checks.length, 0),
		insufficientHistory: learnedRegressions.reduce(
			(sum, item) => sum + item.checks.filter((check) => check.status === "insufficient_history").length,
			0
		),
		normal: learnedRegressions.reduce(
			(sum, item) => sum + item.checks.filter((check) => check.status === "normal").length,
			0
		),
		suspected: learnedRegressions.reduce(
			(sum, item) => sum + item.checks.filter((check) => check.status === "suspected").length,
			0
		),
		confirmed: learnedRegressions.reduce(
			(sum, item) => sum + item.checks.filter((check) => check.status === "confirmed").length,
			0
		),
		anomalyChecks: learnedRegressions.reduce((sum, item) => sum + item.anomalyChecks.length, 0),
		anomalyStable: learnedRegressions.reduce(
			(sum, item) => sum + item.anomalyChecks.filter((check) => check.status === "stable").length,
			0
		),
		anomalyWatch: learnedRegressions.reduce(
			(sum, item) => sum + item.anomalyChecks.filter((check) => check.status === "watch").length,
			0
		),
		anomalyRecurring: learnedRegressions.reduce(
			(sum, item) => sum + item.anomalyChecks.filter((check) => check.status === "recurring").length,
			0
		),
		ruleSuspected: learnedRegressions.reduce(
			(sum, item) => sum + item.anomalyChecks.filter((check) => check.status === "rule_suspected").length,
			0
		),
		baselineRecommendations: baselineRecommendations.length,
	};

	return {
		learnedRegressions,
		learning: learningSummary,
		baselineRecommendations,
	};
};

export const shouldFailForLearning = (
	config: ExternalConfig,
	learnedRegressions: CaseLearning[]
): { shouldFail: boolean; messages: string[] } => {
	if (config.failOnPerformance === "none") return { shouldFail: false, messages: [] };
	const statuses = learnedRegressions.map((item) => item.status);
	const shouldFail =
		config.failOnPerformance === "all"
			? statuses.some((status) => status === "suspected" || status === "confirmed")
			: config.failOnPerformance === "suspected"
				? statuses.some((status) => status === "suspected" || status === "confirmed")
				: statuses.some((status) => status === "confirmed");
	const messages = learnedRegressions
		.filter((item) =>
			config.failOnPerformance === "confirmed"
				? item.status === "confirmed"
				: item.status === "suspected" || item.status === "confirmed"
		)
		.flatMap((item) =>
			item.checks
				.filter((check) =>
					config.failOnPerformance === "confirmed"
						? check.status === "confirmed"
						: check.status === "suspected" || check.status === "confirmed"
				)
				.map((check) => `${item.caseKey} / ${check.metric}: ${check.message}`)
		);
	return { shouldFail, messages };
};
