// File role: render the unified lab report as one self-contained HTML page.
//
// Constraints: single file, inline CSS/JS, no external resources. The full report
// model is embedded as `<script type="application/json" id="lab-data">` so the page
// works from disk (file://) and from `scripts/lab-serve.mjs`. Rerun buttons are
// rendered server-side and only enabled by the inline script when the page is served
// by lab-serve (`window.__LAB_SERVE__ === true`, or `/api/health` answers).
import type { LabMeasurement, LabReport, LabTestCase } from "./lab-report";

const esc = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const attr = (value: unknown): string => esc(value);

const fmt = (value: number | null | undefined, digits = 1): string => {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
	return String(rounded);
};

const fmtDelta = (value: number | null | undefined): string => {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	const rounded = Math.round(value * 10) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded}%`;
};

const fmtDuration = (value: number | null | undefined): string => {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	if (value < 1000) return `${Math.round(value)} ms`;
	if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
	return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
};

const STATUS_LABELS: Record<string, string> = {
	passed: "通过",
	failed: "失败",
	skipped: "跳过",
	pending: "待跑",
	running: "运行中",
	cancelled: "中断",
	missing: "缺失",
	invalid: "无效",
	valid: "有效",
	degraded: "降级",
	unknown: "未知",
	ok: "正常",
	regressed: "回归",
	confirmed: "已确认",
	suspected: "疑似",
	aborted: "已中止",
	stopped: "已停止",
};

const label = (value: string): string => STATUS_LABELS[value] ?? value;

const badge = (value: string | null | undefined, text?: string): string => {
	const status = (value ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
	return `<span class="badge b-${status || "unknown"}">${esc(text ?? label(value ?? "unknown"))}</span>`;
};

const rerunButton = (scope: "case" | "scenario" | "run", ids: string, text = "重跑"): string =>
	`<button type="button" class="rerun" data-rerun-scope="${scope}" data-rerun-ids="${attr(ids)}" title="需 npm run lab:serve（node scripts/lab-serve.mjs）" disabled>${esc(text)}</button>`;

const searchRow = (text: string): string => `data-search="${attr(text.toLowerCase())}"`;

const testRows = (cases: LabTestCase[]): string => {
	if (cases.length === 0) return `<tr><td colspan="5" class="empty">无用例（产物缺失或该套件未运行）</td></tr>`;
	return cases
		.map(
			(testCase) =>
				`<tr ${searchRow(`${testCase.file} ${testCase.title} ${testCase.status}`)}>` +
				`<td>${badge(testCase.status)}</td>` +
				`<td><code>${esc(testCase.file)}</code></td>` +
				`<td>${esc(testCase.title)}</td>` +
				`<td class="num">${fmtDuration(testCase.durationMs)}</td>` +
				`<td>${testCase.rerunnable ? rerunButton("case", testCase.id) : `<span class="muted">—</span>`}</td>` +
				`</tr>`
		)
		.join("");
};

const testTable = (cases: LabTestCase[]): string =>
	`<div class="table-wrap"><table><thead><tr><th>状态</th><th>文件</th><th>用例</th><th class="num">耗时</th><th>操作</th></tr></thead><tbody>${testRows(cases)}</tbody></table></div>`;

const caseStatusBadge = (status: string): string => badge(status);

const measurementRows = (measurements: LabMeasurement[]): string => {
	if (measurements.length === 0) {
		return `<tr><td colspan="14" class="empty">本次运行没有外部/埋点性能测量（external 报告缺失或该 profile 未采集性能）。</td></tr>`;
	}
	return measurements
		.map(
			(measurement) =>
				`<tr ${searchRow(
					`${measurement.caseKey} ${measurement.env ?? ""} ${measurement.scale ?? ""} ${measurement.metric} ${measurement.verdict} ${measurement.validity}`
				)}>` +
				`<td><code>${esc(measurement.id)}</code></td>` +
				`<td>${esc(measurement.env ?? "—")}</td>` +
				`<td class="num">${measurement.scale === null ? "—" : esc(measurement.scale)}</td>` +
				`<td><code>${esc(measurement.metric)}</code> <span class="chip">${esc(measurement.source)}</span></td>` +
				`<td class="num">${fmt(measurement.external, 2)}</td>` +
				`<td class="num">${fmt(measurement.instrumented, 2)}</td>` +
				`<td class="num">${fmt(measurement.witnessDeltaMs, 2)}</td>` +
				`<td class="num">${fmt(measurement.baseline, 2)}</td>` +
				`<td class="num">${fmt(measurement.budget, 2)}</td>` +
				`<td class="num">${fmt(measurement.learned, 2)}</td>` +
				`<td class="num">${fmtDelta(measurement.deltaPercent)}</td>` +
				`<td>${badge(measurement.verdict)}</td>` +
				`<td>${measurement.validity.startsWith("invalid") ? badge("invalid", measurement.validity) : badge(measurement.validity === "unknown" ? "unknown" : "valid")}</td>` +
				`<td>${rerunButton("case", `${measurement.id}|${measurement.env || ""}|${measurement.scale ?? ""}`)}</td>` +
				`</tr>`
		)
		.join("");
};

const statusCounts = (report: LabReport) => {
	const suites = [report.suites.unit, report.suites.integration, report.suites.browser];
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	for (const suite of suites) {
		passed += suite.passed;
		failed += suite.failed;
		skipped += suite.skipped;
	}
	passed += report.suites.go.passed;
	failed += report.suites.go.failed;
	skipped += report.suites.go.skipped;
	for (const summary of [report.suites.e2e, report.suites.performance]) {
		passed += summary.passed;
		failed += summary.failed;
	}
	const invalid = report.gate.cases.filter((item) => item.status === "invalid").length;
	const invalidMeasurements = report.measurements.filter((item) => item.validity.startsWith("invalid")).length;
	return { passed, failed, skipped, invalid, invalidMeasurements };
};

const renderKpis = (report: LabReport): string => {
	const counts = statusCounts(report);
	const coverage = report.coverage.frontend?.metrics.statements;
	const cards = [
		{ label: "通过", value: String(counts.passed), tone: "good" },
		{ label: "失败", value: String(counts.failed), tone: counts.failed > 0 ? "bad" : "good" },
		{ label: "无效测量", value: String(counts.invalid || counts.invalidMeasurements), tone: counts.invalid || counts.invalidMeasurements ? "warn" : "good" },
		{ label: "中断", value: report.run.validity.aborted || report.run.status === "cancelled" ? "是" : "否", tone: report.run.validity.aborted ? "bad" : "good" },
		{ label: "覆盖率（前端 statements）", value: coverage ? `${fmt(coverage.percent)}%` : "—", tone: "neutral" },
		{ label: "证据产物", value: String(report.artifacts.length), tone: "neutral" },
	];
	return `<section class="kpis">${cards
		.map((card) => `<div class="kpi ${card.tone}"><div class="kpi-value">${esc(card.value)}</div><div class="kpi-label">${esc(card.label)}</div></div>`)
		.join("")}</section>`;
};

const renderRunMeta = (report: LabReport): string => {
	const run = report.run;
	const rows: Array<[string, string]> = [
		["运行 ID", `<code>${esc(run.id)}</code>`],
		["模式 / profile", `${badge(run.mode)} <code>${esc(run.profile)}</code>`],
		["状态", `${badge(run.status)} ${badge(run.validity.status, label(run.validity.status))}`],
		["记录（可信证据）", run.recorded ? "是" : "否"],
		["源码版本", `<code>${esc(run.source?.revision ?? "unknown")}</code>`],
		["脏工作区指纹", `<code>${esc((run.source?.dirtyPatchSha256 ?? "").slice(0, 16) || "—")}</code>`],
		["开始 / 结束", `<code>${esc(run.startedAt || "—")}</code> → <code>${esc(run.finishedAt || "—")}</code>`],
		["耗时", fmtDuration(run.durationMs)],
		["采集策略", `<code>${esc(run.policy)}</code>`],
		["契约范围", esc(["span", "external", "sentinel", "none"].map(kind => `${kind}: ${report.gate.cases.filter(item => (item.contractKind || "none") === kind).length}`).join(" · "))],
		["标准性能结论", run.performanceVerdict === "not-run" ? "未运行" : run.performanceVerdict === "failed" ? "失败" : run.performanceVerdict === "passed" ? "通过（同条件基线与学习检查）" : "未判定：基线条件与统计校准尚未认证"],
		["重跑来源", run.rerunOf ? `<code>${esc(run.rerunOf)}</code> · scope=${esc(run.rerunScope)} · ids=${esc(run.rerunIds.join(", "))}` : "—"],
	];
	return `<section class="meta"><dl>${rows.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${value}</dd></div>`).join("")}</dl></section>`;
};

