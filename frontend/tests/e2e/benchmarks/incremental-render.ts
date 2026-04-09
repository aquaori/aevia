import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage, createRoomWithUsers } from "./suite-helpers";

export interface IncrementalRenderReport {
	incrementalRenderMs: number;
	dirtyAreaPx: number;
	dirtyAreaRatio: number;
	pointsPerUpdate: number;
	renderCostPerPoint: number;
}

export const runIncrementalRenderSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<IncrementalRenderReport> => {
	const { creds } = await createRoomWithUsers("IncrementalRoom", ["IncrementalUser"]);
	const { context, page } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(page, { token: creds[0]!.token, userName: "IncrementalUser" });

	const canvas = page.locator("canvas").first();
	const box = await canvas.boundingBox();
	if (!box) throw new Error("canvas bounding box unavailable");

	await page.mouse.move(box.x + 220, box.y + 220);
	await page.mouse.down();
	await page.mouse.move(box.x + 260, box.y + 260, { steps: 4 });
	await page.mouse.up();
	await page.waitForFunction(
		() => {
			const runtime = (window as any).__benchmarkRuntime;
			return Number(runtime?.localInput?.lastRenderEndTs || 0) > 0;
		},
		undefined,
		{ timeout: 5000 }
	);

	const snapshot = await page.evaluate(() => {
		const runtime = (window as any).__benchmarkRuntime || {};
		const events = Array.isArray(runtime.events) ? [...runtime.events] : [];
		const fallbackIncrementalEvent = events
			.reverse()
			.find(
				(event: any) =>
					event?.name === "incremental-render-end" && event?.detail?.source === "local"
			);
		const fallbackPoints = Number(fallbackIncrementalEvent?.detail?.points || 0);
		const fallbackDurationMs = Number(fallbackIncrementalEvent?.detail?.durationMs || 0);
		const summary = runtime.lastIncrementalRender || null;
		return {
			lastDirtyRedraw: runtime.lastDirtyRedraw || null,
			incrementalRenderMs: Number(summary?.durationMs || fallbackDurationMs || 0),
			pointsPerUpdate: Number(summary?.points || fallbackPoints || 0),
		};
	});
	await context.close();

	const rect = snapshot?.lastDirtyRedraw?.lastRect;
	const dirtyAreaPxRaw = rect ? Number(rect.width) * Number(rect.height) : 0;
	const dirtyAreaPx = Number.isFinite(dirtyAreaPxRaw) ? dirtyAreaPxRaw : 0;
	const canvasArea = 1280 * 720;
	const incrementalRenderMs = Number(snapshot?.incrementalRenderMs || 0);
	const pointsPerUpdate = Number(snapshot?.pointsPerUpdate || 0);
	if (pointsPerUpdate <= 0) {
		throw new Error("incremental render metrics missing");
	}
	return {
		incrementalRenderMs,
		dirtyAreaPx,
		dirtyAreaRatio: canvasArea > 0 ? dirtyAreaPx / canvasArea : 0,
		pointsPerUpdate,
		renderCostPerPoint: pointsPerUpdate > 0 ? incrementalRenderMs / pointsPerUpdate : 0,
	};
};

export const collectIncrementalRenderSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runIncrementalRenderSuite(browser, throttleCpu);
		return { status: "passed", durationMs: performance.now() - startedAt, metrics: report };
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "incremental render suite failed",
		};
	}
};
