// File role: deterministic coverage for the measurement gate's judgement matrix (P3).
import { describe, expect, it } from "vitest";
import {
	buildGateReport,
	evaluateCase,
	evaluateScenario,
	neutralCaseEvaluation,
	failedCollectionEvaluation,
} from "../../apps/frontend/tests/e2e/external/lab/evaluate";
import { DEFAULT_LAB_POLICY } from "../../apps/frontend/tests/e2e/external/lab/policy";
import type {
	LabCaseEvaluation,
	LabPageSnapshot,
} from "../../apps/frontend/tests/e2e/external/lab/types";

const SCENARIO = "correctness-full/standard";

const snapshot = (overrides: Partial<LabPageSnapshot> = {}): LabPageSnapshot => ({
	present: true,
	enabled: true,
	contractVersion: 1,
	marks: [],
	counters: {},
	dropped: 0,
	pageErrors: [],
	sentinel: true,
	crashed: false,
	timelineMarkNames: ["aevia.lab.sentinel"],
	timelineMismatch: false,
	url: "http://localhost:5173/room",
	capturedAt: "2026-10-31T00:00:00.000Z",
	...overrides,
});

const baseCase = (caseId: string, caseKey = `${caseId}|gpu_cpuHigh|`) => ({
	caseId,
	caseKey,
	scenarioKey: SCENARIO,
	snapshots: [snapshot()],
	instrumented: { firstNonBlankMs: 40 },
	external: { firstNonBlankMs: 42 },
	sampleCount: 3,
	expectedSampleCount: 3,
} as const);

const evaluation = (caseKey: string, status: "valid" | "invalid", codes: LabCaseEvaluation["codes"] = []): LabCaseEvaluation => ({
	...neutralCaseEvaluation({ caseId: caseKey.split("|")[0]!, caseKey, scenarioKey: SCENARIO, detail: "fixture" }),
	status,
	codes,
});

describe("lab measurement gate", () => {
	it("accepts a case whose instrumentation and contract agree", () => {
		const result = evaluateCase({ ...baseCase("correctness-smoke"), instrumented: { remoteFirstPixelMs: 40 } });
		expect(result.status).toBe("valid");
		expect(result.codes).toEqual([]);
		expect(result.measurementSource).toBe("hybrid");
	});

	it("rejects a missing required span", () => {
		const result = evaluateCase({
			...baseCase("full-render-10000"),
			sampleViolations: [
				{ metric: "firstNonBlankMs", code: "MISSING_MARK", detail: "aevia.init.meta was not emitted" },
			],
		});
		expect(result.status).toBe("invalid");
		expect(result.codes).toContain("MISSING_MARK");
	});

	it("rejects a contract case without any instrumented metric", () => {
		const result = evaluateCase({ ...baseCase("full-render-10000"), instrumented: {} });
		expect(result.status).toBe("invalid");
		expect(result.codes).toContain("EMPTY_METRICS");
	});

	it("rejects a page without the lab runtime and a page-level error", () => {
		const missingRuntime = evaluateCase({
			...baseCase("correctness-smoke"),
			snapshots: [snapshot({ present: false })],
		});
		expect(missingRuntime.codes).toContain("LAB_RUNTIME_MISSING");

		const pageError = evaluateCase({ ...baseCase("correctness-smoke"), pageErrors: ["boom"] });
		expect(pageError.codes).toContain("PAGE_CONSOLE_ERROR");
	});

	it("rejects NaN metrics and incomplete samples", () => {
		const nan = evaluateCase({
			...baseCase("full-render-10000"),
			instrumented: { firstNonBlankMs: Number.NaN },
		});
		expect(nan.codes).toContain("NAN_METRIC");

		const short = evaluateCase({ ...baseCase("correctness-smoke"), sampleCount: 1 });
		expect(short.codes).toContain("SAMPLE_COUNT_MISMATCH");
	});

	it("classifies scenario verdicts by invalid ratio", () => {
		const passed = evaluateScenario([evaluation("a", "valid"), evaluation("b", "valid")]);
		expect(passed.verdict).toBe("passed");

		const warned = evaluateScenario([
			evaluation("a", "valid"),
			evaluation("b", "invalid", ["MISSING_MARK"]),
			evaluation("c", "valid"),
			evaluation("d", "invalid", ["MISSING_MARK"]),
		]);
		expect(warned.invalid).toBe(2);
		expect(warned.verdict).toBe("invalid");

		const aborted = evaluateScenario([evaluation("a", "invalid", ["MISSING_MARK"]), evaluation("b", "invalid", ["EMPTY_METRICS"])]);
		expect(aborted.verdict).toBe("aborted");
	});

	it("marks a fully invalid scenario as an aborted run and keeps partial invalidity degraded", () => {
		const degraded = buildGateReport({
			suite: "correctness-full",
			caseSet: "standard",
			evaluations: [
				evaluation("a", "valid"),
				evaluation("b", "invalid", ["MISSING_MARK"]),
				evaluation("c", "valid"),
				evaluation("d", "valid"),
			],
			instrumentation: { enabled: true, contractVersion: 1, missingMarks: [] },
		});
		expect(degraded.status).toBe("degraded");
		expect(degraded.aborted).toBe(false);
		expect(degraded.cases.filter((item) => item.status === "invalid")).toHaveLength(1);

		const aborted = buildGateReport({
			suite: "correctness-full",
			caseSet: "standard",
			evaluations: [
				evaluation("a", "invalid", ["MISSING_MARK"]),
				evaluation("b", "invalid", ["EMPTY_METRICS"]),
			],
			instrumentation: { enabled: true, contractVersion: 1, missingMarks: ["aevia.frame.commit"] },
		});
		expect(aborted.status).toBe("invalid");
		expect(aborted.aborted).toBe(true);
		expect(aborted.reasons.some((reason) => reason.code === "GATE_ABORTED")).toBe(true);
		expect(aborted.scenarios[0]?.verdict).toBe("aborted");
		expect(DEFAULT_LAB_POLICY.abortRatio).toBe(1);
	});
});

it("rejects unknown measurement contracts instead of certifying skipped collection", () => {
	expect(evaluateCase(baseCase("unknown-case")).status).toBe("invalid");
});

it("does not certify a harness setup failure as valid measurement collection", () => {
	const failure = failedCollectionEvaluation({ caseId: "boundary-full-render-until-crash", caseKey: "boundary", scenarioKey: "boundary", detail: "setup acknowledgement timed out" });
	expect(failure.status).toBe("invalid");
	expect(failure.codes).toEqual(["COLLECTION_FAILED"]);
	expect(evaluateScenario([failure]).verdict).toBe("aborted");
});
it("rejects missing required external measurements", () => {
	expect(evaluateCase({ ...baseCase("resilience-network-recovery"), external: {} }).codes).toContain("EMPTY_METRICS");
});
