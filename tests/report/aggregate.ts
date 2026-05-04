import fs from "node:fs";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

const rootDir = process.cwd();
const reportRoot = path.join(rootDir, "tests", "reports");
const summaryRoot = path.join(reportRoot, "summary");
const dateTag = () => new Date().toISOString().replace(/[:.]/g, "-");

const readJson = <T = unknown>(filePath: string): T | null => {
	if (!fs.existsSync(filePath)) return null;
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
};

const ensureDir = (dir: string) => fs.mkdirSync(dir, { recursive: true });

const resetDir = (dir: string) => {
	fs.rmSync(dir, { recursive: true, force: true });
	ensureDir(dir);
};

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const findLatestExternalReport = () => {
	const baseDir = path.join(
		rootDir,
		"apps",
		"frontend",
		"tests",
		"e2e",
		"external",
		"reports",
		"latest"
	);
	if (!fs.existsSync(baseDir)) return null;
	const candidates = fs
		.readdirSync(baseDir)
		.map((entry) => path.join(baseDir, entry, "external-results.json"))
		.filter((filePath) => fs.existsSync(filePath))
		.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
	return candidates[0] || null;
};

const vitestFiles = {
	unit: path.join(reportRoot, "vitest", "unit.json"),
	integration: path.join(reportRoot, "vitest", "integration.json"),
	browser: path.join(reportRoot, "vitest", "browser.json"),
	bench: path.join(reportRoot, "vitest", "bench.json"),
};

const benchSummary = (payload: JsonRecord | null) => {
	if (!payload) {
		return { status: "missing", total: 0, passed: 0, failed: 0 };
	}
	const files = Array.isArray(payload.files) ? (payload.files as JsonRecord[]) : [];
	const total = files.reduce((fileSum, file) => {
		const groups = Array.isArray(file.groups) ? (file.groups as JsonRecord[]) : [];
		return fileSum + groups.reduce((groupSum, group) => {
			const benchmarks = Array.isArray(group.benchmarks) ? group.benchmarks : [];
			return groupSum + benchmarks.length;
		}, 0);
	}, 0);
	return {
		status: "passed",
		total,
		passed: total,
		failed: 0,
	};
};

const vitestSummary = (payload: JsonRecord | null) => {
	if (!payload) {
		return { status: "missing", total: 0, passed: 0, failed: 0 };
	}
	const total = Number(payload.numTotalTests ?? payload.numTotalTestSuites ?? 0);
	const failed = Number(payload.numFailedTests ?? payload.numFailedTestSuites ?? 0);
	const passed = Number(payload.numPassedTests ?? payload.numPassedTestSuites ?? Math.max(0, total - failed));
	return {
		status: failed > 0 ? "failed" : "passed",
		total,
		passed,
		failed,
	};
};

const externalSummary = (payload: JsonRecord | null) => {
	const summary = payload?.summary as JsonRecord | undefined;
	if (!summary) {
		return {
			status: "missing",
			total: 0,
			passed: 0,
			failed: 0,
			learningConfirmed: 0,
			learningSuspected: 0,
			ruleSuspected: 0,
		};
	}
	const failed = Number(summary.failed ?? 0);
	const learningConfirmed = Number(summary.learningConfirmed ?? 0);
	return {
		status: failed > 0 || learningConfirmed > 0 ? "failed" : "passed",
		total: Number(summary.total ?? 0),
		passed: Number(summary.passed ?? 0),
		failed,
		learningConfirmed,
		learningSuspected: Number(summary.learningSuspected ?? 0),
		ruleSuspected: Number(summary.learningRuleSuspected ?? 0),
	};
};

const collectFailures = (external: JsonRecord | null) => {
	const results = Array.isArray(external?.results) ? (external.results as JsonRecord[]) : [];
	return results
		.filter((result) => result.status === "failed")
		.map((result) => ({
			id: String(result.id ?? "unknown"),
			environment: String(result.environment ?? ""),
			failureType: String(result.failureType ?? ""),
			error: String(result.error ?? ""),
		}));
};

