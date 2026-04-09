import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage, createRoomWithUsers } from "./suite-helpers";

export interface MicroRenderReport {
	microRenderMs: number;
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
		const canvas = document.createElement("canvas");
		canvas.width = 1280;
		canvas.height = 720;
		const context = canvas.getContext("2d");
		if (!context) {
			return { microRenderMs: 0, microPoints: 0, microCostPerPoint: 0 };
		}
		const module = await import("/src/service/canvas.ts");
		const points = Array.from({ length: 2000 }).map((_, index) => ({
			x: ((index % 100) + 20) / 1280,
			y: (Math.floor(index / 100) + 20) / 720,
			p: 0.6,
			cmdId: `micro-${Math.floor(index / 25)}`,
			color: "#111111",
			size: 3,
			tool: "pen",
			isDeleted: false,
		}));
		const startedAt = performance.now();
		module.renderPageContentFromPoints(context, 1280, 720, points as any);
		const microRenderMs = performance.now() - startedAt;
		return {
			microRenderMs,
			microPoints: points.length,
			microCostPerPoint: points.length > 0 ? microRenderMs / points.length : 0,
		};
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