const renderSteps = (report: LabReport): string => {
	const steps = report.steps;
	if (steps.length === 0) return `<p class="empty">没有步骤记录。</p>`;
	return `<div class="table-wrap"><table><thead><tr><th>步骤</th><th>状态</th><th class="num">耗时</th><th>原因</th></tr></thead><tbody>${steps
		.map(
			(step) =>
				`<tr><td>${esc(step.title)} <code>${esc(step.id)}</code></td><td>${badge(step.status)}</td><td class="num">${fmtDuration(step.durationMs)}</td><td>${esc(step.error ?? "")}</td></tr>`
		)
		.join("")}</tbody></table></div>`;
};

const renderGate = (report: LabReport): string => {
	const gate = report.gate;
	const scenarios = gate.scenarios;
	const invalidCases = gate.cases.filter((item) => item.status === "invalid");
	const dual = report.measurements.filter((item) => item.instrumented !== null && item.external !== null);
	const instrumentation = report.instrumentation;
	return `<section class="panel-visible" id="gate">
<h2>门禁面板 <span class="muted">measurement gate</span></h2>
<div class="gate-head">
	<div>${badge(gate.status)}${gate.aborted ? ` ${badge("aborted", "已中止")}` : ""}${gate.derived ? ` <span class="muted">（无 lab-gate 产物，从 manifest/external 推导）</span>` : ""}</div>
	<div class="muted">来源：${gate.sources.length ? gate.sources.map(esc).join("、") : "无"}${gate.policy ? ` · warnRatio=${gate.policy.warnRatio} abortRatio=${gate.policy.abortRatio}` : ""}</div>
</div>
<h3>场景 verdict</h3>
<div class="table-wrap"><table><thead><tr><th>场景</th><th>套件</th><th class="num">attempted</th><th class="num">valid</th><th class="num">invalid</th><th>verdict</th><th>操作</th></tr></thead><tbody>${
		scenarios.length === 0
			? `<tr><td colspan="7" class="empty">无场景记录。</td></tr>`
			: scenarios
					.map(
						(scenario) =>
							`<tr ${searchRow(`${scenario.scenarioKey} ${scenario.suite} ${scenario.verdict}`)}><td><code>${esc(scenario.scenarioKey)}</code></td><td>${esc(scenario.suite)}</td><td class="num">${scenario.attempted}</td><td class="num">${scenario.valid}</td><td class="num">${scenario.invalid}</td><td>${badge(scenario.verdict)}</td><td>${rerunButton("scenario", scenario.scenarioKey)}</td></tr>`
					)
					.join("")
	}</tbody></table></div>
<h3>无效 case（测量不可信，而非产品失败）</h3>
<div class="table-wrap"><table><thead><tr><th>caseKey</th><th>套件</th><th>validity codes</th><th>详情</th></tr></thead><tbody>${
		invalidCases.length === 0
			? `<tr><td colspan="4" class="empty">没有无效 case。</td></tr>`
			: invalidCases
					.map(
						(item) =>
							`<tr ${searchRow(`${item.caseKey} ${item.suite} ${item.codes.join(" ")}`)}><td><code>${esc(item.caseKey)}</code></td><td>${esc(item.suite)}</td><td>${item.codes.map((code) => `<span class="chip">${esc(code)}</span>`).join(" ")}</td><td>${esc(item.details.join("; "))}</td></tr>`
					)
					.join("")
	}</tbody></table></div>
<h3>埋点（instrumentation）</h3>
<div class="chips">${badge(instrumentation.enabled ? "valid" : "invalid", instrumentation.enabled ? "enabled" : "disabled")} <span class="muted">contractVersion: <code>${esc(instrumentation.contractVersion ?? "—")}</code></span> ${
		instrumentation.missingMarks.length
			? `<span class="muted">missingMarks:</span> ${instrumentation.missingMarks.map((mark) => `<span class="chip">${esc(mark)}</span>`).join(" ")}`
			: `<span class="muted">missingMarks: 无</span>`
	}</div>
<h3>双源偏差（instrumented vs external）</h3>
<div class="table-wrap"><table><thead><tr><th>caseKey</th><th>指标</th><th class="num">external</th><th class="num">instrumented</th><th class="num">Δ witness (ms)</th><th class="num">基线变化</th></tr></thead><tbody>${dual.length === 0
			? `<tr><td colspan="6" class="empty">本次运行没有成对的 instrumented/external 样本。</td></tr>`
			: dual
					.slice(0, 200)
					.map(
						(item) =>
							`<tr ${searchRow(`${item.caseKey} ${item.metric}`)}><td><code>${esc(item.caseKey)}</code></td><td><code>${esc(item.metric)}</code></td><td class="num">${fmt(item.external, 2)}</td><td class="num">${fmt(item.instrumented, 2)}</td><td class="num">${fmt(item.witnessDeltaMs, 2)}</td><td class="num">${fmtDelta(item.deltaPercent)}</td></tr>`
					)
					.join("")
	}</tbody></table></div>
<h3>有效性原因</h3>
${
		gate.reasons.length === 0
			? `<p class="empty">没有问题记录。</p>`
			: `<ul class="reasons">${gate.reasons.slice(0, 100).map((reason) => `<li><code>${esc(reason.scope)}:${esc(reason.id)}</code> <span class="chip">${esc(reason.code)}</span> ${esc(reason.detail ?? "")}</li>`).join("")}</ul>`
	}
</section>`;
};

