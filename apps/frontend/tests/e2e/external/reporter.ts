import fs from "fs";
import path from "path";
import { createMarkdownSummary } from "./baseline";
import type { CaseLearning, CaseResult, ExternalReport, MetricMap, MetricStats, RegressionCheck } from "./types";

export const ensureDir = (dir: string) => {
	fs.mkdirSync(dir, { recursive: true });
};

export const writeJson = (filePath: string, value: unknown) => {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

export const writeText = (filePath: string, value: string) => {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, value, "utf-8");
};

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const suiteLabelMap: Record<string, string> = {
	"harness-health": "链路健康检查",
	"correctness-smoke": "正确性冒烟",
	"correctness-full": "完整正确性",
	"performance-external": "外部观测性能",
};

const environmentLabelMap: Record<string, string> = {
	gpu_cpuHigh: "GPU 开 / CPU 高性能",
	gpu_cpuLow: "GPU 开 / CPU 4x 降速",
	noGpu_cpuHigh: "GPU 关 / CPU 高性能",
	noGpu_cpuLow: "GPU 关 / CPU 4x 降速",
};

const runModeLabelMap: Record<string, string> = {
	headless: "无头",
	headed: "有头",
};

const statusLabelMap: Record<string, string> = {
	passed: "通过",
	failed: "失败",
};

const failureLabelMap: Record<string, string> = {
	none: "无",
	harness: "测试链路",
	correctness: "正确性",
	performance: "性能",
	timeout: "超时",
};

const caseTitleMap: Record<string, string> = {
	"harness-health": "链路健康检查",
	"correctness-smoke": "正确性冒烟",
	"concurrent-crossing-visual-consistency": "并发交叉绘制一致性",
	"late-joiner-visual-consistency": "后加入用户画面一致性",
	"protocol-multipage-isolation": "协议多页隔离",
	"incremental-remote-first-pixel": "远端增量首像素",
	"local-realtime-first-pixel": "本地实时首像素",
	"boundary-full-render-until-crash": "全量渲染极限边界",
	"boundary-same-page-heap-growth": "同页堆内存增长边界",
	"boundary-incremental-redraw-freeze": "增量重绘软卡死边界",
	"resilience-network-recovery": "长网络延迟恢复",
};

const caseDescriptionMap: Record<string, string> = {
	"harness-health": "验证前端、后端、WebSocket 和外部观测链路是否正常。",
	"correctness-smoke": "双端真实绘制、撤销重做和基础翻页的可见性与一致性检查。",
	"concurrent-crossing-visual-consistency": "两个浏览器并发交叉绘制后，最终画面是否一致。",
	"late-joiner-visual-consistency": "后加入用户加载历史内容后，与原用户最终画面是否一致。",
	"protocol-multipage-isolation": "通过公开协议制造多页历史，验证翻页后的内容隔离与返回效果。",
	"incremental-remote-first-pixel": "测试侧发出远端笔画后，本端 ROI 首次出现像素变化的时间。",
	"local-realtime-first-pixel": "本地真实输入后，目标 ROI 首次出现像素变化的时间。",
	"boundary-full-render-until-crash": "外部协议制造阶梯历史数据，用 Playwright/CDP 硬指标寻找全量初始化边界。",
	"boundary-same-page-heap-growth": "同一页多轮注入和重载后，通过 CDP JS heap 与 DOM counter 观察内存增长。",
	"boundary-incremental-redraw-freeze": "多协议客户端并发局部重绘，通过截图变化和 CDP heap 观察软卡死边界。",
	"resilience-network-recovery": "通过 CDP 网络模拟长延迟和离线恢复，观察页面恢复到可绘制状态的时间。",
};

const metricLabelMap: Record<string, string> = {
	environment: "环境",
	runMode: "运行模式",
	runs: "采样次数",
	warmup: "预热次数",
	scaleMedian: "规模中位数",
	firstNonBlankMsMedian: "首个非空画面中位数",
	visuallyStableMsMedian: "视觉稳定时间中位数",
	nonBlankRatioMedian: "非空像素比例中位数",
	longTaskCountMedian: "长任务次数中位数",
	longTaskTotalMsMedian: "长任务总时长中位数",
	remoteFirstPixelMsMedian: "远端首像素中位数",
	protocolDispatchOverheadMsMedian: "协议调度开销中位数",
	observerPollElapsedMsMedian: "观测耗时中位数",
	framesToFirstPixelMedian: "首像素帧数中位数",
	roiDiffRatioMedian: "ROI 变化比例中位数",
	inputToFirstPixelMsMedian: "本地首像素中位数",
	inputToFirstPixelFramesMedian: "本地首像素帧数中位数",
	inputDelayMsMedian: "输入延迟中位数",
	finalConsistencyDiffRatio: "最终一致性差异比例",
	passThreshold: "通过阈值",
	page0NonBlankRatio: "第一页非空比例",
	page1SwitchVisibleMs: "第二页切换可见时间",
	page1FramesToFirstPixel: "第二页首像素帧数",
	page1NonBlankRatio: "第二页非空比例",
	remoteFirstPixelMsAtoB: "A 到 B 远端首像素",
	framesToFirstPixelAtoB: "A 到 B 首像素帧数",
	remoteFirstPixelMsBtoA: "B 到 A 远端首像素",
	framesToFirstPixelBtoA: "B 到 A 首像素帧数",
	revisitNonBlankRatio: "返回页非空比例",
	inputToFirstPixelMs: "本地首像素",
	observerPollElapsedMs: "观测耗时",
	framesToFirstPixel: "首像素帧数",
	roiDiffRatio: "ROI 变化比例",
	inputDelayMs: "输入延迟",
	scale: "规模",
	firstNonBlankMs: "首个非空画面",
	visuallyStableMs: "视觉稳定时间",
	nonBlankRatio: "非空像素比例",
	longTaskCount: "长任务次数",
	longTaskTotalMs: "长任务总时长",
	remoteFirstPixelMs: "远端首像素",
	protocolDispatchOverheadMs: "协议调度开销",
	inputToFirstPixelFrames: "本地首像素帧数",
	diffRatio: "差异比例",
	boundaryKind: "边界类型",
	lastSurvivedScale: "最后存活规模",
	firstCrashScale: "首次崩溃规模",
	lastSurvivedConcurrency: "最后存活并发",
	firstCrashConcurrency: "首次崩溃并发",
	crashType: "崩溃类型",
	peakJsHeapMb: "JS 堆峰值",
	peakTotalHeapMb: "JS 堆总量峰值",
	baselinePostGcHeapMb: "首轮 GC 后堆",
	latestPostGcHeapMb: "末轮 GC 后堆",
	heapGrowthMb: "GC 后堆增长",
	seedDurationMs: "预注入耗时",
	scaleRecords: "边界阶梯记录",
	latencyRecords: "延迟恢复记录",
	worstRecoveryMs: "最慢恢复时间",
};

