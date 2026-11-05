// File role: temporary loopback live console for a running lab test (HTTP page + WebSocket events).
//
// The console is started by run-system for every non-CI mode, prints a clickable URL, streams step
// and case progress to the browser, accepts a cancellation request, and finally pushes the report
// URL. It binds 127.0.0.1 only and requires a random per-process token for WebSocket and cancellation,
// so another local page cannot drive a test run. CI mode leaves it disabled by default.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { renderLiveConsoleHtml } from "./live-console-html";

export type LiveStepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";

export type LiveStepState = {
	id: string;
	title: string;
	status: LiveStepStatus;
	startedAt?: string;
	durationMs?: number;
	error?: string;
};

export type LiveCaseState = {
	id: string;
	status: "passed" | "failed";
	durationMs?: number;
	error?: string;
	stepId?: string;
};

export type LiveDonePayload = {
	status: "passed" | "failed" | "cancelled";
	validity?: string;
	recorded?: boolean;
	reportUrl?: string;
	reportPath?: string;
	exitCode?: number | null;
};

export type LiveConsoleOptions = {
	runId: string;
	mode: string;
	profile: string;
	revision?: string;
	startedAt?: string;
	steps: Array<{ id: string; title: string }>;
	runDir: string;
	onCancel: () => void;
	port?: number;
	open?: boolean;
	print?: (line: string) => void;
	graceMs?: number;
};

export type LiveConsole = {
	url: string;
	port: number;
	token: string;
	stepStart: (stepId: string) => void;
	stepEnd: (step: { id: string; status: LiveStepStatus; durationMs?: number; error?: string }) => void;
	log: (stepId: string, chunk: string, stream?: "stdout" | "stderr") => void;
	caseResult: (result: LiveCaseState) => void;
	finish: (done: LiveDonePayload) => void;
	close: () => Promise<void>;
};

const LOOPBACK = "127.0.0.1";
const MAX_LOG_LINES = 200;
const LOG_FLUSH_MS = 90;
const DEFAULT_GRACE_MS = 120_000;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
};

// eslint-disable-next-line no-control-regex -- stripping terminal colour escapes is the whole point here.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string) => value.replace(ANSI_PATTERN, "");

const openBrowser = (url: string) => {
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// Opening a browser is a convenience; failing it must not affect the run.
	}
};

/** CI runs never need the console; every other mode enables it unless explicitly turned off. */
export const isLiveConsoleEnabled = (mode: string, env: NodeJS.ProcessEnv = process.env): boolean => {
	const raw = (env.AEVIA_LIVE || "").trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
	if (raw === "1" || raw === "on" || raw === "true") return true;
	return mode !== "ci";
};