const renderFailures = (report: LabReport): string =>
	report.failures.length === 0
		? `<p class="empty">没有失败记录。</p>`
		: `<ul class="failures">${report.failures.slice(0, 200).map((failure) => `<li>${esc(failure)}</li>`).join("")}</ul>`;

const renderArtifacts = (report: LabReport): string =>
	report.artifacts.length === 0
		? `<p class="empty">没有聚合产物记录。</p>`
		: `<div class="table-wrap"><table><thead><tr><th>产物</th><th>类型</th><th>状态</th><th class="num">通过/总数</th><th>详情</th></tr></thead><tbody>${report.artifacts
				.map(
					(artifact) =>
						`<tr ${searchRow(`${artifact.id} ${artifact.kind} ${artifact.status}`)}><td><code>${esc(artifact.id)}</code></td><td>${esc(artifact.kind)}</td><td>${badge(artifact.status)}</td><td class="num">${artifact.passed}/${artifact.total}</td><td>${esc(
							artifact.error ??
								[
									artifact.coverageMetrics ? Object.entries(artifact.coverageMetrics).map(([name, metric]) => `${name} ${metric.percent}%`).join("; ") : "",
									artifact.coverageByPackage ? `${Object.keys(artifact.coverageByPackage).length} Go 包` : "",
									artifact.gate ? `gate ${artifact.gate.status}` : "",
									artifact.inventory ? `inventory covered ${artifact.inventory.covered}/${artifact.inventory.total}` : "",
								]
									.filter(Boolean)
									.join("; ")
						)}</td></tr>`
				)
				.join("")}</tbody></table></div>`;

