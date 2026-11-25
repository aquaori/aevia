import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { parseConfig } from "../../apps/frontend/tests/e2e/external/config";
import { compareCanvasPages, installCanvasObserver, roiAround, waitForStableCanvas, waitForVisibleScreenshotBlank, waitForVisibleScreenshotContent } from "../../apps/frontend/tests/e2e/external/canvas-observer";
import { captureLabSnapshot } from "../../apps/frontend/tests/e2e/external/lab/install";
import { createDistributedStrokePoints, createRoomWithUsers, joinRoom, ProtocolClient } from "../../apps/frontend/tests/e2e/external/protocol-driver";
import { drawLine, openMeasuredRoomPage, openRoomPage, pressRedo, pressUndo, waitForPageChangeComplete } from "../../apps/frontend/tests/e2e/external/ui-driver";
import { readSourceIdentity } from "../report/provenance";
import { resolveChromiumLaunchOptions } from "../browser-launch";
import { collectBrowser, collectGo, type Collector } from "./collectors";
import { createOverlay } from "./go-overlay";
import { criticalPath, summarizeSpans, wireMetrics, type Span, type Wire } from "./analysis";

type Clock = { remoteMs: number; beforeMs: number; afterMs: number };
type Services = { frontendUrl: string; pprofUrl?: string; profileDirectory?: string; profileControl?: (command: "begin" | "clock" | "end", id: string) => Promise<Clock>; stop(): Promise<void> };
type Setup = (input: { outDir: string; pprof: boolean; viteConfig: string; goOverlay?: string; controlDir?: string }) => Promise<Services>;
type Metrics = Record<string, number | boolean | string>;
type Sample = { iteration: number; metrics?: Metrics; issues: string[]; artifacts: string[]; error?: string };
type Group = { caseId: string; collector: Collector; samples: Sample[] };
type Config = ReturnType<typeof parseConfig>;
type Browser = Parameters<typeof openRoomPage>[0];
type Page = Awaited<ReturnType<typeof openRoomPage>>["page"];
// The root runner owns Chromium. The workspace helper imports its own minor
// Playwright version, whose broader protocol types differ at compile time.
const launchProfileBrowser = async () => await chromium.launch(resolveChromiumLaunchOptions()) as unknown as Browser;

const collectors: Collector[] = ["baseline", "spans", "cpu", "timeline", "memory"];
const small = { width: 1280, height: 720 };
const list = [
	{ id: "join-empty", scale: 0, module: "会话、网关、首屏", oracle: "画布和入房界面就绪" },
	{ id: "join-10k", scale: 10000, module: "快照、编解码、Worker", oracle: "持久确认与像素稳定" },
	{ id: "join-50k", scale: 50000, module: "快照、编解码、Worker", oracle: "持久确认与像素稳定" },
	{ id: "join-100k", scale: 100000, module: "快照、编解码、Worker", oracle: "持久确认与像素稳定" },
	{ id: "join-100k-active", scale: 100000, module: "初始化与本地输入竞争", oracle: "确认输入发生在初始化完成前并对照重放" },
	{ id: "join-gate", scale: 10000, module: "首屏编辑门禁", oracle: "初始化期间不提交，解禁后笔迹可重放" },
	{ id: "pending-store", scale: 100, module: "IndexedDB 待确认操作", oracle: "顺序、内容和删除一致" },
	{ id: "pending-store-points", scale: 100, module: "IndexedDB 笔迹点批量存储", oracle: "顺序、点数和删除一致" },
	{ id: "render-direct", scale: 45600, module: "SceneEngine、Canvas", oracle: "实际分支与逐像素对照" },
	{ id: "render-dirty", scale: 45600, module: "空间索引、候选排序、Canvas", oracle: "实际分支与逐像素对照" },
	{ id: "render-fallback", scale: 45600, module: "重绘策略、Canvas", oracle: "实际分支与逐像素对照" },
	{ id: "render-pencil", scale: 10000, module: "铅笔、Canvas", oracle: "完整绘制与像素对照" },
	{ id: "render-highlighter", scale: 10000, module: "荧光笔、透明合成", oracle: "完整绘制与像素对照" },
	{ id: "draw-dense", scale: 45000, module: "输入、协作、Worker、存储", oracle: "双方画布与新加入客户端重放" },
	{ id: "draw-dense-ready", scale: 45000, module: "初始化完成后的输入、协作、Worker、存储", oracle: "双方完成初始化且画布与新加入客户端重放一致" },
	{ id: "draw-ring", scale: 45000, module: "共享内存 Ring、双端 Worker", oracle: "确认使用 Ring 且双方画布与重放一致" },
	{ id: "draw-transfer", scale: 45000, module: "可转移消息、双端 Worker", oracle: "确认使用 transferable 且双方画布与重放一致" },
	{ id: "draw-distributed", scale: 45000, module: "输入、协作、Worker、存储", oracle: "双方画布与新加入客户端重放" },
	{ id: "draw-solo", scale: 45000, module: "输入、协作、Worker、存储", oracle: "本地画布与新加入客户端重放" },
	{ id: "edit-history", scale: 0, module: "撤销重做、最终像素、存储", oracle: "撤销时目标空白，重做时目标恢复" },
	{ id: "clear-undo", scale: 0, module: "双端清屏、刷新、历史恢复", oracle: "清屏后两端空白，刷新并撤销后两端恢复" },
	{ id: "clear-undo-large", scale: 10000, module: "大房间双端清屏与历史恢复", oracle: "历史区域与两端笔迹在清屏后消失、撤销后恢复" },
	{ id: "edit-text", scale: 0, module: "文字编辑、场景布局、协作与持久化", oracle: "提交后画布可见且重新加入的客户端画面一致" },
	{ id: "edit-sticky", scale: 0, module: "便签编辑、场景布局、协作与持久化", oracle: "提交后画布可见且重新加入的客户端画面一致" },
	{ id: "switch-page", scale: 0, module: "分页、流、画布", oracle: "新页空白，返回后原笔迹恢复" },
	{ id: "rejoin", scale: 10000, module: "快照、刷新恢复", oracle: "刷新前后画布一致" },
	{ id: "delta-reconnect", scale: 0, module: "断线检测、WebSocket、增量重连与画布", oracle: "断线期间远端画笔在重连后出现在本端" },
] as const;
type Scenario = typeof list[number];

