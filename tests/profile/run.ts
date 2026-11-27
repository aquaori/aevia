import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { parseConfig } from "../../apps/frontend/tests/e2e/external/config";
import { compareCanvasPages, installCanvasObserver, roiAround, waitForBlankCanvas, waitForNonBlankCanvas, waitForStableCanvas, waitForVisibleScreenshotBlank, waitForVisibleScreenshotContent } from "../../apps/frontend/tests/e2e/external/canvas-observer";
import { captureLabSnapshot } from "../../apps/frontend/tests/e2e/external/lab/install";
import { createDistributedStrokePoints, createRoomWithUsers, joinRoom, ProtocolClient } from "../../apps/frontend/tests/e2e/external/protocol-driver";
import { drawLine, openMeasuredRoomPage, openRoomPage, pressRedo, pressUndo, waitForPageChangeComplete } from "../../apps/frontend/tests/e2e/external/ui-driver";
import { runMultiToolCollabWorkload, runSustainedStrokeWorkload, seedRichScene } from "../../apps/frontend/tests/e2e/external/sustained-workloads";
import { readSourceIdentity } from "../report/provenance";
import { resolveChromiumLaunchOptions } from "../browser-launch";
import { collectBrowser, collectGo, type Collector } from "./collectors";
import { createOverlay } from "./go-overlay";
import { criticalPath, summarizeSpans, wireMetrics, type Span, type TimelineSummary, type Wire } from "./analysis";

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
	{ id: "pending-refresh-recovery", scale: 0, module: "IndexedDB 实房断线刷新恢复", oracle: "未确认 opId 在刷新重连后按原 ID 持久化并收敛" },
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
	{ id: "tools-matrix", scale: 0, module: "完整工具链路（笔/铅/荧光/橡皮/图形/选择/文字/便签/历史）", oracle: "所有工具端到端提交且与新加入参考客户端像素一致" },
	{ id: "account-room-flow", scale: 0, module: "账号注册、房间设置、邀请、游客准入与踢出", oracle: "权限状态与 HTTP/WS 端到端行为一致" },
	{ id: "switch-page", scale: 0, module: "分页、流、画布", oracle: "新页空白，返回后原笔迹恢复" },
	{ id: "rejoin", scale: 10000, module: "快照、刷新恢复", oracle: "刷新前后画布一致" },
	{ id: "delta-reconnect", scale: 0, module: "断线检测、WebSocket、增量重连与画布", oracle: "断线期间远端画笔在重连后出现在本端" },
	{ id: "sustained-stroke", scale: 0, module: "长时连笔/高频短笔、Input、Vue、Worker、IndexedDB", oracle: "双端持续长连笔+高频短笔爆发不掉队，与新入房参考画布一致" },
	{ id: "multi-tool-collab-stress", scale: 0, module: "多工具高并发协同（钢笔/铅笔/荧光笔/图形/擦除/拖拽/文字/便签/历史）", oracle: "双端并发混合工具绘制后双方及新入房画布均收敛" },
	{ id: "rich-scene-join", scale: 12000, module: "混合图元/变换矩阵/擦除遮罩重型房间进房", oracle: "混合类型场景进房首屏稳定且与参考观察端像素一致" },
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
				.map(point => corner ? { ...point, x: .03 + point.x * .12, y: .12 + point.y * .12 } : distributed ? point : { ...point, x: .26 + point.x * .47, y: .2 + point.y * .48 });
			await client.sendCommittedStroke({ waitForCommit: true, points, color: "#21262e", size: 3 });
		}
	} finally { client.close(); }
}