const renderExternalSuites = (report: LabReport, key: "e2e" | "performance"): string => {
	const summary = report.suites[key];
	if (summary.suites.length === 0) return `<p class="empty">没有 external 报告。</p>`;
	const blocks = summary.suites.map((suite) => {
		const cases = suite.cases
			.map(
				(externalCase) =>
					`<tr ${searchRow(`${suite.suite} ${externalCase.id} ${externalCase.environment ?? ""} ${externalCase.status}`)}>` +
					`<td>${caseStatusBadge(externalCase.status)}</td>` +
					`<td><code>${esc(externalCase.id)}</code></td>` +
					`<td>${esc(externalCase.environment ?? "—")}</td>` +
					`<td class="num">${externalCase.scale === null ? "—" : esc(externalCase.scale)}</td>` +
					`<td class="num">${fmtDuration(externalCase.durationMs)}</td>` +
					`<td>${esc(externalCase.failureType)}</td>` +
					`<td>${esc(externalCase.error ?? "")}</td>` +
					`<td>${externalCase.rerunnable ? rerunButton("case", externalCase.id) : `<span class="muted">—</span>`}</td>` +
					`</tr>`
			)
			.join("");
		return `<div class="suite">
<h3>${esc(suite.suite)} ${badge(summary.failed > 0 && suite.failed > 0 ? "failed" : "passed")} <span class="muted">${esc(suite.reportPath)} · ${esc(suite.generatedAt ?? "")}</span></h3>
<div class="table-wrap"><table><thead><tr><th>状态</th><th>case</th><th>环境</th><th class="num">规模</th><th class="num">耗时</th><th>失败类型</th><th>错误</th><th>操作</th></tr></thead><tbody>${cases}</tbody></table></div>
</div>`;
	});
	return `<div class="suite-summary">${summary.suites.length} 个报告 · ${summary.total} 个 case · 通过 ${summary.passed} · 失败 ${summary.failed}</div>${blocks.join("")}`;
};

const renderEvidence = (report: LabReport): string => {
	const images = report.gallery.filter((item) => item.kind === "image");
	const files = report.gallery.filter((item) => item.kind === "file");
	return `<h3>聚合产物</h3>${renderArtifacts(report)}
<h3>截图画廊（${images.length}）</h3>${
		images.length === 0
			? `<p class="empty">本次运行没有图片产物。</p>`
			: `<div class="gallery">${images
					.map(
						(item) =>
							`<figure ${searchRow(item.path)}><a href="${attr(item.path)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${attr(item.path)}" alt="${attr(item.label)}"></a><figcaption>${esc(item.label)}</figcaption></figure>`
					)
					.join("")}</div>`
	}
<h3>文件链接（${files.length}）</h3><ul class="links">${files.map((item) => `<li><a href="${attr(item.path)}">${esc(item.label)}</a></li>`).join("") || `<li class="empty">无</li>`}</ul>`;
};

