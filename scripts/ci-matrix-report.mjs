import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: node scripts/ci-matrix-report.mjs <artifact-directory>");
const oses = ["ubuntu-24.04", "windows-latest", "macos-latest"];
const browsers = ["chromium", "firefox", "webkit"];
const entries = [];
for (const os of oses) for (const browser of browsers) {
	const name = `aevia-test-evidence-${os}-${browser}`;
	const folder = path.join(root, name);
	const reports = existsSync(folder) ? readdirSync(folder).filter(id => existsSync(path.join(folder, id, "lab-report.json"))) : [];
	const entry = { os, browser, status: "missing", cases: 0, failed: 0, href: "" };
	if (reports.length === 1) {
		const id = reports[0];
		const report = JSON.parse(readFileSync(path.join(folder, id, "lab-report.json"), "utf8"));
		entry.status = report.run?.status ?? "missing";
		entry.cases = report.gate?.cases?.length ?? 0;
		entry.failed = report.failures?.length ?? 0;
		const html = path.join(folder, id, "lab-report.html");
		if (existsSync(html)) entry.href = `${name}/${id}/lab-report.html`;
	}
	entries.push(entry);
}
const passed = entries.filter(e => e.status === "passed").length;
const rows = entries.map(e => `| ${e.os} | ${e.browser} | ${e.status} | ${e.cases} | ${e.failed} |`).join("\n");
const markdown = `# 兼容性汇总\n\n通过 ${passed}/${entries.length} 个系统与浏览器组合。每个组合的完整报告和日志可从下方汇总报告下载查看。\n\n| 系统 | 浏览器 | 结果 | 门禁用例 | 证据问题 |\n| --- | --- | --- | ---: | ---: |\n${rows}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const htmlRows = entries.map(e => `<tr><td>${escape(e.os)}</td><td>${escape(e.browser)}</td><td>${escape(e.status)}</td><td>${e.cases}</td><td>${e.failed}</td><td>${e.href ? `<a href="${escape(e.href)}">查看完整报告</a>` : "报告缺失"}</td></tr>`).join("\n");
writeFileSync(path.join(root, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Aevia 兼容性报告</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px;color:#243047}table{border-collapse:collapse;width:100%}th,td{padding:.7rem;border-bottom:1px solid #ddd;text-align:left}th{background:#eef3fa}a{color:#2458bd}</style><h1>兼容性汇总</h1><p>通过 ${passed}/${entries.length} 个系统与浏览器组合。展开各项报告可查看用例、日志与证据。</p><table><thead><tr><th>系统</th><th>浏览器</th><th>结果</th><th>门禁用例</th><th>证据问题</th><th>详情</th></tr></thead><tbody>${htmlRows}</tbody></table></html>`);
if (entries.some(e => e.status === "missing" || !e.href)) process.exitCode = 1;