async function runSample(
	browser: Browser,
	services: Services,
	scenario: Scenario,
	collector: Collector,
	dir: string,
	cpuThrottle = 1
): Promise<Sample> {
	// The existing Lab contract eagerly flushes some worker paints on live edits.
	const labArg = `--lab=${scenario.id.startsWith("join-") || scenario.id.startsWith("draw-dense") || ["draw-ring", "draw-transfer", "clear-undo-large", "rich-scene-join"].includes(scenario.id) ? "on" : "off"}`;
	const config = parseConfig([labArg, ...(cpuThrottle > 1 ? [`--cpu-throttle=${cpuThrottle}`] : [])]);
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
	const isLongWindow = scenario.id === "sustained-stroke" || scenario.id === "multi-tool-collab-stress";
	const start = async () => {
		stopBrowser = await collectBrowser(browser, pages, collector, dir, !scenario.id.startsWith("render-"), {
			durationMs: isLongWindow ? 25000 : scenario.id === "rich-scene-join" ? 12000 : 2500,
			bucketMs: isLongWindow ? 2500 : 5000,
			cpuThrottle,
		});
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
			if (scenario.id !== "rich-scene-join") {
				await seed(config, roomId, scenario.scale, !(scenario.id.startsWith("draw-dense") || ["draw-ring", "draw-transfer"].includes(scenario.id)), scenario.id === "clear-undo-large");
			}
			if (scenario.id === "rich-scene-join") {
				const seeded = await seedRichScene(config, roomId, scenario.scale);
				const measured = await openMeasuredRoomPage(browser, config, users[0]!, async page => {
					observe(page);
					await start();
				});
				closers.push(measured.close);
				const reference = await openMeasuredRoomPage(browser, { ...config, labEnabled: false }, users[1]!);
				closers.push(reference.close);
				const diff = await compareCanvasPages(measured.page, reference.page);
				metrics = {
					...measured.initialRender,
					seededElements: seeded.seededElements,
					seededPoints: seeded.seededPoints,
					transformedElements: seeded.transformedElements,
					erasedElements: seeded.erasedElements,
					replayDifference: diff.diffRatio,
				};
				if (diff.diffRatio > 0.015) throw new Error(`Rich scene join canvas mismatch (diff=${diff.diffRatio})`);
			} else if (scenario.id === "sustained-stroke") {
				const [a, b] = await Promise.all([openRoomPage(browser, config, users[0]!, observe), openRoomPage(browser, config, users[1]!, observe)]);
				closers.push(a.close, b.close);
				await start();
				const workload = await runSustainedStrokeWorkload({
					browser,
					config,
					roomId,
					pageA: a.page,
					pageB: b.page,
					longPhaseMs: 6000,
					shortPhaseStrokes: 24,
					viewport: small,
				});
				const transport = wireMetrics(wire);
				metrics = {
					...workload,
					acceptedOperations: transport.committed,
					matchedJsonSubmissions: transport.submitted,
					...(transport.acknowledgements.length ? { medianSendToAckMs: median(transport.acknowledgements) } : {}),
				};
				if (!workload.converged) throw new Error(`Sustained stroke canvas mismatch (diff=${workload.replayDifference})`);
			} else if (scenario.id === "multi-tool-collab-stress") {
				const [a, b] = await Promise.all([openRoomPage(browser, config, users[0]!, observe), openRoomPage(browser, config, users[1]!, observe)]);
				closers.push(a.close, b.close);
				await start();
				const workload = await runMultiToolCollabWorkload({
					browser,
					config,
					roomId,
					pageA: a.page,
					pageB: b.page,
					viewport: small,
				});
				const transport = wireMetrics(wire);
				metrics = {
					...workload,
					acceptedOperations: transport.committed,
					matchedJsonSubmissions: transport.submitted,
					...(transport.acknowledgements.length ? { medianSendToAckMs: median(transport.acknowledgements) } : {}),
				};
				if (!workload.converged) throw new Error(`Multi-tool collab stress mismatch (inter=${workload.interClientDiff}, replay=${workload.replayDifference})`);
			} else if (scenario.id.startsWith("join-") && scenario.scale > 0) {
				let inputBeforeInit = false;
				let strokesFinishedBeforeInit = 0;
				let sentDuringGate = 0;
				let gateReadyMs = 0;
				let postGateDrawWindowMs = 0;
				let remotePeer: Awaited<ReturnType<typeof openRoomPage>> | undefined;
				const joinStartedAt = performance.now();
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
						remotePeer = await openRoomPage(browser, config, users[1]!, observe);
						closers.push(remotePeer.close);
						await drawLine(remotePeer.page, 700, 220, 820, 320, 8);
						await page.mouse.move(330, 270);
						await page.mouse.down();
						await page.mouse.move(455, 357, { steps: 6 });
						await page.mouse.up();
						await page.keyboard.press("Control+z");
						sentDuringGate = wire.filter(event => event.target === 0 && event.direction === "send" && event.type === "push-cmd").length;
					} : scenario.id === "join-100k-active" ? async page => {
						await page.locator("canvas").first().waitFor({ timeout: 30000 });
						await page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 30000 });
						gateReadyMs = performance.now() - joinStartedAt;
						inputBeforeInit = await page.evaluate(() => {
							const marks = (window as unknown as { __AEVIA_LAB__?: { marks: { name: string; detail?: { reason?: string } }[] } }).__AEVIA_LAB__?.marks ?? [];
							return !marks.some(mark => mark.name === "aevia.frame.render-complete" && mark.detail?.reason === "init-stream-final");
						});
						const drawBegin = performance.now();
						for (let i = 0; i < 5; i++) {
							await drawLine(page, 300, 200 + i * 20, 440, 250 + i * 20, 6);
							if (await page.evaluate(() => {
								const marks = (window as unknown as { __AEVIA_LAB__?: { marks: { name: string; detail?: { reason?: string } }[] } }).__AEVIA_LAB__?.marks ?? [];
								return !marks.some(mark => mark.name === "aevia.frame.render-complete" && mark.detail?.reason === "init-stream-final");
							})) strokesFinishedBeforeInit++;
						}
						postGateDrawWindowMs = performance.now() - drawBegin;
					} : undefined);
				closers.push(measured.close);
				if (scenario.id === "join-gate") {
					if (sentDuringGate) throw new Error(`Gate allowed ${sentDuringGate} operations`);
					await measured.page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 10000 });
					await waitForNonBlankCanvas(measured.page, { roi: roiAround(760, 270, 140), timeoutMs: 10000 });
					await drawLine(measured.page, 330, 270, 455, 357, 6);
					const deadlineAt = performance.now() + 5000;
					while (!wire.some(event => event.target === 0 && event.direction === "receive" && event.type === "ack.accepted")) {
						if (performance.now() >= deadlineAt) throw new Error("Post-gate stroke was not persisted");
						await delay(20);
					}
				}
				const referenceUser = scenario.id === "join-gate" ? await joinRoom(config, roomId, "Gate reference") : users[1]!;
				const reference = await openMeasuredRoomPage(browser, config, referenceUser);
				closers.push(reference.close);
				await Promise.all([measured.page, reference.page].map(page =>
					page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 15000 })
				));
				const diff = await compareCanvasPages(measured.page, reference.page);
				const rejectedEvents = wire.filter(event => event.target === 0 && event.direction === "receive" && event.type === "op-rejected");
				const rejected = rejectedEvents.length;
				const submitted = wire.filter(event => event.target === 0 && event.direction === "send" && event.type === "push-cmd").length;
				metrics = { ...measured.initialRender, finalDifference: diff.diffRatio, ...(scenario.id === "join-100k-active" ? { postGateMode: true, gateReadyMs, postGateDrawWindowMs, inputBeforeInit, strokesFinishedBeforeInit, submittedOperations: submitted, rejectedOperations: rejected, rejectionCodes: [...new Set(rejectedEvents.map(event => event.code ?? "unknown"))].join(",") } : {}) };
				if (scenario.id === "join-100k-active" && submitted === 0) throw new Error("No operation submitted after initial-scene gate opened");
				if (scenario.id === "join-100k-active" && rejected) throw new Error(`Post-gate operations rejected (${rejected})`);
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
				const historical = { roi: { x: 40, y: 88, width: 145, height: 80 }, timeoutMs: 10000 };
				if (scenario.id === "clear-undo-large") await Promise.all([a.page, b.page].map(page => waitForNonBlankCanvas(page, historical)));
				await drawLine(a.page, 300, 230, 400, 290, 12);
				await drawLine(b.page, 750, 330, 850, 390, 12);
				await Promise.all([a.page, b.page].flatMap(page => [waitForNonBlankCanvas(page, first), waitForNonBlankCanvas(page, second)]));
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
					const result = await waitForBlankCanvas(page, region);
					return { ...result, completedAt: performance.now() };
				})));
				const clearedAt = performance.now();
				if (scenario.id === "clear-undo-large") await Promise.all([a.page, b.page].map(page => waitForBlankCanvas(page, historical)));
				const reloadedAt = performance.now();
				await Promise.all([a.page.reload(), b.page.reload()]);
				await Promise.all([a.page, b.page].map(page => page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 15000 })));
				await Promise.all([a.page, b.page].flatMap(page => [waitForBlankCanvas(page, first), waitForBlankCanvas(page, second)]));
				if (scenario.id === "clear-undo-large") {
					const historyDeadline = performance.now() + 15000;
					while ((!wire.some(event => event.target === 0 && event.t >= reloadedAt && event.type === "page-history-complete") ||
						!wire.some(event => event.target === 1 && event.t >= reloadedAt && event.type === "page-history-complete")) &&
						performance.now() < historyDeadline) {
						await delay(25);
					}
					if (!wire.some(event => event.target === 0 && event.t >= reloadedAt && event.type === "page-history-complete")) {
						throw new Error("Client A did not finish loading page history after reload");
					}
				}
				const refreshedAt = performance.now();
				await pressUndo(a.page);
				await Promise.all([a.page, b.page].flatMap(page => [waitForNonBlankCanvas(page, first), waitForNonBlankCanvas(page, second)]));
				let replayDifference = 0;
				if (scenario.id === "clear-undo-large") {
					await Promise.all([a.page, b.page].map(page => waitForNonBlankCanvas(page, historical)));
					const undoAckDeadline = performance.now() + 8000;
					while (!wire.some(event => event.target === 0 && event.t >= refreshedAt && event.type === "ack.accepted") && performance.now() < undoAckDeadline) {
						await delay(25);
					}
					if (!wire.some(event => event.target === 0 && event.t >= refreshedAt && event.type === "ack.accepted")) {
						throw new Error("Undo clear operation was not durably acknowledged");
					}
					const referenceUser = await joinRoom(config, roomId, "Clear undo reference");
					const reference = await openMeasuredRoomPage(browser, { ...config, labEnabled: false }, referenceUser);
					closers.push(reference.close);
					const compareDeadline = performance.now() + 8000;
					do {
						const results = await Promise.all([a.page, b.page].map(page => compareCanvasPages(page, reference.page)));
						replayDifference = Math.max(...results.map(result => result.diffRatio));
						if (replayDifference <= .005) break;
						await delay(200);
					} while (performance.now() < compareDeadline);
					if (replayDifference > .005) throw new Error(`Restored canvas does not match fresh replay (diff=${replayDifference})`);
				}
				const clearAck = wire.find(event => event.target === 0 && event.t >= beganAt && event.type === "ack.accepted");
				metrics = { sliderGestureMs: releasedAt - beganAt, clearToBothBlankMs: clearedAt - beganAt,
					clearReleaseToBothBlankMs: clearedAt - releasedAt,
					clearLocalFirstRegionObservedMs: observations[0]!.completedAt - releasedAt,
					clearLocalSecondRegionObservedMs: observations[1]!.completedAt - releasedAt,
					clearRemoteFirstRegionObservedMs: observations[2]!.completedAt - releasedAt,
					clearRemoteSecondRegionObservedMs: observations[3]!.completedAt - releasedAt,
					blankObservationSamples: observations.reduce((sum, item) => sum + item.frames + 1, 0),
					refreshToBothBlankMs: refreshedAt - clearedAt, undoToBothVisibleMs: performance.now() - refreshedAt,
					...(scenario.id === "clear-undo-large" ? { replayDifference } : {}) };
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
			} else if (scenario.id === "pending-refresh-recovery") {
				const room = await openRoomPage(browser, config, users[0]!, async page => {
					observe(page);
					await page.addInitScript(() => {
						const OriginalWS = window.WebSocket;
						const originalSend = OriginalWS.prototype.send;
						OriginalWS.prototype.send = function(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
							if (typeof data === "string" && sessionStorage.getItem("__aeviaDropNextPushCmd") === "1") {
								try {
									const parsed = JSON.parse(data) as { type?: string; data?: { id?: string; cmd?: { type?: string } } };
									if (parsed.type === "push-cmd" && parsed.data?.cmd?.type === "scene-op") {
										sessionStorage.removeItem("__aeviaDropNextPushCmd");
										(window as unknown as { __droppedOpId?: string }).__droppedOpId = parsed.data.id;
										setTimeout(() => this.close(4002, "simulate unacked offline close"), 20);
										return;
									}
								} catch { /* ignore non-json */ }
							}
							return originalSend.call(this, data);
						};
					});
				});
				closers.push(room.close);
				await room.page.evaluate(() => sessionStorage.setItem("__aeviaDropNextPushCmd", "1"));
				await start();
				const roi = roiAround(390, 310, 140);
				await drawLine(room.page, 330, 270, 455, 357, 10);
				const droppedAt = performance.now();
				await room.page.waitForFunction(() => Boolean((window as unknown as { __droppedOpId?: string }).__droppedOpId), undefined, { timeout: 5000 });
				const droppedOpId = await room.page.evaluate(() => (window as unknown as { __droppedOpId?: string }).__droppedOpId!);
				if (wire.some(event => event.target === 0 && event.direction === "receive" && event.type === "ack.accepted" && event.id === droppedOpId)) {
					throw new Error("Intercepted operation should not have been acknowledged before reload");
				}
				const reloadedAt = performance.now();
				await room.page.reload();
				await room.page.locator("canvas").first().waitFor({ timeout: 15000 });
				await room.page.locator('[role="status"]').filter({ hasText: "正在准备画布" }).waitFor({ state: "hidden", timeout: 15000 });
				const ackDeadline = performance.now() + 10000;
				while (!wire.some(event => event.target === 0 && event.t >= reloadedAt && event.direction === "receive" && event.type === "ack.accepted" && event.id === droppedOpId)) {
					if (performance.now() >= ackDeadline) throw new Error("Pending operation was not recovered and acknowledged after reload");
					await delay(25);
				}
				const ackEvent = wire.find(event => event.target === 0 && event.t >= reloadedAt && event.direction === "receive" && event.type === "ack.accepted" && event.id === droppedOpId)!;
				await waitForNonBlankCanvas(room.page, { roi, timeoutMs: 8000 });
				const reference = await openRoomPage(browser, { ...config, labEnabled: false }, users[1]!, observe);
				closers.push(reference.close);
				await waitForNonBlankCanvas(reference.page, { roi, timeoutMs: 8000 });
				const diff = await compareCanvasPages(room.page, reference.page);
				metrics = {
					dropToReloadMs: reloadedAt - droppedAt,
					reloadToRecoveredAckMs: ackEvent.t - reloadedAt,
					reloadToVisibleMs: performance.now() - reloadedAt,
					replayDifference: diff.diffRatio,
				};
				if (diff.diffRatio > .005) throw new Error(`Recovered pending canvas mismatch (diff=${diff.diffRatio})`);
			} else if (scenario.id === "tools-matrix") {
				const room = await openRoomPage(browser, config, users[0]!, observe);
				closers.push(room.close);
				const page = room.page;
				await start();
				const beganAt = performance.now();
				await drawLine(page, 120, 140, 220, 200, 10);
				const penDoneAt = performance.now();
				const penButton = page.locator("button").filter({ has: page.locator("svg.lucide-pen-tool, svg.lucide-pencil, svg.lucide-highlighter") }).first();
				await penButton.click();
				await page.getByRole("button", { name: "铅笔", exact: true }).click();
				await drawLine(page, 260, 140, 360, 200, 10);
				await penButton.click();
				await page.getByRole("button", { name: "荧光笔", exact: true }).click();
				await drawLine(page, 400, 140, 500, 200, 10);
				await page.locator('button[title="形状与内容"]').click();
				await page.getByRole("button", { name: "矩形", exact: true }).click();
				await page.keyboard.down("Shift");
				await drawLine(page, 560, 130, 660, 210, 8);
				await page.keyboard.up("Shift");
				const shapeDoneAt = performance.now();
				await page.locator("button").filter({ has: page.locator("svg.lucide-eraser") }).first().click();
				await drawLine(page, 150, 155, 190, 185, 6);
				await page.locator("button").filter({ has: page.locator("svg.lucide-mouse-pointer-2") }).first().click();
				await drawLine(page, 540, 110, 680, 230, 6);
				await drawLine(page, 600, 170, 640, 200, 6);
				const transformDoneAt = performance.now();
				await page.locator('button[title="形状与内容"]').click();
				await page.getByRole("button", { name: "文字", exact: true }).click();
				await drawLine(page, 200, 290, 440, 390, 8);
				const textEditor = page.getByRole("dialog", { name: "文字编辑器" });
				await textEditor.waitFor({ state: "visible" });
				await textEditor.locator("textarea").fill("工具矩阵 Aevia");
				await textEditor.getByRole("button", { name: "完成" }).click();
				await textEditor.waitFor({ state: "hidden" });
				await page.locator('button[title="形状与内容"]').click();
				await page.getByRole("button", { name: "便签", exact: true }).click();
				await drawLine(page, 520, 290, 740, 410, 8);
				await textEditor.waitFor({ state: "visible" });
				await textEditor.locator("textarea").fill("便签工具测试");
				await textEditor.getByRole("button", { name: "完成" }).click();
				await textEditor.waitFor({ state: "hidden" });
				await pressUndo(page);
				await pressRedo(page);
				await Promise.all([
					waitForNonBlankCanvas(page, { roi: roiAround(310, 170, 100), timeoutMs: 8000 }),
					waitForNonBlankCanvas(page, { roi: roiAround(450, 170, 100), timeoutMs: 8000 }),
					waitForNonBlankCanvas(page, { roi: roiAround(630, 180, 120), timeoutMs: 8000 }),
					waitForNonBlankCanvas(page, { roi: roiAround(300, 330, 140), timeoutMs: 8000 }),
					waitForNonBlankCanvas(page, { roi: roiAround(610, 340, 140), timeoutMs: 8000 }),
				]);
				const reference = await openRoomPage(browser, { ...config, labEnabled: false }, users[1]!, observe);
				closers.push(reference.close);
				await waitForNonBlankCanvas(reference.page, { roi: roiAround(610, 340, 140), timeoutMs: 8000 });
				const diff = await compareCanvasPages(page, reference.page);
				const transport = wireMetrics(wire.filter(event => event.t >= beganAt));
				metrics = {
					penMs: penDoneAt - beganAt,
					brushesAndShapeMs: shapeDoneAt - penDoneAt,
					eraseAndDragMs: transformDoneAt - shapeDoneAt,
					textStickyHistoryMs: performance.now() - transformDoneAt,
					acceptedOperations: transport.committed,
					replayDifference: diff.diffRatio,
				};
				if (diff.diffRatio > .005) throw new Error(`Tools matrix canvas mismatch (diff=${diff.diffRatio})`);
			} else if (scenario.id === "account-room-flow") {
				const startedAt = performance.now();
				const ownerUsername = `acct-${randomUUID().slice(0, 8)}`;
				const registerRes = await fetch(`${config.apiUrl}/v2/auth/register`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ username: ownerUsername, password: "profile-password", nickname: "Owner" }),
				});
				const registerJson = await registerRes.json() as { code?: number; data?: { token?: string; account?: { id: string; username: string; nickname: string } } };
				if (!registerRes.ok || registerJson.code !== 200 || !registerJson.data?.token || !registerJson.data.account) {
					throw new Error(`Account register failed: ${JSON.stringify(registerJson)}`);
				}
				const accountToken = registerJson.data.token;
				const account = registerJson.data.account;
				const ownedRoomId = String(Math.floor(100000 + Math.random() * 900000));
				const createRes = await fetch(`${config.apiUrl}/create-room`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountToken}` },
					body: JSON.stringify({ roomId: ownedRoomId, roomName: `Owned_${ownedRoomId}`, password: "" }),
				});
				if (!createRes.ok) throw new Error(`Owned create-room failed: ${createRes.status}`);
				const ownerJoinRes = await fetch(`${config.apiUrl}/v2/rooms/${ownedRoomId}/admission`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountToken}` },
					body: JSON.stringify({ roomId: ownedRoomId, password: "" }),
				});
				const ownerJoinJson = await ownerJoinRes.json() as { code?: number; data?: { sessionToken?: string; expiresAt?: number | null; userId?: string } };
				if (!ownerJoinRes.ok || !ownerJoinJson.data?.sessionToken) throw new Error("Owner admission failed");
				const ownerUser = { roomId: ownedRoomId, userName: account.nickname, token: ownerJoinJson.data.sessionToken, userId: ownerJoinJson.data.userId ?? account.id, expiresAt: ownerJoinJson.data.expiresAt ?? null };
				const ownerPage = await openRoomPage(browser, config, ownerUser, async page => {
					observe(page);
					await page.addInitScript((savedAccount) => {
						if (!localStorage.getItem("account")) {
							localStorage.setItem("account", JSON.stringify(savedAccount));
						}
					}, { token: accountToken, account });
				});
				closers.push(ownerPage.close);
				await start();
				const apiReadyAt = performance.now();
				await ownerPage.page.locator("button").filter({ hasText: "人协作中" }).click();
				await ownerPage.page.getByRole("button", { name: /房间设置/ }).click();
				const settingsDialog = ownerPage.page.getByRole("dialog", { name: "房间设置" });
				await settingsDialog.waitFor({ state: "visible" });
				await settingsDialog.locator("input").first().waitFor({ state: "visible" });
				await settingsDialog.getByRole("button", { name: "保存设置" }).click();
				await settingsDialog.waitFor({ state: "hidden" });
				const activeAccountToken = await ownerPage.page.evaluate(() => {
					const saved = localStorage.getItem("account");
					return saved ? (JSON.parse(saved) as { token?: string }).token ?? "" : "";
				}) || accountToken;
				const guest = await joinRoom(config, ownedRoomId, "Flow Guest");
				const guestClaims = JSON.parse(Buffer.from(guest.token.split(".")[1]!, "base64url").toString("utf8")) as { userId?: string };
				const guestUserId = guestClaims.userId || guest.userId;
				const guestPage = await openRoomPage(browser, config, { ...guest, userId: guestUserId }, observe);
				closers.push(guestPage.close);
				const kickRes = await fetch(`${config.apiUrl}/v2/rooms/${ownedRoomId}/guests/${encodeURIComponent(guestUserId)}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeAccountToken}` },
					body: JSON.stringify({ action: "kick" }),
				});
				if (!kickRes.ok) throw new Error(`Kick guest failed: ${kickRes.status}`);
				await guestPage.page.getByText("你已离开房间或访问权限已被房主移除。").waitFor({ timeout: 8000 });
				const revokedReview = await fetch(`${config.apiUrl}/get-page-review`, {
					headers: { Authorization: `Bearer ${guest.token}` },
				});
				if (revokedReview.status === 200) throw new Error("Revoked guest session token still allowed HTTP access");
				metrics = {
					registerCreateJoinMs: apiReadyAt - startedAt,
					settingsSaveKickRevokeMs: performance.now() - apiReadyAt,
					revokedHttpStatus: revokedReview.status,
				};
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
		if (collector === "timeline" && artifacts.includes("chromium-timeline-summary.json") && metrics) {
			try {
				const summary = JSON.parse(fs.readFileSync(path.join(dir, "chromium-timeline-summary.json"), "utf8")) as TimelineSummary;
				const byThread = new Map(summary.threads.map(row => [row.thread, row]));
				const main = byThread.get("Main"), worker = byThread.get("Worker"), gpu = byThread.get("GPU");
				metrics.timelineDurationMs = summary.durationMs;
				if (main) { metrics.mainBusyPct = main.busyPct; metrics.mainMaxTaskMs = main.maxMs; }
				if (worker) { metrics.workerBusyPct = worker.busyPct; metrics.workerMaxTaskMs = worker.maxMs; }
				if (gpu) { metrics.gpuBusyPct = gpu.busyPct; metrics.gpuMaxTaskMs = gpu.maxMs; }
				metrics.swapFps = summary.fps.swapFps;
				metrics.dropRatePct = summary.fps.dropRatePct;
			} catch (error) { issues.push(errorText(error)); }
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
				const correlation: Array<{ id: string; queueLowMs: number; queueHighMs: number; workerElapsedMs: number; wsSendToAckMs?: number; wsSendToRemoteMs?: number }> = [];
				const key = (detail: NonNullable<PhaseEntry[3]>) => `${detail.epoch}:${detail.first}:${detail.id}`;
				const browserRows = (target: number) => (values[target]?.data as { rows?: PhaseEntry[] } | null)?.rows ?? [];
				const wireSendById = new Map<string, number>();
				const wireAckById = new Map<string, number>();
				const wireRemoteById = new Map<string, number>();
				for (const event of wire) {
					if (!event.id) continue;
					if (event.target === index && event.direction === "send" && (event.type === "push-cmd" || event.type === "binary-scene-append") && !wireSendById.has(event.id)) {
						wireSendById.set(event.id, event.t);
					}
					if (event.target === index && event.direction === "receive" && event.type === "ack.accepted" && !wireAckById.has(event.id)) {
						wireAckById.set(event.id, event.t);
					}
					if (event.target !== index && event.direction === "receive" && event.type === "push-cmd" && !wireRemoteById.has(event.id)) {
						wireRemoteById.set(event.id, event.t);
					}
				}
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
						const sendT = wireSendById.get(detail.id);
						const ackT = wireAckById.get(detail.id);
						const remoteT = wireRemoteById.get(detail.id);
						correlation.push({
							id: detail.id,
							queueLowMs: Math.max(0, center - uncertainty),
							queueHighMs: center + uncertainty,
							workerElapsedMs: matched.end - matched.start,
							...(sendT !== undefined && ackT !== undefined && ackT >= sendT ? { wsSendToAckMs: ackT - sendT } : {}),
							...(sendT !== undefined && remoteT !== undefined && remoteT >= sendT ? { wsSendToRemoteMs: remoteT - sendT } : {}),
						});
					}
				}
				write(path.join(dir, name), { realms: realmsWithSummary, correlation, lab: await deadline(captureLabSnapshot(page), 3000) });
				if (metrics && correlation.length) {
					metrics.matchedWorkerOperations = Number(metrics.matchedWorkerOperations ?? 0) + correlation.length;
					metrics.longestWorkerOperationMs = Math.max(Number(metrics.longestWorkerOperationMs ?? 0), ...correlation.map(row => row.workerElapsedMs));
					metrics.longestWorkerQueueLowerBoundMs = Math.max(Number(metrics.longestWorkerQueueLowerBoundMs ?? 0), ...correlation.map(row => row.queueLowMs));
					const ackSamples = correlation.map(row => row.wsSendToAckMs).filter((v): v is number => v !== undefined);
					const remoteSamples = correlation.map(row => row.wsSendToRemoteMs).filter((v): v is number => v !== undefined);
					if (ackSamples.length) metrics.medianMatchedWsAckMs = median(ackSamples);
					if (remoteSamples.length) metrics.medianMatchedWsRemoteMs = median(remoteSamples);
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
	const cpuThrottle = Math.max(1, Number(options.get("cpu-throttle") || "1"));
	if (!["smoke", "core", "sustained", "all"].includes(set) || !(mode === "all" || collectors.includes(mode as Collector))) throw new Error("Invalid --set or --collector");
	if (caseId && !["dense-pair", "decision", "brushes", "text-tools", "transport-pair", "join-contention", "sustained-pair"].includes(caseId) && !list.some(item => item.id === caseId)) throw new Error(`Unknown profiling case: ${caseId}`);
	const cases = list.filter(item => caseId ? caseId === "join-contention" ? ["join-100k", "join-100k-active"].includes(item.id) : caseId === "transport-pair" ? ["draw-ring", "draw-transfer"].includes(item.id) : caseId === "text-tools" ? ["edit-text", "edit-sticky"].includes(item.id) : caseId === "brushes" ? ["render-pencil", "render-highlighter"].includes(item.id) : caseId === "decision" ? ["join-100k", "draw-dense", "draw-dense-ready"].includes(item.id) : caseId === "dense-pair" ? ["draw-dense", "draw-dense-ready"].includes(item.id) : caseId === "sustained-pair" ? ["sustained-stroke", "multi-tool-collab-stress", "rich-scene-join"].includes(item.id) : item.id === caseId :
		set === "smoke" ? ["join-10k", "render-dirty"].includes(item.id) :
			set === "sustained" ? ["sustained-stroke", "multi-tool-collab-stress", "rich-scene-join"].includes(item.id) :
				set === "core" ? ["join-10k", "join-50k", "join-100k", "render-direct", "render-dirty", "render-fallback", "draw-dense", "draw-dense-ready"].includes(item.id) : true);
	const modes = mode === "all" ? collectors : mode === "baseline" ? ["baseline"] as const : ["baseline", mode as Collector] as const;
	const runId = randomUUID(), out = path.join(root, "tests", "reports", "profile", runId);
	const source = readSourceIdentity(root);
	fs.mkdirSync(out, { recursive: true });
	const groups: Group[] = [];
	const environment = { platform: process.platform, cpu: os.cpus()[0]?.model, node: process.version, chromium: "", viewport: small, dpr: 1, seedVersion: 1, cpuThrottle };
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
						const sample = await deadline(runSample(browser, services, scenario, collector, dir, cpuThrottle), 180000)
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
					if (name === "chromium-timeline-summary.json") {
						const summary = JSON.parse(fs.readFileSync(full, "utf8")) as TimelineSummary & { topHotspots?: Array<{ thread: string; rows: Array<{ name: string; selfMs: number; totalMs: number }> }> };
						const threadRows = summary.threads.map(t => `<tr><td>${escape(t.thread)}</td><td>${format(t.busyPct)}%</td><td>${format(t.p50Ms)} / ${format(t.p95Ms)} / ${format(t.maxMs)} ms</td><td>${t.over16_7ms}</td></tr>`).join("");
						const bucketRows = summary.buckets.map(b => `${b.bucketStartS}-${b.bucketEndS}s: Main ${format(b.mainBusyPct)}%(max ${format(b.mainMaxMs)}ms) · Worker ${format(b.workerBusyPct)}%(max ${format(b.workerMaxMs)}ms) · GPU ${format(b.gpuBusyPct)}%`).join("\n");
						const hotspotList = (summary.topHotspots ?? []).map(h => `<p><strong>${escape(h.thread)} Top Hotspots:</strong> ${h.rows.slice(0, 5).map(r => `${escape(r.name)} (${format(r.selfMs)}ms)`).join(" · ")}</p>`).join("");
						return [`<details open><summary>Chromium Timeline 剖析 · Swap ${format(summary.fps.swapFps)} FPS · 掉帧率 ${format(summary.fps.dropRatePct)}% (${summary.fps.pipelineDroppedSmoothness}/${summary.fps.pipelineTotal})</summary><table><tr><th>线程</th><th>Busy%</th><th>Task P50/P95/Max</th><th>&gt;16.7ms</th></tr>${threadRows}</table><pre>${escape(bucketRows)}</pre>${hotspotList}</details>`];
					}
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