const renderCoverage = (report: LabReport): string => {
	const frontend = report.coverage.frontend;
	const go = report.coverage.go;
	const metricTable = (block: NonNullable<LabReport["coverage"]["frontend"]>): string => {
		const entries = block.entries.slice(0, 400);
		return `<div class="table-wrap"><table><thead><tr><th>${block.kind === "go" ? "Go 包" : "文件"}</th>${Object.keys(block.metrics)
			.map((name) => `<th class="num">${esc(name)}</th>`)
			.join("")}</tr></thead><tbody>${entries
			.map(
				(entry) =>
					`<tr ${searchRow(entry.name)}><td><code>${esc(entry.name)}</code></td>${Object.keys(block.metrics)
						.map((name) => `<td class="num">${entry.metrics[name] ? `${fmt(entry.metrics[name]!.percent)}%` : "—"}</td>`)
						.join("")}</tr>`
			)
			.join("")}</tbody></table></div>${
			block.entries.length > entries.length ? `<p class="muted">仅展示前 ${entries.length} 项（共 ${block.entries.length}）。</p>` : ""
		}`;
	};
	const obligationBlock = report.obligations;
	return `<h3>前端 / shared 覆盖率</h3>${
		frontend
			? `<p>${Object.entries(frontend.metrics)
					.map(([name, metric]) => `<span class="chip">${esc(name)} ${fmt(metric.percent)}%</span>`)
					.join(" ")} <span class="muted">${frontend.entries.length} 个源文件</span></p>${metricTable(frontend)}`
			: `<p class="empty">没有 frontend coverage-summary.json。</p>`
	}
<h3>Go 覆盖率</h3>${
		go
			? `<p>${Object.entries(go.metrics).map(([name, metric]) => `<span class="chip">${esc(name)} ${fmt(metric.percent)}% (${metric.covered}/${metric.total})</span>`).join(" ")}</p>${metricTable(go)}`
			: `<p class="empty">没有 backend/coverage.out。</p>`
	}
<h3>模块义务快照（obligations）</h3>${
		obligationBlock.featureCatalog || obligationBlock.inventory
			? `<div class="obligation-grid">
${obligationBlock.featureCatalog ? `<div class="card"><h4>feature catalog</h4><p>${esc(obligationBlock.featureCatalog.scope)}</p><p>${obligationBlock.featureCatalog.total} 条 · ${obligationBlock.featureCatalog.sourceSurfaceCount} 个 surface · 未决 ${obligationBlock.featureCatalog.unresolvedIds.length}</p><p>${Object.entries(obligationBlock.featureCatalog.stateCounts).map(([state, count]) => `<span class="chip">${esc(state)} ${count}</span>`).join(" ")}</p></div>` : ""}
${obligationBlock.inventory ? `<div class="card"><h4>lab inventory</h4><p>${esc(obligationBlock.inventory.scope)}</p><p>${obligationBlock.inventory.total} 个模块 · covered ${obligationBlock.inventory.covered} · partial ${obligationBlock.inventory.partial} · uncovered ${obligationBlock.inventory.uncovered} · excluded ${obligationBlock.inventory.excluded}</p><p>未决 ${obligationBlock.inventory.unresolvedIds.length}</p></div>` : ""}
</div>`
			: `<p class="empty">没有 feature-obligations / lab-inventory 快照。</p>`
	}`;
};

const renderLogs = (report: LabReport): string => {
	const entries = Object.entries(report.logs);
	if (entries.length === 0) return `<p class="empty">没有 logs/*.log。</p>`;
	return entries
		.map(
			([name, content]) =>
				`<details class="log" ${searchRow(name)}><summary><code>${esc(name)}</code> <span class="muted">${Math.round(content.length / 1024)} KB</span></summary><pre>${esc(content)}</pre></details>`
		)
		.join("");
};

