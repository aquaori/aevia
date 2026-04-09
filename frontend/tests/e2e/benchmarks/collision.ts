import type { Browser, Page } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import {
	bootstrapRoomPage,
	compareCanvasDataUrls,
	createContextAndPage,
	createRoomWithUsers,
	getCanvasDataUrls,
	readBenchmarkRuntime,
} from "./suite-helpers";

export interface CollisionReport {
	collisionTriggerDetected: boolean;
	dirtyRedrawCount: number;
	convergedVisually: boolean;
	settleTimeMs: number;
}

const drawLine = async (
	page: Page,
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	steps = 15
) => {
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	for (let i = 1; i <= steps; i += 1) {
		const progress = i / steps;
		await page.mouse.move(startX + (endX - startX) * progress, startY + (endY - startY) * progress);
		await page.waitForTimeout(20);
	}
	await page.mouse.up();
};

export const runCollisionSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<CollisionReport> => {
	const { creds } = await createRoomWithUsers("CollisionAuto", ["UserA", "UserB"]);
	const { context: contextA, page: pageA } = await createContextAndPage(browser, throttleCpu);
	const { context: contextB, page: pageB } = await createContextAndPage(browser, throttleCpu);

	await Promise.all([
		bootstrapRoomPage(pageA, { token: creds[0]!.token, userName: "UserA" }),
		bootstrapRoomPage(pageB, { token: creds[1]!.token, userName: "UserB" }),
	]);

	let collisionTriggerDetected = false;
	const watchConsole = (msg: any) => {
		const text = msg.text();
		if (text.includes("需要重绘") || text.includes("接收到重绘事件") || text.includes("局部重绘完成")) {
			collisionTriggerDetected = true;
		}
	};
	pageA.on("console", watchConsole);
	pageB.on("console", watchConsole);

	const startedAt = performance.now();
	await Promise.all([
		drawLine(pageA, 500, 300, 700, 400),
		drawLine(pageB, 700, 300, 500, 400),
	]);
	await pageA.waitForTimeout(2500);
	await pageB.waitForTimeout(2500);
	const settleTimeMs = performance.now() - startedAt;

	const [runtimeA, runtimeB, canvasAList, canvasBList] = await Promise.all([
		readBenchmarkRuntime(pageA),
		readBenchmarkRuntime(pageB),
		getCanvasDataUrls(pageA),
		getCanvasDataUrls(pageB),
	]);

	await contextA.close();
	await contextB.close();

	const [canvasA] = canvasAList;
	const [canvasB] = canvasBList;
	const diff = canvasA && canvasB ? compareCanvasDataUrls(canvasA, canvasB) : null;

	return {
		collisionTriggerDetected,
		dirtyRedrawCount: Math.max(runtimeA?.lastDirtyRedraw?.count || 0, runtimeB?.lastDirtyRedraw?.count || 0),
		convergedVisually: diff ? diff.diffRatio < diff.passThreshold : false,
		settleTimeMs,
	};
};

export const collectCollisionSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runCollisionSuite(browser, throttleCpu);
		return {
			status: "passed",
			durationMs: performance.now() - startedAt,
			metrics: report,
		};
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "collision suite failed",
		};
	}
};