export const startLiveConsole = async (options: LiveConsoleOptions): Promise<LiveConsole> => {
	const token = randomBytes(16).toString("hex");
	const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
	const graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS);
	const steps = new Map<string, LiveStepState>();
	const cases = new Map<string, LiveCaseState>();
	const logs = new Map<string, string[]>();
	const pendingLogs = new Map<string, string[]>();
	const clients = new Set<WebSocket>();
	let currentStepId: string | undefined;
	let runStatus: "running" | "passed" | "failed" | "cancelled" = "running";
	let done: LiveDonePayload | undefined;
	let closed = false;
	let cancellationRequested = false;
	let closeTimer: NodeJS.Timeout | undefined;
	let logTimer: NodeJS.Timeout | undefined;
	let publishBaseUrl = "";

	for (const step of options.steps) {
		steps.set(step.id, { id: step.id, title: step.title, status: "pending" });
	}

	const send = (client: WebSocket, payload: unknown) => {
		if (client.readyState === 1) client.send(JSON.stringify(payload));
	};
	const broadcast = (payload: unknown) => {
		for (const client of clients) send(client, payload);
	};
	const stepList = () => [...steps.values()];
	const caseList = () => [...cases.values()];

	const snapshot = () => ({
		type: "hello",
		runId: options.runId,
		mode: options.mode,
		profile: options.profile,
		startedAt: startedAt,
		status: runStatus,
		steps: stepList(),
		cases: caseList(),
		done,
	});

	const flushLogs = () => {
		logTimer = undefined;
		for (const [stepId, lines] of pendingLogs) {
			if (lines.length === 0) continue;
			pendingLogs.set(stepId, []);
			broadcast({ type: "log", stepId, lines: lines.slice(-MAX_LOG_LINES) });
		}
	};

	const queueLog = (stepId: string, line: string) => {
		const buffer = logs.get(stepId) ?? [];
		buffer.push(line);
		if (buffer.length > MAX_LOG_LINES) buffer.splice(0, buffer.length - MAX_LOG_LINES);
		logs.set(stepId, buffer);
		const pending = pendingLogs.get(stepId) ?? [];
		pending.push(line);
		if (pending.length > MAX_LOG_LINES) pending.splice(0, pending.length - MAX_LOG_LINES);
		pendingLogs.set(stepId, pending);
		if (!logTimer) logTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
	};

	const resolveReportTarget = (urlPath: string) => {
		const prefix = `/report/${options.runId}/`;
		const legacy = `/report/${options.runId}`;
		let relative: string;
		if (urlPath === legacy || urlPath === `${legacy}/`) relative = "test-report.html";
		else if (urlPath.startsWith(prefix)) { try { relative = decodeURIComponent(urlPath.slice(prefix.length)); } catch { return null; } }
		else return null;
		const target = path.resolve(options.runDir, relative.replace(/^\/+/, ""));
		const root = path.resolve(options.runDir);
		if (target !== path.join(root, "test-report.html") && !target.startsWith(`${root}${path.sep}`)) return null;
		try {
			const relativeReal = path.relative(fs.realpathSync(root), fs.realpathSync(target));
			if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) return null;
			return target;
		} catch { return null; }
	};

	const serveFile = (response: ServerResponse, filePath: string, status = 200) => {
		try {
			const body = fs.readFileSync(filePath);
			response.writeHead(status, {
				"Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
				"Content-Length": body.length,
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(body);
		} catch {
			writeJson(response, 404, { error: "not found" });
		}
	};

	const writeJson = (response: ServerResponse, status: number, payload: unknown) => {
		const body = Buffer.from(JSON.stringify(payload, null, 2));
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": body.length,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(body);
	};

	const handler = (request: IncomingMessage, response: ServerResponse) => {
		if (request.headers.host !== new URL(publishBaseUrl).host) { writeJson(response, 403, { error: "invalid host" }); return; }
		const url = new URL(request.url || "/", publishBaseUrl || `http://${LOOPBACK}`);
		if (request.method !== "GET" && request.method !== "HEAD") {
			writeJson(response, 405, { error: "method not allowed" });
			return;
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			const html = renderLiveConsoleHtml({
				runId: options.runId,
				mode: options.mode,
				profile: options.profile,
				revision: options.revision,
				startedAt,
				steps: stepList().map((step) => ({ id: step.id, title: step.title, status: step.status })),
				token,
				wsPath: "/ws",
			});
			const body = Buffer.from(html);
			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": body.length,
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(body);
			return;
		}
		if (url.pathname === "/health") {
			writeJson(response, 200, { ok: true, runId: options.runId, status: runStatus, done: done ?? null });
			return;
		}
		if (url.pathname === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (url.pathname.startsWith("/report/")) {
			const target = resolveReportTarget(url.pathname);
			if (!target) {
				writeJson(response, 404, { error: "report path is not readable" });
				return;
			}
			serveFile(response, target);
			return;
		}
		writeJson(response, 404, { error: "not found" });
	};

	const server: Server = createServer(handler);
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		try {
			const url = new URL(request.url || "/", `http://${LOOPBACK}`);
			if (request.headers.host !== new URL(publishBaseUrl).host || (request.headers.origin && request.headers.origin !== publishBaseUrl) || url.pathname !== "/ws" || url.searchParams.get("token") !== token) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(request, socket, head, (client) => {
				clients.add(client);
				client.on("close", () => clients.delete(client));
				client.on("message", (raw) => {
					let parsed: unknown;
					try {
						parsed = JSON.parse(String(raw));
					} catch {
						return;
					}
					if (!parsed || typeof parsed !== "object") return;
					const message = parsed as { type?: unknown };
					if (message.type !== "cancel") return;
					if (closed || done || cancellationRequested) return;
					cancellationRequested = true;
					broadcast({ type: "cancel-requested" });
					try {
						options.onCancel();
					} catch (error) {
						print(`[lab-live] cancel handler failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				});
				send(client, snapshot());
				for (const [stepId, lines] of logs) {
					if (lines.length > 0) send(client, { type: "log", stepId, lines: lines.slice(-MAX_LOG_LINES) });
				}
			});
		} catch {
			socket.destroy();
		}
	});

	const startedAt = options.startedAt ?? new Date().toISOString();

	const listen = async () => {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, LOOPBACK, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		publishBaseUrl = `http://${LOOPBACK}:${port}`;
		return port;
	};

	const port = await listen();
	const url = `${publishBaseUrl}/?token=${encodeURIComponent(token)}`;
	print(`[lab-live] console: ${url}`);
	print(`[lab-live] 仅本机可访问；测试结束后若有页面连接，会保留 ${Math.round(graceMs / 1000)}s 供查看报告`);
	if (options.open) {
		print("[lab-live] opening browser…");
		openBrowser(url);
	}

	const validate = (stepId: string) => {
		if (!steps.has(stepId)) steps.set(stepId, { id: stepId, title: stepId, status: "pending" });
	};

	const api: LiveConsole = {
		url,
		port,
		token,
		stepStart(stepId) {
			if (closed) return;
			validate(stepId);
			currentStepId = stepId;
			const step = steps.get(stepId)!;
			step.status = "running";
			step.startedAt = new Date().toISOString();
			broadcast({ type: "step", step: { ...step } });
			broadcast({ type: "log", stepId, lines: [] });
		},
		stepEnd(input) {
			if (closed) return;
			validate(input.id);
			const step = steps.get(input.id)!;
			step.status = input.status;
			step.durationMs = input.durationMs;
			step.error = input.error;
			broadcast({ type: "step", step: { ...step } });
		},
		log(stepId, chunk, stream = "stdout") {
			if (closed) return;
			const text = stripAnsi(String(chunk)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			for (const line of text.split("\n")) {
				if (line.trim().length === 0) continue;
				queueLog(stepId, stream === "stderr" ? `[stderr] ${line}` : line);
				if (stepId === currentStepId) {
					for (const match of line.matchAll(/[✓✕]\s+\[[^\]]*\]\s+(\S+)\s+(passed|failed)/g)) {
						api.caseResult({ id: match[1]!, status: match[2] === "passed" ? "passed" : "failed", stepId });
					}
				}
			}
		},
		caseResult(result) {
			if (closed) return;
			const previous = cases.get(result.id);
			const merged: LiveCaseState = { ...previous, ...result };
			cases.set(result.id, merged);
			broadcast({ type: "case", case: merged });
		},
		finish(input) {
			if (done) return;
			runStatus = input.status;
			const reportUrl =
				input.reportUrl ?? (input.reportPath ? `${publishBaseUrl}/report/${options.runId}/test-report.html` : undefined);
			done = { ...input, reportUrl };
			if (logTimer) {
				clearTimeout(logTimer);
				flushLogs();
			}
			// Steps that never ran because the run stopped early end up skipped/cancelled,
			// otherwise the final dashboard shows a half-finished plan forever.
			const terminalStatus: LiveStepStatus = input.status === "cancelled" ? "cancelled" : "skipped";
			for (const step of steps.values()) {
				if (step.status !== "pending" && step.status !== "running") continue;
				step.status = terminalStatus;
				broadcast({ type: "step", step: { ...step } });
			}
			broadcast({ type: "state", status: runStatus });
			broadcast({ type: "done", ...done });
			print(`[lab-live] status=${done.status}${done.validity ? ` validity=${done.validity}` : ""}`);
			if (done.reportUrl) print(`[lab-live] report: ${done.reportUrl}`);
			// A watched console keeps the server (and therefore the clickable report URL) alive
			// for the grace period. An unwatched one closes immediately so scripted local runs
			// do not hang after the test result is already printed.
			const watched = clients.size > 0;
			if (graceMs > 0 && watched) {
				print(`[lab-live] 页面保留 ${Math.round(graceMs / 1000)}s 供查看报告；Ctrl+C 立即结束`);
				closeTimer = setTimeout(() => {
					void api.close();
				}, graceMs);
			} else {
				if (!watched && graceMs > 0) print("[lab-live] no viewer connected, closing console");
				closeTimer = setTimeout(() => {
					void api.close();
				}, 50);
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			if (logTimer) clearTimeout(logTimer);
			if (closeTimer) clearTimeout(closeTimer);
			for (const client of clients) {
				try {
					client.close();
				} catch {
					// already gone
				}
			}
			clients.clear();
			await new Promise<void>((resolve) => {
				wss.close(() => resolve());
				server.close(() => resolve());
				setTimeout(resolve, 500).unref();
			});
		},
	};

	return api;
};