const renderPanels = (report: LabReport): string => {
	const goSuite = report.suites.go;
	const goRows =
		goSuite.packages.length === 0
			? `<tr><td colspan="6" class="empty">没有 backend/go-tests.jsonl。</td></tr>`
			: goSuite.packages
					.map(
						(entry) =>
							`<tr ${searchRow(`${entry.package} ${entry.status}`)}><td><code>${esc(entry.package)}</code></td><td>${badge(entry.status)}</td><td class="num">${entry.tests}</td><td class="num">${entry.failed}</td><td class="num">${entry.skipped}</td><td class="num">${fmtDuration(entry.elapsedMs)}</td></tr>`
					)
					.join("");
	const unitPanel = `<h2>前端单元与模块</h2>
<p class="muted">unit ${report.suites.unit.total} · integration ${report.suites.integration.total} · 失败 ${report.suites.unit.failed + report.suites.integration.failed}</p>
<h3>${esc(report.suites.unit.title)} ${badge(report.suites.unit.status)}</h3>${testTable(report.suites.unit.cases)}
<h3>${esc(report.suites.integration.title)} ${badge(report.suites.integration.status)}</h3>${testTable(report.suites.integration.cases)}`;
	const browserPanel = `<h2>浏览器组件测试</h2><p class="muted">${report.suites.browser.total} 个用例 · ${esc(report.suites.browser.note ?? "")}</p>${testTable(report.suites.browser.cases)}`;
	const goPanel = `<h2>Go</h2><p class="muted">${goSuite.total} 个包 · 通过 ${goSuite.passed} · 失败 ${goSuite.failed} · <span class="muted">Go 用例重跑请使用 <code>--profile=single --only=go:&lt;pkg&gt;#&lt;Test&gt;</code></span></p>
<div class="table-wrap"><table><thead><tr><th>包</th><th>状态</th><th class="num">测试</th><th class="num">失败</th><th class="num">跳过</th><th class="num">耗时</th></tr></thead><tbody>${goRows}</tbody></table></div>`;
	const e2ePanel = `<h2>E2E（正确性）</h2>${renderExternalSuites(report, "e2e")}`;
	const perfPanel = `<h2>性能</h2>
<p class="muted">external=${report.measurements.filter((item) => item.source !== "instrumented").length} · instrumented=${report.measurements.filter((item) => item.source === "instrumented").length} · 双源配对=${report.measurements.filter((item) => item.instrumented !== null && item.external !== null).length}</p>
<div class="table-wrap"><table><thead><tr><th>case</th><th>环境</th><th class="num">规模</th><th>指标</th><th class="num">external</th><th class="num">instrumented</th><th class="num">Δwitness</th><th class="num">baseline</th><th class="num">budget</th><th class="num">learned</th><th class="num">基线变化</th><th>判定</th><th>有效性</th><th>操作</th></tr></thead><tbody>${measurementRows(report.measurements)}</tbody></table></div>
<h3>性能套件</h3>${renderExternalSuites(report, "performance")}`;
	return `<section class="panel" data-panel="overview"><h2>总览</h2><h3>步骤</h3>${renderSteps(report)}<h3>失败与无效原因</h3>${renderFailures(report)}<h3>聚合产物</h3>${renderArtifacts(report)}</section>
<section class="panel" data-panel="unit" hidden>${unitPanel}</section>
<section class="panel" data-panel="browser" hidden>${browserPanel}</section>
<section class="panel" data-panel="go" hidden>${goPanel}</section>
<section class="panel" data-panel="e2e" hidden>${e2ePanel}</section>
<section class="panel" data-panel="performance" hidden>${perfPanel}</section>
<section class="panel" data-panel="coverage" hidden><h2>覆盖与义务</h2>${renderCoverage(report)}</section>
<section class="panel" data-panel="evidence" hidden><h2>证据与产物</h2>${renderEvidence(report)}</section>
<section class="panel" data-panel="logs" hidden><h2>日志</h2>${renderLogs(report)}</section>`;
};

const TABS: Array<[string, string]> = [
	["overview", "总览"],
	["unit", "前端单元与模块"],
	["browser", "浏览器"],
	["go", "Go"],
	["e2e", "E2E"],
	["performance", "性能"],
	["coverage", "覆盖"],
	["evidence", "证据"],
	["logs", "日志"],
];

