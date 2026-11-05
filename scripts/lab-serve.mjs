#!/usr/bin/env node
// File role: zero-dependency local lab server.
//
// Serves the unified lab report pages written by tests/report/lab-report.ts, a run
// index, and a token-guarded rerun API that spawns the managed runner with the
// same flags the lab page was designed around:
//
//   npx tsx tests/run-system.ts --profile=<manifest.profile> \
//     --rerun-of=<runId> --scope=<run|scenario|case> --ids=<csv> --yes
//
// Only binds 127.0.0.1. No dependencies, no CORS (the page is same-origin).

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_ROOT = path.join(ROOT, "tests", "reports", "summary", "runs");
const HOST = "127.0.0.1";
const PORT = Number(process.env.LAB_PORT || 4790);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	console.error(`[lab-serve] LAB_PORT 必须是 1-65535 的整数，当前值: ${process.env.LAB_PORT}`);
	process.exit(1);
}
const TOKEN = randomBytes(24).toString("hex");
const SERVER_STARTED_AT = new Date().toISOString();
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[A-Za-z0-9_./:#@|+-]+$/;
const SCOPES = new Set(["run", "scenario", "case"]);

const jobs = new Map();
let activeJobId = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toPosix = (value) => value.replaceAll("\\", "/");

const readJson = (filePath) => {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
};

const isFile = (filePath) => {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
};

const isDirectory = (filePath) => {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
};

const escapeHtml = (value) =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".jsonl": "application/x-ndjson; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webm": "video/webm",
	".mp4": "video/mp4",
	".out": "text/plain; charset=utf-8",
};

const contentTypeOf = (filePath) => CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";

const sendJson = (response, status, payload) => {
	const body = JSON.stringify(payload, null, 2);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(body);
};

