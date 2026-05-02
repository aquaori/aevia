import type { Browser, Page } from "playwright";

export type RunMode = "headless" | "headed";
export type EnvironmentId = "gpu_cpuHigh" | "gpu_cpuLow" | "noGpu_cpuHigh" | "noGpu_cpuLow";
export type SuiteId =
	| "harness-health"
	| "correctness-smoke"
	| "correctness-full"
	| "performance-external";

export type FailureType = "none" | "harness" | "correctness" | "performance" | "timeout";
export type CaseStatus = "passed" | "failed";
export type CaseCategory = "harness" | "correctness" | "performance";

export interface ExternalConfig {
	apiUrl: string;
	wsUrl: string;
	frontendUrl: string;
	reportDir: string;
	mode: RunMode;
	suite: SuiteId;
	scales: number[];
	runs: number;
	warmup: number;
	matrix: boolean;
	environment: EnvironmentId;
	cpuThrottle: number;
	gpu: "on" | "off";
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
	error?: string;
	artifacts?: string[];
}

export interface CaseSample {
	run: number;
	warmup: boolean;
	status: CaseStatus;
	durationMs: number;
	metrics: MetricMap;
	error?: string;
}

export interface MetricStats {
	min: number;
	median: number;
	mean: number;
	p95: number;
	max: number;
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
