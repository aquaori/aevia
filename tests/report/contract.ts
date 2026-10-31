// File role: run manifest, evidence artifact, and lab validity contracts shared by the runner and the aggregator.
export type RunStatus = "running" | "passed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";
export type ArtifactKind =
	| "vitest"
	| "go-test"
	| "coverage"
	| "go-coverage"
	| "package-list"
	| "external"
	| "feature-catalog"
	| "lab-gate"
	| "lab-inventory"
	| "perf-request";

/** Lab runner modes. `custom` keeps legacy/interactive profiles representable. */
export const LAB_MODES = ["single", "smoke", "ci", "nightly", "custom"] as const;
export type LabMode = (typeof LAB_MODES)[number];

export const VALIDITY_STATUSES = ["valid", "degraded", "invalid"] as const;
export type ValidityStatus = (typeof VALIDITY_STATUSES)[number];

/**
 * Measurement validity codes. Every code means "this measurement cannot be trusted",
 * never "the product behaved incorrectly" — product failures stay ordinary test failures.
 */
export const VALIDITY_CODES = [
	"MISSING_MARK",
	"UNPAIRED_MARK",
	"NEGATIVE_DURATION",
	"DURATION_OUT_OF_RANGE",
	"SAMPLE_COUNT_MISMATCH",
	"INVALID_SAMPLE_RATIO",
	"EXTERNAL_DISAGREEMENT",
	"PAGE_CONSOLE_ERROR",
	"WORKER_CRASH",
	"EMPTY_METRICS",
	"NAN_METRIC",
	"UNEXPECTED_CASE_SET",
	"LAB_RUNTIME_MISSING",
	"GATE_ABORTED",
] as const;
export type ValidityCode = (typeof VALIDITY_CODES)[number];

export const RERUN_SCOPES = ["run", "scenario", "case"] as const;
export type RerunScope = (typeof RERUN_SCOPES)[number];

export type ValidityReason = {
	scope: "case" | "scenario" | "run";
	id: string;
	code: ValidityCode;
	detail?: string;
};

export type RunValidity = {
	status: ValidityStatus;
	aborted: boolean;
	reasons: ValidityReason[];
};

export type RunStep = {
	id: string;
	title: string;
	status: StepStatus;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	exitCode?: number | null;
	logPath?: string;
	error?: string;
};

export type ExpectedArtifact = {
	id: string;
	stepId: string;
	kind: ArtifactKind;
	path: string;
	expectedCases?: string[];
	expectedSources?: string[];
};

/** One case as evaluated by the measurement gate. */
export type GateCase = {
	scenarioKey: string;
	caseKey: string;
	id: string;
	suite: string;
	status: "valid" | "invalid";
	codes: ValidityCode[];
	details: string[];
};

/** One scenario (suite + case set) as evaluated by the measurement gate. */
export type GateScenario = {
	scenarioKey: string;
	suite: string;
	attempted: number;
	valid: number;
	invalid: number;
	verdict: "passed" | "invalid" | "aborted";
};

/** Artifact kind `lab-gate`: the harness' own verdict on measurement collection. */
export type LabGateReport = {
	schemaVersion: 1;
	policy: { warnRatio: number; abortRatio: number };
	status: ValidityStatus;
	aborted: boolean;
	cases: GateCase[];
	scenarios: GateScenario[];
	instrumentation: {
		enabled: boolean;
		contractVersion: number | null;
		missingMarks: string[];
	};
	reasons: ValidityReason[];
};

/** Artifact kind `lab-inventory`: module-level test-debt snapshot. */
export type LabInventoryObligation = {
	id: string;
	kind: "frontend" | "go";
	path: string;
	state: "covered" | "partial" | "excluded";
	owner?: string;
	reason?: string;
};

export type LabInventoryReport = {
	schemaVersion: 1;
	scope: string;
	obligations: LabInventoryObligation[];
};

/** Artifact kind `perf-request`: CI asks a human/IM bot to run the performance gate later. */
export type PerfRequestReport = {
	schemaVersion: 1;
	requestedAt: string;
	reason: string;
	suites: string[];
	cases?: string[];
};

export type RunRerun = {
	ofRunId: string;
	scope: RerunScope;
	ids: string[];
};

export type RunMeasurement = {
	policy: "prefer-instrumented" | "external-only";
	instrumentation?: {
		enabled: boolean;
		contractVersion: number | null;
	};
};

export type RunManifest = {
	schemaVersion: 2;
	runId: string;
	profile: string;
	mode: LabMode;
	status: RunStatus;
	source: {
		revision: string | null;
		dirtyPatchSha256: string;
		trackedChanges?: string[];
		untrackedFiles?: string[];
	};
	startedAt: string;
	finishedAt?: string;
	expectedSteps: string[];
	steps: RunStep[];
	expectedArtifacts: ExpectedArtifact[];
	validity: RunValidity;
	recorded: boolean;
	rerun?: RunRerun;
	measurement?: RunMeasurement;
};

export const isLabMode = (value: unknown): value is LabMode =>
	typeof value === "string" && (LAB_MODES as readonly string[]).includes(value);

export const isValidityStatus = (value: unknown): value is ValidityStatus =>
	typeof value === "string" && (VALIDITY_STATUSES as readonly string[]).includes(value);

export const isValidityCode = (value: unknown): value is ValidityCode =>
	typeof value === "string" && (VALIDITY_CODES as readonly string[]).includes(value);

export const isRerunScope = (value: unknown): value is RerunScope =>
	typeof value === "string" && (RERUN_SCOPES as readonly string[]).includes(value);

export const emptyValidity = (): RunValidity => ({ status: "valid", aborted: false, reasons: [] });
