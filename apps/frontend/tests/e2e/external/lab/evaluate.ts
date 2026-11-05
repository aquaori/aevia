// File role: pure measurement-validity judgement and lab gate report builder (P3).
//
// Validity codes never describe product behavior; they only say that a
// measurement cannot be trusted. Product failures remain ordinary case
// failures. The functions here are pure so the judgement matrix can be tested
// without Playwright or services.
import type {
	GateCase,
	GateScenario,
	LabGateReport,
	ValidityCode,
	ValidityReason,
	ValidityStatus,
} from "../../../../../../tests/report/contract";
import type { CaseResult, MetricMap } from "../types";
import type {
	LabCaseEvaluation,
	LabInstrumentationSummary,
	LabPageSnapshot,
	LabPolicy,
	LabScenarioEvaluation,
	LabSpanViolation,
	MeasurementSource,
} from "./types";
import { DEFAULT_LAB_POLICY } from "./policy";
import { caseLabContract } from "./contracts";

export const labScenarioKey = (suite: string, caseSet: string, caseId?: string): string => {
	const family = caseId?.startsWith("full-render-") ? "full-render" : caseId;
	return suite === "performance-external" && caseSet === "standard" && family ? `${suite}/${caseSet}/${family}` : `${suite}/${caseSet}`;
};

export type EvaluateCaseInput = {
	caseId: string;
	caseKey: string;
	scenarioKey: string;
	snapshots: LabPageSnapshot[];
	instrumented?: MetricMap;
	external?: MetricMap;
	sampleCount: number;
	expectedSampleCount: number;
	invalidSampleCount?: number;
	sampleViolations?: LabSpanViolation[];
	witnessDeltaMs?: MetricMap;
	pageErrors?: string[];
	policy?: LabPolicy;
	labEnabled?: boolean;
};

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const measurementSourceOf = (instrumented: MetricMap, external: MetricMap): MeasurementSource => {
	const hasInstrumented = Object.values(instrumented).some(isFiniteNumber);
	const hasExternal = Object.values(external).some(isFiniteNumber);
	if (hasInstrumented && hasExternal) return "hybrid";
	if (hasInstrumented) return "instrumented";
	return "external";
};

const errorMessageOf = (error: { message: string }): string => error.message;

/**
 * Judges one case's measurement collection. Returns `status: "invalid"` with
 * one or more `VALIDITY_CODES` when the measurement cannot be trusted.
 */
