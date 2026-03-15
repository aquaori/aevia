import { chromium, type Page, type Browser } from "playwright";
import { CONFIG, createRoom, joinRoom, WebSocketInjector } from "./utils";

export interface FullRenderReport {
	scale: number;
	injectTimeMs: number;
	payloadSizeKb: number;
	networkSyncMs: number;
	domReadyMs: number;
	pureRenderMs: number;
	totalPerceivedMs: number;
	throughputTps: number;
	memoryUsageMb: number; // 验证内存占用增长率
}

export const runFullRenderSuite = async (
	scale: number,
	browser: Browser,
	throttleCpu: boolean = false
): Promise<FullRenderReport> => {
	const roomId = String(Math.floor(100000 + Math.random() * 900000));
	await createRoom(roomId, `FullRender_${scale}`);

	// --- 阶段一：极速灌水 ---
	const injectors: WebSocketInjector[] = [];
	const WS_CLIENT_COUNT = 5;
	const pointsPerClient = Math.ceil(scale / WS_CLIENT_COUNT);

	for (let i = 0; i < WS_CLIENT_COUNT; i++) {
		const u = await joinRoom(roomId, `Bot_${i}`);
		if (!u) throw new Error("建 Bot 失败");
		const inj = new WebSocketInjector(roomId, `Bot_${i}`, u.token, u.userId);
		await inj.connect();
		injectors.push(inj);
	}

	const injStart = performance.now();
	await Promise.all(injectors.map((inj) => inj.injectPoints(pointsPerClient, 300))); // 线条断点 300
	const injEnd = performance.now();
	const injectTimeMs = injEnd - injStart;

	// 给服务端3秒缓冲消化
	await new Promise((r) => setTimeout(r, 3000));
	injectors.forEach((j) => j.close());

	// --- 阶段二：观测者进场提取指标 ---
	const observer = await joinRoom(roomId, "Observer");
	if (!observer) throw new Error("Observer joining failed");

	const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const page: Page = await context.newPage();

	// CDP 硬件降级
	if (throttleCpu) {
		const client = await context.newCDPSession(page);
		await client.send("Emulation.setCPUThrottlingRate", { rate: 4 }); // 4倍限速
	}

	let initPayloadBytes = 0;
	page.on("websocket", (ws) => {
		ws.on("framereceived", (frame) => {
			const str =
				typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
			if (str.includes('"type":"init"')) {
				initPayloadBytes = Buffer.byteLength(str, "utf8");
			}
		});
	});

	let renderTimeMs = 0;
	let actualPointsRendered = 0;
	let isRenderFired = false;

	const renderCompletePromise = new Promise<void>((resolve, reject) => {
		page.on("console", (msg) => {
			const text = msg.text();
			if (text.includes("[全量渲染完成]") && !text.includes("点数=0") && !isRenderFired) {
				isRenderFired = true;
				const match1 = text.match(/耗时=([\d\.]+)ms/);
				const match2 = text.match(/点数=(\d+)/);
				if (match1) renderTimeMs = parseFloat(match1[1]);
				if (match2) actualPointsRendered = parseInt(match2[1], 10);
				resolve();
			}
		});
		setTimeout(
			() => {
				if (!isRenderFired) reject(new Error("首次渲染等待超时"));
			},
			throttleCpu ? 120000 : 60000
		);
	});

	await page.goto(CONFIG.FRONTEND_URL);
	await page.evaluate(
		({ t, name }: { t: string; name: string }) => {
			sessionStorage.setItem(
				"user",
				JSON.stringify({ token: t, userId: "", username: name })
			);
			localStorage.setItem("wb_username", name);
		},
		{ t: observer.token, name: `Observer` }
	);

	const navStart = performance.now();
	await page.goto(`${CONFIG.FRONTEND_URL}/room`);

	await page.waitForSelector("canvas", { timeout: 30000 });
	const domReadyTime = performance.now();
	const domReadyMs = domReadyTime - navStart;

	await renderCompletePromise;
	const renderCompleteTime = performance.now();

	const totalPerceivedMs = renderCompleteTime - navStart;
	const networkSyncMs = totalPerceivedMs - renderTimeMs - domReadyMs;

	const payloadKb = initPayloadBytes / 1024;

	// 获取当下的内存状态 (限 Chromium 内核)
	const memUsage = await page.evaluate(() => {
		const memory = (window.performance as any).memory;
		return memory ? memory.usedJSHeapSize / (1024 * 1024) : 0;
	});

	await context.close();

	return {
		scale: scale,
		injectTimeMs,
		payloadSizeKb: Number(payloadKb.toFixed(2)),
		networkSyncMs: Math.max(0, networkSyncMs),
		domReadyMs,
		pureRenderMs: renderTimeMs,
		totalPerceivedMs,
		throughputTps: actualPointsRendered / (renderTimeMs / 1000),
		memoryUsageMb: Number(memUsage.toFixed(2)),
	};
};
