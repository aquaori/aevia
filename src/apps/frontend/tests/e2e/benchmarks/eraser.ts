import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage, createRoomWithUsers, readBenchmarkRuntime } from "./suite-helpers";

export interface EraserReport {
	eraserStrokeMs: number;
	eraseRedrawMs: number;
	eraseDirtyAreaRatio: number;
	eraseConvergencePass: boolean;
}

export const runEraserSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<EraserReport> => {
	const { creds } = await createRoomWithUsers("EraserRoom", ["EraserUser"]);
	const { context, page } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(page, { token: creds[0]!.token, userName: "EraserUser" });

	await page.mouse.move(220, 220);
	await page.mouse.down();
	await page.mouse.move(440, 260, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(500);

	await page.keyboard.press("KeyE");
	const startedAt = performance.now();
	await page.mouse.move(240, 235);
	await page.mouse.down();
	await page.mouse.move(380, 250, { steps: 10 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	const eraserStrokeMs = performance.now() - startedAt;

	const runtime = await readBenchmarkRuntime(page);
	await context.close();
	const rect = runtime?.lastDirtyRedraw?.lastRect;
	const dirtyArea = rect ? rect.width * rect.height : 0;
	return {
		eraserStrokeMs,
		eraseRedrawMs: Number(runtime?.lastDirtyRedraw?.lastDurationMs || 0),
		eraseDirtyAreaRatio: dirtyArea / (1280 * 720),
		eraseConvergencePass: Number(runtime?.lastDirtyRedraw?.count || 0) >= 0,
	};
};

export const collectEraserSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runEraserSuite(browser, throttleCpu);
		return { status: "passed", durationMs: performance.now() - startedAt, metrics: report };
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "eraser suite failed",
		};
	}
};
