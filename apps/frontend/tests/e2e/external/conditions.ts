// Conditions describe comparability, not a claim that the developer host was idle.
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Browser } from "playwright";
import type { CaseResult, ExternalConfig, BaselineFile } from "./types";
import { selectedBrowser } from "../../../../../tests/browser-launch";
export type PerformanceConditions = { fingerprint: string; details: Record<string, unknown>; gpuObserved: boolean; freeMemoryRatio: number };
export const sameConditions = (a?: PerformanceConditions, b?: PerformanceConditions): boolean => Boolean(a?.gpuObserved && b?.gpuObserved && a.fingerprint === b.fingerprint);
export const collectConditions = async (browser: Browser, config: ExternalConfig): Promise<PerformanceConditions> => {
	let gpu: unknown = null;
	let gpuObserved = false;
	if (selectedBrowser() === "chromium") {
		const session = await browser.newBrowserCDPSession();
		try { const info = await session.send("SystemInfo.getInfo"); gpu = { devices: info.gpu.devices, features: info.gpu.featureStatus, renderer: info.gpu.auxAttributes?.glRenderer, vendor: info.gpu.auxAttributes?.glVendor, glVersion: info.gpu.auxAttributes?.glVersion, skiaBackend: info.gpu.auxAttributes?.skiaBackendType }; gpuObserved = true; }
		catch { /* Missing GPU provenance leaves performance inconclusive. */ }
		finally { await session.detach(); }
	}
	const workload = createHash("sha256");
	for (const file of ["suites.ts", "ui-driver.ts", "canvas-observer.ts", "cdp-observer.ts", "performance-observer.ts", "lab/contracts.ts", "lab/evaluate.ts", "lab/install.ts", "lab/policy.ts"]) workload.update(fs.readFileSync(new URL(file, import.meta.url)));
	const details = { version: 1, host: process.env.AEVIA_PERF_HOST_ID || os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, node: process.version, browser: selectedBrowser(), browserVersion: browser.version(), gpu, gpuMode: config.gpu, cpuThrottle: config.cpuThrottle, mode: config.mode, runs: config.runs, warmup: config.warmup, viewport: [1280, 720], measurementContract: 3, workload: workload.digest("hex") };
	return { fingerprint: createHash("sha256").update(JSON.stringify(details)).digest("hex"), details, gpuObserved, freeMemoryRatio: os.freemem() / os.totalmem() };
};
export const qualifyPerformanceResults = (results: CaseResult[], baseline: BaselineFile | null, mode = "confirmed"): void => {
	for (const result of results) {
		if (result.category !== "performance") continue;
		const reference = baseline?.cases[`${result.environment || "default"}::${result.id}`];
		const compatible = sameConditions(result.conditions, reference?.conditions);
		const budgetFailure = mode !== "none" && compatible && result.regression?.checks.some(check => (check.source === "budget" || mode === "all") && check.status === "failed");
		if (budgetFailure) { result.status = "failed"; result.failureType = "performance"; result.error = "Comparable performance threshold exceeded"; }
		result.performanceQualification = result.status === "failed" ? "failed" :
			mode === "none" || !compatible || !result.regression?.checks.some(check => check.source === "baseline") || !result.regression?.checks.some(check => check.source === "budget") || result.regression.status !== "passed" || result.learning?.status !== "normal" ? "inconclusive" : "passed";
	}
};
