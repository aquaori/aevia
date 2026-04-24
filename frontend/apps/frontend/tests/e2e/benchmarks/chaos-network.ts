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

export interface ChaosReport {
	recoveryMode: "latency" | "latency-bandwidth" | "offline-recover" | "hide-resume";
	catchUpMs: number;
	fullyRecovered: boolean;
	commandsConsistent: boolean;
	visualConsistent: boolean;
}

type ChaosMode = ChaosReport["recoveryMode"];

const drawLine = async (page: Page, startX: number, startY: number, endX: number, endY: number) => {
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(endX, endY, { steps: 20 });
	await page.mouse.up();
};

const getDigest = async (page: Page) => {
	const runtime = await readBenchmarkRuntime(page);
	return runtime?.lastCommandDigest || "";
};

const applyChaosMode = async (mode: ChaosMode, client: any, page: Page) => {
	await client.send("Network.enable");
	switch (mode) {
		case "latency":
			await client.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 500,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
			break;
		case "latency-bandwidth":
			await client.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 500,
				downloadThroughput: (50 * 1024) / 8,
				uploadThroughput: (50 * 1024) / 8,
			});
			break;
		case "offline-recover":
			await client.send("Network.emulateNetworkConditions", {
				offline: true,
				latency: 0,
				downloadThroughput: 0,
				uploadThroughput: 0,
			});
			break;
		case "hide-resume":
			await page.evaluate(() => {
				Object.defineProperty(document, "hidden", {
					configurable: true,
					get: () => true,
				});
			});
			await client.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 400,
				downloadThroughput: (80 * 1024) / 8,
				uploadThroughput: (80 * 1024) / 8,
			});
			break;
	}
};

const restoreNetwork = async (mode: ChaosMode, client: any, page: Page) => {
	await client.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: -1,
	});
	if (mode === "hide-resume") {
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				get: () => false,
			});
		});
	}
};

export const runChaosSuite = async (
	browser: Browser,
	throttleCpu = false,
	mode: ChaosMode = "latency"
): Promise<ChaosReport> => {
	const { creds } = await createRoomWithUsers("ChaosRoom", ["StableA", "PoorB"]);
	const { context: contextA, page: pageA } = await createContextAndPage(browser, throttleCpu);
	const { context: contextB, page: pageB } = await createContextAndPage(browser, throttleCpu);
	const clientB = await contextB.newCDPSession(pageB);

	await Promise.all([
		bootstrapRoomPage(pageA, { token: creds[0]!.token, userName: "StableA" }),
		bootstrapRoomPage(pageB, { token: creds[1]!.token, userName: "PoorB" }),
	]);

	await applyChaosMode(mode, clientB, pageB);

	const actionStart = performance.now();
	await drawLine(pageA, 100, 100, 320, 320);
	await pageA.waitForTimeout(300);
	const baselineDigest = await getDigest(pageA);

	if (mode === "offline-recover") {
		await pageB.waitForTimeout(1200);
		await restoreNetwork(mode, clientB, pageB);
	}

	let catchUpMs = 0;
	for (let i = 0; i < 50; i += 1) {
		await pageB.waitForTimeout(200);
		const digest = await getDigest(pageB);
		if (digest && digest === baselineDigest) {
			catchUpMs = performance.now() - actionStart;
			break;
		}
	}

	await restoreNetwork(mode, clientB, pageB);
	await pageB.waitForTimeout(800);

	const [digestA, digestB, canvasesA, canvasesB] = await Promise.all([
		getDigest(pageA),
		getDigest(pageB),
		getCanvasDataUrls(pageA),
		getCanvasDataUrls(pageB),
	]);

	await contextA.close();
	await contextB.close();

	const [canvasA] = canvasesA;
	const [canvasB] = canvasesB;
	const diff = canvasA && canvasB ? compareCanvasDataUrls(canvasA, canvasB) : null;

	return {
		recoveryMode: mode,
		catchUpMs,
		fullyRecovered: Boolean(catchUpMs) && digestA === digestB,
		commandsConsistent: Boolean(digestA) && digestA === digestB,
		visualConsistent: diff ? diff.diffRatio < diff.passThreshold : false,
	};
};

export const collectChaosSample = async (
	browser: Browser,
	throttleCpu = false,
	mode: ChaosMode = "latency"
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runChaosSuite(browser, throttleCpu, mode);
		return {
			status: "passed",
			durationMs: performance.now() - startedAt,
			metrics: report,
		};
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: { recoveryMode: mode },
			error: error?.message || "chaos suite failed",
		};
	}
};