const formatNumber = (value: number) => {
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(1);
};

const formatMetricValue = (key: string, value: unknown) => {
	if (typeof value === "number") {
		if (key.includes("Ms")) return `${value.toFixed(1)} ms`;
		if (key.includes("Mb")) return `${value.toFixed(1)} MB`;
		if (key.includes("Ratio")) return value.toFixed(4);
		return formatNumber(value);
	}
	if (key === "environment" && typeof value === "string") {
		return environmentLabelMap[value] || value;
	}
	if (key === "runMode" && typeof value === "string") {
		return runModeLabelMap[value] || value;
	}
	return String(value);
};

const formatSignedDelta = (metric: string, value: number | undefined) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return "无";
	const sign = value > 0 ? "+" : value < 0 ? "-" : "";
	const absolute = Math.abs(value);
	if (metric.includes("Ms")) return `${sign}${absolute.toFixed(1)} ms`;
	if (metric.includes("Ratio")) return `${sign}${absolute.toFixed(4)}`;
	return `${sign}${formatNumber(absolute)}`;
};

const formatPercentDelta = (value: number | undefined) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return "无";
	const sign = value > 0 ? "+" : value < 0 ? "" : "";
	return `${sign}${value.toFixed(1)}%`;
};

const regressionTrendLabelMap: Record<RegressionCheck["trend"], string> = {
	improved: "提升",
	regressed: "下降",
	unchanged: "持平",
};

const regressionSourceLabelMap: Record<RegressionCheck["source"], string> = {
	baseline: "基线",
	budget: "预算",
};

const learningStatusLabelMap: Record<CaseLearning["status"], string> = {
	insufficient_history: "样本不足",
	normal: "正常",
	suspected: "疑似回归",
	confirmed: "确认回归",
};

const anomalyStatusLabelMap = {
	insufficient_history: "样本不足",
	stable: "稳定",
	watch: "观察中",
	recurring: "重复异常",
	rule_suspected: "规则疑似过严",
} as const;

const translateCaseTitle = (result: CaseResult) => {
	if (result.id.startsWith("full-render-")) {
		const scale = result.scale ?? result.id.replace("full-render-", "");
		return `全量渲染 ${scale} 点`;
	}
	return caseTitleMap[result.id] || result.title || result.id;
};

const translateCaseDescription = (result: CaseResult) => {
	if (result.id.startsWith("full-render-")) {
		return "公开 WebSocket 协议制造历史点数据，测量 late joiner 首个非空画面与视觉稳定时间。";
	}
	return caseDescriptionMap[result.id] || result.description || "";
};

const getPrimaryMetricItems = (result: CaseResult) => {
	const metrics = result.metrics;
	if (typeof metrics.firstNonBlankMsMedian === "number") {
		return [
			{ label: "首个非空", value: formatMetricValue("firstNonBlankMsMedian", metrics.firstNonBlankMsMedian) },
			{ label: "视觉稳定", value: formatMetricValue("visuallyStableMsMedian", metrics.visuallyStableMsMedian) },
		];
	}
	if (typeof metrics.remoteFirstPixelMsMedian === "number") {
		return [
			{ label: "远端首像素", value: formatMetricValue("remoteFirstPixelMsMedian", metrics.remoteFirstPixelMsMedian) },
			{ label: "首像素帧数", value: formatMetricValue("framesToFirstPixelMedian", metrics.framesToFirstPixelMedian) },
		];
	}
	if (typeof metrics.inputToFirstPixelMsMedian === "number") {
		return [
			{ label: "本地首像素", value: formatMetricValue("inputToFirstPixelMsMedian", metrics.inputToFirstPixelMsMedian) },
			{ label: "首像素帧数", value: formatMetricValue("inputToFirstPixelFramesMedian", metrics.inputToFirstPixelFramesMedian) },
		];
	}
	return Object.entries(metrics)
		.slice(0, 2)
		.map(([key, value]) => ({
			label: metricLabelMap[key] || key,
			value: formatMetricValue(key, value),
		}));
};

const getRegressionOverview = (result: CaseResult) => {
	if (!result.regression || result.regression.checks.length === 0) return [];
	return result.regression.checks.slice(0, 2).map((check) => ({
		label: check.label,
		trend: regressionTrendLabelMap[check.trend],
		trendKey: check.trend,
		delta: formatSignedDelta(check.metric, check.delta),
		deltaPercent: formatPercentDelta(check.deltaPercent),
	}));
};

