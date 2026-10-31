// File role: shared lab collection types for the external E2E harness (P2).
//
// The harness consumes the product instrumentation through the global
// `window.__AEVIA_LAB__` contract only; these types describe what it reads and
// what it hands to the pure validity evaluator.
import type { ValidityCode } from "../../../../../../tests/report/contract";
import type { MetricMap } from "../types";

/** Thread that produced a mark. Worker clocks are never subtracted from main clocks. */
export type LabThread = "main" | "worker";

export type LabMarkDetail = Record<string, string | number | boolean>;

/** Mirror of the product contract `window.__AEVIA_LAB__.marks` entry. */
export type LabMark = {
	name: string;
	thread: LabThread;
	t: number;
	detail?: LabMarkDetail;
};

export type LabPageErrorSource =
	| "console.error"
	| "pageerror"
	| "unhandledrejection"
	| "crash"
	| "harness";

export type LabPageError = {
	source: LabPageErrorSource;
	message: string;
	t: number;
};

/**
 * Serializable snapshot of `window.__AEVIA_LAB__` in one page at one point in
 * time. `timelineMarkNames` is the `performance.getEntriesByName("aevia.*")`
 * cross-check for the ring buffer.
 */
export type LabPageSnapshot = {
	present: boolean;
	enabled: boolean;
	contractVersion: number | null;
	marks: LabMark[];
	counters: Record<string, number>;
	dropped: number;
	pageErrors: LabPageError[];
	sentinel: boolean;
	crashed: boolean;
	timelineMarkNames: string[];
	timelineMismatch: boolean;
	url: string;
	capturedAt: string;
};

/** Measurement source actually used for a metric map. */
export type MeasurementSource = "instrumented" | "external" | "hybrid";

export type LabWitnessKind = "firstPaint" | "visuallyStable" | "interaction";

export type LabPolicy = {
	/** Invalid-case ratio at which a scenario verdict becomes `invalid`. */
	warnRatio: number;
	/** Invalid-case ratio at which a scenario aborts the whole round. */
	abortRatio: number;
	/** Invalid-sample ratio above which a sampled case is invalid. */
	sampleInvalidRatio: number;
	/** Absolute sanity ceiling for a single instrumented span. */
	maxSpanMs: number;
	/** Cross-source witness tolerances. */
	witness: {
		firstPaintMs: number;
		visuallyStableMs: number;
		interactionMs: number;
	};
};

export type LabSpanViolation = {
	metric: string;
	code: ValidityCode;
	detail: string;
};

export type LabInstrumentationSummary = {
	enabled: boolean;
	contractVersion: number | null;
	missingMarks: string[];
};

/** One case as judged by the measurement gate, attached to its CaseResult. */
export type LabCaseEvaluation = {
	caseId: string;
	caseKey: string;
	scenarioKey: string;
	status: "valid" | "invalid";
	codes: ValidityCode[];
	details: string[];
	witnessDeltaMs: MetricMap;
	measurementSource: MeasurementSource;
	pageErrors: string[];
	sampleCount: number;
	expectedSampleCount: number;
	invalidSampleCount: number;
};

export type LabScenarioEvaluation = {
	scenarioKey: string;
	suite: string;
	attempted: number;
	valid: number;
	invalid: number;
	verdict: "passed" | "invalid" | "aborted";
};
