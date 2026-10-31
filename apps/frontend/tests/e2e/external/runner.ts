import path from "path";
import { randomUUID } from "node:crypto";
import type { Browser, LaunchOptions } from "playwright";
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
import { ensureDir, writeJson, writeReports } from "./reporter";
import type {
	CaseResult,
	EnvironmentId,
	ExternalConfig,
	ExternalValidity,
	LearningSummary,
	RunMode,
	SuiteContext,
} from "./types";
import {
	runCorrectnessFull,
	runCorrectnessSmoke,
	runHarnessHealth,
	runPerformanceExternal,
} from "./suites";
import { logEnvironment, logReport, logRunHeader } from "./cli-progress";
import { readSourceIdentity } from "../../../../../tests/report/provenance";
import { resolveChromiumLaunchOptions, selectedBrowser, selectedBrowserType } from "../../../../../tests/browser-launch";
import type { LabGateReport, ValidityReason } from "../../../../../tests/report/contract";
import { contractMarkNames } from "./lab/contracts";
import { buildGateReport, evaluationReason, labScenarioKey, LabAbortError, neutralCaseEvaluation } from "./lab/evaluate";
import { labInstrumentationSummary, resetLabAccumulator } from "./lab/install";
import { resolveLabPolicy } from "./lab/policy";
import { caseKeyOf, hasCaseSelection, isCaseSelected } from "./lab/select";
import type { LabCaseEvaluation } from "./lab/types";

const EMPTY_LEARNING: LearningSummary = {
	historyEntries: 0,
	learnedChecks: 0,
	insufficientHistory: 0,
	normal: 0,
	suspected: 0,
	confirmed: 0,
	anomalyChecks: 0,
	anomalyStable: 0,
	anomalyWatch: 0,
	anomalyRecurring: 0,
	ruleSuspected: 0,
	baselineRecommendations: 0,
};