const getLearningOverview = (result: CaseResult) => {
	if (!result.learning) return [];
	const regressionChecks = result.learning.checks
		.filter((check) => check.status !== "insufficient_history")
		.slice(0, 2)
		.map((check) => ({
			label: check.label,
			status: check.status,
			value:
				check.delta !== undefined
					? `${formatSignedDelta(check.metric, check.delta)} / ${formatPercentDelta(check.deltaPercent)}`
					: `${check.sampleCount} 样本`,
		}));
	if (regressionChecks.length > 0) return regressionChecks;
	return result.learning.anomalyChecks
		.filter((check) => check.status !== "insufficient_history" && check.status !== "stable")
		.slice(0, 2)
		.map((check) => ({
			label: check.label,
			status: check.status === "rule_suspected" ? "suspected" : check.status === "recurring" ? "confirmed" : "normal",
			statusLabel: anomalyStatusLabelMap[check.status],
			value: `${formatPercentDelta(typeof check.recentMean === "number" ? (check.current - check.recentMean) * 100 : undefined)} / ${check.sampleCount} 样本`,
		}));
};

const renderMetricList = (metrics: MetricMap) =>
	Object.entries(metrics)
		.map(([key, value]) => {
			const label = metricLabelMap[key] || key;
			return `<div class="metric-row"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-value">${escapeHtml(formatMetricValue(key, value))}</span></div>`;
		})
		.join("");

const renderAggregateList = (aggregate: Record<string, MetricStats>) =>
	Object.entries(aggregate)
		.map(([key, stats]) => {
			const label = metricLabelMap[key] || key;
			const format = (name: string, value: number) =>
				`${name} ${key.includes("Ratio") ? value.toFixed(4) : key.includes("Ms") ? `${value.toFixed(1)} ms` : formatNumber(value)}`;
			return `<div class="aggregate-item">
				<div class="aggregate-label">${escapeHtml(label)}</div>
				<div class="aggregate-values">${escapeHtml(format("中位", stats.median))} / ${escapeHtml(format("平均", stats.mean))} / ${escapeHtml(format("P95", stats.p95))}</div>
			</div>`;
		})
		.join("");

const renderRegressionList = (result: CaseResult) => {
	if (!result.regression || result.regression.checks.length === 0) {
		return '<div class="empty-text">未配置基线或预算对比</div>';
	}
	return result.regression.checks
		.map((check) => {
			const baselineValue =
				check.baseline !== undefined
					? `<div class="regression-subrow"><span>基线值</span><span>${escapeHtml(formatMetricValue(check.metric, check.baseline))}</span></div>`
					: "";
			const currentValue = `<div class="regression-subrow"><span>当前值</span><span>${escapeHtml(formatMetricValue(check.metric, check.current))}</span></div>`;
			const deltaValue = check.delta !== undefined
				? `<div class="regression-subrow"><span>变化</span><span>${escapeHtml(formatSignedDelta(check.metric, check.delta))} / ${escapeHtml(formatPercentDelta(check.deltaPercent))}</span></div>`
				: "";
			const limitValue = check.allowedMax !== undefined
				? `<div class="regression-subrow"><span>允许上限</span><span>${escapeHtml(formatMetricValue(check.metric, check.allowedMax))}</span></div>`
				: "";
			return `<div class="regression-item">
				<div class="regression-item-head">
					<div>
						<div class="regression-item-title">${escapeHtml(check.label)}</div>
						<div class="regression-item-meta">${escapeHtml(regressionSourceLabelMap[check.source])}对比</div>
					</div>
					<div class="regression-badges">
						<span class="trend-badge trend-${check.trend}">${escapeHtml(regressionTrendLabelMap[check.trend])}</span>
						<span class="trend-badge ${check.status === "failed" ? "trend-failed" : "trend-passed"}">${check.status === "failed" ? "超阈值" : "在阈值内"}</span>
					</div>
				</div>
				<div class="regression-grid">
					${baselineValue}
					${currentValue}
					${deltaValue}
					${limitValue}
				</div>
				<div class="regression-message">${escapeHtml(check.message)}</div>
			</div>`;
		})
		.join("");
};

