import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAggregate, shouldPublishLatest } from "./aggregate";
import type { LabGateReport, LabInventoryReport, RunManifest } from "./contract";

const temporaryDirs: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const createFixture = () => {
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aevia-report-"));
	temporaryDirs.push(runDir);
	const coverageSource = path.join(runDir, "src", "room.ts");
	const manifest: RunManifest = {
		schemaVersion: 2,
		runId: "run-123",
		profile: "ci",
		mode: "ci",
		status: "passed",
		source: { revision: "a".repeat(40), dirtyPatchSha256: "b".repeat(64) },
		startedAt: "2026-10-07T00:00:00.000Z",
		finishedAt: "2026-10-07T00:01:00.000Z",
		validity: { status: "valid", aborted: false, reasons: [] },
		recorded: true,
		expectedSteps: ["verification"],
		steps: [{ id: "verification", title: "Verification", status: "passed" }],
		expectedArtifacts: [
			{ id: "feature-catalog", stepId: "verification", kind: "feature-catalog", path: "feature-catalog.json" },
			{ id: "vitest", stepId: "verification", kind: "vitest", path: "vitest.json" },
			{ id: "coverage", stepId: "verification", kind: "coverage", path: "coverage-summary.json", expectedSources: [coverageSource] },
			{ id: "go-tests", stepId: "verification", kind: "go-test", path: "go-tests.jsonl", expectedCases: ["example/room"] },
			{ id: "go-coverage", stepId: "verification", kind: "go-coverage", path: "go-coverage.out", expectedCases: ["example/room"] },
			{ id: "go-packages", stepId: "verification", kind: "package-list", path: "go-packages.txt" },
			{ id: "external", stepId: "verification", kind: "external", path: "external.json", expectedCases: ["room-create"] },
		],
	};
	const write = (name: string, value: unknown) => fs.writeFileSync(path.join(runDir, name), typeof value === "string" ? value : JSON.stringify(value));
	write("feature-catalog.json", {
		schemaVersion: 1,
		scope: "Backend test fixture only",
		obligations: [
			{ id: "http.create", kind: "http", surface: "POST /rooms", state: "obligation_verified", oracle: "Creates a room", evidence: [] },
			{ id: "http.check", kind: "http", surface: "GET /rooms/{id}", state: "partial", oracle: "Checks a room", evidence: [] },
			{ id: "scene.delete", kind: "scene", surface: "element.delete", state: "uncovered", oracle: "Deletes only requested items", evidence: [] },
			{ id: "http.reserved", kind: "http", surface: "POST /v2/rooms", state: "rejection_contract_verified", oracle: "Returns 501", evidence: [] },
		],
	});
	write("vitest.json", { success: true, numTotalTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 });
	write("coverage-summary.json", {
		total: {
			statements: { total: 10, covered: 8 },
			functions: { total: 5, covered: 4 },
			branches: { total: 10, covered: 7 },
			lines: { total: 9, covered: 7 },
		},
		[coverageSource]: {
			statements: { total: 10, covered: 8 },
			functions: { total: 5, covered: 4 },
			branches: { total: 10, covered: 7 },
			lines: { total: 9, covered: 7 },
		},
	});
	write("go-tests.jsonl", JSON.stringify({ Action: "pass", Package: "example/room" }));
	write("go-coverage.out", "mode: set\nexample/room/room.go:1.1,2.1 2 1\nexample/room/room.go:2.1,2.1 0 0\nexample/room/room.go:3.1,4.1 3 0\n");
	write("go-packages.txt", "example/room\n");
	write("external.json", {
		run: { id: manifest.runId, sourceRevision: manifest.source.revision, dirtyPatchSha256: manifest.source.dirtyPatchSha256 },
		summary: { total: 1, passed: 1, failed: 0 },
		results: [{ id: "room-create", status: "passed" }],
	});
	return { manifest, runDir, write };
};

