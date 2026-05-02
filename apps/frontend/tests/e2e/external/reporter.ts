import fs from "fs";
import path from "path";
import type { CaseResult, ExternalConfig, MetricMap, MetricStats } from "./types";

export const ensureDir = (dir: string) => {
	fs.mkdirSync(dir, { recursive: true });
};

export const writeJson = (filePath: string, value: unknown) => {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
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
};

const caseDescriptionMap: Record<string, string> = {
	"harness-health": "验证前端、后端、WebSocket 和外部观测链路是否正常。",
	"correctness-smoke": "双端真实绘制、撤销重做和基础翻页的可见性与一致性检查。",
	"concurrent-crossing-visual-consistency": "两个浏览器并发交叉绘制后，最终画面是否一致。",
	"late-joiner-visual-consistency": "后加入用户加载历史内容后，与原用户最终画面是否一致。",
	"protocol-multipage-isolation": "通过公开协议制造多页历史，验证翻页后的内容隔离与返回效果。",
	"incremental-remote-first-pixel": "测试侧发出远端笔画后，本端 ROI 首次出现像素变化的时间。",
	"local-realtime-first-pixel": "本地真实输入后，目标 ROI 首次出现像素变化的时间。",
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
};

const formatNumber = (value: number) => {
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(1);
};