const makeCard = (title: string, summary: ReturnType<typeof vitestSummary> | ReturnType<typeof externalSummary>) => `
	<section class="card ${summary.status}">
		<div class="card-title">${escapeHtml(title)}</div>
		<div class="status">${escapeHtml(summary.status)}</div>
		<div class="metrics">
			<span>总数 <strong>${summary.total}</strong></span>
			<span>通过 <strong>${summary.passed}</strong></span>
			<span>失败 <strong>${summary.failed}</strong></span>
		</div>
	</section>`;

const buildHtml = (report: JsonRecord) => {
	const summaries = report.summary as JsonRecord;
	const failures = report.failures as JsonRecord[];
	const cards = Object.entries(summaries)
		.map(([key, value]) => makeCard(key, value as ReturnType<typeof vitestSummary>))
		.join("");
	const failureRows = failures.length
		? failures
				.map(
					(failure) => `<tr>
						<td>${escapeHtml(String(failure.environment))}</td>
						<td>${escapeHtml(String(failure.id))}</td>
						<td>${escapeHtml(String(failure.failureType))}</td>
						<td>${escapeHtml(String(failure.error))}</td>
					</tr>`
				)
				.join("")
		: `<tr><td colspan="4">暂无失败用例</td></tr>`;

	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>测试汇总报告</title>
	<style>
		body { margin: 0; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
		main { max-width: 1280px; margin: 0 auto; padding: 32px 20px 64px; }
		h1 { margin: 0 0 8px; font-size: 30px; }
		p { margin: 0 0 24px; color: #64748b; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
		.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06); }
		.card.failed { border-color: #fecaca; background: #fff7f7; }
		.card.missing { border-color: #fed7aa; background: #fffaf0; }
		.card-title { font-weight: 700; margin-bottom: 10px; }
		.status { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #e2e8f0; font-size: 12px; font-weight: 700; }
		.metrics { display: flex; gap: 12px; margin-top: 14px; color: #475569; font-size: 13px; }
		table { width: 100%; border-collapse: collapse; margin-top: 18px; background: #fff; border-radius: 8px; overflow: hidden; }
		th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 12px; text-align: left; vertical-align: top; font-size: 13px; }
		th { background: #f1f5f9; color: #334155; }
		code { font-family: "Consolas", monospace; }
	</style>
</head>
<body>
	<main>
		<h1>测试汇总报告</h1>
		<p>汇总 Vitest 单测/集成/浏览器/微基准，以及 external E2E benchmark 的最新 JSON 输出。</p>
		<div class="grid">${cards}</div>
		<h2>失败与回归</h2>
		<table>
			<thead><tr><th>环境</th><th>用例</th><th>类型</th><th>详情</th></tr></thead>
			<tbody>${failureRows}</tbody>
		</table>
	</main>
</body>
</html>`;
};

const externalPath = findLatestExternalReport();
const vitest = {
	unit: readJson<JsonRecord>(vitestFiles.unit),
	integration: readJson<JsonRecord>(vitestFiles.integration),
	browser: readJson<JsonRecord>(vitestFiles.browser),
	bench: readJson<JsonRecord>(vitestFiles.bench),
};
const external = readJson<JsonRecord>(externalPath || "");

const report = {
	generatedAt: new Date().toISOString(),
	summary: {
		unit: vitestSummary(vitest.unit),
		integration: vitestSummary(vitest.integration),
		browser: vitestSummary(vitest.browser),
		bench: benchSummary(vitest.bench),
		external: externalSummary(external),
	},
	vitest,
	external,
	artifacts: {
		vitest: vitestFiles,
		external: externalPath,
		coverage: path.join(reportRoot, "vitest", "coverage"),
	},
	failures: collectFailures(external),
};

const runDir = path.join(summaryRoot, "runs", dateTag());
const latestDir = path.join(summaryRoot, "latest");
ensureDir(runDir);
resetDir(latestDir);

const json = JSON.stringify(report, null, 2);
const html = buildHtml(report);
fs.writeFileSync(path.join(runDir, "test-report.json"), json, "utf-8");
fs.writeFileSync(path.join(runDir, "test-report.html"), html, "utf-8");
fs.writeFileSync(path.join(latestDir, "test-report.json"), json, "utf-8");
fs.writeFileSync(path.join(latestDir, "test-report.html"), html, "utf-8");

console.log(`[test-report] wrote ${path.join(runDir, "test-report.html")}`);
console.log(`[test-report] latest ${path.join(latestDir, "test-report.html")}`);