const renderLearningList = (result: CaseResult) => {
	if (!result.learning || result.learning.checks.length === 0) {
		if (!result.learning || result.learning.anomalyChecks.length === 0) {
			return '<div class="empty-text">未启用历史学习</div>';
		}
	}
	const checks = result.learning.checks
		.map((check) => {
			const rows = [
				`<div class="regression-subrow"><span>状态</span><span>${escapeHtml(learningStatusLabelMap[check.status])}</span></div>`,
				`<div class="regression-subrow"><span>当前值</span><span>${escapeHtml(formatMetricValue(check.metric, check.current))}</span></div>`,
				`<div class="regression-subrow"><span>样本数</span><span>${check.sampleCount}</span></div>`,
			];
			if (check.learnedMedian !== undefined) {
				rows.push(
					`<div class="regression-subrow"><span>学习中位数</span><span>${escapeHtml(formatMetricValue(check.metric, check.learnedMedian))}</span></div>`
				);
			}
			if (check.learnedUpperBound !== undefined) {
				rows.push(
					`<div class="regression-subrow"><span>学习上界</span><span>${escapeHtml(formatMetricValue(check.metric, check.learnedUpperBound))}</span></div>`
				);
			}
			if (check.delta !== undefined) {
				rows.push(
					`<div class="regression-subrow"><span>偏移</span><span>${escapeHtml(formatSignedDelta(check.metric, check.delta))} / ${escapeHtml(formatPercentDelta(check.deltaPercent))}</span></div>`
				);
			}
			return `<div class="regression-item">
				<div class="regression-item-head">
					<div>
						<div class="regression-item-title">${escapeHtml(check.label)}</div>
						<div class="regression-item-meta">历史学习判定</div>
					</div>
					<div class="regression-badges">
						<span class="trend-badge ${check.status === "confirmed" ? "trend-failed" : check.status === "suspected" ? "trend-regressed" : "trend-passed"}">${escapeHtml(learningStatusLabelMap[check.status])}</span>
					</div>
				</div>
				<div class="regression-grid">
					${rows.join("")}
				</div>
				<div class="regression-message">${escapeHtml(check.message)}</div>
			</div>`;
		})
		.join("");
	const anomalyChecks = result.learning.anomalyChecks
		.map((check) => {
			const rows = [
				`<div class="regression-subrow"><span>状态</span><span>${escapeHtml(anomalyStatusLabelMap[check.status])}</span></div>`,
				`<div class="regression-subrow"><span>当前值</span><span>${escapeHtml(check.current.toFixed(3))}</span></div>`,
				`<div class="regression-subrow"><span>样本数</span><span>${check.sampleCount}</span></div>`,
			];
			if (typeof check.recentMedian === "number") {
				rows.push(
					`<div class="regression-subrow"><span>历史中位数</span><span>${escapeHtml(check.recentMedian.toFixed(3))}</span></div>`
				);
			}
			if (typeof check.recentUpperBound === "number") {
				rows.push(
					`<div class="regression-subrow"><span>历史上界</span><span>${escapeHtml(check.recentUpperBound.toFixed(3))}</span></div>`
				);
			}
			if (typeof check.recentMean === "number") {
				rows.push(
					`<div class="regression-subrow"><span>历史均值</span><span>${escapeHtml(check.recentMean.toFixed(3))}</span></div>`
				);
			}
			return `<div class="regression-item">
				<div class="regression-item-head">
					<div>
						<div class="regression-item-title">${escapeHtml(check.label)}</div>
						<div class="regression-item-meta">异常通道学习</div>
					</div>
					<div class="regression-badges">
						<span class="trend-badge ${check.status === "rule_suspected" ? "trend-unchanged" : check.status === "recurring" ? "trend-failed" : check.status === "watch" ? "trend-regressed" : "trend-passed"}">${escapeHtml(anomalyStatusLabelMap[check.status])}</span>
					</div>
				</div>
				<div class="regression-grid">
					${rows.join("")}
				</div>
				<div class="regression-message">${escapeHtml(check.message)}</div>
			</div>`;
		})
		.join("");
	const recommendations =
		result.learning.recommendations.length > 0
			? `<div class="learning-recommendations">${result.learning.recommendations
					.map((item) => `<div class="recommendation-item">${escapeHtml(item.message)}</div>`)
					.join("")}</div>`
			: "";
	return `${checks}${anomalyChecks}${recommendations}`;
};

const renderSamples = (result: CaseResult) => {
	if (!result.samples || result.samples.length === 0) return "";
	const sampleCards = result.samples
		.filter((sample) => !sample.warmup)
		.map((sample) => {
			const rows = Object.entries(sample.metrics)
				.filter(([key]) =>
					[
						"firstNonBlankMs",
						"visuallyStableMs",
						"remoteFirstPixelMs",
						"inputToFirstPixelMs",
						"framesToFirstPixel",
						"inputToFirstPixelFrames",
						"inputDelayMs",
					].includes(key)
				)
				.map(([key, value]) => `<span>${escapeHtml(metricLabelMap[key] || key)}: ${escapeHtml(formatMetricValue(key, value))}</span>`)
				.join("");
			return `<div class="sample-card">
				<div class="sample-title">第 ${sample.run} 次</div>
				${sample.qualityStatus && sample.qualityStatus !== "valid" ? `<div class="sample-quality sample-quality-${sample.qualityStatus}">${escapeHtml(sample.qualityStatus)}${sample.qualityReason ? `: ${escapeHtml(sample.qualityReason)}` : ""}</div>` : ""}
				<div class="sample-values">${rows || "<span>无摘要数据</span>"}</div>
			</div>`;
		})
		.join("");
	return `<details class="detail-block">
		<summary>展开采样明细</summary>
		<div class="sample-grid">${sampleCards}</div>
	</details>`;
};

const renderArtifacts = (reportRoot: string, result: CaseResult) => {
	if (!result.artifacts || result.artifacts.length === 0) return "";
	const links = result.artifacts
		.map((artifact) => `<a href="${escapeHtml(path.relative(reportRoot, artifact))}">${escapeHtml(path.basename(artifact))}</a>`)
		.join("");
	return `<details class="detail-block">
		<summary>查看产物</summary>
		<div class="artifact-list">${links}</div>
	</details>`;
};