const formatMetricValue = (key: string, value: unknown) => {
	if (typeof value === "number") {
		if (key.includes("Ms")) return `${value.toFixed(1)} ms`;
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

	return `<article class="case-card ${result.status === "failed" ? "case-card-failed" : ""}">
		<div class="case-card-head">
			<div>
				<div class="case-id">${escapeHtml(result.id)}</div>
				<h3>${escapeHtml(translateCaseTitle(result))}</h3>
				<p>${escapeHtml(translateCaseDescription(result))}</p>
			</div>
			<div class="case-state">
				<span class="status-badge ${result.status === "passed" ? "status-pass" : "status-fail"}">${escapeHtml(statusLabelMap[result.status])}</span>
				<span class="minor-badge">${escapeHtml(failureLabelMap[result.failureType])}</span>
			</div>
		</div>
		<div class="primary-metric-grid">${primaryItems}</div>
		<div class="meta-row">
			<span>${escapeHtml(environmentLabelMap[result.environment || ""] || result.environment || "")}</span>
			<span>${escapeHtml(runModeLabelMap[result.runMode || ""] || result.runMode || "")}</span>
		</div>
		<div class="detail-grid">
			<section class="panel">
				<h4>详细指标</h4>
				${renderMetricList(result.metrics)}
			</section>
			<section class="panel">
				<h4>聚合统计</h4>
				${result.aggregate ? renderAggregateList(result.aggregate) : '<div class="empty-text">无聚合统计</div>'}
			</section>
		</div>
		${renderSamples(result)}
		${renderArtifacts(reportRoot, result)}
		${result.error ? `<div class="error-box">${escapeHtml(result.error)}</div>` : ""}
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

export const writeHtmlReport = (
	reportRoot: string,
	config: ExternalConfig,
	results: CaseResult[]
) => {
	const grouped = new Map<string, CaseResult[]>();
	for (const result of results) {
		const key = result.environment || "default";
		const group = grouped.get(key) || [];
		group.push(result);
		grouped.set(key, group);
	}

	const totalPassed = results.filter((result) => result.status === "passed").length;
	const totalFailed = results.length - totalPassed;
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
			--bg: #eef4ff;
			--bg-accent: linear-gradient(135deg, #eff6ff 0%, #f8fafc 45%, #fff7ed 100%);
			--surface: rgba(255, 255, 255, 0.88);
			--surface-strong: #ffffff;
			--border: rgba(148, 163, 184, 0.22);
			--text: #0f172a;
			--muted: #475569;
			--blue: #1d4ed8;
			--blue-soft: rgba(29, 78, 216, 0.1);
			--amber: #d97706;
			--amber-soft: rgba(217, 119, 6, 0.12);
			--green: #15803d;
			--green-soft: rgba(21, 128, 61, 0.12);
			--red: #b91c1c;
			--red-soft: rgba(185, 28, 28, 0.12);
			--shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
			--radius: 20px;
		}
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; }
		body {
			font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
			color: var(--text);
			background:
				radial-gradient(circle at top left, rgba(59, 130, 246, 0.14), transparent 28%),
				radial-gradient(circle at top right, rgba(245, 158, 11, 0.16), transparent 24%),
				var(--bg-accent);
			line-height: 1.5;
		}
		.page {
			max-width: 1560px;
			margin: 0 auto;
			padding: 28px 24px 56px;
		}
		.hero {
			background: var(--surface);
			backdrop-filter: blur(18px);
			border: 1px solid var(--border);
			border-radius: 28px;
			box-shadow: var(--shadow);
			padding: 28px;
			margin-bottom: 24px;
		}
		.hero h1 {
			margin: 0;
			font-size: 32px;
			letter-spacing: -0.03em;
		}
		.hero p {
			margin: 10px 0 0;
			color: var(--muted);
			max-width: 920px;
		}
		.hero-grid {
			display: grid;
			grid-template-columns: 1.4fr 1fr;
			gap: 18px;
			margin-top: 22px;
		}
		.summary-card, .meta-card {
			background: var(--surface-strong);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			padding: 18px 18px 16px;
		}
		.summary-kpis {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 12px;
			margin-top: 14px;
		}
		.kpi {
			padding: 14px 16px;
			border-radius: 16px;
			background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
			border: 1px solid rgba(191, 219, 254, 0.9);
		}
		.kpi-label {
			display: block;
			font-size: 12px;
			color: var(--muted);
			margin-bottom: 6px;
		}
		.kpi-value {
			font: 700 24px/1 "Fira Code", "Consolas", monospace;
			color: var(--blue);
		}
		.meta-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px 16px;
			margin-top: 10px;
		}
		.meta-item {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			padding-bottom: 8px;
			border-bottom: 1px dashed rgba(148, 163, 184, 0.25);
			font-size: 13px;
		}
		.meta-item span:first-child { color: var(--muted); }
		.environment-section {
			margin-top: 26px;
		}
		.environment-head {
			display: flex;
			justify-content: space-between;
			align-items: flex-end;
			gap: 12px;
			margin-bottom: 14px;
		}
		.environment-head h2 {
			margin: 0;
			font-size: 22px;
		}
		.environment-head p {
			margin: 6px 0 0;
			color: var(--muted);
			font-size: 14px;
		}
		.environment-pill {
			padding: 8px 12px;
			border-radius: 999px;
			font: 600 12px/1 "Fira Code", "Consolas", monospace;
			color: var(--blue);
			background: var(--blue-soft);
			border: 1px solid rgba(59, 130, 246, 0.18);
		}
		.case-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 16px;
		}
		.case-card {
			background: var(--surface);
			backdrop-filter: blur(14px);
			border: 1px solid var(--border);
			border-radius: 22px;
			box-shadow: var(--shadow);
			padding: 18px;
		}
		.case-card-failed {
			border-color: rgba(185, 28, 28, 0.22);
			box-shadow: 0 18px 40px rgba(185, 28, 28, 0.08);
		}
		.case-card-head {
			display: flex;
			justify-content: space-between;
			gap: 16px;
			align-items: flex-start;
		}
		.case-id {
			font: 600 12px/1.4 "Fira Code", "Consolas", monospace;
			color: var(--muted);
			margin-bottom: 10px;
		}
		.case-card h3 {
			margin: 0 0 8px;
			font-size: 20px;
			letter-spacing: -0.02em;
		}
		.case-card p {
			margin: 0;
			color: var(--muted);
			font-size: 14px;
		}
		.case-state {
			display: flex;
			flex-direction: column;
			align-items: flex-end;
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
			background: rgba(148, 163, 184, 0.14);
			color: var(--muted);
		}
		.primary-metric-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
			margin: 18px 0 12px;
		}
		.primary-chip {
			padding: 14px 16px;
			border-radius: 18px;
			background: linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
			border: 1px solid rgba(148, 163, 184, 0.18);
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
			font-size: 13px;
			color: var(--muted);
			margin-bottom: 14px;
		}
		.detail-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
		}
		.panel {
			background: rgba(255, 255, 255, 0.78);
			border: 1px solid rgba(148, 163, 184, 0.14);
			border-radius: 18px;
			padding: 14px 14px 12px;
		}
		.panel h4 {
			margin: 0 0 10px;
			font-size: 14px;
		}
		.metric-row {
			display: flex;
			justify-content: space-between;
			align-items: baseline;
			gap: 10px;
			padding: 6px 0;
			border-bottom: 1px dashed rgba(148, 163, 184, 0.18);
		}
		.metric-row:last-child { border-bottom: none; }
		.metric-label {
			font-size: 13px;
			color: var(--muted);
		}
		.metric-value {
			font: 600 13px/1.4 "Fira Code", "Consolas", monospace;
			text-align: right;
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
		}
		.detail-block {
			margin-top: 12px;
			background: rgba(255, 255, 255, 0.72);
			border: 1px solid rgba(148, 163, 184, 0.14);
			border-radius: 16px;
			padding: 12px 14px;
		}
		.detail-block summary {
			cursor: pointer;
			font-weight: 700;
			color: var(--blue);
			list-style: none;
		}
		.detail-block summary::-webkit-details-marker { display: none; }
		.sample-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 10px;
			margin-top: 12px;
		}
		.sample-card {
			border-radius: 14px;
			background: #fff;
			border: 1px solid rgba(148, 163, 184, 0.14);
			padding: 12px;
		}
		.sample-title {
			font-weight: 700;
			margin-bottom: 8px;
		}
		.sample-values {
			display: flex;
			flex-direction: column;
			gap: 4px;
			font: 600 12px/1.45 "Fira Code", "Consolas", monospace;
			color: var(--muted);
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
			color: #9a3412;
			text-decoration: none;
			font-size: 12px;
			font-weight: 700;
		}
		.error-box {
			margin-top: 12px;
			padding: 12px 14px;
			border-radius: 16px;
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
			.case-grid,
			.detail-grid,
			.sample-grid {
				grid-template-columns: 1fr;
			}
		}
		@media (max-width: 760px) {
			.page { padding: 18px 14px 42px; }
			.hero { padding: 18px; border-radius: 22px; }
			.hero h1 { font-size: 26px; }
			.summary-kpis,
			.meta-list,
			.primary-metric-grid {
				grid-template-columns: 1fr;
			}
			.case-card-head {
				flex-direction: column;
			}
			.case-state {
				align-items: flex-start;
				flex-direction: row;
				flex-wrap: wrap;
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
					</div>
				</div>
			</div>
		</section>
		${environmentSections}
	</div>
</body>
</html>`;

	const filePath = path.join(reportRoot, "external-report.html");
	fs.writeFileSync(filePath, html, "utf-8");
	return filePath;
};

export const writeReports = (reportRoot: string, config: ExternalConfig, results: CaseResult[]) => {
	writeJson(path.join(reportRoot, "external-results.json"), results);
	return writeHtmlReport(reportRoot, config, results);
};
