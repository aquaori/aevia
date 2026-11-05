import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyPerformanceRegressions } from "../../apps/frontend/tests/e2e/external/baseline";
import { sameConditions, qualifyPerformanceResults } from "../../apps/frontend/tests/e2e/external/conditions";
import { buildLearningArtifacts } from "../../apps/frontend/tests/e2e/external/learning";
import { parseConfig } from "../../apps/frontend/tests/e2e/external/config";
import { promoteInstrumentedMetrics } from "../../apps/frontend/tests/e2e/external/suites";
import type { BaselineFile, CaseResult, PerformanceHistoryEntry } from "../../apps/frontend/tests/e2e/external/types";
const conditions = { fingerprint: "host-a-contract-2", gpuObserved: true, details: {}, freeMemoryRatio: 0.5 };
const config = parseConfig(["--suite=performance-external"]);
const result = (): CaseResult => ({ id: "full-render-10000", environment: "gpu_cpuHigh", category: "performance", status: "passed", failureType: "none", durationMs: 1, scale: 10000, conditions, metrics: { firstNonBlankMsMedian: 100, visuallyStableMsMedian: 120 } });
const baseline = (): BaselineFile => ({ version: 1, createdAt: "2026-11-05", cases: { "gpu_cpuHigh::full-render-10000": { id: "full-render-10000", conditions, metrics: { firstNonBlankMsMedian: 10, visuallyStableMsMedian: 12 } } } });
const budgets = (reference: BaselineFile) => ({ version: 1 as const, sourceBaselineSha256: createHash("sha256").update(JSON.stringify(reference.cases)).digest("hex"), cases: { "gpu_cpuHigh::full-render-10000": { metrics: { firstNonBlankMsMedian: { max: 20 }, visuallyStableMsMedian: { max: 24 } } } } });
describe("performance comparability and hard budgets", () => {
	it("uses validated instrumented values for baselines and keeps the independent witness", () => {
		const current = { ...result(), lab: { status: "valid" }, instrumented: { firstNonBlankMs: 80, visuallyStableMs: 90 } } as CaseResult;
		promoteInstrumentedMetrics(current);
		expect(current.metrics.visuallyStableMsMedian).toBe(90);
		expect(current.externalMetrics?.visuallyStableMsMedian).toBe(120);
		const invalid = { ...result(), lab: { status: "invalid" }, instrumented: { visuallyStableMs: 1 } } as CaseResult;
		promoteInstrumentedMetrics(invalid);
		expect(invalid.metrics.visuallyStableMsMedian).toBe(120);
	});
	it("stores automatic history outside tracked baseline inputs", () => {
		expect(config.historyFile.replaceAll("\\", "/")).toMatch(/\/tests\/reports\/lab-history\/performance-external.history.jsonl$/);
	});
	it("rejects missing provenance and different host/contract fingerprints", () => {
		expect(sameConditions(undefined, undefined)).toBe(false);
		expect(sameConditions(conditions, { ...conditions, fingerprint: "host-b" })).toBe(false);
		expect(sameConditions(conditions, { ...conditions, gpuObserved: false })).toBe(false);
	});
	it("does not compare a foreign-host baseline or fail its budget", () => {
		const current = result(), reference = baseline();
		reference.cases["gpu_cpuHigh::full-render-10000"]!.conditions = { ...conditions, fingerprint: "other-host" };
		applyPerformanceRegressions(config, [current], reference, budgets(reference));
		qualifyPerformanceResults([current], reference);
		expect(current.status).toBe("passed");
		expect(current.regression?.checks).toEqual([]);
		expect(current.performanceQualification).toBe("inconclusive");
	});
	it("fails comparable absolute budgets even without confirmed learned regressions", () => {
		const current = result(), reference = baseline();
		applyPerformanceRegressions(config, [current], reference, budgets(reference));
		qualifyPerformanceResults([current], reference);
		expect(current.status).toBe("failed");
		expect(current.performanceQualification).toBe("failed");
	});
	it("keeps an explicit diagnostic-only run nonblocking", () => {
		const current = result(), reference = baseline();
		applyPerformanceRegressions(config, [current], reference, budgets(reference));
		qualifyPerformanceResults([current], reference, "none");
		expect(current.status).toBe("passed");
		expect(current.performanceQualification).toBe("inconclusive");
	});
	it("does not use a budget generated from a different baseline", () => {
		const current = result(), reference = baseline();
		applyPerformanceRegressions(config, [current], reference, { ...budgets(reference), sourceBaselineSha256: "stale" });
		expect(current.regression?.checks.some(check => check.source === "budget")).toBe(false);
	});
	it("excludes legacy and foreign-condition history from learning", () => {
		const current = result();
		const history = Array.from({ length: 12 }, (_, index) => ({ version: 1, channel: "normal", caseKey: "gpu_cpuHigh::full-render-10000", metric: "firstNonBlankMsMedian", value: 1, status: "passed", reportGeneratedAt: String(index), conditionHash: index % 2 ? "other-host" : undefined })) as PerformanceHistoryEntry[];
		const learned = buildLearningArtifacts(config, [current], history, baseline());
		expect(learned.learning.historyEntries).toBe(0);
		expect(current.learning?.status).toBe("insufficient_history");
	});
});