const INLINE_CSS = `
:root{color-scheme:light dark;--bg:#f6f8fb;--panel:#fff;--ink:#18212c;--muted:#647083;--line:#dbe2ec;--good:#177245;--bad:#a12622;--warn:#8a5a00;--accent:#2457c5;}
@media (prefers-color-scheme:dark){:root{--bg:#11161d;--panel:#171e27;--ink:#e6edf5;--muted:#93a1b3;--line:#2a3442;--good:#54c98a;--bad:#ff8b84;--warn:#f0c063;--accent:#7aa2ff;}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1440px;margin:0 auto;padding:0 18px 64px}header.top{max-width:1440px;margin:0 auto;padding:22px 18px 6px;display:flex;gap:16px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:26px 0 10px}h3{font-size:14px;margin:18px 0 8px}h4{margin:0 0 6px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:rgba(120,140,170,.14);padding:1px 5px;border-radius:5px;word-break:break-all}
.sub{margin:0;color:var(--muted)}.muted{color:var(--muted);font-weight:400;font-size:12.5px}
.meta{margin:6px 0 4px}.meta dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px;margin:0}
.meta dt{font-size:12px;color:var(--muted)}.meta dd{margin:0;font-size:13px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi-value{font-size:22px;font-weight:700;line-height:1.2}.kpi-label{font-size:12px;color:var(--muted);margin-top:2px}
.kpi.good .kpi-value{color:var(--good)}.kpi.bad .kpi-value{color:var(--bad)}.kpi.warn .kpi-value{color:var(--warn)}
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.b-passed,.b-valid,.b-ok,.b-good{background:rgba(23,114,69,.14);color:var(--good);border-color:rgba(23,114,69,.35)}
.b-failed,.b-invalid,.b-regressed,.b-aborted,.b-bad{background:rgba(161,38,34,.14);color:var(--bad);border-color:rgba(161,38,34,.35)}
.b-degraded,.b-warn,.b-suspected,.b-skipped,.b-missing,.b-pending,.b-unknown,.b-running{background:rgba(138,90,0,.14);color:var(--warn);border-color:rgba(138,90,0,.35)}
.b-confirmed{background:rgba(36,87,197,.14);color:var(--accent);border-color:rgba(36,87,197,.35)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0 0;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5}
.tab{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
#lab-search{width:100%;margin:6px 0 12px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);font:inherit}
#gate,#job-panel,.panel,.card,.suite{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:14px 0}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:9px;margin:8px 0}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:rgba(120,140,170,.09);font-size:12px;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}.empty{color:var(--muted);text-align:center;padding:14px}
.chip{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:6px;background:rgba(120,140,170,.14);margin:1px 2px}
.chips{margin:6px 0}.reasons,.failures,.links{padding-left:20px;margin:6px 0}.reasons li,.failures li{margin:3px 0}
.rerun{cursor:pointer;border:1px solid var(--accent);color:var(--accent);background:transparent;border-radius:7px;padding:3px 9px;font:inherit;font-size:12px}
.rerun:disabled{opacity:.5;cursor:not-allowed}
.serve{margin-left:auto;font-size:12.5px;padding:5px 10px;border-radius:8px;border:1px solid var(--line)}
.head-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.head-actions .serve{margin-left:0}
.serve.warn{color:var(--warn);border-color:rgba(138,90,0,.4)}
.serve.ok{color:var(--good);border-color:rgba(23,114,69,.4)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.gallery figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.gallery img{width:100%;height:150px;object-fit:contain;background:rgba(120,140,170,.08);display:block}
.gallery figcaption{font-size:12px;padding:6px 8px;color:var(--muted);word-break:break-all}
.obligation-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.suite-summary{color:var(--muted);font-size:12.5px}
details.log{margin:8px 0;border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:var(--panel)}
details.log pre{max-height:520px;overflow:auto;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.rerun-bar{position:fixed;bottom:0;left:0;right:0;display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:10px 18px;background:var(--panel);border-top:1px solid var(--line);z-index:20}
#job-panel{position:fixed;right:16px;bottom:56px;width:min(560px,92vw);z-index:30;box-shadow:0 10px 32px rgba(0,0,0,.22)}
#job-panel pre{max-height:260px;overflow:auto;font-size:12px;white-space:pre-wrap}
`;

