import type { Browser } from "playwright";

export type BenchmarkRunMode = "headless" | "headed";

export type BenchmarkEnvironmentId =
	| "gpu_cpuHigh"
	| "gpu_cpuLow"
	| "noGpu_cpuHigh"
	| "noGpu_cpuLow";

export type BenchmarkCategory =
	| "micro"
	| "full-render"
	| "latency"
	| "stress"
	| "collision"
	| "chaos"
	| "visual"
	| "incremental"
	| "undo-redo"
	| "multi-page"
	| "eraser";

export type DatasetShape =
	| "many-short-strokes"
	| "few-long-strokes"
	| "dense-overlap"
	| "sparse-fullscreen"
	| "mixed-tool-history";

export interface BenchmarkMetricMap {
	[key: string]: number | boolean | string | string[] | number[] | null | undefined;
}

export interface BenchmarkRunSample {
	status: "passed" | "failed";
	durationMs: number;
	metrics: BenchmarkMetricMap;
	error?: string;
	artifacts?: string[];
}

export interface NumericAggregate {
	min: number;
	median: number;
	mean: number;
	p95: number;
	max: number;
}

export interface BenchmarkAggregate {
	numeric: Record<string, NumericAggregate>;
	boolean: Record<string, boolean>;
	lastString: Record<string, string>;
	sampleCount: number;
	failureCount: number;
}

export interface BenchmarkThresholds {
	durationWarnPct: number;
	durationFailPct: number;
	fpsWarnPct: number;
	fpsFailPct: number;
}

export interface BenchmarkBaselineEntry {
	version: string;
	runMode: BenchmarkRunMode;
	environment: BenchmarkEnvironmentId;
	caseId: string;
	category: BenchmarkCategory;
	shape: DatasetShape;
	scale: number | null;
	aggregates: Record<string, NumericAggregate>;
	booleanChecks: Record<string, boolean>;
	thresholds: BenchmarkThresholds;
}

export interface BenchmarkDiffResult {
	status: "ok" | "warn" | "fail" | "no-baseline";
	reasons: string[];
	metricDiffPct: Record<string, number>;
}

export interface BenchmarkCaseResult {
	id: string;
	category: BenchmarkCategory;
	runMode: BenchmarkRunMode;
	environment: BenchmarkEnvironmentId;
	shape: DatasetShape;
	scale: number | null;
	tags: string[];
	samples: BenchmarkRunSample[];
	aggregate: BenchmarkAggregate;
	diff: BenchmarkDiffResult;
}

export interface BenchmarkContext {
	browser: Browser;
	runMode: BenchmarkRunMode;
	environment: BenchmarkEnvironmentId;
	throttleCpu: boolean;
	gpuEnabled: boolean;
	headless: boolean;
	shape: DatasetShape;
	scale: number | null;
	artifactDir: string;
	reportDir: string;
}

export interface BenchmarkCase {
	id: string;
	category: BenchmarkCategory;
	tags: string[];
	defaultScale: number | null;
	supportedShapes: DatasetShape[];
	warmupRuns: number;
	sampleRuns: number;
	collect: (context: BenchmarkContext) => Promise<BenchmarkRunSample>;
}

export interface BenchmarkCliOptions {
	mode: "headless" | "headed" | "both";
	suites: string[] | null;
	scales: number[];
	shapes: DatasetShape[];
	runs: number;
	warmup: number;
	updateBaseline: boolean;
	reportDir: string;
	smoke: boolean;
}