describe("run evidence aggregation", () => {
	it("accepts complete evidence bound to this run and source revision", () => {
		const { manifest, runDir } = createFixture();
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("passed");
		expect(report.artifacts).toHaveLength(7);
		const featureCatalog = report.artifacts.find((artifact) => artifact.id === "feature-catalog");
		expect(featureCatalog?.featureInventory).toEqual({
			scope: "Backend test fixture only",
			sourceSurfaceCount: 4,
			stateCounts: { obligation_verified: 1, partial: 1, uncovered: 1, rejection_contract_verified: 1 },
			unresolvedIds: ["http.check", "scene.delete"],
		});
	});

	it("fails closed when the run-scoped feature catalog is malformed", () => {
		const { manifest, runDir, write } = createFixture();
		write("feature-catalog.json", { schemaVersion: 1, obligations: [{ id: "duplicate" }, { id: "duplicate" }] });
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("feature-catalog"))).toBe(true);
	});

	it("rejects unfinished runs and non-passed required steps", () => {
		const { manifest, runDir } = createFixture();
		manifest.status = "running";
		manifest.steps[0].status = "skipped";
		expect(buildAggregate(manifest, runDir).status).toBe("failed");
	});

	it("rejects a missing current-run artifact instead of reusing history", () => {
		const { manifest, runDir } = createFixture();
		fs.rmSync(path.join(runDir, "external.json"));
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("Expected current-run artifact is missing"))).toBe(true);
	});

	it("rejects skipped Vitest cases and empty coverage denominators", () => {
		const { manifest, runDir, write } = createFixture();
		write("vitest.json", { success: true, numTotalTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0 });
		const expectedCoverage = manifest.expectedArtifacts.find((artifact) => artifact.kind === "coverage")!;
		write("coverage-summary.json", {
			total: {
				statements: { total: 0, covered: 0 },
				functions: { total: 0, covered: 0 },
				branches: { total: 0, covered: 0 },
				lines: { total: 0, covered: 0 },
			},
			[expectedCoverage.expectedSources![0]!]: {
				statements: { total: 0, covered: 0 },
				functions: { total: 0, covered: 0 },
				branches: { total: 0, covered: 0 },
				lines: { total: 0, covered: 0 },
			},
		});
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("did not run"))).toBe(true);
		expect(report.failures.some((failure) => failure.includes("empty denominator"))).toBe(true);
	});

	it("rejects a missing source file from the frontend coverage denominator", () => {
		const { manifest, runDir } = createFixture();
		const expectedCoverage = manifest.expectedArtifacts.find((artifact) => artifact.kind === "coverage")!;
		expectedCoverage.expectedSources!.push(path.join(runDir, "src", "unmeasured.ts"));
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("missing source files"))).toBe(true);
	});

	it("rejects coverage summaries that omit a required metric dimension", () => {
		const { manifest, runDir, write } = createFixture();
		const summary = JSON.parse(fs.readFileSync(path.join(runDir, "coverage-summary.json"), "utf8"));
		delete summary.total.branches;
		write("coverage-summary.json", summary);
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("denominator for branches"))).toBe(true);
	});

	it("rejects external reports from another source and incomplete case lists", () => {
		const { manifest, runDir, write } = createFixture();
		write("external.json", {
			run: { id: manifest.runId, sourceRevision: "c".repeat(40), dirtyPatchSha256: manifest.source.dirtyPatchSha256 },
			summary: { total: 1, passed: 1, failed: 0 },
			results: [],
		});
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("source identity"))).toBe(true);
	});

	it("rejects duplicate and unexpected external case IDs", () => {
		const { manifest, runDir, write } = createFixture();
		write("external.json", {
			run: { id: manifest.runId, sourceRevision: manifest.source.revision, dirtyPatchSha256: manifest.source.dirtyPatchSha256 },
			summary: { total: 2, passed: 2, failed: 0 },
			results: [
				{ id: "room-create", status: "passed" },
				{ id: "room-create", status: "passed" },
				{ id: "extra", status: "passed" },
			],
		});
		expect(buildAggregate(manifest, runDir).status).toBe("failed");
	});

	it("rejects duplicate or unexpected step results", () => {
		const { manifest, runDir } = createFixture();
		manifest.steps.push({ id: "verification", title: "Duplicate", status: "passed" });
		manifest.steps.push({ id: "extra", title: "Unexpected", status: "passed" });
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("Duplicate step"))).toBe(true);
		expect(report.failures.some((failure) => failure.includes("Unexpected step"))).toBe(true);
	});

	it("rejects a Go package inventory that does not match the test output", () => {
		const { manifest, runDir, write } = createFixture();
		write("go-tests.jsonl", JSON.stringify({ Action: "pass", Package: "example/other" }));
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("missing Go packages"))).toBe(true);
	});

	it("accepts legitimate zero-statement Go profile blocks but rejects an all-zero denominator", () => {
		const { manifest, runDir, write } = createFixture();
		const report = buildAggregate(manifest, runDir);
		const goCoverage = report.artifacts.find((artifact) => artifact.id === "go-coverage");
		expect(goCoverage?.status).toBe("passed");
		expect(goCoverage?.total).toBe(5);

		write("go-coverage.out", "mode: set\nroom.go:1.1,1.1 0 0\n");
		const emptyReport = buildAggregate(manifest, runDir);
		expect(emptyReport.status).toBe("failed");
		expect(emptyReport.failures.some((failure) => failure.includes("empty denominator"))).toBe(true);
	});
});

const validGatePayload = (): LabGateReport => ({
	schemaVersion: 1,
	policy: { warnRatio: 0.25, abortRatio: 1 },
	status: "valid",
	aborted: false,
	cases: [
		{
			scenarioKey: "correctness-full/standard",
			caseKey: "room-create",
			id: "room-create",
			suite: "correctness-full",
			status: "valid",
			codes: [],
			details: [],
		},
	],
	scenarios: [
		{ scenarioKey: "correctness-full/standard", suite: "correctness-full", attempted: 1, valid: 1, invalid: 0, verdict: "passed" },
	],
	instrumentation: { enabled: true, contractVersion: 1, missingMarks: [] },
	reasons: [],
});