const renderCaseCard = (reportRoot: string, result: CaseResult) => {
	const primaryItems = getPrimaryMetricItems(result)
		.map(
			(item) => `<div class="primary-chip">
				<span class="primary-chip-label">${escapeHtml(item.label)}</span>
				<span class="primary-chip-value">${escapeHtml(item.value)}</span>
			</div>`
		)
		.join("");
	const regressionOverview = getRegressionOverview(result)
		.map(
			(item) => `<div class="regression-chip regression-chip-${item.trendKey}">
				<span class="regression-chip-label">${escapeHtml(item.label)}</span>
				<span class="regression-chip-value">${escapeHtml(item.trend)} ${escapeHtml(item.delta)}${item.deltaPercent !== "无" ? ` / ${escapeHtml(item.deltaPercent)}` : ""}</span>
			</div>`
		)
		.join("");
	const learningOverview = getLearningOverview(result)
		.map(
			(item) => `<div class="regression-chip regression-chip-${item.status === "confirmed" ? "regressed" : item.status === "suspected" ? "unchanged" : "improved"}">
				<span class="regression-chip-label">${escapeHtml(item.label)}</span>
				<span class="regression-chip-value">${escapeHtml(("statusLabel" in item && typeof item.statusLabel === "string" ? item.statusLabel : learningStatusLabelMap[item.status]))} ${escapeHtml(item.value)}</span>
			</div>`
		)
		.join("");

	return `<article class="case-card ${result.status === "failed" ? "case-card-failed" : ""}">
		<div class="case-card-head">
			<div class="case-title-wrap">
				<div class="case-id">${escapeHtml(result.id)}</div>
				<h3>${escapeHtml(translateCaseTitle(result))}</h3>
				<p>${escapeHtml(translateCaseDescription(result))}</p>
			</div>
			<div class="case-state">
				<span class="status-badge ${result.status === "passed" ? "status-pass" : "status-fail"}">${escapeHtml(statusLabelMap[result.status])}</span>
				<span class="minor-badge">${escapeHtml(failureLabelMap[result.failureType])}</span>
			</div>
		</div>
		<div class="meta-row">
			<span>${escapeHtml(environmentLabelMap[result.environment || ""] || result.environment || "")}</span>
			<span>${escapeHtml(runModeLabelMap[result.runMode || ""] || result.runMode || "")}</span>
			${typeof result.metrics.validSampleCount === "number" ? `<span>有效样本 ${escapeHtml(String(result.metrics.validSampleCount))}</span>` : ""}
			${typeof result.metrics.invalidSampleCount === "number" ? `<span>剔除样本 ${escapeHtml(String(result.metrics.invalidSampleCount))}</span>` : ""}
		</div>
		<div class="case-overview">
			<div class="primary-metric-grid">${primaryItems}</div>
			<div class="overview-stack">
				${regressionOverview ? `<div class="regression-overview-grid">${regressionOverview}</div>` : '<div class="regression-empty">未配置回归对比</div>'}
				${learningOverview ? `<div class="regression-overview-grid">${learningOverview}</div>` : '<div class="regression-empty">未启用历史学习</div>'}
			</div>
		</div>
		<details class="detail-block detail-block-strong">
			<summary>展开详细指标</summary>
			<div class="detail-grid">
				<section class="panel">
					<h4>详细指标</h4>
					${renderMetricList(result.metrics)}
				</section>
				<section class="panel">
					<h4>聚合统计</h4>
					${result.aggregate ? renderAggregateList(result.aggregate) : '<div class="empty-text">无聚合统计</div>'}
				</section>
				<section class="panel">
					<h4>回归对比</h4>
					${renderRegressionList(result)}
				</section>
				<section class="panel">
					<h4>学习判定</h4>
					${renderLearningList(result)}
				</section>
			</div>
			${renderSamples(result)}
			${renderArtifacts(reportRoot, result)}
			${result.error ? `<div class="error-box">${escapeHtml(result.error)}</div>` : ""}
		</details>
	</article>`;
};

const renderEnvironmentSection = (reportRoot: string, environment: string, results: CaseResult[]) => {
	const passed = results.filter((result) => result.status === "passed").length;
	const failed = results.length - passed;
	return `<section class="environment-section">
		<div class="environment-head">
			<div>
				<h2>${escapeHtml(environmentLabelMap[environment] || environment)}</h2>
				<p>${results.length} 个用例，${passed} 个通过，${failed} 个失败</p>
			</div>
			<div class="environment-pill">${escapeHtml(environment)}</div>
		</div>
		<div class="case-grid">
			${results.map((result) => renderCaseCard(reportRoot, result)).join("")}
		</div>
	</section>`;
};

