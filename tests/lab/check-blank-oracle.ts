// Independent browser fixture: a single faint residual must fail the real blank oracle.
import fs from "node:fs";
import path from "node:path";
import { selectedBrowser, selectedBrowserType, resolveChromiumLaunchOptions } from "../browser-launch";
import { captureCanvasSample } from "../../apps/frontend/tests/e2e/external/canvas-observer";
import { waitForCanvasRegionBlank } from "../../apps/frontend/tests/e2e/external/suites";
import { ROOM_RENDER_MEASUREMENT_SCRIPT } from "../../apps/frontend/tests/e2e/external/ui-driver";

const main = async () => {
	const browser = await selectedBrowserType().launch({ headless: true, ...(selectedBrowser() === "chromium" ? resolveChromiumLaunchOptions() : {}) });
	try {
		const page = await browser.newPage();
		await page.setContent('<style>body{margin:0}canvas{display:block}</style><canvas width="100" height="100"></canvas>');
		await page.evaluate(() => { const ctx = document.querySelector("canvas")!.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 100, 100); });
		const region = { x: 0, y: 0, width: 100, height: 100 };
		await waitForCanvasRegionBlank(page, region, 1000);
		await page.evaluate(() => { const ctx = document.querySelector("canvas")!.getContext("2d")!; ctx.fillStyle = "#fafafa"; ctx.fillRect(40, 40, 1, 1); });
		const sample = await captureCanvasSample(page, region, { sampleSize: 100, nonBlankThreshold: 255 });
		let rejected = false;
		try { await waitForCanvasRegionBlank(page, region, 200); } catch { rejected = true; }
		const checks = [{ id: "blank", passed: true }, { id: "faint-residual", passed: rejected && sample.nonBlankRatio > 0 && sample.nonBlankRatio < 0.002 }];
		await page.evaluate(() => {
			const ctx = document.querySelector("canvas")!.getContext("2d")!;
			ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 100, 100);
			ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 10, 10);
			setTimeout(() => ctx.fillRect(20, 20, 10, 10), 250);
		});
		await page.evaluate(ROOM_RENDER_MEASUREMENT_SCRIPT({ timeoutMs: 5000, minNonBlankRatio: 0.0015, sampleSize: 100, stableFrames: 2, quietWindowMs: 500, waitForCollectionStop: false, maxDiffRatio: 0.0001 }));
		const stability = await page.evaluate(() => (window as unknown as { __externalRoomRenderMeasurement: Promise<{ visuallyStableMs: number; stabilityConfirmedMs: number }> }).__externalRoomRenderMeasurement);
		checks.push({ id: "staged-render", passed: stability.visuallyStableMs >= 200 && stability.stabilityConfirmedMs - stability.visuallyStableMs >= 500 });
		const report = { schemaVersion: 1, runId: process.env.AEVIA_TEST_RUN_ID, checks, residualRatio: sample.nonBlankRatio, stagedRenderStableMs: stability.visuallyStableMs, stagedRenderConfirmedMs: stability.stabilityConfirmedMs };
		const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
		if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
		console.log(JSON.stringify(report));
		if (checks.some(check => !check.passed)) throw new Error("Blank oracle accepted a faint residual");
	} finally { await browser.close(); }
};
main().catch(error => { console.error(error); process.exitCode = 1; });
