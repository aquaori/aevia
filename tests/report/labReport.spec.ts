// File role: regression tests for the unified lab report model/writer and its HTML page.
//
// The fixture builds one synthetic run directory (manifest v2 + vitest/browser reports +
// Go JSONL + external results + lab-gate + coverage + obligations + logs + an image) and
// then asserts the report fields, the rerun index, and the graceful-degradation path for
// a run directory with almost no artifacts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AggregateReport } from "./aggregate";
import type { RunManifest } from "./contract";
import { writeLabReport } from "./lab-report";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const REVISION = "a".repeat(40);
const DIRTY = "b".repeat(64);
const temporaryRoots: string[] = [];

const writeFile = (filePath: string, content: string) => {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
};

const writeJson = (filePath: string, value: unknown) => writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);

const makeManifest = (): RunManifest => ({
	schemaVersion: 2,
	runId: RUN_ID,
	profile: "ci",
	mode: "ci",
	status: "passed",
	source: {
		revision: REVISION,
		dirtyPatchSha256: DIRTY,
		trackedChanges: [],
		untrackedFiles: [],
	},
	startedAt: "2026-10-31T00:00:00.000Z",
	finishedAt: "2026-10-31T00:01:00.000Z",
	expectedSteps: ["frontend-test", "external-e2e"],
	steps: [
		{ id: "frontend-test", title: "Frontend and shared coverage tests", status: "passed", durationMs: 1200 },
		{ id: "external-e2e", title: "External correctness E2E", status: "passed", durationMs: 3000 },
	],
	expectedArtifacts: [
		{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" },
		{ id: "external-correctness", stepId: "external-e2e", kind: "external", path: "external/correctness-full-external-results.json" },
	],
	validity: {
		status: "degraded",
		aborted: false,
		reasons: [{ scope: "case", id: "gpu_cpuHigh::correctness-smoke", code: "MISSING_MARK", detail: "missing mark" }],
	},
	recorded: true,
	measurement: { policy: "prefer-instrumented" },
});

const makeAggregate = (): AggregateReport => ({
	schemaVersion: 2,
	runId: RUN_ID,
	status: "passed",
	generatedAt: "2026-10-31T00:01:00.000Z",
	manifest: "run-manifest.json",
	profile: "ci",
	mode: "ci",
	validity: {
		status: "degraded",
		aborted: false,
		reasons: [{ scope: "case", id: "gpu_cpuHigh::correctness-smoke", code: "MISSING_MARK", detail: "missing mark" }],
	},
	recorded: true,
	source: { revision: REVISION, dirtyPatchSha256: DIRTY, trackedChanges: [], untrackedFiles: [] },
	steps: [
		{ id: "frontend-test", title: "Frontend and shared coverage tests", status: "passed", durationMs: 1200 },
		{ id: "external-e2e", title: "External correctness E2E", status: "passed", durationMs: 3000 },
	],
	artifacts: [
		{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", status: "passed", total: 3, passed: 3, failed: 0 },
		{
			id: "external-correctness",
			stepId: "external-e2e",
			kind: "external",
			status: "passed",
			total: 2,
			passed: 1,
			failed: 1,
			caseIds: ["correctness-smoke", "concurrent-crossing-visual-consistency"],
		},
	],
	failures: ["external-correctness: one case did not pass"],
});

const vitestFixture = () => ({
	success: true,
	numTotalTests: 3,
	numFailedTests: 1,
	numPendingTests: 0,
	numTodoTests: 0,
	testResults: [
		{
			name: "apps/frontend/src/scene/sceneEngine.spec.ts",
			status: "passed",
			assertionResults: [
				{ fullName: "scene engine > render order", status: "passed", duration: 5, failureMessages: [] },
				{ fullName: "scene engine > erase history", status: "passed", duration: 7, failureMessages: [] },
			],
		},
		{
			name: "apps/frontend/src/service/localCommandService.spec.ts",
			status: "failed",
			assertionResults: [
				{ fullName: "local command service > presets", status: "failed", duration: 11, failureMessages: ["expected 1 got 2"] },
			],
		},
	],
});

const browserFixture = () => ({
	success: true,
	numTotalTests: 1,
	numFailedTests: 0,
	testResults: [
		{
			name: "apps/frontend/tests/browser/scene-dirty-render.browser.spec.ts",
			status: "passed",
			assertionResults: [{ fullName: "dirty render matches full replay", status: "passed", duration: 9 }],
		},
	],
});

const goFixture = () =>
	[
		{ Action: "run", Package: "collaborative-whiteboard/apps/backend/internal/domain", Test: "TestCompareFlatPoint" },
		{ Action: "pass", Package: "collaborative-whiteboard/apps/backend/internal/domain", Test: "TestCompareFlatPoint", Elapsed: 0.001 },
		{ Action: "pass", Package: "collaborative-whiteboard/apps/backend/internal/domain", Elapsed: 0.02 },
	]
		.map((event) => JSON.stringify(event))
		.join("\n");

const goCoverageFixture = () =>
	[
		"mode: set",
		"collaborative-whiteboard/apps/backend/internal/domain/types.go:10.20,12.2 2 1",
		"collaborative-whiteboard/apps/backend/internal/domain/types.go:14.20,16.2 4 0",
	].join("\n");

const frontendCoverageFixture = () => ({
	total: {
		statements: { total: 10, covered: 5, pct: 50 },
		branches: { total: 4, covered: 1, pct: 25 },
		functions: { total: 2, covered: 1, pct: 50 },
		lines: { total: 9, covered: 5, pct: 55.56 },
	},
	"apps/frontend/src/scene/sceneEngine.ts": {
		statements: { total: 10, covered: 5, pct: 50 },
		branches: { total: 4, covered: 1, pct: 25 },
		functions: { total: 2, covered: 1, pct: 50 },
		lines: { total: 9, covered: 5, pct: 55.56 },
	},
});

const correctnessReportFixture = (artifactPath: string) => ({
	version: 1,
	generatedAt: "2026-10-31T00:00:40.000Z",
	run: { id: RUN_ID, sourceRevision: REVISION, dirtyPatchSha256: DIRTY },
	config: { suite: "correctness-full", mode: "headless", caseSet: "all", environment: "gpu_cpuHigh" },
	summary: { total: 2, passed: 1, failed: 1 },
	results: [
		{
			id: "correctness-smoke",
			title: "Correctness smoke",
			category: "correctness",
			environment: "gpu_cpuHigh",
			status: "passed",
			failureType: "none",
			durationMs: 1000,
			metrics: { diffRatio: 0.001, passThreshold: 0.012 },
			artifacts: [artifactPath],
		},
		{
			id: "concurrent-crossing-visual-consistency",
			title: "Concurrent crossing consistency",
			category: "correctness",
			environment: "gpu_cpuHigh",
			status: "failed",
			failureType: "correctness",
			durationMs: 1200,
			metrics: {},
			error: "pixel diff 0.5",
		},
	],
	regressions: [],
	learning: {
		historyEntries: 0,
		learnedChecks: 0,
		insufficientHistory: 0,
		normal: 0,
		suspected: 0,
		confirmed: 0,
		anomalyChecks: 0,
		anomalyStable: 0,
		anomalyWatch: 0,
		anomalyRecurring: 0,
		ruleSuspected: 0,
		baselineRecommendations: 0,
	},
	learnedRegressions: [],
	baselineRecommendations: [],
});

const performanceReportFixture = () => ({
	version: 1,
	generatedAt: "2026-10-31T00:00:50.000Z",
	run: { id: RUN_ID, sourceRevision: REVISION, dirtyPatchSha256: DIRTY },
	config: { suite: "performance-external", mode: "headless", caseSet: "all", environment: "gpu_cpuHigh" },
	summary: { total: 1, passed: 1, failed: 0 },
	results: [
		{
			id: "full-render-10000",
			title: "Full render late joiner",
			category: "performance",
			environment: "gpu_cpuHigh",
			scale: 10000,
			status: "passed",
			failureType: "none",
			durationMs: 500,
			metrics: {
				firstNonBlankMsMedian: 40,
				firstNonBlankMsInstrumented: 42,
				visuallyStableMsMedian: 60,
				nonBlankRatio: 0.2,
			},
			samples: [],
			regression: {
				caseKey: "gpu_cpuHigh::full-render-10000",
				id: "full-render-10000",
				status: "passed",
				checks: [
					{
						metric: "firstNonBlankMsMedian",
						label: "首个非空画面中位数",
						source: "baseline",
						status: "passed",
						trend: "regressed",
						current: 40,
						baseline: 34,
						allowedMax: 44,
						delta: 6,
						deltaPercent: 17.6,
						message: "within tolerance",
					},
					{
						metric: "firstNonBlankMsMedian",
						label: "首个非空画面中位数",
						source: "budget",
						status: "passed",
						trend: "regressed",
						current: 40,
						allowedMax: 44,
						delta: -4,
						deltaPercent: -9.1,
						message: "within budget",
					},
				],
			},
			learning: {
				caseKey: "gpu_cpuHigh::full-render-10000",
				id: "full-render-10000",
				status: "normal",
				checks: [
					{ metric: "firstNonBlankMsMedian", label: "首个非空画面中位数", status: "normal", current: 40, sampleCount: 12, learnedMedian: 38, message: "normal" },
				],
				anomalyChecks: [],
				baselineHealth: [],
				recommendations: [],
			},
		},
	],
	regressions: [],
	learning: {
		historyEntries: 12,
		learnedChecks: 1,
		insufficientHistory: 0,
		normal: 1,
		suspected: 0,
		confirmed: 0,
		anomalyChecks: 0,
		anomalyStable: 0,
		anomalyWatch: 0,
		anomalyRecurring: 0,
		ruleSuspected: 0,
		baselineRecommendations: 0,
	},
	learnedRegressions: [],
	baselineRecommendations: [],
});

const gateFixture = (artifactPath: string) => ({
	schemaVersion: 1,
	policy: { warnRatio: 0.1, abortRatio: 0.5 },
	status: "degraded",
	aborted: false,
	cases: [
		{
			scenarioKey: "correctness-full:all",
			caseKey: "gpu_cpuHigh::correctness-smoke",
			id: "correctness-smoke",
			suite: "correctness-full",
			status: "invalid",
			codes: ["MISSING_MARK"],
			details: ["render mark not observed"],
		},
	],
	scenarios: [
		{ scenarioKey: "correctness-full:all", suite: "correctness-full", attempted: 2, valid: 1, invalid: 1, verdict: "invalid" },
	],
	instrumentation: { enabled: false, contractVersion: null, missingMarks: ["aevia.render.firstNonBlank"] },
	reasons: [{ scope: "case", id: "gpu_cpuHigh::correctness-smoke", code: "MISSING_MARK", detail: "render mark not observed" }],
	artifact: artifactPath,
});

const createRunDirectory = (): { tempRoot: string; runDir: string; manifest: RunManifest; aggregate: AggregateReport } => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aevia-lab-report-"));
	temporaryRoots.push(tempRoot);
	const runDir = path.join(tempRoot, "tests", "reports", "summary", "runs", RUN_ID);
	const manifest = makeManifest();
	manifest.expectedArtifacts.push(
		{ id: "performance", stepId: "external-e2e", kind: "external", path: "external/performance-external-all-external-results.json" },
		{ id: "gate", stepId: "external-e2e", kind: "lab-gate", path: "external/correctness-full-lab-gate.json" },
	);
	const aggregate = makeAggregate();
	const screenshot = path.join(runDir, "external", "artifacts", "correctness-smoke-shot.png");

	writeJson(path.join(runDir, "run-manifest.json"), manifest);
	writeJson(path.join(runDir, "test-report.json"), aggregate);
	writeFile(path.join(runDir, "logs", "frontend-test.log"), "frontend tests ok\n");
	writeJson(path.join(runDir, "frontend", "vitest.json"), vitestFixture());
	writeJson(path.join(runDir, "frontend", "browser.json"), browserFixture());
	writeFile(path.join(runDir, "backend", "go-tests.jsonl"), goFixture());
	writeFile(path.join(runDir, "backend", "coverage.out"), goCoverageFixture());
	writeFile(path.join(runDir, "backend", "packages.txt"), "collaborative-whiteboard/apps/backend/internal/domain\n");
	writeJson(path.join(runDir, "frontend", "coverage", "coverage-summary.json"), frontendCoverageFixture());
	writeJson(path.join(runDir, "external", "correctness-full-external-results.json"), correctnessReportFixture(screenshot));
	writeJson(path.join(runDir, "external", "performance-external-all-external-results.json"), performanceReportFixture());
	writeJson(path.join(runDir, "external", "correctness-full-lab-gate.json"), gateFixture(screenshot));
	writeJson(path.join(runDir, "catalog", "feature-obligations.json"), {
		schemaVersion: 1,
		scope: "fixture feature catalog",
		obligations: [
			{ id: "scene.element-create", kind: "scene", surface: "element.create", state: "obligation_verified", oracle: "o", evidence: [] },
			{ id: "scene.page-clear", kind: "scene", surface: "page.clear", state: "uncovered", oracle: "o", evidence: [] },
			{ id: "frontend.tool.pen", kind: "frontend", surface: "tool:pen", state: "partial", oracle: "o", evidence: [] },
		],
	});
	writeJson(path.join(runDir, "catalog", "lab-inventory.json"), {
		schemaVersion: 1,
		scope: "fixture inventory",
		obligations: [
			{ id: "frontend.scene", kind: "frontend", path: "apps/frontend/src/scene", state: "covered", owner: "sceneEngine.spec.ts" },
			{ id: "go.room", kind: "go", path: "apps/backend/internal/room", state: "partial", owner: "index_test.go" },
			{ id: "go.console", kind: "go", path: "apps/backend/internal/console", state: "excluded", reason: "CLI only" },
		],
	});
	fs.mkdirSync(path.dirname(screenshot), { recursive: true });
	fs.writeFileSync(screenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	return { tempRoot, runDir, manifest, aggregate };
};

const readEmbeddedLabData = (html: string) => {
	const match = /<script type="application\/json" id="lab-data">([\s\S]*?)<\/script>/.exec(html);
	expect(match).not.toBeNull();
	return JSON.parse(match![1]!) as Record<string, unknown>;
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("unified lab report", () => {
	it("builds lab-report.json and the lab HTML from a complete run directory", () => {
		const { runDir, manifest, aggregate } = createRunDirectory();
		const report = writeLabReport({ runDir, manifest, aggregate });

		expect(report.schemaVersion).toBe(2);
		expect(report.run).toMatchObject({
			id: RUN_ID,
			mode: "ci",
			profile: "ci",
			status: "passed",
			recorded: true,
		});
		expect(report.run.validity.status).toBe("degraded");
		expect(report.run.durationMs).toBe(60_000);
		expect(report.steps).toHaveLength(2);
		expect(report.artifacts).toBe(aggregate.artifacts);

		// Gate + instrumentation are lifted from external/*-lab-gate.json.
		expect(report.gate.derived).toBe(false);
		expect(report.gate.status).toBe("degraded");
		expect(report.gate.sources).toEqual(["external/correctness-full-lab-gate.json"]);
		expect(report.gate.cases).toHaveLength(1);
		expect(report.gate.cases[0]!.codes).toEqual(["MISSING_MARK"]);
		expect(report.gate.scenarios[0]!.verdict).toBe("invalid");
		expect(report.instrumentation.missingMarks).toContain("aevia.render.firstNonBlank");
		expect(report.instrumentation.enabled).toBe(false);

		// Vitest reports are split into unit vs integration, browser is separate.
		expect(report.suites.unit.total).toBe(2);
		expect(report.suites.unit.failed).toBe(0);
		expect(report.suites.integration.total).toBe(1);
		expect(report.suites.integration.failed).toBe(1);
		expect(report.suites.browser.total).toBe(1);
		expect(report.suites.unit.cases[0]!.rerunIds).toEqual(["apps/frontend/src/scene/sceneEngine.spec.ts"]);

		// Go JSONL / coverage.
		expect(report.suites.go.total).toBe(1);
		expect(report.suites.go.passed).toBe(1);
		expect(report.suites.go.packages[0]!.package).toContain("internal/domain");

		// External grouping + measurements (instrumented/external, baseline, budget, learned).
		expect(report.suites.e2e.total).toBe(2);
		expect(report.suites.e2e.failed).toBe(1);
		expect(report.suites.performance.total).toBe(1);
		const firstNonBlank = report.measurements.find((item) => item.metric === "firstNonBlankMsMedian");
		expect(firstNonBlank).toBeDefined();
		expect(firstNonBlank).toMatchObject({
			caseKey: "gpu_cpuHigh::full-render-10000",
			env: "gpu_cpuHigh",
			scale: 10000,
			external: 40,
			instrumented: 42,
			witnessDeltaMs: 2,
			baseline: 34,
			budget: 44,
			learned: 38,
			source: "instrumented",
		});
		expect(firstNonBlank!.deltaPercent).toBeCloseTo(17.6, 1);
		const invalidMeasurement = report.measurements.find((item) => item.caseKey === "gpu_cpuHigh::correctness-smoke");
		expect(invalidMeasurement?.validity).toContain("invalid");

		// Coverage + obligations.
		expect(report.coverage.frontend?.metrics.statements?.percent).toBe(50);
		expect(report.coverage.frontend?.entries).toHaveLength(1);
		expect(report.coverage.go?.total).toMatchObject({ total: 6, covered: 2 });
		expect(report.obligations.featureCatalog?.total).toBe(3);
		expect(report.obligations.featureCatalog?.stateCounts).toMatchObject({ obligation_verified: 1, uncovered: 1, partial: 1 });
		expect(report.obligations.inventory).toMatchObject({ total: 3, covered: 1, partial: 1, uncovered: 0, excluded: 1 });

		// Failures + logs + gallery.
		expect(report.failures.some((item) => item.includes("external-correctness: one case did not pass"))).toBe(true);
		expect(report.failures.some((item) => item.includes("MISSING_MARK"))).toBe(true);
		expect(report.failures.some((item) => item.includes("concurrent-crossing-visual-consistency"))).toBe(true);
		expect(Object.keys(report.logs)).toContain("logs/frontend-test.log");
		expect(report.gallery.some((item) => item.kind === "image" && item.path === "external/artifacts/correctness-smoke-shot.png")).toBe(true);

		// Rerun index: file targets for vitest, external ids, gate scenarios.
		expect(report.rerun.cases.some((item) => item.id === "apps/frontend/src/scene/sceneEngine.spec.ts")).toBe(true);
		expect(report.rerun.cases.some((item) => item.id === "full-render-10000")).toBe(true);
		expect(report.rerun.scenarios.map((item) => item.scenarioKey)).toContain("correctness-full:all");

		// JSON + both HTML entry points are written.
		const json = JSON.parse(fs.readFileSync(path.join(runDir, "lab-report.json"), "utf8"));
		expect(json.schemaVersion).toBe(2);
		const labHtml = fs.readFileSync(path.join(runDir, "lab-report.html"), "utf8");
		const legacyHtml = fs.readFileSync(path.join(runDir, "test-report.html"), "utf8");
		expect(labHtml).toBe(legacyHtml);

		// Embedded data + rerun controls + offline hint.
		expect(labHtml).toContain('id="lab-data"');
		expect(labHtml).toContain('data-rerun-scope="case"');
		expect(labHtml).toContain('data-rerun-scope="scenario"');
		expect(labHtml).toContain('data-rerun-scope="run"');
		expect(labHtml).toContain('data-rerun-ids="full-render-10000|gpu_cpuHigh|10000"');
		expect(labHtml).toContain("需 npm run lab:serve");
		const embedded = readEmbeddedLabData(labHtml);
		expect(embedded.schemaVersion).toBe(2);
		expect((embedded.run as { id: string }).id).toBe(RUN_ID);
		expect((embedded.measurements as unknown[]).length).toBe(report.measurements.length);
	});

	it("degrades gracefully when most optional artifacts are missing (legacy manifest)", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aevia-lab-report-empty-"));
		temporaryRoots.push(tempRoot);
		const runDir = path.join(tempRoot, "tests", "reports", "summary", "runs", RUN_ID);
		const legacyManifest = {
			schemaVersion: 1,
			runId: RUN_ID,
			profile: "ci",
			status: "passed",
			source: { revision: REVISION, dirtyPatchSha256: DIRTY },
			startedAt: "2026-10-31T00:00:00.000Z",
			finishedAt: "2026-10-31T00:00:10.000Z",
			expectedSteps: [],
			steps: [],
			expectedArtifacts: [],
		};
		writeJson(path.join(runDir, "run-manifest.json"), legacyManifest);
		const aggregate = {
			...makeAggregate(),
			steps: [],
			artifacts: [],
			failures: [],
			status: "failed" as const,
		};

		const report = writeLabReport({
			runDir,
			manifest: legacyManifest as unknown as RunManifest,
			aggregate,
		});

		expect(report.schemaVersion).toBe(2);
		expect(report.run.mode).toBe("ci");
		expect(report.run.recorded).toBe(true);
		expect(report.run.validity.status).toBe("valid");
		expect(report.run.durationMs).toBe(10_000);
		expect(report.suites.unit.status).toBe("missing");
		expect(report.suites.integration.status).toBe("missing");
		expect(report.suites.browser.status).toBe("missing");
		expect(report.suites.go.status).toBe("missing");
		expect(report.suites.e2e.suites).toEqual([]);
		expect(report.suites.performance.suites).toEqual([]);
		expect(report.measurements).toEqual([]);
		expect(report.coverage.frontend).toBeNull();
		expect(report.coverage.go).toBeNull();
		expect(report.obligations.featureCatalog).toBeNull();
		expect(report.obligations.inventory).toBeNull();
		expect(report.logs).toEqual({});
		expect(report.gate.derived).toBe(true);
		expect(report.gate.status).toBe("valid");
		expect(report.rerun.cases).toEqual([]);
		expect(report.failures).toEqual([]);

		// Files are still written and the page still parses/renders.
		expect(fs.existsSync(path.join(runDir, "lab-report.json"))).toBe(true);
		expect(fs.existsSync(path.join(runDir, "lab-report.html"))).toBe(true);
		expect(fs.existsSync(path.join(runDir, "test-report.html"))).toBe(true);
		const html = fs.readFileSync(path.join(runDir, "lab-report.html"), "utf8");
		expect(html).toContain('id="lab-data"');
		expect(html).toContain("需 npm run lab:serve");
		const embedded = readEmbeddedLabData(html);
		expect(embedded.schemaVersion).toBe(2);
	});
});

it("keeps the report usable when external results exist but the gate is missing", () => {
	const { runDir, manifest, aggregate } = createRunDirectory();
	fs.renameSync(path.join(runDir, "external/correctness-full-lab-gate.json"), path.join(runDir, "gate-backup.json"));
	expect(() => writeLabReport({ runDir, manifest, aggregate })).not.toThrow();
});
