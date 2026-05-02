import path from "path";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { dateTag, parseConfig } from "./config";
import { ensureDir, writeReports } from "./reporter";
import type { CaseResult, EnvironmentId, ExternalConfig, RunMode, SuiteContext } from "./types";
import {
	runCorrectnessFull,
	runCorrectnessSmoke,
	runHarnessHealth,
	runPerformanceExternal,
} from "./suites";

const launchBrowser = async (mode: RunMode, gpu: "on" | "off"): Promise<Browser> => {
	const launchOptions: LaunchOptions = {
		headless: mode === "headless",
		channel: "chrome",
	};
	if (gpu === "off") {
		launchOptions.args = [
			"--disable-gpu",
			"--disable-gpu-compositing",
			"--disable-gpu-rasterization",
			"--disable-accelerated-2d-canvas",
		];
	}
	return chromium.launch(launchOptions);
};

const runSuite = async (context: SuiteContext): Promise<CaseResult[]> => {
	if (context.config.suite === "harness-health") {
		return runHarnessHealth(context);
	}
	if (context.config.suite === "correctness-smoke") {
		return runCorrectnessSmoke(context);
	}
	if (context.config.suite === "correctness-full") {
		return runCorrectnessFull(context);
	}
	if (context.config.suite === "performance-external") {
		return runPerformanceExternal(context);
	}
	throw new Error(`Unsupported suite: ${context.config.suite}`);
};

const matrixEnvironment = (
	config: ExternalConfig,
	environment: EnvironmentId
): ExternalConfig => ({
	...config,
	environment,
	gpu: environment.startsWith("noGpu") ? "off" : "on",
	cpuThrottle: environment.endsWith("cpuLow") ? 4 : 1,
});

const runWithBrowser = async (config: ExternalConfig, reportRoot: string, artifactRoot: string) => {
	const browser = await launchBrowser(config.mode, config.gpu);
	try {
		return await runSuite({ browser, config, reportRoot, artifactRoot });
	} finally {
		await browser.close();
	}
};

const main = async () => {
	const config = parseConfig(process.argv.slice(2));
	const reportRoot = path.join(config.reportDir, dateTag());
	const artifactRoot = path.join(reportRoot, "artifacts");
	ensureDir(artifactRoot);

	let results: CaseResult[] = [];
	if (config.suite === "performance-external" && config.matrix) {
		const environments: EnvironmentId[] = ["gpu_cpuHigh", "gpu_cpuLow", "noGpu_cpuHigh", "noGpu_cpuLow"];
		for (const environment of environments) {
			const envConfig = matrixEnvironment(config, environment);
			console.log(
				`[external-e2e] environment=${environment} mode=${envConfig.mode} gpu=${envConfig.gpu} cpuThrottle=${envConfig.cpuThrottle}`
			);
			results.push(...(await runWithBrowser(envConfig, reportRoot, artifactRoot)));
		}
	} else {
		results = await runWithBrowser(config, reportRoot, artifactRoot);
	}

	const reportPath = writeReports(reportRoot, config, results);
	const failed = results.filter((result) => result.status === "failed");
	console.log(`[external-e2e] wrote report: ${reportPath}`);
	console.log(`[external-e2e] passed=${results.length - failed.length} failed=${failed.length}`);
	if (failed.length > 0) {
		failed.forEach((result) => {
			console.error(`[external-e2e] ${result.id} failed (${result.failureType}): ${result.error || "unknown"}`);
		});
		process.exit(1);
	}
};

main().catch((error) => {
	console.error("[external-e2e] runner failed", error);
	process.exit(1);
});