const write = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const median = (values: number[]) => {
	const ordered = values.slice().sort((a, b) => a - b);
	const i = Math.floor(ordered.length / 2);
	return ordered.length % 2 ? ordered[i]! : (ordered[i - 1]! + ordered[i]!) / 2;
};
const deadline = <T>(task: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

async function seed(config: Config, roomId: string, count: number, distributed: boolean, corner = false) {
	if (!count) return;
	const user = await joinRoom(config, roomId, "Profile seed");
	const client = new ProtocolClient(config, user);
	await client.connect();
	try {
		const strokes = Math.ceil(count / 75);
		for (let i = 0; i < strokes; i++) {
			const points = createDistributedStrokePoints(Math.min(75, count - i * 75), i, strokes)
				.map(point => corner ? { ...point, x: .02 + point.x * .12, y: .02 + point.y * .12 } : distributed ? point : { ...point, x: .26 + point.x * .47, y: .2 + point.y * .48 });
			await client.sendCommittedStroke({ waitForCommit: true, points, color: "#21262e", size: 3 });
		}
	} finally { client.close(); }
}

async function runSample(browser: Browser, services: Services, scenario: Scenario, collector: Collector, dir: string): Promise<Sample> {
	// The existing Lab contract eagerly flushes some worker paints on live edits.
	const config = parseConfig([`--lab=${scenario.id.startsWith("join-") || scenario.id.startsWith("draw-dense") || ["draw-ring", "draw-transfer", "clear-undo-large"].includes(scenario.id) ? "on" : "off"}`]);
	const pages: Page[] = [];
	const wire: Wire[] = [];
	let wireDropped = 0;
	const crashes: string[] = [];
	const closers: Array<() => Promise<void>> = [];
	const issues: string[] = [], artifacts: string[] = [];
	const observe = (page: Page) => {
		const target = pages.length;
		pages.push(page);
		page.on("crash", () => crashes.push(`page ${target} crashed`));
		page.on("websocket", socket => {
			if (new URL(socket.url()).pathname !== "/ws") return;
			const collect = (direction: Wire["direction"], payload: string | Buffer) => {
				const t = performance.now();
				if (wire.length >= 20000) { wireDropped++; return; }
				const bytes = Buffer.byteLength(payload);
				if (typeof payload !== "string") { wire.push({ t, target, direction, bytes, type: "binary" }); return; }
				try {
					const envelope = JSON.parse(payload);
					const data = envelope?.data;
					if (typeof envelope?.type !== "string") return;
					const id = data?.opId ?? data?.cmdId ?? data?.id;
					wire.push({ t, target, direction, bytes, type: envelope.type, id: typeof id === "string" ? id : undefined,
						seq: Number.isSafeInteger(data?.roomSeq) ? data.roomSeq : undefined,
						code: envelope.type === "op-rejected" && typeof data?.code === "string" ? data.code : undefined,
						reason: envelope.type === "op-rejected" && typeof data?.reason === "string" ? data.reason : undefined });
				} catch { issues.push("Unparsed WebSocket frame"); }
			};
			socket.on("framesent", item => collect("send", item.payload));
			socket.on("framereceived", item => collect("receive", item.payload));
		});
	};
	let stopBrowser: Awaited<ReturnType<typeof collectBrowser>> | undefined;
	let stopGo: ReturnType<typeof collectGo> | undefined;
	const clock: Clock[] = [];
	const windowId = randomUUID();
	const start = async () => {
		stopBrowser = await collectBrowser(browser, pages, collector, dir, !scenario.id.startsWith("render-"));
		stopGo = collectGo(services.pprofUrl, collector, dir);
		if (services.profileControl) {
			for (let i = 0; i < 3; i++) clock.push(await services.profileControl("clock", randomUUID()));
			clock.push(await services.profileControl("begin", windowId));
		}
	};
	let metrics: Metrics | undefined;
	let failure: string | undefined;
	try {
		if (scenario.id === "pending-store" || scenario.id === "pending-store-points") {
			const context = await browser.newContext();
			closers.push(() => context.close());
			const page = await context.newPage();
			observe(page);
			await page.goto(services.frontendUrl);
			await start();
			metrics = await page.evaluate(async ({ count, pointsPerOperation }) => {
				const fixture = await import(/* @vite-ignore */ "/assets/profile-pending.js");
				return fixture.measure(count, pointsPerOperation) as Promise<Metrics>;
			}, { count: scenario.scale, pointsPerOperation: scenario.id === "pending-store-points" ? 75 : 0 });
		} else if (scenario.id.startsWith("render-")) {
			const context = await browser.newContext({ viewport: small });
			closers.push(() => context.close());
			const page = await context.newPage();
			observe(page);
			await page.route("**/__profile_render", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Aevia Render Fixture</title>" }));
			await page.goto(services.frontendUrl + "/__profile_render");
			const variant = scenario.id.slice("render-".length);
			const tool = variant === "pencil" || variant === "highlighter" ? variant : "pen";
			const mode = tool === "pen" ? variant : "direct";
			await start();
			metrics = await page.evaluate(async ({ count, mode, tool }) => {
				const url = "/assets/profile-render.js";
				const fixture = await import(/* @vite-ignore */ url);
				return fixture.setup(count, tool)(mode) as Metrics;
			}, { count: scenario.scale, mode, tool });
			if (metrics.observed !== (mode === "fallback" ? "full" : mode) || Number(metrics.maxPremultipliedDiff) > 2) {
				throw new Error(`Render path or pixel oracle failed (mode=${metrics.observed}, premultiplied difference=${metrics.maxPremultipliedDiff}, pixels=${metrics.differentPixels})`);
			}
		} else {
			const { roomId, users } = await createRoomWithUsers(config, ["Profile A", "Profile B"]);
			await seed(config, roomId, scenario.scale, !(scenario.id.startsWith("draw-dense") || ["draw-ring", "draw-transfer"].includes(scenario.id)), scenario.id === "clear-undo-large");
			if (scenario.id.startsWith("join-") && scenario.scale > 0) {
				let inputBeforeInit = false;
				let strokesFinishedBeforeInit = 0;
				let sentDuringGate = 0;
				const measured = await openMeasuredRoomPage(browser, config, users[0]!, async page => {
					observe(page);
					if (scenario.id === "join-gate") await page.addInitScript(() => {
						const original = Worker.prototype.postMessage;
						Worker.prototype.postMessage = function(message: unknown, ...rest: unknown[]) {
							if ((message as { type?: string })?.type === "init-scene-barrier") {
								setTimeout(() => (original as (...args: unknown[]) => void).apply(this, [message, ...rest]), 1500);
								return;
							}
							return (original as (...args: unknown[]) => void).apply(this, [message, ...rest]);
						} as typeof original;
					});
					await start();
				},
					scenario.id === "join-gate" ? async page => {
						await page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ timeout: 10000 });
						await page.mouse.move(330, 270);
						await page.mouse.down();
						await page.mouse.move(455, 357, { steps: 6 });
						await page.mouse.up();
						await page.keyboard.press("Control+z");
						sentDuringGate = wire.filter(event => event.target === 0 && event.direction === "send" && event.type === "push-cmd").length;
					} : scenario.id === "join-100k-active" ? async page => {
						await page.locator("canvas").first().waitFor({ timeout: 30000 });
						await page.waitForFunction(() => (window as unknown as { __AEVIA_LAB__?: { marks: { name: string }[] } }).__AEVIA_LAB__?.marks.some(mark => mark.name === "aevia.init.meta"), undefined, { timeout: 10000 });
						inputBeforeInit = await page.evaluate(() => {
							const marks = (window as unknown as { __AEVIA_LAB__?: { marks: { name: string; detail?: { reason?: string } }[] } }).__AEVIA_LAB__?.marks ?? [];
							return !marks.some(mark => mark.name === "aevia.frame.render-complete" && mark.detail?.reason === "init-stream-final");
						});
						for (let i = 0; i < 5; i++) {
							await drawLine(page, 300, 200 + i * 20, 440, 250 + i * 20, 6);
							if (await page.evaluate(() => {
								const marks = (window as unknown as { __AEVIA_LAB__?: { marks: { name: string; detail?: { reason?: string } }[] } }).__AEVIA_LAB__?.marks ?? [];
								return !marks.some(mark => mark.name === "aevia.frame.render-complete" && mark.detail?.reason === "init-stream-final");
							})) strokesFinishedBeforeInit++;
						}
					} : undefined);
				closers.push(measured.close);
				if (scenario.id === "join-gate") {
					if (sentDuringGate) throw new Error(`Gate allowed ${sentDuringGate} operations`);
					await measured.page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 10000 });
					await drawLine(measured.page, 330, 270, 455, 357, 6);
					const deadlineAt = performance.now() + 5000;
					while (!wire.some(event => event.target === 0 && event.direction === "receive" && event.type === "ack.accepted")) {
						if (performance.now() >= deadlineAt) throw new Error("Post-gate stroke was not persisted");
						await delay(20);
					}
				}
				const reference = await openMeasuredRoomPage(browser, config, users[1]!);
				closers.push(reference.close);
				const diff = await compareCanvasPages(measured.page, reference.page);
				const rejectedEvents = wire.filter(event => event.target === 0 && event.direction === "receive" && event.type === "op-rejected");
				const rejected = rejectedEvents.length;
				const submitted = wire.filter(event => event.target === 0 && event.direction === "send" && event.type === "push-cmd").length;
				metrics = { ...measured.initialRender, finalDifference: diff.diffRatio, ...(scenario.id === "join-100k-active" ? { inputBeforeInit, strokesFinishedBeforeInit, submittedOperations: submitted, rejectedOperations: rejected, rejectionCodes: [...new Set(rejectedEvents.map(event => event.code ?? "unknown"))].join(",") } : {}) };
				if (scenario.id === "join-100k-active" && !inputBeforeInit) throw new Error("Input started after initialization; not a valid contention sample");
				if (scenario.id === "join-100k-active" && submitted === 0) throw new Error("No operation submitted during initialization; not a valid contention sample");
				if (scenario.id === "join-100k-active" && rejected) throw new Error(`Initialization-time operations rejected (${rejected}); not a valid contention sample`);
				if (typeof metrics.firstNonBlankMs !== "number" || metrics.firstNonBlankMs <= 0) throw new Error("Missing first visible content");
				if (diff.diffRatio > .005) throw new Error("Initial canvas does not match independently loaded room");
			} else if (scenario.id === "join-empty") {
				const started = performance.now();
				const room = await openRoomPage(browser, config, users[0]!, observe);
				closers.push(room.close);
				await start();
				await room.page.locator('button[title="形状与内容"]').waitFor({ timeout: 8000 });
				metrics = { navigationToEditableUiMs: performance.now() - started, blankRoom: true };
			} else if (scenario.id === "delta-reconnect") {
				const a = await openRoomPage(browser, config, users[0]!, async page => {
					observe(page);
					await page.addInitScript(() => {
						const sockets: WebSocket[] = [];
						(globalThis as unknown as { __profileSockets: WebSocket[] }).__profileSockets = sockets;
						window.WebSocket = new Proxy(window.WebSocket, {
							construct(target, args) {
								const socket = Reflect.construct(target, args) as WebSocket;
								if (new URL(socket.url).pathname === "/ws") sockets.push(socket);
								return socket;
							},
						});
					});
				});
				closers.push(a.close);
				await a.page.waitForFunction(() => (globalThis as unknown as { __profileSockets: WebSocket[] }).__profileSockets.some(socket => socket.readyState === WebSocket.OPEN), undefined, { timeout: 10000 }).catch(async error => {
					const snapshot = await a.page.evaluate(() => ({ sockets: (globalThis as unknown as { __profileSockets?: WebSocket[] }).__profileSockets?.map(s => ({ url: s.url, state: s.readyState })), webSocketName: WebSocket.name }));
					throw new Error(`${errorText(error)}: ${JSON.stringify(snapshot)}`);
				});
				const b = await openRoomPage(browser, config, users[1]!, observe);
				closers.push(b.close);
				const roi = { roi: roiAround(390, 310, 180), timeoutMs: 15000 };
				await waitForVisibleScreenshotBlank(a.page, roi);
				await drawLine(b.page, 850, 120, 970, 160, 8);
				await waitForVisibleScreenshotContent(a.page, { roi: roiAround(910, 140, 180), timeoutMs: 10000 });
				await start();
				const offlineAt = performance.now();
				await a.page.context().setOffline(true);
				await a.page.evaluate(() => {
					for (const socket of (globalThis as unknown as { __profileSockets: WebSocket[] }).__profileSockets) {
						if (socket.readyState === WebSocket.OPEN) socket.close(4001, "profile network interruption");
					}
				});
				await a.page.waitForFunction(() => (globalThis as unknown as { __profileSockets: WebSocket[] }).__profileSockets.every(socket => socket.readyState !== WebSocket.OPEN));
				const disconnectedAt = performance.now();
				await drawLine(b.page, 330, 270, 455, 357, 14);
				await waitForVisibleScreenshotContent(b.page, roi);
				await b.page.mouse.move(40, 500);
				const restoredAt = performance.now();
				await a.page.context().setOffline(false);
				await a.page.waitForFunction(() => (globalThis as unknown as { __profileSockets: WebSocket[] }).__profileSockets.some(socket => socket.readyState === WebSocket.OPEN), undefined, { timeout: 15000 });
				const connectedAt = performance.now();
				try {
					await waitForVisibleScreenshotContent(a.page, roi);
				} catch (error) {
					for (const [label, page] of [["observer", a.page], ["writer", b.page]] as const) {
						const filename = `${label}-reconnect-failure.png`;
						await page.screenshot({ path: path.join(dir, filename) });
						artifacts.push(filename);
					}
					const referenceUser = await joinRoom(config, roomId, "Reconnect reference");
					const reference = await openMeasuredRoomPage(browser, { ...config, labEnabled: false }, referenceUser);
					closers.push(reference.close);
					const filename = "reconnect-reference.png";
					await reference.page.screenshot({ path: path.join(dir, filename) });
					artifacts.push(filename);
					write(path.join(dir, "reconnect-diagnostic.json"), {
						observerBody: await a.page.locator("body").innerText(),
						writerToReference: await compareCanvasPages(b.page, reference.page),
						observerToReference: await compareCanvasPages(a.page, reference.page),
					});
					artifacts.push("reconnect-diagnostic.json");
					throw error;
				}
				const visibleAt = performance.now();
				const deadlineAt = performance.now() + 5000;
				while (!wire.some(event => event.target === 0 && event.t >= restoredAt && event.type === "delta-replay-complete") && performance.now() < deadlineAt) await delay(50);
				const delta = wire.filter(event => event.target === 0 && event.t >= restoredAt && event.type.startsWith("delta-replay-"));
				metrics = { offlineToSocketClosedMs: disconnectedAt - offlineAt, restoreToSocketOpenMs: connectedAt - restoredAt,
					restoreToVisibleMs: visibleAt - restoredAt, deltaMetaObserved: delta.some(event => event.type === "delta-replay-meta"),
					deltaCompleteObserved: delta.some(event => event.type === "delta-replay-complete") };
				if (!metrics.deltaMetaObserved || !metrics.deltaCompleteObserved) throw new Error("Delta replay was not observed");
			} else if (scenario.id === "clear-undo" || scenario.id === "clear-undo-large") {
				const open = scenario.id === "clear-undo-large" ? (user: typeof users[number]) => openMeasuredRoomPage(browser, config, user, async page => observe(page)) : (user: typeof users[number]) => openRoomPage(browser, config, user, observe);
				const [a, b] = await Promise.all([open(users[0]!), open(users[1]!) ]);
				closers.push(a.close, b.close);
				const first = { roi: roiAround(350, 260, 120), timeoutMs: 10000 };
				const second = { roi: roiAround(800, 360, 120), timeoutMs: 10000 };
				const historical = { roi: { x: 35, y: 35, width: 125, height: 85 }, timeoutMs: 10000 };
				if (scenario.id === "clear-undo-large") await Promise.all([a.page, b.page].map(page => waitForVisibleScreenshotContent(page, historical)));
				await drawLine(a.page, 300, 230, 400, 290, 12);
				await drawLine(b.page, 750, 330, 850, 390, 12);
				await Promise.all([a.page, b.page].flatMap(page => [waitForVisibleScreenshotContent(page, first), waitForVisibleScreenshotContent(page, second)]));
				// The screenshot oracle sees remote cursors as well as canvas pixels.
				// Move both cursors away from the inspected regions before clearing.
				await Promise.all([a.page.mouse.move(40, 500), b.page.mouse.move(60, 500)]);
				await start();
				const eraser = a.page.locator("button").filter({ has: a.page.locator("svg.lucide-eraser") }).first();
				await eraser.click();
				await eraser.click();
				const slider = a.page.locator(".slider-track");
				await slider.waitFor({ state: "visible" });
				const bounds = await slider.boundingBox();
				if (!bounds) throw new Error("Clear slider is unavailable");
				const beganAt = performance.now();
				await a.page.mouse.move(bounds.x + 20, bounds.y + bounds.height / 2);
				await a.page.mouse.down();
				await a.page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 12 });
				await a.page.mouse.up();
				const releasedAt = performance.now();
				const observations = await Promise.all([a.page, b.page].flatMap(page => [first, second].map(async region => {
					const result = await waitForVisibleScreenshotBlank(page, region);
					return { ...result, completedAt: performance.now() };
				})));
				const clearedAt = performance.now();
				if (scenario.id === "clear-undo-large") await Promise.all([a.page, b.page].map(page => waitForVisibleScreenshotBlank(page, historical)));
				await Promise.all([a.page.reload(), b.page.reload()]);
				await Promise.all([a.page, b.page].flatMap(page => [waitForVisibleScreenshotBlank(page, first), waitForVisibleScreenshotBlank(page, second)]));
				await Promise.all([a.page, b.page].map(page => page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 10000 })));
				const refreshedAt = performance.now();
				await pressUndo(a.page);
				await Promise.all([a.page, b.page].flatMap(page => [waitForVisibleScreenshotContent(page, first), waitForVisibleScreenshotContent(page, second)]));
				if (scenario.id === "clear-undo-large") await Promise.all([a.page, b.page].map(page => waitForVisibleScreenshotContent(page, historical)));
				const clearAck = wire.find(event => event.target === 0 && event.t >= beganAt && event.type === "ack.accepted");
				metrics = { sliderGestureMs: releasedAt - beganAt, clearToBothBlankMs: clearedAt - beganAt,
					clearReleaseToBothBlankMs: clearedAt - releasedAt,
					clearLocalFirstRegionObservedMs: observations[0]!.completedAt - releasedAt,
					clearLocalSecondRegionObservedMs: observations[1]!.completedAt - releasedAt,
					clearRemoteFirstRegionObservedMs: observations[2]!.completedAt - releasedAt,
					clearRemoteSecondRegionObservedMs: observations[3]!.completedAt - releasedAt,
					blankObservationSamples: observations.reduce((sum, item) => sum + item.frames + 1, 0),
					refreshToBothBlankMs: refreshedAt - clearedAt, undoToBothVisibleMs: performance.now() - refreshedAt };
				if (clearAck) metrics.firstAckAfterSliderStartMs = clearAck.t - beganAt;
			} else if (scenario.id === "edit-text" || scenario.id === "edit-sticky") {
				const room = await openRoomPage(browser, config, users[0]!, observe);
				closers.push(room.close);
				await room.page.locator('button[title="形状与内容"]').click();
				await room.page.getByRole("button", { name: scenario.id === "edit-text" ? "文字" : "便签", exact: true }).click();
				const roi = roiAround(440, 275, 300);
				await waitForVisibleScreenshotBlank(room.page, { roi, timeoutMs: 8000 });
				await start();
				const beganAt = performance.now();
				await drawLine(room.page, 300, 200, 660, 350, 8);
				const editor = room.page.getByRole("dialog", { name: "文字编辑器" });
				await editor.waitFor({ state: "visible" });
				const editorReadyAt = performance.now();
				await editor.locator("textarea").fill("性能测试 Aevia 123\n多行文本与换行");
				const beforeCommit = performance.now();
				await editor.getByRole("button", { name: "完成" }).click();
				await editor.waitFor({ state: "hidden" });
				await waitForVisibleScreenshotContent(room.page, { roi, timeoutMs: 10000 });
				const visibleAt = performance.now();
				const observer = await openMeasuredRoomPage(browser, { ...config, labEnabled: false }, users[1]!);
				closers.push(observer.close);
				const diff = await compareCanvasPages(room.page, observer.page);
				metrics = { createToEditorMs: editorReadyAt - beganAt, inputMs: beforeCommit - editorReadyAt,
					commitToEditorHiddenAndContentObservedMs: visibleAt - beforeCommit, replayDifference: diff.diffRatio };
				if (diff.diffRatio > .005) throw new Error("Text or sticky replay canvas mismatch");
			} else if (scenario.id === "edit-history" || scenario.id === "switch-page") {
				const room = await openRoomPage(browser, config, users[0]!, observe);
				closers.push(room.close);
				const roi = roiAround(390, 310);
				const pixel = { roi, timeoutMs: 8000 };
				await drawLine(room.page, 330, 270, 455, 357, 14);
				await waitForVisibleScreenshotContent(room.page, pixel);
				await start();
				const beganAt = performance.now();
				if (scenario.id === "edit-history") await pressUndo(room.page);
				else await Promise.all([waitForPageChangeComplete(room.page), room.page.locator('button[title="新建页面"]').click()]);
				await waitForVisibleScreenshotBlank(room.page, pixel);
				const blankAt = performance.now();
				if (scenario.id === "edit-history") await pressRedo(room.page);
				else await Promise.all([waitForPageChangeComplete(room.page), room.page.locator('button[title="上一页"]').click()]);
				await waitForVisibleScreenshotContent(room.page, pixel);
				metrics = { actionToBlankMs: blankAt - beganAt, restoreToPixelsMs: performance.now() - blankAt };
			} else if (scenario.id === "rejoin") {
				const room = await openMeasuredRoomPage(browser, config, users[0]!, async page => { observe(page); await start(); });
				closers.push(room.close);
				const observer = await openMeasuredRoomPage(browser, { ...config, labEnabled: false }, users[1]!);
				closers.push(observer.close);
				const beganAt = performance.now();
				await room.page.reload();
				await waitForStableCanvas(room.page, { roi: { x: 0, y: 0, ...small }, timeoutMs: 10000 });
				const diff = await compareCanvasPages(room.page, observer.page);
				metrics = { reloadToComparedPixelsMs: performance.now() - beganAt, difference: diff.diffRatio };
				if (diff.diffRatio > .005) throw new Error("Refresh canvas mismatch");
			} else {
				const transportCase = scenario.id === "draw-ring" || scenario.id === "draw-transfer";
				const open = scenario.id === "draw-dense-ready" || transportCase
					? (user: typeof users[number]) => openMeasuredRoomPage(browser, config, user, async page => {
						observe(page);
						if (transportCase) await page.addInitScript((disableRing) => {
							if (disableRing) Object.defineProperty(globalThis, "SharedArrayBuffer", { value: undefined, configurable: true });
							const original = Worker.prototype.postMessage;
							const counters = { ring: 0, transfer: 0 };
							(globalThis as unknown as { __profileTransport: typeof counters }).__profileTransport = counters;
							Worker.prototype.postMessage = function(message: unknown, ...rest: unknown[]) {
								const type = (message as { type?: string })?.type;
								if (type === "scene-batch-ring") counters.ring++;
								if (type === "scene-batch-transfer") counters.transfer++;
								return (original as (...args: unknown[]) => void).apply(this, [message, ...rest]);
							} as typeof original;
						}, scenario.id === "draw-transfer");
					})
					: (user: typeof users[number]) => openRoomPage(browser, config, user, observe);
				const [a, b] = await Promise.all([open(users[0]!), open(users[1]!)]);
				closers.push(a.close, b.close);
				const applications = scenario.id === "draw-solo" ? [a.page] : [a.page, b.page];
				if (transportCase) await Promise.all(applications.map(page => page.evaluate(() => {
					const counters = (globalThis as unknown as { __profileTransport: { ring: number; transfer: number } }).__profileTransport;
					counters.ring = 0;
					counters.transfer = 0;
				})));
				await start();
				const total = 40;
				const sessions = await Promise.all(applications.map(page => page.context().newCDPSession(page)));
				const started = performance.now(), lateness: number[] = [];
				await Promise.all(sessions.map(async (session, actor) => {
					const requests: Promise<unknown>[] = [];
					const post = async (due: number, type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, down: boolean) => {
						await delay(Math.max(0, due - performance.now()));
						lateness.push(Math.max(0, performance.now() - due));
						requests.push(session.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left",
							buttons: down ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }).catch(error => error));
					};
					for (let i = 0; i < total; i++) {
						const due = started + 120 * i + 30 * actor;
						const x = scenario.id === "draw-distributed" ? 140 + (i % 7) * 140 : 340 + (i * 73 % 330);
						const y = scenario.id === "draw-distributed" ? 100 + Math.floor(i / 7) * 83 : 200 + (i * 97 % 260);
						await post(due, "mousePressed", x, y, true);
						for (let step = 1; step <= 6; step++) await post(due + step * 15, "mouseMoved", x + step * 19, y + step * 11, true);
						await post(due + 104, "mouseReleased", x + 114, y + 66, false);
					}
					const posted = await Promise.all(requests);
					const failed = posted.find(result => result instanceof Error);
					if (failed) throw failed;
					await session.detach();
				}));
				const lastInput = performance.now();
				const fullRoi = { x: 0, y: 0, ...small };
				await Promise.all([a.page, b.page].map(async page => {
					await installCanvasObserver(page);
					await waitForStableCanvas(page, { roi: fullRoi, timeoutMs: 8000, stableFrames: 12 });
				}));
				const stableObservationMs = performance.now() - lastInput;
				const viewer = await joinRoom(config, roomId, "Profile replay");
				const replay = await openMeasuredRoomPage(browser, { ...config, labEnabled: false }, viewer);
				closers.push(replay.close);
				const deadlineAt = performance.now() + 8000;
				let difference = 1;
				do {
					const results = await Promise.all([a.page, b.page].map(page => compareCanvasPages(page, replay.page)));
					difference = Math.max(...results.map(result => result.diffRatio));
					if (difference <= .005) break;
					await delay(200);
				} while (performance.now() < deadlineAt);
				metrics = { requestedStrokes: total * applications.length, inputWindowMs: lastInput - started,
					maxInjectionLateMs: Math.max(...lateness), stableObservationMs, replayComparisonMs: performance.now() - lastInput, difference,
					converged: difference <= .005 };
				if (transportCase) {
					const channels = await Promise.all(applications.map(page => page.evaluate(() =>
						(globalThis as unknown as { __profileTransport: { ring: number; transfer: number } }).__profileTransport)));
					metrics.ringBatches = channels.reduce((sum, channel) => sum + channel.ring, 0);
					metrics.transferBatches = channels.reduce((sum, channel) => sum + channel.transfer, 0);
					if ((scenario.id === "draw-ring" && (!metrics.ringBatches || metrics.transferBatches)) ||
						(scenario.id === "draw-transfer" && (!metrics.transferBatches || metrics.ringBatches))) {
						throw new Error("Observed Worker transport differs from the requested channel");
					}
				}
				const transport = wireMetrics(wire.filter(event => event.t >= started));
				metrics.acceptedOperations = transport.committed;
				metrics.matchedJsonSubmissions = transport.submitted;
				if (transport.lastAccepted !== undefined) metrics.lastAckAfterInputMs = transport.lastAccepted - lastInput;
				if (transport.acknowledgements.length) metrics.medianSendToAckMs = median(transport.acknowledgements);
				if (transport.remoteDeliveries.length) metrics.medianSendToRemoteMessageMs = median(transport.remoteDeliveries);
				if (transport.committed < total * applications.length) throw new Error("Insufficient durable acknowledgements for the scheduled strokes");
				if (!metrics.converged) throw new Error("Canvas did not converge to the late-join replay");
			}
		}
	} catch (error) {
		failure = errorText(error);
	} finally {
		if (wire.length) {
			write(path.join(dir, "wire.json"), { events: wire, dropped: wireDropped, ...wireMetrics(wire) });
			artifacts.push("wire.json");
		}
		if (clock.length && services.profileControl) {
			try {
				clock.push(await services.profileControl("end", windowId));
				const goFile = fs.readFileSync(path.join(services.profileDirectory!, windowId + ".json"), "utf8");
				const spans = JSON.parse(goFile) as { rows: Span[] | null; dropped: number };
				write(path.join(dir, "go-spans.json"), { ...spans, clock, summary: summarizeSpans(spans.rows ?? []) });
				if (spans.dropped) issues.push(`Go events dropped: ${spans.dropped}`);
				artifacts.push("go-spans.json");
			} catch (error) { issues.push(errorText(error)); }
		}
		// Preserve evidence from the original attempt even when the page crashes.
		const results = await Promise.allSettled([stopBrowser && deadline(stopBrowser(), 12000), stopGo && deadline(stopGo(), 24000)]);
		for (const result of results) {
			if (result.status === "rejected") issues.push(errorText(result.reason));
			else if (result.value) { issues.push(...result.value.issues); artifacts.push(...result.value.artifacts); }
		}
		if (collector === "spans") for (const [index, page] of pages.entries()) {
			try {
				const realms = [page, ...page.workers()];
				const values = await deadline(Promise.all(realms.map(async (realm, target) => {
					const beforeMs = performance.now();
					const remoteMs = await realm.evaluate(() => performance.now());
					const afterMs = performance.now();
					return { target, clock: { remoteMs, beforeMs, afterMs }, data: await realm.evaluate(() =>
						(globalThis as unknown as { __aeviaDiagnosticSpans?: unknown }).__aeviaDiagnosticSpans ?? null) };
				})), 3000);
				const name = `page-${index}-spans.json`;
				const realmsWithSummary = values.map(value => {
					const data = value.data as { rows: Array<[string, number, number]>; dropped: number } | null;
					if (data?.dropped) issues.push(`Browser target ${value.target} events dropped: ${data.dropped}`);
					return { ...value, summary: summarizeSpans(data?.rows.map(([name, startMs, endMs]) => ({ name, startMs, endMs })) ?? []) };
				});
				type PhaseEntry = [string, number, number, { epoch?: number; first?: number; id?: string }?];
				const apply = new Map<string, { start?: number; end?: number }>();
				const correlation: Array<{ id: string; queueLowMs: number; queueHighMs: number; workerElapsedMs: number }> = [];
				const key = (detail: NonNullable<PhaseEntry[3]>) => `${detail.epoch}:${detail.first}:${detail.id}`;
				const browserRows = (target: number) => (values[target]?.data as { rows?: PhaseEntry[] } | null)?.rows ?? [];
				for (let target = 1; target < values.length; target++) {
					apply.clear();
					for (const [event, t,, detail] of browserRows(target)) {
						if (!detail?.id || !["worker.apply.start", "worker.apply.done"].includes(event)) continue;
						const id = key(detail);
						const record = apply.get(id) ?? {};
						apply.set(id, event.endsWith("start") ? { ...record, start: t } : { ...record, end: t });
					}
					const main = values[0]!.clock, worker = values[target]!.clock;
					const uncertainty = (main.afterMs - main.beforeMs + worker.afterMs - worker.beforeMs) / 2;
					const offset = (worker.beforeMs + worker.afterMs - main.beforeMs - main.afterMs) / 2 - worker.remoteMs + main.remoteMs;
					for (const [event, t,, detail] of browserRows(0)) {
						if (event !== "worker.enqueued" || !detail?.id) continue;
						const matched = apply.get(key(detail));
						if (matched?.start === undefined || matched.end === undefined || matched.end < matched.start) continue;
						const center = matched.start + offset - t;
						if (center + uncertainty < 0) continue;
						correlation.push({ id: detail.id, queueLowMs: Math.max(0, center - uncertainty), queueHighMs: center + uncertainty,
							workerElapsedMs: matched.end - matched.start });
					}
				}
				write(path.join(dir, name), { realms: realmsWithSummary, correlation, lab: await deadline(captureLabSnapshot(page), 3000) });
				if (metrics && correlation.length) {
					metrics.matchedWorkerOperations = Number(metrics.matchedWorkerOperations ?? 0) + correlation.length;
					metrics.longestWorkerOperationMs = Math.max(Number(metrics.longestWorkerOperationMs ?? 0), ...correlation.map(row => row.workerElapsedMs));
					metrics.longestWorkerQueueLowerBoundMs = Math.max(Number(metrics.longestWorkerQueueLowerBoundMs ?? 0), ...correlation.map(row => row.queueLowMs));
					// Keep the two bounds paired; the upper bound belongs to the same
					// operation as the worst lower bound, rather than another sample.
					const longest = correlation.reduce((a, b) => b.queueLowMs > a.queueLowMs ? b : a);
					if (longest.queueLowMs >= Number(metrics.worstQueueLowerBoundMs ?? -1)) {
						metrics.worstQueueLowerBoundMs = longest.queueLowMs;
						metrics.worstQueueUpperBoundMs = longest.queueHighMs;
					}
				}
				artifacts.push(name);
			} catch (error) { issues.push(errorText(error)); }
		}
		await Promise.allSettled(closers.map(close => deadline(close(), 3000)));
	}
	return { iteration: 0, metrics, issues: [...issues, ...crashes], artifacts, error: failure ?? crashes[0] };
}

