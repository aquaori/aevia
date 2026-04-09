import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import {
	bootstrapRoomPage,
	compareCanvasDataUrls,
	createContextAndPage,
	createRoomWithUsers,
	getCanvasDataUrls,
	readBenchmarkRuntime,
} from "./suite-helpers";

export interface UndoRedoReport {
	undoMedianMs: number;
	redoMedianMs: number;
	catchUpMsAfterUndo: number;
	visualConsistentAfterUndo: boolean;
}

export const runUndoRedoSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<UndoRedoReport> => {
	const { creds } = await createRoomWithUsers("UndoRedoRoom", ["UndoA", "UndoB"]);
	const { context: contextA, page: pageA } = await createContextAndPage(browser, throttleCpu);
	const { context: contextB, page: pageB } = await createContextAndPage(browser, throttleCpu);
	await Promise.all([
		bootstrapRoomPage(pageA, { token: creds[0]!.token, userName: "UndoA" }),
		bootstrapRoomPage(pageB, { token: creds[1]!.token, userName: "UndoB" }),
	]);

	for (let i = 0; i < 8; i += 1) {
		await pageA.mouse.move(150 + i * 20, 150 + i * 12);
		await pageA.mouse.down();
		await pageA.mouse.move(260 + i * 12, 220 + i * 14, { steps: 6 });
		await pageA.mouse.up();
	}
	await pageB.waitForTimeout(1200);

	const undoDurations: number[] = [];
	for (let i = 0; i < 4; i += 1) {
		const startedAt = performance.now();
		await pageA.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
		await pageA.keyboard.press("KeyZ");
		await pageA.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
		await pageB.waitForTimeout(350);
		undoDurations.push(performance.now() - startedAt);
	}

	const redoDurations: number[] = [];
	for (let i = 0; i < 4; i += 1) {
		const startedAt = performance.now();
		await pageA.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
		await pageA.keyboard.down("Shift");
		await pageA.keyboard.press("KeyZ");
		await pageA.keyboard.up("Shift");
		await pageA.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
		await pageB.waitForTimeout(350);
		redoDurations.push(performance.now() - startedAt);
	}

	const [runtimeA, runtimeB, canvasesA, canvasesB] = await Promise.all([
		readBenchmarkRuntime(pageA),
		readBenchmarkRuntime(pageB),
		getCanvasDataUrls(pageA),
		getCanvasDataUrls(pageB),
	]);

	await contextA.close();
	await contextB.close();

	const [canvasA] = canvasesA;
	const [canvasB] = canvasesB;
	const diff = canvasA && canvasB ? compareCanvasDataUrls(canvasA, canvasB) : null;
	const median = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		const middle = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0
			? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
			: (sorted[middle] ?? 0);
	};

	return {
		undoMedianMs: median(undoDurations),
		redoMedianMs: median(redoDurations),
		catchUpMsAfterUndo: Math.max(runtimeA?.lastUndo?.durationMs || 0, runtimeB?.lastUndo?.durationMs || 0),
		visualConsistentAfterUndo: diff ? diff.diffRatio < diff.passThreshold : false,
	};
};

export const collectUndoRedoSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runUndoRedoSuite(browser, throttleCpu);
		return { status: "passed", durationMs: performance.now() - startedAt, metrics: report };
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "undo redo suite failed",
		};
	}
};