const INLINE_JS = `
(function(){
	var data=JSON.parse(document.getElementById('lab-data').textContent);
	var serve=window.__LAB_SERVE__===true;
	var token=window.__LAB_TOKEN__||'';
	var note=document.getElementById('serve-note');
	var panel=document.getElementById('job-panel');
	var jobText=document.getElementById('job-text');
	var jobStop=document.getElementById('job-stop');
	var currentJob=null;
	function setRerun(enabled,reason){
		document.querySelectorAll('button.rerun').forEach(function(button){
			button.disabled=!enabled;
			button.title=enabled?'通过 lab-serve 重跑':(reason||'需 npm run lab:serve（node scripts/lab-serve.mjs）');
		});
		if(note){note.textContent=enabled?'lab-serve 已连接，可一键重跑':'需 npm run lab:serve（node scripts/lab-serve.mjs）';note.className=enabled?'serve ok':'serve warn';}
	}
	setRerun(serve);
	if(!serve){
		fetch('/api/health',{cache:'no-store'}).then(function(response){return response.ok?response.json():null;}).then(function(payload){if(payload&&payload.ok){setRerun(true);}}).catch(function(){});
	}
	document.querySelectorAll('.tab').forEach(function(tab){
		tab.addEventListener('click',function(){
			var name=tab.getAttribute('data-tab');
			document.querySelectorAll('.tab').forEach(function(other){other.classList.toggle('active',other===tab);});
			document.querySelectorAll('[data-panel]').forEach(function(section){section.hidden=section.getAttribute('data-panel')!==name;});
		});
	});
	var search=document.getElementById('lab-search');
	if(search){search.addEventListener('input',function(){
		var query=search.value.trim().toLowerCase();
		document.querySelectorAll('[data-search]').forEach(function(element){
			var haystack=element.getAttribute('data-search')||'';
			element.style.display=!query||haystack.indexOf(query)>=0?'':'none';
		});
	});}
	function showJob(message,text){if(!panel)return;panel.hidden=false;if(jobText)jobText.textContent=message;if(text)console.log(text);}
	function pollJob(id){
		if(!id)return;
		currentJob=id;
		if(jobStop)jobStop.hidden=false;
		var timer=setInterval(function(){
			fetch('/api/jobs/'+encodeURIComponent(id),{cache:'no-store'}).then(function(response){return response.ok?response.json():null;}).then(function(job){
				if(!job){clearInterval(timer);return;}
				var tail=(job.tail||[]).join('\\n');
				showJob('job '+id+' · '+job.status+(job.exitCode===null?'':' · exit '+job.exitCode)+'\\n'+tail.slice(-1600),null);
				if(job.status!=='running'){clearInterval(timer);setRerun(true);}
			}).catch(function(error){clearInterval(timer);showJob('job '+id+' 查询失败: '+error,null);});
		},1500);
	}
	if(jobStop){jobStop.addEventListener('click',function(){
		if(!currentJob)return;
		fetch('/api/jobs/'+encodeURIComponent(currentJob)+'/stop',{method:'POST',headers:{'X-Lab-Token':token}})
			.then(function(response){return response.json().catch(function(){return {};}).then(function(payload){if(!response.ok)throw new Error(payload.error||('HTTP '+response.status));return payload;});})
			.then(function(payload){showJob('已请求停止 '+currentJob+' ('+payload.status+')',null);})
			.catch(function(error){showJob('停止失败: '+error.message,null);});
	});}
	document.addEventListener('click',function(event){
		var button=event.target.closest?event.target.closest('button.rerun'):null;
		if(!button||button.disabled)return;
		var scope=button.getAttribute('data-rerun-scope');
		var rawIds=button.getAttribute('data-rerun-ids')||'';
		var body={runId:data.run.id,scope:scope};
		var ids=rawIds.split(',').map(function(item){return item.trim();}).filter(Boolean);
		if(ids.length)body.ids=ids;
		showJob('提交重跑：scope='+scope+(ids.length?' · '+ids.length+' 个目标':''),null);
		fetch('/api/rerun',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':token},body:JSON.stringify(body)})
			.then(function(response){return response.json().catch(function(){return {};}).then(function(payload){if(!response.ok)throw new Error(payload.error||('HTTP '+response.status));return payload;});})
			.then(function(payload){pollJob(payload.jobId);})
			.catch(function(error){
				if(String(error.message).indexOf('401')>=0||String(error.message).indexOf('token')>=0){
					showJob('重跑请求被拒绝：需通过 npm run lab:serve 打开的页面操作。',null);
				}else{showJob('重跑失败: '+error.message,null);}
			});
	});
})();
`;

export const renderLabHtml = (report: LabReport): string => {
	const counts = statusCounts(report);
	const dataJson = JSON.stringify(report)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
	const title = `Aevia Lab · ${report.run.profile} · ${report.run.id}`;
	const serveState = `<div id="serve-state" class="serve warn">需 npm run lab:serve（node scripts/lab-serve.mjs）</div>`;
	const tabs = TABS.map(
		([name, text], index) => `<button type="button" class="tab${index === 0 ? " active" : ""}" data-tab="${name}">${esc(text)}</button>`
	).join("");
	const kpiSummary = `${counts.passed} 通过 / ${counts.failed} 失败`;
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<header class="top">
	<div>
		<h1>Aevia Lab 运行报告</h1>
		<p class="sub"><code>${esc(report.run.id)}</code> · profile <code>${esc(report.run.profile)}</code> · mode ${badge(report.run.mode)} · ${kpiSummary}</p>
	</div>
	<div class="head-actions">${serveState}${rerunButton("run", "", "重跑整轮")}</div>
</header>
<main>
	${renderRunMeta(report)}
	${renderKpis(report)}
	${renderGate(report)}
	<nav class="tabs">${tabs}</nav>
	<input id="lab-search" type="search" placeholder="搜索用例 / 文件 / 指标 / caseKey（当前标签页与所有表格）" autocomplete="off">
	${renderPanels(report)}
</main>
<footer class="rerun-bar">
	<span id="serve-note" class="warn">需 npm run lab:serve（node scripts/lab-serve.mjs）</span>
	${rerunButton("run", "", "重跑整轮")}
</footer>
<div id="job-panel" hidden>
	<div style="display:flex;gap:10px;align-items:center;justify-content:space-between">
		<h3 style="margin:0">重跑任务</h3>
		<button type="button" id="job-stop" class="rerun" hidden>停止</button>
	</div>
	<pre id="job-text"></pre>
</div>
<script type="application/json" id="lab-data">${dataJson}</script>
<script>${INLINE_JS}</script>
</body>
</html>`;
};
