import type { Browser, Page } from "playwright";

export type RunMode = "headless" | "headed";
export type EnvironmentId = "gpu_cpuHigh" | "gpu_cpuLow" | "noGpu_cpuHigh" | "noGpu_cpuLow";
export type ReportFormat = "html" | "json" | "both";
export type RunnerAction = "run" | "set-baseline" | "import-history";
export type FailOnPerformance = "none" | "suspected" | "confirmed" | "all";
export type HistoryChannel = "normal" | "anomaly";
export type SuiteId =
	| "harness-health"
	| "correctness-smoke"
	| "correctness-full"
	| "performance-external";

export type FailureType = "none" | "harness" | "correctness" | "performance" | "timeout";
export type CaseStatus = "passed" | "failed";
export type CaseCategory = "harness" | "correctness" | "performance";

export interface ExternalConfig {
	action: RunnerAction;
	apiUrl: string;
	wsUrl: string;
	frontendUrl: string;
	reportDir: string;
	reportFormat: ReportFormat;
	mode: RunMode;
	suite: SuiteId;
	scales: number[];
	runs: number;
	warmup: number;
	matrix: boolean;
	environment: EnvironmentId;
	cpuThrottle: number;
	gpu: "on" | "off";
	baselineFile: string;
	baselineSource?: string;
	saveBaseline: boolean;
	budgetsFile?: string;
	historyFile: string;
	noisePercent: number;
	regressionPercent: number;
	regressionAbsoluteMs: number;
	learnWindow: number;
	learnMinSamples: number;
	learnZScore: number;
	confirmWindow: number;
	confirmMinFailures: number;
	stableImprovementRuns: number;
	failOnPerformance: FailOnPerformance;
	importCurrentToHistory: boolean;
}

export interface MetricMap {
	[key: string]: number | string | boolean | null | undefined;
}

export interface CaseResult {
	id: string;
	title?: string;
	description?: string;
	category?: CaseCategory;
	environment?: EnvironmentId;
	runMode?: RunMode;
	scale?: number;
	status: CaseStatus;
	failureType: FailureType;
	durationMs: number;
	metrics: MetricMap;
	samples?: CaseSample[];
	aggregate?: Record<string, MetricStats>;
	regression?: CaseRegression;
	learning?: CaseLearning;
	error?: string;
	artifacts?: string[];
}

export interface CaseSample {
	run: number;
	warmup: boolean;
	status: CaseStatus;
	durationMs: number;
	metrics: MetricMap;
	qualityStatus?: "valid" | "invalid_quality" | "outlier";
	qualityReason?: string;
	error?: string;
}

export interface MetricStats {
	min: number;
	median: number;
	mean: number;
	p95: number;
	max: number;
}

export interface BaselineCaseSnapshot {
	id: string;
	environment?: EnvironmentId;
	runMode?: RunMode;
	scale?: number;
	metrics: MetricMap;
}

export interface BaselineFile {
	version: 1;
	createdAt: string;
	sourceReport?: string;
	suite?: SuiteId;
	cases: Record<string, BaselineCaseSnapshot>;
}

export interface BudgetMetricRule {
	max?: number;
}

export interface BudgetCaseRule {
	metrics: Record<string, BudgetMetricRule>;
}

export interface BudgetFile {
	version: 1;
	cases: Record<string, BudgetCaseRule>;
}

export interface RegressionCheck {
	metric: string;
	label: string;
	source: "baseline" | "budget";
	status: "passed" | "failed" | "missing";
	trend: "improved" | "regressed" | "unchanged";
	current: number;
	baseline?: number;
	allowedMax?: number;
	delta?: number;
	deltaPercent?: number;
	thresholdPercent?: number;
	thresholdAbsoluteMs?: number;
	message: string;
}

export interface CaseRegression {
	caseKey: string;
	id: string;
	environment?: EnvironmentId;
	status: "passed" | "failed" | "missing";
	checks: RegressionCheck[];
}

export interface PerformanceHistoryEntry {
	version: 1;
	suite: SuiteId;
	sourceReport: string;
	reportGeneratedAt: string;
	importedAt: string;
	channel: HistoryChannel;
	caseKey: string;
	id: string;
	environment?: EnvironmentId;
	runMode?: RunMode;
	scale?: number;
	metric: string;
	value: number;
	status: CaseStatus;
	failureType: FailureType;
	anomalyType?: "case_failure" | "invalid_sample_ratio" | "outlier_sample_ratio";
	qualityReason?: string;
}