const launchBrowser = async (mode: RunMode, gpu: "on" | "off"): Promise<Browser> => {
	const browser = selectedBrowser();
	const browserType = selectedBrowserType();
	const launchOptions: LaunchOptions = {
		headless: mode === "headless",
		...(browser === "chromium" ? resolveChromiumLaunchOptions() : {}),
	};
	if (browser === "chromium" && gpu === "off") {
		launchOptions.args = [
			"--disable-gpu",
			"--disable-gpu-compositing",
			"--disable-gpu-rasterization",
			"--disable-accelerated-2d-canvas",
		];
	}
	return browserType.launch(launchOptions);
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

const resolveReportRoot = (config: ExternalConfig) => {
	if (path.basename(config.reportDir) === "latest") {
		return path.join(config.reportDir, dateTag());
	}
	return config.reportDir;
};

const reportTagOf = (config: ExternalConfig) =>
	config.suite === "performance-external" ? `${config.suite}-${config.caseSet}` : config.suite;

const labScenarioKeyOf = (config: ExternalConfig) => labScenarioKey(config.suite, config.caseSet);

const caseKeyOfResult = (config: ExternalConfig, result: CaseResult) =>
	caseKeyOf(result.id, result.environment ?? config.environment, result.scale);

/** Evaluation for a result the suite could not gate (e.g. service failure). */
const evaluationOf = (config: ExternalConfig, result: CaseResult): LabCaseEvaluation =>
	result.lab ??
	neutralCaseEvaluation({
		caseId: result.id,
		caseKey: caseKeyOfResult(config, result),
		scenarioKey: labScenarioKeyOf(config),
		detail:
			result.status === "passed"
				? "measurement gate did not evaluate this case"
				: "case failed before the measurement gate judged collection",
	});

/**
 * Defensive guard for `--case-ids` / `--case-keys`: suites filter at their
 * enumeration sites, but a result outside the selection is a harness bug and
 * must not be certified by the gate.
 */
const evaluationsOf = (config: ExternalConfig, results: CaseResult[]): LabCaseEvaluation[] =>
	results.map((result) => {
		const evaluation = evaluationOf(config, result);
		if (!hasCaseSelection(config)) return evaluation;
		if (isCaseSelected(config, result.id, result.environment ?? config.environment, result.scale)) {
			return evaluation;
		}
		return {
			...evaluation,
			status: "invalid",
			codes: ["UNEXPECTED_CASE_SET", ...evaluation.codes.filter((code) => code !== "UNEXPECTED_CASE_SET")],
			details: [
				...evaluation.details,
				`case ${evaluation.caseKey} is outside the --case-ids/--case-keys selection`,
			],
			measurementSource: evaluation.measurementSource,
		};
	});

/**
 * A scenario whose every attempted case has invalid measurements aborts the
 * round: continuing would produce a baseline from untrusted numbers.
 */
const detectAbort = (
	config: ExternalConfig,
	results: CaseResult[],
	abortRatio: number
): LabAbortError | null => {
	if (!config.labEnabled || results.length === 0) return null;
	const evaluations = evaluationsOf(config, results);
	const groups = new Map<string, LabCaseEvaluation[]>();
	for (const evaluation of evaluations) {
		const group = groups.get(evaluation.scenarioKey) ?? [];
		group.push(evaluation);
		groups.set(evaluation.scenarioKey, group);
	}
	for (const [scenarioKey, group] of groups) {
		if (group.length === 0) continue;
		const invalid = group.filter((evaluation) => evaluation.status === "invalid");
		if (invalid.length === group.length && invalid.length / group.length >= abortRatio) {
			return new LabAbortError(scenarioKey, invalid.map(evaluationReason), results);
		}
	}
	return null;
};

const buildGate = (
	config: ExternalConfig,
	results: CaseResult[],
	aborted: boolean
): LabGateReport =>
	buildGateReport({
		suite: config.suite,
		caseSet: config.caseSet,
		evaluations: evaluationsOf(config, results),
		instrumentation: config.labEnabled
			? labInstrumentationSummary(contractMarkNames())
			: { enabled: false, contractVersion: null, missingMarks: [] },
		policy: resolveLabPolicy(),
		aborted,
		labEnabled: config.labEnabled,
	});

const validityOf = (config: ExternalConfig, gate: LabGateReport): ExternalValidity => {
	if (!config.labEnabled) {
		return {
			enabled: false,
			status: "valid",
			aborted: false,
			cases: [],
			scenarios: [],
			instrumentation: { enabled: false, contractVersion: null, missingMarks: [] },
			reasons: [],
		};
	}
	return {
		enabled: true,
		status: gate.status,
		aborted: gate.aborted,
		cases: gate.cases,
		scenarios: gate.scenarios,
		instrumentation: gate.instrumentation,
		reasons: gate.reasons,
	};
};

const writeGateReport = (reportRoot: string, reportTag: string, gate: LabGateReport) => {
	const filePath = path.join(reportRoot, `${reportTag}-lab-gate.json`);
	writeJson(filePath, gate);
	return filePath;
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
	resetLabAccumulator();
	const policy = resolveLabPolicy();
	const reportRoot = resolveReportRoot(config);
	const reportTag = reportTagOf(config);
	const artifactRoot = path.join(reportRoot, `${reportTag}-artifacts`);
	ensureDir(artifactRoot);
	logRunHeader(config);

	const results: CaseResult[] = [];
	let abortError: LabAbortError | null = null;
	const runChunk = async (chunkConfig: ExternalConfig) => {
		results.push(...(await runWithBrowser(chunkConfig, reportRoot, artifactRoot)));
		const abort = detectAbort(chunkConfig, results, policy.abortRatio);
		if (abort) throw abort;
	};
	try {
		if (config.suite === "performance-external" && config.matrix) {
			const environments: EnvironmentId[] = ["gpu_cpuHigh", "gpu_cpuLow", "noGpu_cpuHigh", "noGpu_cpuLow"];
			for (const [index, environment] of environments.entries()) {
				const envConfig = matrixEnvironment(config, environment);
				logEnvironment(envConfig, index + 1, environments.length);
				await runChunk(envConfig);
			}
		} else {
			logEnvironment(config);
			await runChunk(config);
		}
	} catch (error: unknown) {
		if (error instanceof LabAbortError) {
			abortError = error;
		} else {
			throw error;
		}
	}

	const gate = buildGate(config, results, abortError !== null);
	const gatePath = writeGateReport(reportRoot, reportTag, gate);
	const validity = validityOf(config, gate);
	const source = readSourceIdentity(process.cwd());
	const run = {
		id: process.env.AEVIA_TEST_RUN_ID || randomUUID(),
		sourceRevision: process.env.AEVIA_TEST_SOURCE_REVISION || source.revision,
		dirtyPatchSha256: process.env.AEVIA_TEST_DIRTY_SHA256 || source.dirtyPatchSha256,
	};

	if (abortError) {
		// Aborted collection: skip baseline save and history import, still write
		// the reports so the aggregate can see validity.aborted=true.
		const report = {
			...buildExternalReport(config, results, [], EMPTY_LEARNING, [], []),
			run,
			validity,
		};
		const reportPath = writeReports(reportRoot, report, reportTag);
		console.error(
			`[external-e2e] lab gate aborted scenario=${abortError.scenarioKey} (measurement collection is not trustworthy)`
		);
		for (const reason of abortError.reasons.slice(0, 10)) {
			console.error(
				`[lab][abort] ${reason.scope}:${reason.id} ${reason.code}${reason.detail ? ` (${reason.detail})` : ""}`
			);
		}
		console.error(`[external-e2e] lab gate: ${gatePath}`);
		logReport(reportPath);
		process.exit(3);
	}

	const baseline = loadBaselineFile(config.baselineFile);
	const budgets = loadBudgetFile(config.budgetsFile);
	const regressions = applyPerformanceRegressions(config, results, baseline, budgets);
	const historyEntries = loadHistoryEntries(config.historyFile);
	const learningArtifacts = buildLearningArtifacts(config, results, historyEntries, baseline);
	if (config.saveBaseline) {
		const baselineSourcePath = path.join(reportRoot, `${reportTag}-external-results.json`);
		writeBaselineFile(
			config.baselineFile,
			createBaselineFromResults(results, baselineSourcePath, config.suite)
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
	const report = {
		...buildExternalReport(
			config,
			results,
			regressions,
			learningArtifacts.learning,
			learningArtifacts.learnedRegressions,
			learningArtifacts.baselineRecommendations
		),
		run,
		validity,
	};
	const reportPath = writeReports(reportRoot, report, reportTag);
	if (config.importCurrentToHistory) {
		const imported = importHistoryFromReport(config, reportPath);
		console.log(
			`[external-e2e] imported current report into history: +${imported.imported} entries (total=${imported.total})`
		);
	}
	const failed = results.filter((result) => result.status === "failed");
	const validityReasons: ValidityReason[] = gate.reasons;
	if (validityReasons.length > 0) {
		console.error(
			`[external-e2e] [lab] validity=${gate.status} reasons=${validityReasons
				.slice(0, 20)
				.map((reason) => `${reason.scope}:${reason.id}:${reason.code}`)
				.join(",")}`
		);
	}
	logReport(reportPath);
	console.log(`[external-e2e] lab gate: ${gatePath}`);
	console.log(
		`[external-e2e] passed=${report.summary.passed} failed=${report.summary.failed} learnedConfirmed=${report.summary.learningConfirmed} learnedSuspected=${report.summary.learningSuspected} recurringAnomalies=${report.summary.learningRecurringAnomalies} ruleSuspected=${report.summary.learningRuleSuspected} validity=${validity.status}`
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