export const evaluateCase = (input: EvaluateCaseInput): LabCaseEvaluation => {
	const policy = input.policy ?? DEFAULT_LAB_POLICY;
	const instrumented = input.instrumented ?? {};
	const external = input.external ?? {};
	const codes: ValidityCode[] = [];
	const details: string[] = [];
	const addCode = (code: ValidityCode) => {
		if (!codes.includes(code)) codes.push(code);
	};
	const addDetail = (detail: string) => {
		if (details.length < 40) details.push(detail);
	};

	const measurementSource = measurementSourceOf(instrumented, external);
	let contractKind: "span" | "external" | "sentinel" | "none" = "none";
	const base = (): LabCaseEvaluation => ({
		caseId: input.caseId,
		caseKey: input.caseKey,
		scenarioKey: input.scenarioKey,
		status: codes.length > 0 ? "invalid" : "valid",
		contractKind,
		codes,
		details,
		witnessDeltaMs: input.witnessDeltaMs ?? {},
		measurementSource,
		pageErrors: pageErrorsOf(input),
		sampleCount: input.sampleCount,
		expectedSampleCount: input.expectedSampleCount,
		invalidSampleCount: input.invalidSampleCount ?? 0,
	});

	if (input.labEnabled === false) {
		addDetail("lab mode is off: measurement was not instrumented");
		return base();
	}

	const contract = caseLabContract(input.caseId);
	if (!contract) {
		addCode("MISSING_CONTRACT");
		addDetail(`no lab measurement contract for case ${input.caseId}`);
		return base();
	}

	for (const metric of contract.requiredExternalMetrics ?? []) {
		if (!isFiniteNumber(external[metric])) { addCode("EMPTY_METRICS"); addDetail(`required external metric missing: ${metric}`); }
	}
	contractKind = contract.requiredSpans.length > 0 ? "span" : contract.requiredExternalMetrics?.length ? "external" : "sentinel";
	// --- runtime presence and contract version -------------------------------
	if (contract.runtimeRequired !== false && input.snapshots.length === 0) {
		addCode("LAB_RUNTIME_MISSING");
		addDetail("no page snapshot was collected for this case");
	}
	for (const snapshot of contract.runtimeRequired === false ? [] : input.snapshots) {
		if (!snapshot.present) {
			addCode("LAB_RUNTIME_MISSING");
			addDetail(`window.__AEVIA_LAB__ missing in ${snapshot.url || "page"}`);
			continue;
		}
		if (!snapshot.enabled) {
			addCode("LAB_RUNTIME_MISSING");
			addDetail(`lab runtime is disabled in ${snapshot.url || "page"}`);
		}
		if (snapshot.contractVersion !== 1) {
			addCode("LAB_RUNTIME_MISSING");
			addDetail(
				`lab contractVersion ${String(snapshot.contractVersion)} is not 1 in ${snapshot.url || "page"}`
			);
		}
		if (contract.requireSentinel && !snapshot.sentinel) {
			addCode("LAB_RUNTIME_MISSING");
			addDetail(`aevia.lab.sentinel mark missing in ${snapshot.url || "page"}`);
		}
		if (snapshot.crashed) {
			addCode("WORKER_CRASH");
			addDetail(`page crashed while collecting: ${snapshot.url || "page"}`);
		}
		if (snapshot.timelineMismatch) {
			addDetail(
				`performance timeline has no aevia.* marks although the ring buffer has ${snapshot.marks.length} in ${
					snapshot.url || "page"
				}`
			);
		}
		if (snapshot.dropped > 0) {
			addDetail(`${snapshot.dropped} mark(s) were dropped by the ring buffer`);
		}
	}

	// --- page console errors -------------------------------------------------
	if (contract.checkPageErrors) {
		const pageErrors = pageErrorsOf(input);
		if (pageErrors.length > 0) {
			addCode("PAGE_CONSOLE_ERROR");
			addDetail(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
		}
	}

	// --- precomputed span / witness violations -------------------------------
	for (const violation of input.sampleViolations ?? []) {
		addCode(violation.code);
		addDetail(violation.detail);
	}

	// --- metric sanity --------------------------------------------------------
	const instrumentedValues = Object.values(instrumented).filter((value) => typeof value === "number");
	if (contract.requiredSpans.length > 0 && instrumentedValues.length === 0) {
		addCode("EMPTY_METRICS");
		addDetail(`no instrumented metric could be derived for ${input.caseId}`);
	}
	for (const [key, value] of Object.entries(instrumented)) {
		if (typeof value === "number" && Number.isNaN(value)) {
			addCode("NAN_METRIC");
			addDetail(`instrumented metric ${key} is NaN`);
		}
	}
	for (const [key, value] of Object.entries(external)) {
		if (typeof value === "number" && Number.isNaN(value)) {
			addCode("NAN_METRIC");
			addDetail(`external metric ${key} is NaN`);
		}
	}

	// --- sample accounting ---------------------------------------------------
	if (input.sampleCount !== input.expectedSampleCount) {
		addCode("SAMPLE_COUNT_MISMATCH");
		addDetail(`collected ${input.sampleCount} sample(s), expected ${input.expectedSampleCount}`);
	}
	const invalidSampleCount = input.invalidSampleCount ?? 0;
	if (input.sampleCount > 0 && invalidSampleCount / input.sampleCount > policy.sampleInvalidRatio) {
		addCode("INVALID_SAMPLE_RATIO");
		addDetail(
			`${invalidSampleCount}/${input.sampleCount} sample(s) were invalid (limit ${policy.sampleInvalidRatio.toFixed(3)})`
		);
	}

	return base();
};

const pageErrorsOf = (input: EvaluateCaseInput): string[] => {
	const seen = new Set<string>();
	const messages: string[] = [];
	const push = (message: string) => {
		const trimmed = message.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) return;
		seen.add(trimmed);
		messages.push(trimmed);
	};
	for (const error of input.pageErrors ?? []) push(error);
	for (const snapshot of input.snapshots) {
		for (const error of snapshot.pageErrors) push(errorMessageOf(error));
	}
	return messages;
};

/** Per-scenario attempted/valid/invalid counts and verdict. */
export const evaluateScenario = (
	evaluations: LabCaseEvaluation[],
	policy: LabPolicy = DEFAULT_LAB_POLICY,
	suite = ""
): LabScenarioEvaluation => {
	const attempted = evaluations.length;
	const valid = evaluations.filter((evaluation) => evaluation.status === "valid").length;
	const invalid = attempted - valid;
	const invalidRatio = attempted > 0 ? invalid / attempted : 0;
	const verdict: LabScenarioEvaluation["verdict"] =
		attempted === 0 || invalid === 0
			? "passed"
			: invalidRatio >= policy.abortRatio
				? "aborted"
				: invalidRatio >= policy.warnRatio
					? "invalid"
					: "passed";
	return {
		scenarioKey: evaluations[0]?.scenarioKey ?? "",
		suite,
		attempted,
		valid,
		invalid,
		verdict,
	};
};