export interface LearnedRegressionCheck {
	caseKey: string;
	metric: string;
	label: string;
	status: "insufficient_history" | "normal" | "suspected" | "confirmed";
	current: number;
	sampleCount: number;
	learnedMedian?: number;
	learnedMad?: number;
	learnedSigma?: number;
	learnedLowerBound?: number;
	learnedUpperBound?: number;
	delta?: number;
	deltaPercent?: number;
	zScore?: number;
	recentAboveThreshold?: number;
	message: string;
}

export interface LearnedAnomalyCheck {
	caseKey: string;
	metric: string;
	label: string;
	status: "insufficient_history" | "stable" | "watch" | "recurring" | "rule_suspected";
	current: number;
	sampleCount: number;
	recentMedian?: number;
	recentMean?: number;
	recentUpperBound?: number;
	recentAboveThreshold?: number;
	message: string;
}

export interface BaselineRecommendation {
	caseKey: string;
	metric: string;
	label: string;
	status: "none" | "suggested";
	currentBaseline?: number;
	recommendedBaseline?: number;
	sampleCount: number;
	improvementPercent?: number;
	message: string;
}

export interface BaselineHealthCheck {
	caseKey: string;
	metric: string;
	label: string;
	status: "healthy" | "too_strict" | "too_loose" | "unknown";
	currentBaseline?: number;
	learnedMedian?: number;
	learnedUpperBound?: number;
	message: string;
}

export interface CaseLearning {
	caseKey: string;
	id: string;
	environment?: EnvironmentId;
	status: "insufficient_history" | "normal" | "suspected" | "confirmed";
	checks: LearnedRegressionCheck[];
	anomalyChecks: LearnedAnomalyCheck[];
	baselineHealth: BaselineHealthCheck[];
	recommendations: BaselineRecommendation[];
}

export interface LearningSummary {
	historyEntries: number;
	learnedChecks: number;
	insufficientHistory: number;
	normal: number;
	suspected: number;
	confirmed: number;
	anomalyChecks: number;
	anomalyStable: number;
	anomalyWatch: number;
	anomalyRecurring: number;
	ruleSuspected: number;
	baselineRecommendations: number;
}

export interface ExternalRunSummary {
	total: number;
	passed: number;
	failed: number;
	performanceRegressionFailures: number;
	baselineComparisons: number;
	budgetComparisons: number;
	learningSuspected: number;
	learningConfirmed: number;
	learningRecurringAnomalies: number;
	learningRuleSuspected: number;
	baselineRecommendations: number;
}

export interface ExternalReport {
	version: 1;
	generatedAt: string;
	config: Pick<
		ExternalConfig,
		| "action"
		| "reportFormat"
		| "mode"
		| "suite"
		| "scales"
		| "runs"
		| "warmup"
		| "matrix"
		| "environment"
		| "cpuThrottle"
		| "gpu"
		| "baselineFile"
		| "budgetsFile"
		| "historyFile"
		| "noisePercent"
		| "regressionPercent"
		| "regressionAbsoluteMs"
		| "learnWindow"
		| "learnMinSamples"
		| "learnZScore"
		| "confirmWindow"
		| "confirmMinFailures"
		| "stableImprovementRuns"
		| "failOnPerformance"
		| "importCurrentToHistory"
	>;
	summary: ExternalRunSummary;
	results: CaseResult[];
	regressions: CaseRegression[];
	learning: LearningSummary;
	learnedRegressions: CaseLearning[];
	baselineRecommendations: BaselineRecommendation[];
}

export interface SuiteContext {
	browser: Browser;
	config: ExternalConfig;
	reportRoot: string;
	artifactRoot: string;
}

export interface RoomCredentials {
	token: string;
	userId: string;
}

export interface RoomUser {
	roomId: string;
	userName: string;
	token: string;
	userId: string;
}

export interface CanvasSample {
	signature: string;
	nonBlankRatio: number;
	width: number;
	height: number;
	pixels?: number[];
	source: "canvas-readback" | "screenshot";
}

export interface Roi {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserPage {
	page: Page;
	close: () => Promise<void>;
}
