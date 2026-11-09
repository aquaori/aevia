// File role: deterministic checks for the lab evidence plans behind smoke/nightly/single modes.
import { describe, expect, it } from "vitest";
import {
	buildLabEvidencePlan,
	buildNightlyPlan,
	buildSinglePlan,
	buildSmokePlan,
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
		const raceSteps: string[] = [];
		expect(stepIds(plan)).toEqual([
			"build",
			"go-vet",
			"go-package-list",
			"go-test",
			"frontend-test",
			"browser-test",
			"external-e2e",
			...raceSteps,
			"go-fuzz",
			"lab-inventory",
			"external-performance-standard",
			"external-performance-resilience",
			"external-performance-boundary-full-render",
			"external-performance-boundary-heap-growth",
			"external-performance-boundary-redraw-freeze",
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
		expect(plan.steps.find(step => step.id === "go-fuzz")?.env?.GOCACHE).toContain("go-fuzz-cache");
		expect(standard?.command).toContain("--case-set=standard");
		expect(standard?.command).toContain("--matrix=true");
		expect(standard?.command).not.toContain("--import-current-to-history=true");
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
		expect(goPlan.steps[0]?.command).toContain("go test -json");

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

it("includes race only from an explicit capability and requires every matrix key", () => {
	const plan = buildNightlyPlan(context({ goRaceSupported: true }));
	expect(stepIds(plan)).toContain("go-race");
	expect(plan.artifacts.find(item => item.id === "performance-external-standard")?.expectedCaseKeys).toHaveLength(20);
});
it("routes focused performance cases to their owning suite and preserves dimensional keys", () => {
	const plan = buildSinglePlan(context(), { selections: [{ kind: "external", caseIds: ["full-render-10000"], caseKeys: ["full-render-10000|gpu_cpuLow|10000"] }], unresolved: [] });
	expect(plan.steps[0]!.command).toContain("--suite=performance-external");
	expect(plan.steps[0]!.command).toContain("--case-keys=");
	expect(plan.artifacts[0]?.expectedCaseKeys).toEqual(["full-render-10000|gpu_cpuLow|10000"]);
});

it("does not omit a required race step when capability probing fails", () => {
	expect(stepIds(buildNightlyPlan(context({ goRaceSupported: false, goRaceRequired: true })))).toContain("go-race");
});

it("partitions Windows performance and Linux quality without dropping required evidence", () => {
	const quality = buildNightlyPlan(context({ lane: "quality", goRaceRequired: true }));
	expect(stepIds(quality)).toContain("go-race");
	expect(stepIds(quality)).toContain("go-fuzz");
	expect(stepIds(quality).some(id => id.startsWith("external-performance"))).toBe(false);
	expect(quality.artifacts.some(item => item.kind === "external" && item.id === "external-correctness")).toBe(true);
	const performance = buildNightlyPlan(context({ lane: "performance", goRaceSupported: true }));
	expect(stepIds(performance)).toContain("external-performance-standard");
	expect(stepIds(performance)).not.toContain("go-race");
	expect(stepIds(performance)).not.toContain("go-fuzz");
	const standard = buildNightlyPlan(context({ lane: "performance-standard" }));
	const boundary = buildNightlyPlan(context({ lane: "performance-boundary" }));
	expect(stepIds(standard)).toContain("external-performance-standard");
	expect(stepIds(standard)).toContain("external-performance-resilience");
	expect(stepIds(standard).some(id => id.startsWith("external-performance-boundary-"))).toBe(false);
	expect(stepIds(boundary).filter(id => id.startsWith("external-performance-boundary-"))).toHaveLength(3);
	expect(stepIds(boundary)).not.toContain("external-performance-standard");
	for (const plan of [standard, boundary]) expect(plan.artifacts.every(item => stepIds(plan).includes(item.stepId))).toBe(true);
	for (const plan of [quality, performance]) expect(plan.artifacts.every(item => stepIds(plan).includes(item.stepId))).toBe(true);
});
