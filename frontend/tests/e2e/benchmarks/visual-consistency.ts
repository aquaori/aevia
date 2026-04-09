import path from "path";
import type { Browser, Page } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import {
	bootstrapRoomPage,
	compareCanvasDataUrls,
	createContextAndPage,
	createRoomWithUsers,
	getCanvasDataUrls,
	writeDataUrlPng,
} from "./suite-helpers";

export interface VisualConsistencyReport {
	lateJoinerMatched: boolean;
	concurrentCrossingMatched: boolean;
	undoRedoMatched: boolean;
	multiPageRevisitMatched: boolean;
	diffPixels: number;
	diffRatio: number;
	passThreshold: number;
	artifactPaths: string[];
}

const drawLine = async (
	page: Page,
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	steps = 20
) => {
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(endX, endY, { steps });
	await page.mouse.up();
};

const comparePageCanvases = async (pageA: Page, pageB: Page, artifactRoot?: string) => {
	const urlsA = await getCanvasDataUrls(pageA);
	const urlsB = await getCanvasDataUrls(pageB);
	const primaryA = urlsA[0] || "";
	const primaryB = urlsB[0] || "";
	const diffPath = artifactRoot ? path.join(artifactRoot, "canvas-diff.png") : undefined;
	const diff = compareCanvasDataUrls(primaryA, primaryB, diffPath);
	const artifacts: string[] = [];
	if (artifactRoot) {
		const aPath = path.join(artifactRoot, "canvas-a.png");
		const bPath = path.join(artifactRoot, "canvas-b.png");
		writeDataUrlPng(primaryA, aPath);
		writeDataUrlPng(primaryB, bPath);
		artifacts.push(aPath, bPath);
		if (diffPath) artifacts.push(diffPath);
	}
	return { diff, artifacts };
};

export const runVisualConsistencySuite = async (
	browser: Browser,
	throttleCpu = false,
	artifactDir?: string
): Promise<VisualConsistencyReport> => {
	const artifactPaths: string[] = [];

	const lateJoinerRoom = await createRoomWithUsers("VisualRoomLate", ["UserA1", "UserA2"]);
	const { context: contextA1, page: pageA1 } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(pageA1, { token: lateJoinerRoom.creds[0]!.token, userName: "UserA1" });
	await drawLine(pageA1, 200, 200, 400, 400);
	await drawLine(pageA1, 200, 400, 400, 200);
	await drawLine(pageA1, 300, 150, 300, 450);
	await pageA1.waitForTimeout(800);

	const { context: contextA2, page: pageA2 } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(pageA2, { token: lateJoinerRoom.creds[1]!.token, userName: "UserA2" });
	await pageA2.waitForTimeout(1200);
	const lateCompare = await comparePageCanvases(
		pageA1,
		pageA2,
		artifactDir ? path.join(artifactDir, "visual-late-joiner") : undefined
	);
	artifactPaths.push(...lateCompare.artifacts);
	const lateJoinerMatched = lateCompare.diff.diffRatio < lateCompare.diff.passThreshold;
	await contextA1.close();
	await contextA2.close();

	const crossingRoom = await createRoomWithUsers("VisualRoomCross", ["UserB1", "UserB2"]);
	const { context: contextB1, page: pageB1 } = await createContextAndPage(browser, throttleCpu);
	const { context: contextB2, page: pageB2 } = await createContextAndPage(browser, throttleCpu);
	await Promise.all([
		bootstrapRoomPage(pageB1, { token: crossingRoom.creds[0]!.token, userName: "UserB1" }),
		bootstrapRoomPage(pageB2, { token: crossingRoom.creds[1]!.token, userName: "UserB2" }),
	]);
	await Promise.all([
		drawLine(pageB1, 600, 300, 600, 500, 25),
		drawLine(pageB2, 500, 400, 700, 400, 25),
	]);
	await Promise.all([
		drawLine(pageB1, 500, 300, 700, 500, 25),
		drawLine(pageB2, 700, 300, 500, 500, 25),
	]);
	await pageB1.waitForTimeout(2000);
	await pageB2.waitForTimeout(2000);
	const crossingCompare = await comparePageCanvases(
		pageB1,
		pageB2,
		artifactDir ? path.join(artifactDir, "visual-crossing") : undefined
	);
	artifactPaths.push(...crossingCompare.artifacts);
	const concurrentCrossingMatched = crossingCompare.diff.diffRatio < crossingCompare.diff.passThreshold;

	await pageB1.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
	await pageB1.keyboard.press("KeyZ");
	await pageB1.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
	await pageB2.waitForTimeout(800);
	await pageB1.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
	await pageB1.keyboard.down("Shift");
	await pageB1.keyboard.press("KeyZ");
	await pageB1.keyboard.up("Shift");
	await pageB1.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
	await pageB2.waitForTimeout(800);
	const undoCompare = await comparePageCanvases(
		pageB1,
		pageB2,
		artifactDir ? path.join(artifactDir, "visual-undo-redo") : undefined
	);
	artifactPaths.push(...undoCompare.artifacts);
	const undoRedoMatched = undoCompare.diff.diffRatio < undoCompare.diff.passThreshold;

	await pageB1.keyboard.press("ArrowRight");
	await pageB1.keyboard.press("ArrowLeft");
	await pageB2.keyboard.press("ArrowRight");
	await pageB2.keyboard.press("ArrowLeft");
	await pageB1.waitForTimeout(1000);
	await pageB2.waitForTimeout(1000);
	const revisitCompare = await comparePageCanvases(
		pageB1,
		pageB2,
		artifactDir ? path.join(artifactDir, "visual-multi-page") : undefined
	);
	artifactPaths.push(...revisitCompare.artifacts);
	const multiPageRevisitMatched = revisitCompare.diff.diffRatio < revisitCompare.diff.passThreshold;

	await contextB1.close();
	await contextB2.close();

	return {
		lateJoinerMatched,
		concurrentCrossingMatched,
		undoRedoMatched,
		multiPageRevisitMatched,
		diffPixels: revisitCompare.diff.diffPixels,
		diffRatio: revisitCompare.diff.diffRatio,
		passThreshold: revisitCompare.diff.passThreshold,
		artifactPaths,
	};
};

export const collectVisualConsistencySample = async (
	browser: Browser,
	throttleCpu = false,
	artifactDir?: string
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runVisualConsistencySuite(browser, throttleCpu, artifactDir);
		return {
			status: "passed",
			durationMs: performance.now() - startedAt,
			metrics: {
				lateJoinerMatched: report.lateJoinerMatched,
				concurrentCrossingMatched: report.concurrentCrossingMatched,
				undoRedoMatched: report.undoRedoMatched,
				multiPageRevisitMatched: report.multiPageRevisitMatched,
				diffPixels: report.diffPixels,
				diffRatio: report.diffRatio,
				passThreshold: report.passThreshold,
			},
			artifacts: report.artifactPaths,
		};
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "visual consistency suite failed",
		};
	}
};
