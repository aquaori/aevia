import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage, createRoomWithUsers } from "./suite-helpers";

export interface MicroRenderReport {
	microAppRenderMs: number;
	microVisiblePaintMs: number;
	microPoints: number;
	microCostPerPoint: number;
}

export const runMicroRenderSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<MicroRenderReport> => {
	const { creds } = await createRoomWithUsers("MicroRenderRoom", ["MicroUser"]);
	const { context, page } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(page, { token: creds[0]!.token, userName: "MicroUser" });
	const report = await page.evaluate(async () => {
		const runMicroRender = (window as any).__benchmarkRunMicroRender as
			| (() => Promise<MicroRenderReport>)
			| undefined;
		if (!runMicroRender) {
			throw new Error("benchmark micro runner unavailable");
		}
		return runMicroRender();
	});

	await context.close();
	return report;
};

export const collectMicroRenderSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runMicroRenderSuite(browser, throttleCpu);
		return { status: "passed", durationMs: performance.now() - startedAt, metrics: report };
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "micro render suite failed",
		};
	}
};