const sendText = (response, status, text, contentType = "text/plain; charset=utf-8") => {
	response.writeHead(status, {
		"Content-Type": contentType,
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(text);
};

const sendError = (response, status, message) => sendJson(response, status, { ok: false, error: message });

const safeResolve = (baseDirectory, relativePath) => {
	const base = path.resolve(baseDirectory);
	const target = path.resolve(base, relativePath);
	if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
	try {
		const realBase = fs.realpathSync(base);
		const realTarget = fs.realpathSync(target);
		const relative = path.relative(realBase, realTarget);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
		return realTarget;
	} catch { return null; }
};

const tokenMatches = (candidate) => {
	if (typeof candidate !== "string" || candidate.length === 0) return false;
	const provided = Buffer.from(candidate);
	const expected = Buffer.from(TOKEN);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
};

const readRequestBody = (request) =>
	new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > 128 * 1024) {
				reject(new Error("请求体过大"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});

// ---------------------------------------------------------------------------
// Run index
// ---------------------------------------------------------------------------

const runEntries = () => {
	const entries = [];
	let names;
	try {
		names = fs.readdirSync(RUNS_ROOT);
	} catch {
		return entries;
	}
	for (const name of names) {
		if (!RUN_ID_PATTERN.test(name)) continue;
		const runDir = safeResolve(RUNS_ROOT, name);
		if (!runDir || !isDirectory(runDir)) continue;
		const labReport = readJson(path.join(runDir, "lab-report.json"));
		const manifest = readJson(path.join(runDir, "run-manifest.json"));
		if (labReport && typeof labReport === "object") {
			const run = labReport.run && typeof labReport.run === "object" ? labReport.run : {};
			const validity = run.validity && typeof run.validity === "object" ? run.validity : {};
			entries.push({
				runId: name,
				hasLabReport: true,
				mode: typeof run.mode === "string" ? run.mode : typeof manifest?.mode === "string" ? manifest.mode : "custom",
				profile: typeof run.profile === "string" ? run.profile : String(manifest?.profile ?? "unknown"),
				status: typeof run.status === "string" ? run.status : "unknown",
				validity: typeof validity.status === "string" ? validity.status : "unknown",
				aborted: validity.aborted === true,
				recorded: run.recorded !== false,
				startedAt: typeof run.startedAt === "string" ? run.startedAt : "",
				finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : null,
				durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
				measurements: Array.isArray(labReport.measurements) ? labReport.measurements.length : 0,
				failures: Array.isArray(labReport.failures) ? labReport.failures.length : 0,
				href: `/runs/${name}/`,
			});
			continue;
		}
		if (manifest && typeof manifest === "object") {
			entries.push({
				runId: name,
				hasLabReport: false,
				mode: typeof manifest.mode === "string" ? manifest.mode : "custom",
				profile: String(manifest.profile ?? "unknown"),
				status: String(manifest.status ?? "unknown"),
				validity: manifest.validity && typeof manifest.validity.status === "string" ? manifest.validity.status : "unknown",
				aborted: manifest.validity?.aborted === true,
				recorded: manifest.recorded !== false,
				startedAt: typeof manifest.startedAt === "string" ? manifest.startedAt : "",
				finishedAt: typeof manifest.finishedAt === "string" ? manifest.finishedAt : null,
				durationMs: null,
				measurements: 0,
				failures: 0,
				href: `/runs/${name}/`,
			});
		}
	}
	entries.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
	return entries;
};

const serveIndex = (response) => {
	const entries = runEntries();
	const rows = entries
		.map((entry) => {
			const badge = `<span class="badge b-${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span>`;
			const validity = `<span class="badge b-${escapeHtml(entry.validity)}">${escapeHtml(entry.validity)}</span>`;
			return `<tr>
<td><a href="${escapeHtml(entry.href)}"><code>${escapeHtml(entry.runId)}</code></a></td>
<td>${escapeHtml(entry.mode)} · <code>${escapeHtml(entry.profile)}</code></td>
<td>${badge} ${validity}</td>
<td>${entry.recorded ? "已记录" : "不记录"}</td>
<td>${entry.hasLabReport ? "lab-report" : "<span class=warn>仅 manifest</span>"}</td>
<td>${escapeHtml(entry.startedAt || "—")}</td>
<td>${entry.finishedAt ? escapeHtml(entry.finishedAt) : "—"}</td>
<td>${entry.measurements}</td>
</tr>`;
		})
		.join("");
	const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aevia Lab · runs</title>
<style>
:root{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light dark}
body{margin:0;background:#f6f8fb;color:#18212c;max-width:1200px;margin:0 auto;padding:24px 18px}
h1{font-size:22px;margin:0 0 4px}p.sub{color:#647083;margin:0 0 18px}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #dbe2ec;border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid #dbe2ec;text-align:left;font-size:13px}
th{background:#eef2f7}tr:last-child td{border-bottom:0}
code{font:12.5px ui-monospace,Consolas,monospace}.badge{font-size:11.5px;padding:1px 8px;border-radius:999px;background:#e8edf4;white-space:nowrap}
.b-passed,.b-valid{background:#dff3e7;color:#177245}.b-failed,.b-invalid,.b-aborted{background:#f8e1df;color:#a12622}
.b-degraded{background:#f7ecd3;color:#8a5a00}.warn{color:#8a5a00}
footer{margin-top:14px;color:#647083;font-size:12.5px}
</style></head><body>
<h1>Aevia Lab · 运行索引</h1>
<p class="sub">共 ${entries.length} 个 run · ${entries.filter((entry) => entry.hasLabReport).length} 个已有 lab-report · 点击 run 查看报告</p>
<table><thead><tr><th>run</th><th>mode / profile</th><th>状态 / 有效性</th><th>记录</th><th>报告</th><th>开始</th><th>结束</th><th>测量行</th></tr></thead><tbody>${rows || `<tr><td colspan="8">还没有 run 目录。</td></tr>`}</tbody></table>
<footer>重跑入口在报告页内（需本服务提供页面）。API: <code>GET /api/health</code> · <code>GET /api/runs</code> · <code>POST /api/rerun</code></footer>
</body></html>`;
	sendText(response, 200, html, "text/html; charset=utf-8");
};

// ---------------------------------------------------------------------------
// Static run files (report HTML with lab-serve injection, artifacts)
// ---------------------------------------------------------------------------

const injectLabServe = (html) => {
	const injection = `<script>window.__LAB_SERVE__=true;window.__LAB_TOKEN__=${JSON.stringify(TOKEN)};</script>`;
	const headMatch = /<head[^>]*>/i.exec(html);
	if (headMatch) return `${html.slice(0, headMatch.index + headMatch[0].length)}${injection}${html.slice(headMatch.index + headMatch[0].length)}`;
	return `${injection}${html}`;
};

const serveRunFile = (response, runId, rawRelative) => {
	const runDir = safeResolve(RUNS_ROOT, runId);
	if (!runDir || !isDirectory(runDir)) return sendError(response, 404, `run 不存在: ${runId}`);
	let relative = rawRelative.replace(/^\/+/, "");
	if (relative.startsWith("artifacts/")) relative = relative.slice("artifacts/".length);
	if (relative === "" || relative.endsWith("/")) {
		for (const candidate of ["lab-report.html", "test-report.html", "test-report.json"]) {
			if (isFile(path.join(runDir, candidate))) {
				relative = candidate;
				break;
			}
		}
		if (relative === "") return sendError(response, 404, `run ${runId} 没有报告文件（先运行 writeLabReport）`);
	}
	const target = safeResolve(runDir, relative);
	if (!target || !isFile(target)) return sendError(response, 404, `文件不存在: ${toPosix(relative)}`);
	const contentType = contentTypeOf(target);
	if (contentType.startsWith("text/html")) {
		let html;
		try {
			html = fs.readFileSync(target, "utf8");
		} catch (error) {
			return sendError(response, 500, `读取失败: ${error.message}`);
		}
		return sendText(response, 200, injectLabServe(html), contentType);
	}
	const body = fs.readFileSync(target);
	response.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length, "Cache-Control": "no-store" });
	response.end(body);
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const appendJobLog = (job, chunk) => {
	job.log += chunk;
	if (job.log.length > 2_000_000) job.log = job.log.slice(-1_500_000);
};

const jobTail = (job, lineCount = 120) => {
	const lines = job.log.split(/\r?\n/).filter(Boolean);
	return lines.slice(-lineCount);
};

const publicJob = (job) => ({
	id: job.id,
	runId: job.runId,
	scope: job.scope,
	ids: job.ids,
	command: job.command,
	status: job.status,
	startedAt: job.startedAt,
	finishedAt: job.finishedAt,
	exitCode: job.exitCode,
	stopRequested: job.stopRequested === true,
	tail: jobTail(job),
});

const killTree = (child) => {
	if (!child || typeof child.pid !== "number" || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	}
	const forceTimer = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}, 2500);
	forceTimer.unref();
};

const startRerunJob = ({ runId, profile, scope, ids }) => {
	if (activeJobId) return null;
	const args = [
		"tsx",
		"tests/run-system.ts",
		`--profile=${profile}`,
		`--rerun-of=${runId}`,
		`--scope=${scope}`,
	];
	if (ids.length > 0) args.push(`--ids=${ids.join(",")}`);
	args.push("--yes");
	const command = `npx ${args.join(" ")}`;
	const job = {
		id: randomUUID(),
		runId,
		scope,
		ids,
		command,
		status: "running",
		startedAt: new Date().toISOString(),
		finishedAt: null,
		exitCode: null,
		stopRequested: false,
		log: "",
		child: null,
	};
	jobs.set(job.id, job);
	activeJobId = job.id;
	let child;
	try {
		child = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), ...args.slice(1)], {
			cwd: ROOT,
			shell: false,
			detached: process.platform !== "win32",
			windowsHide: true,
			env: { ...process.env, FORCE_COLOR: "0" },
		});
	} catch (error) {
		job.status = "failed";
		job.exitCode = null;
		job.finishedAt = new Date().toISOString();
		appendJobLog(job, `[lab-serve] spawn failed: ${error.message}\n`);
		activeJobId = null;
		return job;
	}
	job.child = child;
	appendJobLog(job, `[lab-serve] ${command}\n`);
	child.stdout?.on("data", (chunk) => appendJobLog(job, chunk.toString()));
	child.stderr?.on("data", (chunk) => appendJobLog(job, chunk.toString()));
	child.on("error", (error) => {
		appendJobLog(job, `[lab-serve] process error: ${error.message}\n`);
	});
	child.on("close", (code) => {
		job.status = job.stopRequested ? "cancelled" : code === 0 ? "passed" : "failed";
		job.exitCode = code;
		job.finishedAt = new Date().toISOString();
		appendJobLog(job, `\n[lab-serve] exited with code ${code}\n`);
		if (activeJobId === job.id) activeJobId = null;
	});
	return job;
};

// ---------------------------------------------------------------------------
// Rerun API
// ---------------------------------------------------------------------------

const validCaseIdsOf = (labReport) => {
	const ids = new Set();
	const rerun = labReport && typeof labReport === "object" && labReport.rerun && typeof labReport.rerun === "object" ? labReport.rerun : null;
	if (rerun && Array.isArray(rerun.cases)) {
		for (const item of rerun.cases) {
			const id = typeof item?.id === "string" ? item.id : typeof item?.caseKey === "string" ? item.caseKey : "";
			if (id) ids.add(id);
			if (typeof item.selector === "string") ids.add(item.selector);
		}
	}
	const suites = labReport && typeof labReport === "object" && labReport.suites && typeof labReport.suites === "object" ? labReport.suites : null;
	if (suites) {
		for (const key of ["unit", "integration", "browser"]) {
			const suite = suites[key];
			if (!suite || !Array.isArray(suite.cases)) continue;
			for (const testCase of suite.cases) {
				if (!testCase || testCase.rerunnable === false) continue;
				const rerunIds = Array.isArray(testCase.rerunIds) && testCase.rerunIds.length > 0 ? testCase.rerunIds : [testCase.id];
				for (const id of rerunIds) if (typeof id === "string" && id) ids.add(id);
			}
		}
		for (const key of ["e2e", "performance"]) {
			const summary = suites[key];
			if (!summary || !Array.isArray(summary.suites)) continue;
			for (const suite of summary.suites) {
				if (!suite || !Array.isArray(suite.cases)) continue;
				for (const testCase of suite.cases) {
					if (!testCase || testCase.rerunnable === false) continue;
					if (typeof testCase.id === "string" && testCase.id) ids.add(testCase.id);
				}
			}
		}
	}
	return ids;
};

const validScenarioIdsOf = (labReport) => {
	const ids = new Set();
	const rerun = labReport && typeof labReport === "object" && labReport.rerun && typeof labReport.rerun === "object" ? labReport.rerun : null;
	if (rerun && Array.isArray(rerun.scenarios)) {
		for (const item of rerun.scenarios) if (typeof item?.scenarioKey === "string" && item.scenarioKey) ids.add(item.scenarioKey);
	}
	if (ids.size === 0 && labReport?.gate && Array.isArray(labReport.gate.scenarios)) {
		for (const item of labReport.gate.scenarios) if (typeof item?.scenarioKey === "string") ids.add(item.scenarioKey);
	}
	return ids;
};

const handleRerun = async (request, response) => {
	if (!tokenMatches(request.headers["x-lab-token"])) {
		return sendError(response, 401, "缺少或错误的 X-Lab-Token；请通过 npm run lab:serve 打开报告页");
	}
	let body;
	try {
		body = JSON.parse(await readRequestBody(request));
	} catch (error) {
		return sendError(response, 400, `请求体必须是 JSON: ${error.message}`);
	}
	if (!body || typeof body !== "object") return sendError(response, 400, "请求体缺失");
	const runId = typeof body.runId === "string" ? body.runId : "";
	if (!RUN_ID_PATTERN.test(runId)) return sendError(response, 400, "runId 必须是运行 UUID");
	const scope = typeof body.scope === "string" ? body.scope : "";
	if (!SCOPES.has(scope)) return sendError(response, 400, "scope 必须是 run|scenario|case");
	const ids = Array.isArray(body.ids) ? body.ids.map((item) => String(item)) : [];
	if (ids.length > 200) return sendError(response, 400, "ids 过多");
	for (const id of ids) {
		if (!id || !ID_PATTERN.test(id)) return sendError(response, 400, `非法 id: ${id}`);
	}
	const runDir = safeResolve(RUNS_ROOT, runId);
	if (!runDir || !isDirectory(runDir)) return sendError(response, 404, `run 不存在: ${runId}`);
	const manifest = readJson(path.join(runDir, "run-manifest.json"));
	if (!manifest || typeof manifest !== "object") return sendError(response, 404, `run 缺少 run-manifest.json: ${runId}`);
	const labReport = readJson(path.join(runDir, "lab-report.json"));

	if (scope === "case") {
		if (ids.length === 0) return sendError(response, 400, "case scope 需要 ids");
		const valid = validCaseIdsOf(labReport);
		const unknown = ids.filter((id) => !valid.has(id));
		if (unknown.length > 0) return sendError(response, 400, `ids 不在该 run 中: ${unknown.join(", ")}`);
	} else if (scope === "scenario") {
		if (ids.length === 0) return sendError(response, 400, "scenario scope 需要 ids");
		const valid = validScenarioIdsOf(labReport);
		const unknown = ids.filter((id) => !valid.has(id));
		if (unknown.length > 0) return sendError(response, 400, `scenarioKey 不在该 run 中: ${unknown.join(", ")}`);
	}

	const profile = typeof manifest.profile === "string" ? manifest.profile : "";
	if (!/^[a-z0-9-]+$/i.test(profile)) return sendError(response, 400, "该 run 的 profile 不可重跑");

	if (profile === "single" && scope === "run") {
		const rerun = manifest.rerun && typeof manifest.rerun === "object" ? manifest.rerun : null;
		const previousIds = rerun && Array.isArray(rerun.ids) ? rerun.ids.filter(id => typeof id === "string" && id) : [];
		if (previousIds.length === 0) for (const selection of manifest.selection?.selections ?? []) {
			if (selection.kind === "go") previousIds.push(...selection.packages.map(pkg => `go:${pkg}${selection.runPattern ? `#${selection.runPattern}` : ""}`));
			if (selection.kind === "vitest") previousIds.push(...selection.files.map(file => `file:${file}`), ...(selection.testNamePattern ? [`test:${selection.testNamePattern}`] : []));
			if (selection.kind === "external") previousIds.push(...(selection.caseKeys?.length ? selection.caseKeys : selection.caseIds));
		}
		if (previousIds.some(id => !ID_PATTERN.test(id))) return sendError(response, 400, "Saved selection cannot be safely rerun");
		if (previousIds.length === 0) {
			return sendError(response, 400, "single profile 的整轮重跑需要原始 --only 选择，请使用 case scope");
		}
		ids.splice(0, ids.length, ...previousIds);
		const effectiveScope = "case";
		const job = startRerunJob({ runId, profile, scope: effectiveScope, ids });
		if (!job) return sendError(response, 409, "已有运行中的任务，请先等待或停止");
		if (job.status === "failed") return sendError(response, 500, `重跑进程启动失败: ${job.log || "unknown"}`);
		return sendJson(response, 202, { ok: true, jobId: job.id, status: job.status, command: job.command });
	}

	const job = startRerunJob({ runId, profile, scope, ids });
	if (!job) return sendError(response, 409, "已有运行中的任务，请先等待或停止");
	if (job.status === "failed") return sendError(response, 500, `重跑进程启动失败: ${job.log || "unknown"}`);
	return sendJson(response, 202, { ok: true, jobId: job.id, status: job.status, command: job.command });
};

// ---------------------------------------------------------------------------
// HTTP router
// ---------------------------------------------------------------------------

const route = async (request, response) => {
	if (request.headers.host !== `${HOST}:${PORT}` || (request.headers.origin && request.headers.origin !== `http://${HOST}:${PORT}`)) return sendError(response, 403, "Invalid Host or Origin");
	const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return sendError(response, 400, "非法 URL");
	}
	const method = request.method ?? "GET";

	if (pathname === "/api/health" && method === "GET") {
		return sendJson(response, 200, {
			ok: true,
			service: "lab-serve",
			version: 1,
			port: PORT,
			pid: process.pid,
			startedAt: SERVER_STARTED_AT,
			serve: true,
			activeJobId,
			runs: runEntries().length,
		});
	}
	if (pathname === "/api/runs" && method === "GET") {
		return sendJson(response, 200, { ok: true, runs: runEntries() });
	}
	const runApiMatch = /^\/api\/runs\/([^/]+)\/?$/.exec(pathname);
	if (runApiMatch && method === "GET") {
		const runId = runApiMatch[1];
		if (!RUN_ID_PATTERN.test(runId)) return sendError(response, 400, "非法 runId");
		const labReport = readJson(safeResolve(RUNS_ROOT, `${runId}/lab-report.json`) ?? "");
		if (!labReport) return sendError(response, 404, `run ${runId} 没有 lab-report.json（先由 runner 写出）`);
		return sendJson(response, 200, labReport);
	}
	if (pathname === "/api/jobs" && method === "GET") {
		return sendJson(response, 200, { ok: true, activeJobId, jobs: [...jobs.values()].map(publicJob) });
	}
	const jobStopMatch = /^\/api\/jobs\/([^/]+)\/stop$/.exec(pathname);
	if (jobStopMatch && method === "POST") {
		if (!tokenMatches(request.headers["x-lab-token"])) return sendError(response, 401, "缺少或错误的 X-Lab-Token");
		const job = jobs.get(jobStopMatch[1]);
		if (!job) return sendError(response, 404, "job 不存在");
		if (job.status !== "running") return sendError(response, 409, `job 状态为 ${job.status}，不可停止`);
		job.stopRequested = true;
		killTree(job.child);
		return sendJson(response, 202, { ok: true, jobId: job.id, status: "stopping" });
	}
	const jobLogMatch = /^\/api\/jobs\/([^/]+)\/log$/.exec(pathname);
	if (jobLogMatch && method === "GET") {
		const job = jobs.get(jobLogMatch[1]);
		if (!job) return sendError(response, 404, "job 不存在");
		return sendText(response, 200, job.log || "(empty)", "text/plain; charset=utf-8");
	}
	const jobMatch = /^\/api\/jobs\/([^/]+)\/?$/.exec(pathname);
	if (jobMatch && method === "GET") {
		const job = jobs.get(jobMatch[1]);
		if (!job) return sendError(response, 404, "job 不存在");
		return sendJson(response, 200, { ok: true, ...publicJob(job) });
	}
	if (pathname === "/api/rerun" && method === "POST") {
		return handleRerun(request, response);
	}

	if (pathname === "/" && method === "GET") return serveIndex(response);

	const runFileMatch = /^\/runs\/([0-9a-fA-F-]{36})(?:\/(.*))?$/.exec(pathname);
	if (runFileMatch && method === "GET") {
		return serveRunFile(response, runFileMatch[1], runFileMatch[2] ?? "");
	}

	sendError(response, 404, `未知路由: ${method} ${pathname}`);
};

const server = http.createServer((request, response) => {
	route(request, response).catch((error) => {
		try {
			sendError(response, 500, `内部错误: ${error instanceof Error ? error.message : String(error)}`);
		} catch {
			// Response already sent.
		}
	});
});

const shutdown = () => {
	for (const job of jobs.values()) if (job.status === "running" && job.child) killTree(job.child);
};

process.once("SIGINT", () => {
	shutdown();
	process.exit(0);
});
process.once("SIGTERM", () => {
	shutdown();
	process.exit(0);
});
process.once("exit", shutdown);

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`[lab-serve] 端口 ${PORT} 已被占用，设置 LAB_PORT 后重试。`);
	} else {
		console.error(`[lab-serve] 服务启动失败: ${error.message}`);
	}
	process.exit(1);
});

server.listen(PORT, HOST, () => {
	console.log(`[lab-serve] http://${HOST}:${PORT}`);
	console.log(`[lab-serve] token: ${TOKEN}`);
	console.log(`[lab-serve] runs: ${RUNS_ROOT}`);
	console.log(`[lab-serve] 打开浏览器后点击报告页中的「重跑」按钮；API 需通过页面注入的 token。`);
});