export const writeHtmlReport = (reportRoot: string, report: ExternalReport, runTag = "external") => {
	const { config, results } = report;
	const grouped = new Map<string, CaseResult[]>();
	for (const result of results) {
		const key = result.environment || "default";
		const group = grouped.get(key) || [];
		group.push(result);
		grouped.set(key, group);
	}

	const totalPassed = results.filter((result) => result.status === "passed").length;
	const totalFailed = results.length - totalPassed;
	const regressionChecks = report.regressions.flatMap((item) => item.checks);
	const regressionImproved = regressionChecks.filter((check) => check.trend === "improved").length;
	const regressionRegressed = regressionChecks.filter((check) => check.trend === "regressed").length;
	const regressionUnchanged = regressionChecks.filter((check) => check.trend === "unchanged").length;
	const environmentSections = Array.from(grouped.entries())
		.map(([environment, environmentResults]) => renderEnvironmentSection(reportRoot, environment, environmentResults))
		.join("");

	const html = `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>外部观测测试报告</title>
	<style>
		:root {
			--bg: #f8fafc;
			--surface: rgba(255, 255, 255, 0.88);
			--surface-strong: #ffffff;
			--surface-soft: rgba(241, 245, 249, 0.9);
			--border: rgba(148, 163, 184, 0.18);
			--border-strong: rgba(148, 163, 184, 0.28);
			--text: #0f172a;
			--muted: #64748b;
			--blue: #1d4ed8;
			--blue-soft: rgba(29, 78, 216, 0.1);
			--amber: #f59e0b;
			--amber-soft: rgba(245, 158, 11, 0.14);
			--green: #15803d;
			--green-soft: rgba(21, 128, 61, 0.12);
			--red: #dc2626;
			--red-soft: rgba(220, 38, 38, 0.12);
			--shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
			--radius: 18px;
		}
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; }
		body {
			font-family: "Fira Sans", "Microsoft YaHei UI", "Segoe UI", sans-serif;
			color: var(--text);
			background:
				radial-gradient(circle at 15% 18%, rgba(59, 130, 246, 0.08), transparent 26%),
				radial-gradient(circle at 88% 14%, rgba(245, 158, 11, 0.08), transparent 20%),
				linear-gradient(180deg, #f8fafc 0%, #eef4ff 52%, #f8fafc 100%);
			line-height: 1.5;
		}
		.page {
			max-width: 1640px;
			margin: 0 auto;
			padding: 28px 24px 72px;
		}
		.hero {
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(248, 250, 252, 0.96) 100%);
			backdrop-filter: blur(20px);
			border: 1px solid var(--border);
			border-radius: 24px;
			box-shadow: var(--shadow);
			padding: 32px;
			margin-bottom: 28px;
			position: relative;
			overflow: hidden;
		}
		.hero::before {
			content: "";
			position: absolute;
			inset: 0;
			background:
				linear-gradient(90deg, rgba(29, 78, 216, 0.06), transparent 28%),
				linear-gradient(180deg, transparent, rgba(245, 158, 11, 0.04));
			pointer-events: none;
		}
		.hero > * { position: relative; z-index: 1; }
		.hero h1 {
			margin: 0;
			font-size: 34px;
			letter-spacing: 0;
			font-weight: 700;
		}
		.hero p {
			margin: 12px 0 0;
			color: var(--muted);
			max-width: 980px;
			font-size: 14px;
		}
		.hero-grid {
			display: grid;
			grid-template-columns: 1.6fr 1fr;
			gap: 20px;
			margin-top: 24px;
		}
		.summary-card, .meta-card {
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.98) 100%);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			padding: 18px 18px 16px;
		}
		.summary-head,
		.meta-card > strong {
			display: block;
			font-size: 13px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--muted);
		}
		.summary-kpis {
			display: grid;
			grid-template-columns: repeat(7, minmax(0, 1fr));
			gap: 12px;
			margin-top: 14px;
		}
		.kpi {
			padding: 14px 16px;
			border-radius: 14px;
			background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
			border: 1px solid var(--border-strong);
			min-height: 92px;
		}
		.kpi-label {
			display: block;
			font-size: 12px;
			color: var(--muted);
			margin-bottom: 10px;
		}
		.kpi-value {
			font: 700 24px/1.1 "Fira Code", "Consolas", monospace;
			color: var(--text);
		}
		.meta-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px 18px;
			margin-top: 10px;
		}
		.meta-item {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			padding: 8px 0;
			border-bottom: 1px dashed rgba(148, 163, 184, 0.14);
			font-size: 13px;
		}
		.meta-item span:first-child { color: var(--muted); }
		.meta-item span:last-child {
			font-family: "Fira Code", "Consolas", monospace;
			font-size: 12px;
			color: var(--text);
			text-align: right;
		}
		.environment-section {
			margin-top: 24px;
			padding: 22px 22px 18px;
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.98) 100%);
			border: 1px solid var(--border);
			border-radius: 22px;
			box-shadow: var(--shadow);
		}
		.environment-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
			margin-bottom: 18px;
		}
		.environment-head h2 {
			margin: 0;
			font-size: 22px;
			font-weight: 700;
		}
		.environment-head p {
			margin: 4px 0 0;
			color: var(--muted);
			font-size: 14px;
		}
		.environment-pill {
			padding: 8px 12px;
			border-radius: 999px;
			font: 600 12px/1 "Fira Code", "Consolas", monospace;
			color: var(--blue);
			background: var(--blue-soft);
			border: 1px solid rgba(56, 189, 248, 0.22);
		}
		.case-grid {
			display: flex;
			flex-direction: column;
			gap: 14px;
		}
		.case-card {
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.98) 100%);
			backdrop-filter: blur(14px);
			border: 1px solid var(--border);
			border-radius: 18px;
			box-shadow: 0 10px 28px rgba(15, 23, 42, 0.07);
			padding: 16px 18px;
		}
		.case-card-failed {
			border-color: rgba(220, 38, 38, 0.26);
			box-shadow: 0 14px 30px rgba(220, 38, 38, 0.08);
		}
		.case-card-head {
			display: flex;
			justify-content: space-between;
			gap: 16px;
			align-items: flex-start;
		}
		.case-title-wrap {
			min-width: 0;
		}
		.case-id {
			font: 600 12px/1.4 "Fira Code", "Consolas", monospace;
			color: var(--muted);
			margin-bottom: 6px;
			opacity: 0.86;
		}
		.case-card h3 {
			margin: 0 0 6px;
			font-size: 18px;
			letter-spacing: 0;
		}
		.case-card p {
			margin: 0;
			color: var(--muted);
			font-size: 13px;
			max-width: 78ch;
		}
		.case-state {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-start;
			justify-content: flex-end;
			gap: 8px;
		}
		.status-badge, .minor-badge {
			padding: 8px 12px;
			border-radius: 999px;
			font-size: 12px;
			font-weight: 700;
			white-space: nowrap;
		}
		.status-pass {
			background: var(--green-soft);
			color: var(--green);
		}
		.status-fail {
			background: var(--red-soft);
			color: var(--red);
		}
		.minor-badge {
			background: rgba(148, 163, 184, 0.1);
			color: #475569;
		}
		.case-overview {
			display: grid;
			grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.9fr);
			gap: 14px;
			margin-top: 14px;
		}
		.overview-stack {
			display: grid;
			gap: 10px;
		}
		.primary-metric-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
			margin: 0;
		}
		.regression-overview-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
			margin: 0;
		}
		.regression-empty {
			display: flex;
			align-items: center;
			justify-content: center;
			min-height: 100%;
			padding: 16px;
			border-radius: 14px;
			border: 1px dashed rgba(148, 163, 184, 0.16);
			color: var(--muted);
			font-size: 13px;
			background: var(--surface-soft);
		}
		.regression-chip {
			padding: 12px 14px;
			border-radius: 14px;
			border: 1px solid rgba(148, 163, 184, 0.18);
			background: rgba(255, 255, 255, 0.82);
		}
		.regression-chip-improved {
			background: rgba(34, 197, 94, 0.12);
			border-color: rgba(34, 197, 94, 0.2);
		}
		.regression-chip-regressed {
			background: rgba(248, 113, 113, 0.12);
			border-color: rgba(248, 113, 113, 0.22);
		}
		.regression-chip-unchanged {
			background: rgba(226, 232, 240, 0.9);
		}
		.regression-chip-label {
			display: block;
			font-size: 12px;
			color: var(--muted);
			margin-bottom: 5px;
		}
		.regression-chip-value {
			font: 700 13px/1.35 "Fira Code", "Consolas", monospace;
			color: var(--text);
		}
		.primary-chip {
			padding: 14px 16px;
			border-radius: 14px;
			background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
			border: 1px solid rgba(148, 163, 184, 0.18);
			min-height: 94px;
		}
		.primary-chip-label {
			display: block;
			font-size: 12px;
			color: var(--muted);
			margin-bottom: 6px;
		}
		.primary-chip-value {
			font: 700 20px/1.15 "Fira Code", "Consolas", monospace;
			color: var(--text);
		}
		.meta-row {
			display: flex;
			flex-wrap: wrap;
			gap: 10px 18px;
			font-size: 12px;
			color: var(--muted);
			margin-top: 12px;
		}
		.meta-row span {
			padding: 4px 8px;
			border-radius: 999px;
			background: rgba(241, 245, 249, 0.92);
			border: 1px solid rgba(148, 163, 184, 0.1);
		}
		.detail-grid {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 12px;
			margin-top: 14px;
		}
		.panel {
			background: rgba(255, 255, 255, 0.86);
			border: 1px solid rgba(148, 163, 184, 0.12);
			border-radius: 14px;
			padding: 14px 14px 12px;
		}
		.panel h4 {
			margin: 0 0 10px;
			font-size: 13px;
			color: #0f172a;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}
		.metric-row {
			display: flex;
			justify-content: space-between;
			align-items: baseline;
			gap: 10px;
			padding: 6px 0;
			border-bottom: 1px dashed rgba(148, 163, 184, 0.12);
		}
		.metric-row:last-child { border-bottom: none; }
		.metric-label {
			font-size: 13px;
			color: var(--muted);
		}
		.metric-value {
			font: 600 13px/1.4 "Fira Code", "Consolas", monospace;
			text-align: right;
			color: #0f172a;
		}
		.aggregate-item + .aggregate-item {
			margin-top: 10px;
			padding-top: 10px;
			border-top: 1px dashed rgba(148, 163, 184, 0.18);
		}
		.aggregate-label {
			font-size: 13px;
			color: var(--muted);
			margin-bottom: 4px;
		}
		.aggregate-values {
			font: 600 13px/1.5 "Fira Code", "Consolas", monospace;
			color: #0f172a;
		}
		.regression-item + .regression-item {
			margin-top: 12px;
			padding-top: 12px;
			border-top: 1px dashed rgba(148, 163, 184, 0.18);
		}
		.regression-item-head {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 10px;
			margin-bottom: 8px;
		}
		.regression-item-title {
			font-size: 13px;
			font-weight: 700;
			color: #0f172a;
		}
		.regression-item-meta {
			font-size: 12px;
			color: var(--muted);
			margin-top: 2px;
		}
		.regression-badges {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			justify-content: flex-end;
		}
		.trend-badge {
			padding: 6px 10px;
			border-radius: 999px;
			font-size: 11px;
			font-weight: 700;
			white-space: nowrap;
		}
		.trend-improved {
			background: var(--green-soft);
			color: var(--green);
		}
		.trend-regressed {
			background: var(--red-soft);
			color: var(--red);
		}
		.trend-unchanged {
			background: rgba(148, 163, 184, 0.14);
			color: #475569;
		}
		.trend-passed {
			background: rgba(59, 130, 246, 0.1);
			color: var(--blue);
		}
		.trend-failed {
			background: var(--red-soft);
			color: var(--red);
		}
		.regression-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 6px 10px;
		}
		.regression-subrow {
			display: flex;
			justify-content: space-between;
			gap: 8px;
			font-size: 12px;
			color: var(--muted);
		}
		.regression-subrow span:last-child {
			font: 600 12px/1.35 "Fira Code", "Consolas", monospace;
			color: var(--text);
			text-align: right;
		}
		.regression-message {
			margin-top: 8px;
			font-size: 12px;
			color: var(--muted);
		}
		.learning-recommendations {
			margin-top: 12px;
			display: grid;
			gap: 8px;
		}
		.recommendation-item {
			padding: 10px 12px;
			border-radius: 12px;
			background: rgba(245, 158, 11, 0.08);
			border: 1px solid rgba(245, 158, 11, 0.16);
			color: #92400e;
			font-size: 12px;
			line-height: 1.45;
		}
		.detail-block {
			margin-top: 14px;
			background: rgba(255, 255, 255, 0.7);
			border: 1px solid rgba(148, 163, 184, 0.1);
			border-radius: 14px;
			padding: 12px 14px;
		}
		.detail-block-strong {
			background: rgba(248, 250, 252, 0.92);
		}
		.detail-block summary {
			cursor: pointer;
			font-weight: 700;
			color: #0f172a;
			list-style: none;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
		}
		.detail-block summary::-webkit-details-marker { display: none; }
		.detail-block summary::after {
			content: "展开";
			font-size: 12px;
			color: var(--muted);
			font-weight: 600;
		}
		.detail-block[open] summary::after {
			content: "收起";
		}
		.sample-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 10px;
			margin-top: 12px;
		}
		.sample-card {
			border-radius: 12px;
			background: rgba(255, 255, 255, 0.96);
			border: 1px solid rgba(148, 163, 184, 0.12);
			padding: 12px;
		}
		.sample-title {
			font-weight: 700;
			margin-bottom: 8px;
		}
		.sample-quality {
			margin-bottom: 8px;
			padding: 6px 8px;
			border-radius: 8px;
			font-size: 11px;
			line-height: 1.35;
		}
		.sample-quality-invalid_quality {
			background: rgba(245, 158, 11, 0.12);
			color: #92400e;
		}
		.sample-quality-outlier {
			background: rgba(220, 38, 38, 0.12);
			color: #991b1b;
		}
		.sample-values {
			display: flex;
			flex-direction: column;
			gap: 4px;
			font: 600 12px/1.45 "Fira Code", "Consolas", monospace;
			color: #475569;
		}
		.artifact-list {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 12px;
		}
		.artifact-list a {
			display: inline-flex;
			align-items: center;
			padding: 8px 10px;
			border-radius: 12px;
			background: var(--amber-soft);
			color: #92400e;
			text-decoration: none;
			font-size: 12px;
			font-weight: 700;
		}
		.error-box {
			margin-top: 12px;
			padding: 12px 14px;
			border-radius: 12px;
			background: var(--red-soft);
			color: var(--red);
			font: 600 13px/1.5 "Fira Code", "Consolas", monospace;
		}
		.empty-text {
			font-size: 13px;
			color: var(--muted);
		}
		@media (max-width: 1180px) {
			.hero-grid,
			.detail-grid,
			.sample-grid {
				grid-template-columns: 1fr;
			}
			.case-overview {
				grid-template-columns: 1fr;
			}
		}
		@media (max-width: 760px) {
			.page { padding: 18px 14px 42px; }
			.hero { padding: 20px; border-radius: 20px; }
			.hero h1 { font-size: 28px; }
			.summary-kpis,
			.meta-list,
			.primary-metric-grid,
			.regression-overview-grid,
			.regression-grid {
				grid-template-columns: 1fr;
			}
			.summary-kpis {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
			.case-card-head {
				flex-direction: column;
			}
			.case-state {
				justify-content: flex-start;
			}
			.environment-section {
				padding: 18px 16px 14px;
			}
		}
	</style>
</head>
<body>
	<div class="page">
		<section class="hero">
			<h1>外部观测测试报告</h1>
			<p>这是给本地排查和性能回归看的报告。默认先看每张卡片里的核心指标，再按需展开详细指标、聚合统计和采样明细。</p>
			<div class="hero-grid">
				<div class="summary-card">
					<div class="summary-head">
						<strong>结果总览</strong>
					</div>
					<div class="summary-kpis">
						<div class="kpi">
							<span class="kpi-label">总用例数</span>
							<span class="kpi-value">${results.length}</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">通过</span>
							<span class="kpi-value">${totalPassed}</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">失败</span>
							<span class="kpi-value">${totalFailed}</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">性能回归失败</span>
							<span class="kpi-value">${report.summary.performanceRegressionFailures}</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">学习疑似 / 确认</span>
							<span class="kpi-value">${report.summary.learningSuspected}/${report.summary.learningConfirmed}</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">重复异常 / 规则疑似</span>
							<span class="kpi-value">${report.summary.learningRecurringAnomalies}/${report.summary.learningRuleSuspected}</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">baseline 建议</span>
							<span class="kpi-value">${report.summary.baselineRecommendations}</span>
						</div>
					</div>
				</div>
				<div class="meta-card">
					<strong>当前配置</strong>
					<div class="meta-list">
						<div class="meta-item"><span>套件</span><span>${escapeHtml(suiteLabelMap[config.suite] || config.suite)}</span></div>
						<div class="meta-item"><span>运行模式</span><span>${escapeHtml(runModeLabelMap[config.mode] || config.mode)}</span></div>
						<div class="meta-item"><span>环境矩阵</span><span>${config.matrix ? "开启" : "关闭"}</span></div>
						<div class="meta-item"><span>采样次数</span><span>${config.runs}</span></div>
						<div class="meta-item"><span>预热次数</span><span>${config.warmup}</span></div>
						<div class="meta-item"><span>默认规模档位</span><span>${config.scales.join(" / ")}</span></div>
						<div class="meta-item"><span>输出格式</span><span>${config.reportFormat}</span></div>
						<div class="meta-item"><span>波动带</span><span>±${config.noisePercent}%</span></div>
						<div class="meta-item"><span>历史文件</span><span>${escapeHtml(path.basename(config.historyFile))}</span></div>
						<div class="meta-item"><span>学习窗口 / 最小样本</span><span>${config.learnWindow} / ${config.learnMinSamples}</span></div>
						<div class="meta-item"><span>Z 倍数 / 确认窗口</span><span>${config.learnZScore} / ${config.confirmWindow}</span></div>
						<div class="meta-item"><span>确认最少失败数</span><span>${config.confirmMinFailures}</span></div>
						<div class="meta-item"><span>稳定优化窗口</span><span>${config.stableImprovementRuns}</span></div>
						<div class="meta-item"><span>性能失败策略</span><span>${config.failOnPerformance}</span></div>
						<div class="meta-item"><span>异常学习稳定 / 观察</span><span>${report.learning.anomalyStable} / ${report.learning.anomalyWatch}</span></div>
						<div class="meta-item"><span>基线对比项</span><span>${report.summary.baselineComparisons}</span></div>
						<div class="meta-item"><span>预算对比项</span><span>${report.summary.budgetComparisons}</span></div>
					</div>
				</div>
			</div>
		</section>
		${environmentSections}
	</div>
</body>
</html>`;

	const filePath = path.join(reportRoot, `${runTag}-external-report.html`);
	fs.writeFileSync(filePath, html, "utf-8");
	return filePath;
};

export const writeReports = (reportRoot: string, report: ExternalReport, runTag = "external") => {
	const jsonPath = path.join(reportRoot, `${runTag}-external-results.json`);
	writeJson(jsonPath, report);
	const markdownSummary = createMarkdownSummary(report);
	writeText(path.join(reportRoot, `${runTag}-external-summary.md`), markdownSummary);
	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownSummary}\n`, "utf-8");
	}
	if (report.config.reportFormat === "json") {
		return jsonPath;
	}
	return writeHtmlReport(reportRoot, report, runTag);
};