const validInventoryPayload = (): LabInventoryReport => ({
	schemaVersion: 1,
	scope: "frontend and Go source modules",
	obligations: [
		{
			id: "frontend:src/scene/sceneEngine.ts",
			kind: "frontend",
			path: "apps/frontend/src/scene/sceneEngine.ts",
			state: "covered",
			owner: "apps/frontend/src/scene/sceneEngine.spec.ts",
		},
		{
			id: "go:internal/console",
			kind: "go",
			path: "apps/backend/internal/console",
			state: "partial",
			owner: "apps/backend/internal/console/handler_test.go",
		},
		{ id: "frontend:src/foo.ts", kind: "frontend", path: "apps/frontend/src/foo.ts", state: "excluded", reason: "generated fixture" },
	],
});

const createLabFixture = () => {
	const fixture = createFixture();
	fixture.manifest.expectedArtifacts.push(
		{ id: "lab-gate", stepId: "verification", kind: "lab-gate", path: "lab-gate.json" },
		{ id: "lab-inventory", stepId: "verification", kind: "lab-inventory", path: "lab-inventory.json" }
	);
	fixture.write("lab-gate.json", validGatePayload());
	fixture.write("lab-inventory.json", validInventoryPayload());
	return fixture;
};

describe("lab measurement gate aggregation", () => {
	it("accepts a valid gate and cross-checks its cases against external results", () => {
		const { manifest, runDir } = createLabFixture();
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("passed");
		const gate = report.artifacts.find((artifact) => artifact.id === "lab-gate");
		expect(gate?.status).toBe("passed");
		expect(gate?.caseIds).toEqual(["room-create"]);
		const inventory = report.artifacts.find((artifact) => artifact.id === "lab-inventory");
		expect(inventory?.inventory).toEqual({
			total: 3,
			covered: 1,
			partial: 1,
			uncovered: 0,
			excluded: 1,
			unresolvedIds: ["go:internal/console", "frontend:src/foo.ts"],
		});
	});

	it("fails closed when any case measurement is invalid", () => {
		const { manifest, runDir, write } = createLabFixture();
		const gate = validGatePayload();
		gate.status = "degraded";
		gate.cases[0]!.status = "invalid";
		gate.cases[0]!.codes = ["MISSING_MARK"];
		gate.scenarios[0] = { ...gate.scenarios[0]!, valid: 0, invalid: 1, verdict: "invalid" };
		write("lab-gate.json", gate);
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("invalid measurements"))).toBe(true);
		expect(report.failures.some((failure) => failure.includes("MISSING_MARK"))).toBe(true);
	});

	it("rejects aborted runs and keeps them out of the recorded evidence", () => {
		const { manifest, runDir } = createLabFixture();
		manifest.validity = {
			status: "invalid",
			aborted: true,
			reasons: [{ scope: "run", id: manifest.runId, code: "LAB_RUNTIME_MISSING" }],
		};
		manifest.recorded = false;
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("aborted"))).toBe(true);
		expect(report.failures.some((failure) => failure.includes("LAB_RUNTIME_MISSING"))).toBe(true);
		expect(shouldPublishLatest(manifest, report)).toBe(false);
	});

	it("accepts degraded validity when the run itself was not aborted", () => {
		const { manifest, runDir } = createFixture();
		manifest.validity = {
			status: "degraded",
			aborted: false,
			reasons: [{ scope: "case", id: "room-create", code: "EXTERNAL_DISAGREEMENT" }],
		};
		expect(buildAggregate(manifest, runDir).status).toBe("passed");
	});

	it("rejects a gate whose case coverage does not match external results", () => {
		const { manifest, runDir, write } = createLabFixture();
		const gate = validGatePayload();
		gate.cases[0] = { ...gate.cases[0]!, id: "other-case", caseKey: "other-case" };
		write("lab-gate.json", gate);
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("does not match external results"))).toBe(true);
	});

	it("validates the module inventory snapshot", () => {
		const { manifest, runDir, write } = createLabFixture();
		const inventory = validInventoryPayload();
		delete inventory.obligations[2]!.reason;
		write("lab-inventory.json", inventory);
		const report = buildAggregate(manifest, runDir);
		expect(report.status).toBe("failed");
		expect(report.failures.some((failure) => failure.includes("excluded without a reason"))).toBe(true);
	});

	it("only publishes the latest pointer for valid, recorded, passing runs", () => {
		const { manifest, runDir } = createLabFixture();
		const report = buildAggregate(manifest, runDir);
		expect(shouldPublishLatest(manifest, report)).toBe(true);
		expect(shouldPublishLatest({ ...manifest, recorded: false }, report)).toBe(false);
		expect(
			shouldPublishLatest({ ...manifest, validity: { status: "invalid", aborted: false, reasons: [] } }, report)
		).toBe(false);
		expect(shouldPublishLatest(manifest, { ...report, status: "failed" })).toBe(false);
	});
});
