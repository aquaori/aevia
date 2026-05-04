import path from "path";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import {
	applyPerformanceRegressions,
	buildExternalReport,
	createBaselineFromResults,
	loadBaselineFile,
	loadBudgetFile,
	loadReportResults,
	writeBaselineFile,
} from "./baseline";
import { dateTag, parseConfig } from "./config";
import { buildLearningArtifacts, importHistoryFromReport, loadHistoryEntries, shouldFailForLearning } from "./learning";
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

const setBaselineFromSource = (config: ExternalConfig) => {
	if (!config.baselineSource) {
		throw new Error("baseline source is required when --action=set-baseline");
	}
	const { filePath, results } = loadReportResults(config.baselineSource);
	const baseline = createBaselineFromResults(results, filePath, config.suite);
	writeBaselineFile(config.baselineFile, baseline);
	console.log(`[external-e2e] baseline updated: ${config.baselineFile}`);
	console.log(`[external-e2e] baseline source: ${filePath}`);
	console.log(`[external-e2e] baseline cases: ${Object.keys(baseline.cases).length}`);
};

const importHistory = (config: ExternalConfig) => {
	if (!config.baselineSource) {
		throw new Error("history source is required when --action=import-history");
	}
	const result = importHistoryFromReport(config, config.baselineSource);
	console.log(`[external-e2e] history file: ${result.historyFile}`);
	console.log(`[external-e2e] imported entries: ${result.imported}`);
	console.log(`[external-e2e] total entries: ${result.total}`);
};

const main = async () => {
	const config = parseConfig(process.argv.slice(2));
	if (config.action === "set-baseline") {
		setBaselineFromSource(config);
		return;
	}
	if (config.action === "import-history") {
		importHistory(config);
		return;
	}
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

	const baseline = loadBaselineFile(config.baselineFile);
	const budgets = loadBudgetFile(config.budgetsFile);
	const regressions = applyPerformanceRegressions(config, results, baseline, budgets);
	const historyEntries = loadHistoryEntries(config.historyFile);
	const learningArtifacts = buildLearningArtifacts(config, results, historyEntries, baseline);
	if (config.saveBaseline) {
		writeBaselineFile(
			config.baselineFile,
			createBaselineFromResults(results, path.join(reportRoot, "external-results.json"), config.suite)
		);
		console.log(`[external-e2e] saved baseline: ${config.baselineFile}`);
	}
	const learningFailure = shouldFailForLearning(config, learningArtifacts.learnedRegressions);
	if (learningFailure.shouldFail) {
		for (const message of learningFailure.messages) {
			console.error(`[external-e2e] learned-regression: ${message}`);
		}
		for (const result of results) {
			if (result.learning?.status === "confirmed" || result.learning?.status === "suspected") {
				result.status = "failed";
				result.failureType = "performance";
				if (!result.error) {
					const messages = result.learning.checks
						.filter((check) => check.status === result.learning?.status)
						.map((check) => check.message);
					result.error = messages.join("；");
				}
			}
		}
	}
	const report = buildExternalReport(
		config,
		results,
		regressions,
		learningArtifacts.learning,
		learningArtifacts.learnedRegressions,
		learningArtifacts.baselineRecommendations
	);
	const reportPath = writeReports(reportRoot, report);
	if (config.importCurrentToHistory) {
		const imported = importHistoryFromReport(config, path.join(reportRoot, "external-results.json"));
		console.log(
			`[external-e2e] imported current report into history: +${imported.imported} entries (total=${imported.total})`
		);
	}
	const failed = results.filter((result) => result.status === "failed");
	console.log(`[external-e2e] wrote report: ${reportPath}`);
	console.log(
		`[external-e2e] passed=${report.summary.passed} failed=${report.summary.failed} learnedConfirmed=${report.summary.learningConfirmed} learnedSuspected=${report.summary.learningSuspected} recurringAnomalies=${report.summary.learningRecurringAnomalies} ruleSuspected=${report.summary.learningRuleSuspected}`
	);
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
