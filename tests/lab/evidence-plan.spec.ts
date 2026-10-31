// File role: deterministic checks for the lab evidence plans behind smoke/nightly/single modes.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLabEvidencePlan,
	buildNightlyPlan,
	buildSinglePlan,
	buildSmokePlan,
	supportsGoRaceDetector,
	type LabPlanContext,
} from "./evidence-plan";
import { CORRECTNESS_FULL_EXTERNAL_CASE_IDS } from "../catalog/external-cases";

const context = (overrides: Partial<LabPlanContext> = {}): LabPlanContext => ({
	runDir: "C:/repo/tests/reports/summary/runs/run-1",
	rootDir: "C:/repo",
	frontendDir: "C:/repo/apps/frontend",
	backendDir: "C:/repo/apps/backend",
	canonicalRootDir: "C:/repo",
	shellQuote: (value: string) => `"${value}"`,
	listCoverageSources: () => ["C:/repo/apps/frontend/src/a.ts"],
	externalEnv: { AEVIA_TEST_RUN_ID: "run-1" },
	cleanTree: true,
	perfRequest: false,
	...overrides,
});

const stepIds = (plan: { steps: { id: string }[] }) => plan.steps.map((step) => step.id);
const artifactIds = (plan: { artifacts: { id: string }[] }) => plan.artifacts.map((artifact) => artifact.id);

describe("lab evidence plans", () => {
	it("builds a smoke plan with gate evidence and isolated services", () => {
		const plan = buildSmokePlan(context());
		expect(stepIds(plan)).toEqual(["catalog-check", "frontend-test", "external-smoke", "source-check"]);
		expect(artifactIds(plan)).toEqual([
			"feature-obligations",
			"frontend-vitest",
			"correctness-smoke-external",
			"correctness-smoke-gate",
		]);
		const external = plan.steps.find((step) => step.id === "external-smoke");
		expect(external?.requiresServices).toBe(true);
		expect(external?.env?.AEVIA_TEST_RUN_ID).toBe("run-1");
		expect(external?.command).toContain("--suite=correctness-smoke");
	});

	it("builds a nightly plan with the performance matrix, fuzz/race and all gates", () => {
		const plan = buildNightlyPlan(context());
		const raceSteps = supportsGoRaceDetector(path.resolve("apps/backend")) ? ["go-race"] : [];
		expect(stepIds(plan)).toEqual([
			"build",
			"go-vet",
			"go-package-list",
			"go-test",
			"frontend-test",
			"browser-test",
			"external-performance-standard",
			"external-performance-resilience",
			"external-performance-boundary-full-render",
			"external-performance-boundary-heap-growth",
			"external-performance-boundary-redraw-freeze",
			"external-e2e",
			...raceSteps,
			"go-fuzz",
			"lab-inventory",
			"source-check",
		]);
		expect(artifactIds(plan)).toEqual(
			expect.arrayContaining([
				"performance-external-standard-gate",
				"performance-external-resilience-gate",
				"performance-external-boundary-full-render-gate",
				"performance-external-boundary-heap-growth-gate",
				"performance-external-boundary-redraw-freeze-gate",
				"external-correctness-gate",
				"lab-inventory",
			])
		);
		const standard = plan.steps.find((step) => step.id === "external-performance-standard");
		expect(standard?.command).toContain("--case-set=standard");
		expect(standard?.command).toContain("--matrix=true");
		expect(standard?.command).toContain("--import-current-to-history=true");
		const boundarySteps = plan.steps.filter((step) => step.id.startsWith("external-performance-boundary-"));
		expect(boundarySteps).toHaveLength(3);
		for (const boundary of boundarySteps) {
			expect(boundary.freshServices).toBe(true);
			expect(boundary.command).toContain("--case-set=boundary");
			expect(boundary.command).toContain("--case-ids=boundary-");
		}
		const boundaryReportDirs = boundarySteps.map((step) => step.command.match(/--report-dir=.*?boundary-[a-z-]+/)?.[0] ?? "");
		expect(new Set(boundaryReportDirs).size).toBe(3);
		const correctness = plan.artifacts.find((artifact) => artifact.id === "external-correctness");
		expect(correctness?.expectedCases).toEqual(CORRECTNESS_FULL_EXTERNAL_CASE_IDS);
	});

	it("skips history import on a dirty nightly tree and can request a perf gate", () => {
		const dirty = buildNightlyPlan(context({ cleanTree: false }));
		expect(dirty.steps.find((step) => step.id === "external-performance-standard")?.command).not.toContain(
			"--import-current-to-history=true"
		);
		const requested = buildLabEvidencePlan("smoke", context({ perfRequest: true }));
		expect(stepIds(requested)).toContain("perf-request");
		expect(artifactIds(requested)).toContain("perf-request");
	});

	it("builds single-mode plans from resolved selections", () => {
		const vitestPlan = buildSinglePlan(context(), {
			selections: [{ kind: "vitest", files: ["apps/frontend/src/a.spec.ts"] }],
			unresolved: [],
		});
		expect(stepIds(vitestPlan)).toEqual(["frontend-test", "source-check"]);
		expect(vitestPlan.steps[0]?.command).toContain("apps/frontend/src/a.spec.ts");

		const goPlan = buildSinglePlan(context(), {
			selections: [{ kind: "go", packages: ["./internal/room"], runPattern: "TestWindow" }],
			unresolved: [],
		});
		expect(stepIds(goPlan)).toEqual(["go-test", "source-check"]);
		expect(goPlan.steps[0]?.command).toContain("-run");

		const externalPlan = buildSinglePlan(context(), {
			selections: [{ kind: "external", caseIds: ["harness-health"] }],
			unresolved: [],
		});
		expect(stepIds(externalPlan)).toEqual(["external-focused", "source-check"]);
		expect(externalPlan.artifacts.find((artifact) => artifact.id === "external-focused")?.expectedCases).toEqual([
			"harness-health",
		]);
	});

	it("refuses a single-mode run with no resolvable target", () => {
		expect(() => buildSinglePlan(context(), { selections: [], unresolved: ["file:missing.ts"] })).toThrow(
			/no resolvable targets/
		);
		expect(() => buildLabEvidencePlan("single", context(), undefined)).toThrow();
	});
});
