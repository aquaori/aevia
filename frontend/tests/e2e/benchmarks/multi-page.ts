import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage, createRoomWithUsers, readBenchmarkRuntime, sampleHeap } from "./suite-helpers";

export interface MultiPageReport {
	pageSwitchMs: number;
	previewRenderMs: number;
	pageCount: number;
	multiPageMemoryMb: number;
	pageSwitchVisualPass: boolean;
}

export const runMultiPageSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<MultiPageReport> => {
	const { creds } = await createRoomWithUsers("MultiPageRoom", ["Pager"]);
	const { context, page } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(page, { token: creds[0]!.token, userName: "Pager" });

	await page.keyboard.press("ArrowRight");
	await page.waitForTimeout(600);
	await page.keyboard.press("ArrowRight");
	await page.waitForTimeout(600);
	await page.keyboard.press("ArrowLeft");
	await page.waitForTimeout(600);

	const runtime = await readBenchmarkRuntime(page);
	const heap = await sampleHeap(page);
	await context.close();

	return {
		pageSwitchMs: Number(runtime?.lastPageSwitch?.durationMs || 0),
		previewRenderMs: Number(runtime?.lastFullRender?.durationMs || 0),
		pageCount: Number(runtime?.totalPages || 1),
		multiPageMemoryMb: Number(heap?.lastUsedMb || 0),
		pageSwitchVisualPass: Number(runtime?.lastPageSwitch?.durationMs || 0) >= 0,
	};
};

export const collectMultiPageSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runMultiPageSuite(browser, throttleCpu);
		return { status: "passed", durationMs: performance.now() - startedAt, metrics: report };
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "multi page suite failed",
		};
	}
};