const escape = (input: unknown) => String(input ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const format = (number: number) => number.toFixed(2);
function summarize(group: Group) {
	const metrics: Record<string, { median: number; min: number; max: number; n: number }> = {};
	const successful = group.samples.filter(sample => sample.iteration > 0 && !sample.error && sample.metrics);
	for (const key of new Set(successful.flatMap(sample => Object.keys(sample.metrics!)))) {
		const values = successful.map(sample => sample.metrics![key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		if (values.length) metrics[key] = { median: median(values), min: Math.min(...values), max: Math.max(...values), n: values.length };
	}
	return metrics;
}

export async function runDiagnostics(root: string, setup: Setup) {
	const options = new Map(process.argv.slice(2).flatMap(arg => {
		const match = arg.match(/^--([^=]+)=(.*)$/);
		return match ? [[match[1]!, match[2]!] as const] : [];
	}));
	const set = options.get("set") ?? "core", mode = options.get("collector") ?? "baseline", caseId = options.get("case");
	if (!["smoke", "core", "all"].includes(set) || !(mode === "all" || collectors.includes(mode as Collector))) throw new Error("Invalid --set or --collector");
	if (caseId && !["dense-pair", "decision", "brushes", "text-tools", "transport-pair", "join-contention"].includes(caseId) && !list.some(item => item.id === caseId)) throw new Error(`Unknown profiling case: ${caseId}`);
	const cases = list.filter(item => caseId ? caseId === "join-contention" ? ["join-100k", "join-100k-active"].includes(item.id) : caseId === "transport-pair" ? ["draw-ring", "draw-transfer"].includes(item.id) : caseId === "text-tools" ? ["edit-text", "edit-sticky"].includes(item.id) : caseId === "brushes" ? ["render-pencil", "render-highlighter"].includes(item.id) : caseId === "decision" ? ["join-100k", "draw-dense", "draw-dense-ready"].includes(item.id) : caseId === "dense-pair" ? ["draw-dense", "draw-dense-ready"].includes(item.id) : item.id === caseId :
		set === "smoke" ? ["join-10k", "render-dirty"].includes(item.id) :
			set === "core" ? ["join-10k", "join-50k", "join-100k", "render-direct", "render-dirty", "render-fallback", "draw-dense", "draw-dense-ready"].includes(item.id) : true);
	const modes = mode === "all" ? collectors : mode === "baseline" ? ["baseline"] as const : ["baseline", mode as Collector] as const;
	const runId = randomUUID(), out = path.join(root, "tests", "reports", "profile", runId);
	const source = readSourceIdentity(root);
	fs.mkdirSync(out, { recursive: true });
	const groups: Group[] = [];
	const environment = { platform: process.platform, cpu: os.cpus()[0]?.model, node: process.version, chromium: "", viewport: small, dpr: 1, seedVersion: 1 };
	const results = () => groups.map(group => ({ ...group, summary: summarize(group) }));
	const manifest = () => ({ schemaVersion: 1, runId, source: { revision: source.revision, dirtyPatchSha256: source.dirtyPatchSha256 },
		environment, cases, modes, groups: results() });
	const config = path.join(root, "tests/profile/vite.config.ts");
	let browser: Browser | undefined;
	console.log(`Profile ${runId} · ${out}`);
	try {
		browser = await launchProfileBrowser();
		environment.chromium = browser.version();
		// Reuse the normal build for browser/runtime profilers. Only span collection instruments the build.
		for (const spans of [false, true]) {
			const selected = modes.filter(collector => (collector === "spans") === spans);
			if (!selected.length) continue;
			process.env.AEVIA_PROFILE_SPANS = spans ? "1" : "0";
			const controlDir = spans ? path.join(out, "go-control") : undefined;
			const goOverlay = controlDir ? createOverlay(root, controlDir) : undefined;
			const services = { ...await setup({ outDir: path.join(out, spans ? "span-build" : "build"), pprof: selected.some(collector => collector !== "baseline"), viteConfig: config, goOverlay, controlDir }),
				profileDirectory: controlDir };
			try {
				for (const collector of selected) {
					if (collector === "cpu" || collector === "timeline") {
						await browser.close();
						browser = await launchProfileBrowser();
					}
					for (const scenario of cases) {
					const group: Group = { caseId: scenario.id, collector, samples: [] };
					groups.push(group);
					const sampled = set !== "smoke" && (collector === "baseline" || collector === "spans");
					const total = sampled ? 5 : 1;
					for (let iteration = sampled ? 0 : 1; iteration <= total; iteration++) {
						const relative = path.join(scenario.id, collector, String(iteration));
						const dir = path.join(out, relative);
						fs.mkdirSync(dir, { recursive: true });
						console.log(`${scenario.id} ${collector} · ${iteration === 0 ? "warmup" : iteration}`);
						const sample = await deadline(runSample(browser, services, scenario, collector, dir), 120000)
							.catch(error => ({ issues: [], artifacts: [], error: errorText(error), iteration }));
						if (sample.error) console.log(sample.error);
						group.samples.push({ ...sample, iteration, artifacts: sample.artifacts.map(file => path.join(relative, file).replaceAll("\\", "/")) });
						write(path.join(out, "run-manifest.json"), manifest());
					}
					}
				}
			} finally { await services.stop(); }
		}
	} finally {
		await browser?.close();
		delete process.env.AEVIA_PROFILE_SPANS;
		const current = readSourceIdentity(root);
		const drift = source.revision !== current.revision || source.dirtyPatchSha256 !== current.dirtyPatchSha256;
		const data = { ...manifest(), sourceDrift: drift };
		write(path.join(out, "run-manifest.json"), data);
		const compare = options.get("compare");
		const previous = compare ? JSON.parse(fs.readFileSync(path.resolve(compare), "utf8")) as typeof data : undefined;
		const comparable = previous?.schemaVersion === data.schemaVersion && !previous.sourceDrift && !drift &&
			JSON.stringify(previous.environment) === JSON.stringify(data.environment);
		const sections = data.groups.map(group => {
			const preceding = comparable ? previous?.groups.find(item => item.caseId === group.caseId && item.collector === group.collector)?.summary : undefined;
			const baseline = data.groups.find(item => item.caseId === group.caseId && item.collector === "baseline")?.summary;
			let rows = "";
			for (const [key, value] of Object.entries(group.summary)) {
				const old = preceding?.[key]?.median;
				const control = baseline?.[key]?.median;
				const count = group.summary.acceptedOperations?.median, baselineCount = baseline?.acceptedOperations?.median;
				const workloadChanged = count && baselineCount && Math.abs(count / baselineCount - 1) > .1;
				const overhead = group.collector !== "baseline" && key.endsWith("Ms") && control && (value.n < 5 || workloadChanged || Math.abs(value.median / control - 1) > .1);
				rows += `<tr><td>${escape(key)}</td><td>${format(value.median)}</td><td>${format(value.min)} – ${format(value.max)}</td><td>${value.n}</td><td>${old ? format((1 - value.median / old) * 100) + "%" : "—"}</td><td>${overhead ? "仅用于定位" : ""}</td></tr>`;
			}
			const render = group.summary.renderMs?.median, readback = group.summary.readbackMs?.median;
			let bound = "现有观测不足以构造完整依赖图，剩余等待保留为未归因。";
			if (render !== undefined && readback !== undefined) {
				const stages = [{ id: "render", ms: render, after: [] }, { id: "readback", ms: readback, after: ["render"] }];
				const saved = criticalPath(stages, "readback").ms - criticalPath(stages, "readback", "render").ms;
				bound = `在此隔离测量的串行调用中，将 Canvas 绘制调用时间全部移除，最多省 ${format(saved)} ms，假定像素同步成本不变。`;
			}
			const samples = group.samples.map(sample => {
				const ranks = sample.artifacts.flatMap(file => {
					const name = path.basename(file);
					const full = path.join(out, file);
					if (name.endsWith("-bottom-up.json")) {
						const entries = (JSON.parse(fs.readFileSync(full, "utf8")) as Array<{ name: string; selfMs: number; totalMs: number; heaviestStack: string[] }>)
							.filter(entry => !/^\((idle|program|root)\)/.test(entry.name));
						return [`<details><summary>${escape(name)} · CPU 自身 / 含子调用</summary><ol>${entries.slice(0, 12).map(entry => `<li title="${escape(entry.heaviestStack.join(" → "))}">${escape(entry.name)} · ${format(entry.selfMs)} / ${format(entry.totalMs)} ms</li>`).join("")}</ol></details>`];
					}
					if (name === "go-spans.json" || name.endsWith("-spans.json")) {
						type Ranking = ReturnType<typeof summarizeSpans>;
						const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { summary?: Ranking; realms?: Array<{ target: number; summary: Ranking }> };
						const rankings = parsed.realms?.map(realm => ({ name: realm.target ? `Worker ${realm.target}` : "主线程", rows: realm.summary })) ??
							[{ name: "Go", rows: parsed.summary ?? [] }];
						return rankings.map(rank => `<details><summary>${escape(rank.name)} · 阶段累计耗时（含重叠）</summary><ol>${rank.rows.slice(0, 12).map(entry => `<li>${escape(entry.name)} · ${format(entry.inclusiveMs)} ms / ${entry.calls} 次 · 最长 ${format(entry.longestMs)} ms</li>`).join("")}</ol></details>`);
					}
					if (name === "go-cpu-top.txt") return [`<details><summary>Go CPU 热点</summary><pre>${escape(fs.readFileSync(full, "utf8").split("\n").slice(0, 20).join("\n"))}</pre></details>`];
					return [];
				});
				return `<li>${sample.iteration || "预热"} ${escape(sample.error ?? "")} ${escape(sample.issues.join(" · "))} ${sample.artifacts.map(file => `<a href="${escape(file)}">${escape(path.basename(file))}</a>`).join(" · ")}${ranks.join("")}</li>`;
			}).join("");
			return `<details open><summary>${escape(group.caseId)} · ${escape(group.collector)}</summary><table><tr><th>指标</th><th>中位数</th><th>范围</th><th>样本</th><th>对比耗时降幅</th><th>采集影响</th></tr>${rows}</table><p>${escape(bound)}</p><ul>${samples}</ul></details>`;
		}).join("");
		fs.writeFileSync(path.join(out, "report.html"), `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Aevia 性能剖析</title><style>body{max-width:1080px;margin:36px auto;padding:0 20px;font:15px system-ui}details{padding:12px;margin:12px 0;border:1px solid #ddd}summary{font-weight:bold}table{border-collapse:collapse;width:100%}th,td{padding:6px;text-align:left;border-bottom:1px solid #eee}</style><h1>Aevia 性能剖析</h1><p>${escape(source.revision)} · ${escape(environment.chromium)} · <a href="run-manifest.json">运行清单</a></p><p>${drift ? "运行中源码发生变化。" : ""}${compare && !comparable ? "对照构建的条件不匹配。" : ""} 像素、工作线程和 CPU 采样使用各自的观测口径。跨进程未对应的时间保留为未归因。</p>${sections}</html>`);
		console.log(`Report: ${path.join(out, "report.html")}`);
		if (drift || groups.some(group => group.samples.some(sample => sample.error))) process.exitCode = 1;
	}
}