export type BuildGateReportInput = {
	suite: string;
	caseSet: string;
	evaluations: LabCaseEvaluation[];
	instrumentation: LabInstrumentationSummary;
	policy?: LabPolicy;
	aborted?: boolean;
	labEnabled?: boolean;
	runReasons?: ValidityReason[];
};

export const evaluationReason = (evaluation: LabCaseEvaluation): ValidityReason => ({
	scope: "case",
	id: evaluation.caseKey,
	code: evaluation.codes[0] ?? "MISSING_MARK",
	detail: evaluation.details.join("; ").slice(0, 1000) || undefined,
});

/**
 * Builds the `lab-gate` artifact. `status` stays `degraded` for partial invalid
 * cases (the run still exits 1 as a harness failure) and becomes `invalid` only
 * when a scenario aborts the round (runner exits 3).
 */
export const buildGateReport = (input: BuildGateReportInput): LabGateReport => {
	const policy = input.policy ?? DEFAULT_LAB_POLICY;
	const labEnabled = input.labEnabled !== false;
	const scenarioKeys = [...new Set(input.evaluations.map((evaluation) => evaluation.scenarioKey))];
	const scenarios: GateScenario[] = scenarioKeys.map((scenarioKey) => {
		const scenario = evaluateScenario(
			input.evaluations.filter((evaluation) => evaluation.scenarioKey === scenarioKey),
			policy,
			input.suite
		);
		return {
			scenarioKey,
			suite: input.suite,
			attempted: scenario.attempted,
			valid: scenario.valid,
			invalid: scenario.invalid,
			verdict: scenario.verdict,
		};
	});
	const cases: GateCase[] = input.evaluations.map((evaluation) => ({
		scenarioKey: evaluation.scenarioKey,
		caseKey: evaluation.caseKey,
		id: evaluation.caseId,
		suite: input.suite,
		status: evaluation.status,
		contractKind: evaluation.contractKind,
		codes: [...evaluation.codes],
		details: [...evaluation.details],
	}));

	const aborted = input.aborted === true || scenarios.some((scenario) => scenario.verdict === "aborted");
	const invalidCases = cases.filter((item) => item.status === "invalid");
	const status: ValidityStatus = aborted ? "invalid" : invalidCases.length > 0 ? "degraded" : "valid";

	const reasons: ValidityReason[] = [...(input.runReasons ?? [])];
	for (const evaluation of input.evaluations) {
		if (evaluation.status === "invalid") reasons.push(evaluationReason(evaluation));
	}
	if (aborted && !reasons.some((reason) => reason.code === "GATE_ABORTED")) {
		reasons.push({
			scope: "run",
			id: input.suite,
			code: "GATE_ABORTED",
			detail: `measurement collection aborted for ${scenarioKeys.join(",") || input.suite}`,
		});
	}

	return {
		schemaVersion: 1,
		policy: { warnRatio: policy.warnRatio, abortRatio: policy.abortRatio },
		status,
		aborted,
		cases,
		scenarios,
		instrumentation: labEnabled
			? input.instrumentation
			: { enabled: false, contractVersion: null, missingMarks: [] },
		reasons,
	};
};

/** A case that failed before lab collection finished keeps the gate neutral. */
export const neutralCaseEvaluation = (input: {
	caseId: string;
	caseKey: string;
	scenarioKey: string;
	detail: string;
}): LabCaseEvaluation => ({
	caseId: input.caseId,
	caseKey: input.caseKey,
	scenarioKey: input.scenarioKey,
	status: "valid",
	contractKind: "none",
	codes: [],
	details: [input.detail],
	witnessDeltaMs: {},
	measurementSource: "external",
	pageErrors: [],
	sampleCount: 0,
	expectedSampleCount: 0,
	invalidSampleCount: 0,
});

export const failedCollectionEvaluation = (input: Parameters<typeof neutralCaseEvaluation>[0]): LabCaseEvaluation => ({
	...neutralCaseEvaluation(input),
	status: "invalid",
	codes: ["COLLECTION_FAILED"],
});

export class LabAbortError extends Error {
	readonly scenarioKey: string;
	readonly reasons: ValidityReason[];
	readonly results: CaseResult[];

	constructor(scenarioKey: string, reasons: ValidityReason[], results: CaseResult[]) {
		super(`lab gate aborted scenario ${scenarioKey}`);
		this.name = "LabAbortError";
		this.scenarioKey = scenarioKey;
		this.reasons = reasons;
		this.results = results;
	}
}
