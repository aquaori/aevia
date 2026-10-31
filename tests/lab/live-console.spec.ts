// File role: protocol and security checks for the temporary live test console.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { isLiveConsoleEnabled, startLiveConsole, type LiveConsole } from "./live-console";

const consoles: LiveConsole[] = [];
const temporaryDirs: string[] = [];

afterEach(async () => {
	for (const live of consoles.splice(0)) await live.close();
	for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const createRunDir = () => {
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aevia-live-console-"));
	temporaryDirs.push(runDir);
	fs.writeFileSync(path.join(runDir, "test-report.html"), "<h1>report body</h1>");
	return runDir;
};

const startConsole = async (overrides: { runDir?: string; onCancel?: () => void } = {}) => {
	const live = await startLiveConsole({
		runId: "run-1",
		mode: "smoke",
		profile: "smoke",
		steps: [
			{ id: "frontend-test", title: "Frontend tests" },
			{ id: "external-e2e", title: "External E2E" },
		],
		runDir: overrides.runDir ?? createRunDir(),
		onCancel: overrides.onCancel ?? (() => undefined),
		print: () => undefined,
		graceMs: 0,
	});
	consoles.push(live);
	return live;
};

type LiveMessage = Record<string, unknown>;
type LiveClient = {
	socket: WebSocket;
	waitFor: (predicate: (message: LiveMessage) => boolean, timeoutMs?: number) => Promise<LiveMessage>;
};

/**
 * Buffers every frame from the moment the socket object exists. The server sends `hello`
 * immediately on upgrade, so attaching a listener only after `open` can miss it.
 */
const openSocket = (live: LiveConsole, token = live.token) =>
	new Promise<LiveClient>((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${live.port}/ws?token=${token}`);
		const buffered: LiveMessage[] = [];
		const waiters: Array<{
			predicate: (message: LiveMessage) => boolean;
			resolve: (message: LiveMessage) => void;
			reject: (error: Error) => void;
			timer: NodeJS.Timeout;
		}> = [];
		socket.on("message", (raw) => {
			let message: LiveMessage;
			try {
				message = JSON.parse(String(raw)) as LiveMessage;
			} catch {
				return;
			}
			const index = waiters.findIndex((waiter) => {
				try {
					return waiter.predicate(message);
				} catch {
					return false;
				}
			});
			if (index >= 0) {
				const [waiter] = waiters.splice(index, 1);
				clearTimeout(waiter!.timer);
				waiter!.resolve(message);
			} else {
				buffered.push(message);
			}
		});
		socket.once("open", () => {
			resolve({
				socket,
				waitFor: (predicate, timeoutMs = 3000) => {
					const existing = buffered.findIndex((message) => predicate(message));
					if (existing >= 0) return Promise.resolve(buffered.splice(existing, 1)[0]!);
					return new Promise<LiveMessage>((resolveMessage, rejectMessage) => {
						const timer = setTimeout(() => {
							const index = waiters.findIndex((waiter) => waiter.timer === timer);
							if (index >= 0) waiters.splice(index, 1);
							rejectMessage(new Error("timed out waiting for live console message"));
						}, timeoutMs);
						waiters.push({ predicate, resolve: resolveMessage, reject: rejectMessage, timer });
					});
				},
			});
		});
		socket.once("error", reject);
	});

describe("live console", () => {
	it("is enabled for every mode except CI unless explicitly toggled", () => {
		expect(isLiveConsoleEnabled("ci")).toBe(false);
		expect(isLiveConsoleEnabled("smoke")).toBe(true);
		expect(isLiveConsoleEnabled("nightly")).toBe(true);
		expect(isLiveConsoleEnabled("single")).toBe(true);
		expect(isLiveConsoleEnabled("ci", { AEVIA_LIVE: "on" })).toBe(true);
		expect(isLiveConsoleEnabled("smoke", { AEVIA_LIVE: "off" })).toBe(false);
	});

	it("serves the page, health endpoint and the run report", async () => {
		const live = await startConsole();
		const base = `http://127.0.0.1:${live.port}`;
		const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
		expect(health.ok).toBe(true);
		expect(health.runId).toBe("run-1");
		const html = await (await fetch(`${base}/`)).text();
		expect(html).toContain("Aevia Lab");
		expect(html).toContain("终止测试");
		const report = await fetch(`${base}/report/run-1/test-report.html`);
		expect(report.status).toBe(200);
		expect(await report.text()).toContain("report body");
	});

	it("rejects a socket without the process token and blocks report traversal", async () => {
		const live = await startConsole();
		await expect(openSocket(live, "wrong-token")).rejects.toBeTruthy();
		const traversal = await fetch(`http://127.0.0.1:${live.port}/report/run-1/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
		expect(traversal.status).toBe(404);
	});

	it("streams steps, logs, cases and the final report URL", async () => {
		const live = await startConsole();
		const client = await openSocket(live);
		const hello = await client.waitFor((message) => message.type === "hello");
		expect(hello.runId).toBe("run-1");
		expect((hello.steps as unknown[]).length).toBe(2);

		live.stepStart("external-e2e");
		const running = await client.waitFor((message) => message.type === "step");
		expect((running.step as { status: string }).status).toBe("running");

		live.log("external-e2e", "✓ [21.0s] concurrent-crossing passed (5.1s)");
		const logMessage = await client.waitFor(
			(message) => message.type === "log" && (message.lines as string[]).length > 0
		);
		expect((logMessage.lines as string[]).join("\n")).toContain("concurrent-crossing");
		const caseMessage = await client.waitFor((message) => message.type === "case");
		expect((caseMessage.case as { id: string; status: string }).id).toBe("concurrent-crossing");
		expect((caseMessage.case as { status: string }).status).toBe("passed");

		live.stepEnd({ id: "external-e2e", status: "passed", durationMs: 5100 });
		await client.waitFor((message) => message.type === "step" && (message.step as { status: string }).status === "passed");

		live.finish({ status: "passed", validity: "valid", recorded: true, reportPath: "test-report.html", exitCode: 0 });
		const done = await client.waitFor((message) => message.type === "done");
		expect(done.status).toBe("passed");
		expect(String(done.reportUrl)).toContain("/report/run-1/test-report.html");
		const report = await fetch(String(done.reportUrl));
		expect(report.status).toBe(200);
		client.socket.close();
	});

	it("forwards a cancellation request exactly once while running", async () => {
		let cancelled = 0;
		const live = await startConsole({ onCancel: () => (cancelled += 1) });
		const client = await openSocket(live);
		await client.waitFor((message) => message.type === "hello");
		const requested = client.waitFor((message) => message.type === "cancel-requested");
		client.socket.send(JSON.stringify({ type: "cancel" }));
		await requested;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(cancelled).toBe(1);
		client.socket.close();
	});
});
