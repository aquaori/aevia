import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeChangeObligations } from "../lab/change-obligations";
import { mergeSelections, resolveChangeObligationPlan } from "../lab/resolve-only";
import { buildAggregate } from "./aggregate";
import type { ChangeObligationsReport, LabInventoryReport, RunManifest } from "./contract";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aevia-change-obligations-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

const createMinimalWorkspace = (rootDir: string, catalog: LabInventoryReport) => {
	const write = (rel: string, content: string) => {
		const abs = path.join(rootDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf8");
	};
	write("tests/catalog/module-obligations.json", JSON.stringify(catalog, null, 2));
	write("tests/catalog/feature-obligations.json", JSON.stringify({ schemaVersion: 1, scope: "test", obligations: [] }, null, 2));
	write("apps/frontend/src/service/foo.ts", "export const foo = 1;\n");
	write("apps/frontend/src/service/foo.spec.ts", "export const spec = true;\n");
	write("apps/frontend/src/components/Legacy.vue", "<template><div/></template>\n");
	write("apps/frontend/tests/browser/smoke.browser.spec.ts", "export const browserSpec = true;\n");
	write("apps/backend/internal/room/state.go", "package room\n");
	write("apps/backend/internal/room/state_test.go", "package room\nfunc TestRoomState() {}\n");
	write("packages/shared/src/protocol/collabProtocol.ts", "export const v = 1;\n");
	write("packages/shared/src/protocol/collabProtocol.spec.ts", "export const s = true;\n");
};

const baseCatalogFixture = (): LabInventoryReport => ({
	schemaVersion: 2,
	scope: "test",
	obligations: [
		{
			id: "frontend:apps/frontend/src/service/foo.ts",
			kind: "frontend",
			path: "apps/frontend/src/service/foo.ts",
			state: "covered",
			owner: "apps/frontend/src/service/foo.spec.ts",
			evidence: [{ kind: "vitest", file: "apps/frontend/src/service/foo.spec.ts", level: "module" }],
		},
		{
			id: "frontend:apps/frontend/src/components/Legacy.vue",
			kind: "frontend",
			path: "apps/frontend/src/components/Legacy.vue",
			state: "uncovered",
			recommendedEvidence: [{ kind: "browser", file: "apps/frontend/tests/browser/smoke.browser.spec.ts", level: "browser" }],
		},
		{
			id: "go:apps/backend/internal/room/state.go",
			kind: "go",
			path: "apps/backend/internal/room/state.go",
			state: "covered",
			owner: "apps/backend/internal/room/state_test.go",
			evidence: [{ kind: "go", package: "./internal/room", file: "apps/backend/internal/room/state_test.go", level: "unit" }],
		},
		{
			id: "shared:packages/shared/src/protocol/collabProtocol.ts",
			kind: "shared",
			path: "packages/shared/src/protocol/collabProtocol.ts",
			state: "covered",
			owner: "packages/shared/src/protocol/collabProtocol.spec.ts",
			evidence: [{ kind: "vitest", file: "packages/shared/src/protocol/collabProtocol.spec.ts", level: "unit" }],
		},
	],
});

describe("change obligations enforcement", () => {
	it("blocks newly added source without confirmed evidence even when recommendedEvidence exists", () => {
		const rootDir = makeTempDir();
		const catalog = baseCatalogFixture();
		catalog.obligations.push({
			id: "frontend:apps/frontend/src/service/newModule.ts",
			kind: "frontend",
			path: "apps/frontend/src/service/newModule.ts",
			state: "uncovered",
			recommendedEvidence: [{ kind: "vitest", file: "apps/frontend/src/service/foo.spec.ts" }],
		});
		createMinimalWorkspace(rootDir, catalog);
		fs.writeFileSync(path.join(rootDir, "apps/frontend/src/service/newModule.ts"), "export const n = 1;\n");

		const res = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [{ status: "A", path: "apps/frontend/src/service/newModule.ts" }],
		});

		expect(res.report.passed).toBe(false);
		expect(res.report.summary.newUncovered).toBe(1);
		expect(res.report.violations.some((v) => v.code === "NEW_FILE_UNCOVERED")).toBe(true);
	});

	it("accepts newly added source bound to valid confirmed evidence", () => {
		const rootDir = makeTempDir();
		const catalog = baseCatalogFixture();
		catalog.obligations.push({
			id: "frontend:apps/frontend/src/service/newModule.ts",
			kind: "frontend",
			path: "apps/frontend/src/service/newModule.ts",
			state: "covered",
			owner: "apps/frontend/src/service/foo.spec.ts",
			evidence: [{ kind: "vitest", file: "apps/frontend/src/service/foo.spec.ts", level: "module" }],
		});
		createMinimalWorkspace(rootDir, catalog);
		fs.writeFileSync(path.join(rootDir, "apps/frontend/src/service/newModule.ts"), "export const n = 1;\n");

		const res = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [{ status: "A", path: "apps/frontend/src/service/newModule.ts" }],
		});

		expect(res.report.passed).toBe(true);
		expect(res.report.selectedTargets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "vitest", file: "apps/frontend/src/service/foo.spec.ts" }),
			]),
		);
	});

	it("blocks modifying an existing historical uncovered file while keeping untouched uncovered debt non-blocking", () => {
		const rootDir = makeTempDir();
		createMinimalWorkspace(rootDir, baseCatalogFixture());

		// Modifying covered foo.ts does not fail due to untouched Legacy.vue (1 historicalDebt)
		const okRes = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [{ status: "M", path: "apps/frontend/src/service/foo.ts" }],
		});
		expect(okRes.report.passed).toBe(true);
		expect(okRes.report.summary.historicalDebt).toBe(1);

		// Directly modifying Legacy.vue without covering it fails
		const blockedRes = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [{ status: "M", path: "apps/frontend/src/components/Legacy.vue" }],
		});
		expect(blockedRes.report.passed).toBe(false);
		expect(blockedRes.report.violations.some((v) => v.code === "MODIFIED_UNCOVERED_MODULE")).toBe(true);
	});

	it("rejects dangling references to missing or deleted test files", () => {
		const rootDir = makeTempDir();
		const catalog = baseCatalogFixture();
		catalog.obligations[0] = {
			id: "frontend:apps/frontend/src/service/foo.ts",
			kind: "frontend",
			path: "apps/frontend/src/service/foo.ts",
			state: "covered",
			owner: "apps/frontend/src/service/deleted.spec.ts",
			evidence: [{ kind: "vitest", file: "apps/frontend/src/service/deleted.spec.ts" }],
		};
		createMinimalWorkspace(rootDir, catalog);

		const res = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [
				{ status: "M", path: "apps/frontend/src/service/foo.ts" },
				{ status: "D", path: "apps/frontend/src/service/deleted.spec.ts" },
			],
		});

		expect(res.report.passed).toBe(false);
		expect(res.report.violations.some((v) => v.code === "INVALID_EVIDENCE_TARGET" || v.code === "DANGLING_TEST_REFERENCE")).toBe(true);
	});

	it("returns 0 selected targets for pure docs/markdown edits and expands shared changes conservatively", () => {
		const rootDir = makeTempDir();
		createMinimalWorkspace(rootDir, baseCatalogFixture());

		const docsRes = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [{ status: "M", path: "docs/git-event-ci.md" }],
		});
		expect(docsRes.report.passed).toBe(true);
		expect(docsRes.report.fallbackMode).toBe("none");
		expect(docsRes.report.selectedTargets).toEqual([]);

		const sharedRes = analyzeChangeObligations({
			rootDir,
			baseSha: "base",
			headSha: "head",
			baseCatalogOverride: baseCatalogFixture(),
			diffEntriesOverride: [{ status: "M", path: "packages/shared/src/protocol/collabProtocol.ts" }],
		});
		expect(sharedRes.report.passed).toBe(true);
		expect(sharedRes.report.fallbackMode).toBe("targeted");
		expect(sharedRes.report.selectedTargets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "vitest", file: "packages/shared/src/protocol/collabProtocol.spec.ts" }),
				expect.objectContaining({ kind: "go", package: "./internal/domain" }),
				expect.objectContaining({ kind: "go", package: "./internal/gateway" }),
				expect.objectContaining({ kind: "external", caseId: "correctness-smoke" }),
			]),
		);
	});

	it("preserves separate patterned vs full-file selections in mergeSelections", () => {
		const merged = mergeSelections([
			{ kind: "vitest", files: ["apps/frontend/src/a.spec.ts"], testNamePattern: "only one" },
			{ kind: "vitest", files: ["apps/frontend/src/b.spec.ts"] },
		]);
		expect(merged).toEqual([
			{ kind: "vitest", files: ["apps/frontend/src/b.spec.ts"] },
			{ kind: "vitest", files: ["apps/frontend/src/a.spec.ts"], testNamePattern: "only one" },
		]);
	});

	it("works end-to-end against a real git commit range and handles renames cleanly", () => {
		const repo = makeTempDir();
		const runGit = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		runGit(["init", "-q"]);
		runGit(["config", "user.email", "test@example.com"]);
		runGit(["config", "user.name", "Test User"]);

		createMinimalWorkspace(repo, baseCatalogFixture());
		runGit(["add", "-A"]);
		runGit(["commit", "-q", "-m", "chore: base"]);
		const baseSha = runGit(["rev-parse", "HEAD"]);

		fs.writeFileSync(path.join(repo, "apps/frontend/src/service/foo.ts"), "export const foo = 2;\n");
		runGit(["add", "-A"]);
		runGit(["commit", "-q", "-m", "fix: update foo"]);
		const headSha = runGit(["rev-parse", "HEAD"]);

		const analysis = resolveChangeObligationPlan({
			rootDir: repo,
			baseSha,
			headSha,
			isCoreRun: true,
		});
		expect(analysis.analysis.report.passed).toBe(true);
		expect(analysis.analysis.report.summary.changedSources).toBe(1);
		expect(analysis.analysis.report.selectedTargets.every((t) => t.kind === "external" || t.executionMode === "reused-from-core")).toBe(true);
	});

	it("fails closed in aggregate when any selected target did not execute or failed", () => {
		const runDir = makeTempDir();
		const runId = "change-agg-run";
		const revision = "a".repeat(40);
		const dirtyHash = "b".repeat(64);
		const writeJson = (rel: string, value: unknown) => {
			const abs = path.join(runDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, JSON.stringify(value, null, 2));
		};

		const obligationsReport: ChangeObligationsReport = {
			schemaVersion: 1,
			baseSha: "base",
			headSha: "head",
			stagedOnly: false,
			passed: true,
			fallbackMode: "none",
			fallbackReasons: [],
			changedFiles: [],
			violations: [],
			selectedTargets: [
				{ kind: "vitest", file: "apps/frontend/src/service/foo.spec.ts", executionMode: "reused-from-core" },
				{ kind: "go", package: "./internal/room", executionMode: "reused-from-core" },
				{ kind: "external", caseId: "correctness-smoke", executionMode: "reused-from-core" },
			],
			summary: {
				changedSources: 1,
				changedTests: 0,
				newUncovered: 0,
				historicalDebt: 0,
				selectedCount: 3,
				reusedCount: 3,
				executedExtraCount: 0,
			},
		};
		writeJson("catalog/change-obligations.json", obligationsReport);
		writeJson("frontend/vitest.json", {
			success: true,
			numTotalTests: 1,
			numPassedTests: 1,
			numFailedTests: 0,
			numPendingTests: 0,
			numTodoTests: 0,
			testResults: [
				{
					name: "/repo/apps/frontend/src/service/foo.spec.ts",
					assertionResults: [{ fullName: "foo > works", title: "works", status: "passed" }],
				},
			],
		});
		fs.mkdirSync(path.join(runDir, "backend"), { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "backend", "go-tests.jsonl"),
			`${JSON.stringify({ Action: "pass", Package: "collaborative-whiteboard/backend/internal/room", Test: "TestRoom" })}\n` +
				`${JSON.stringify({ Action: "pass", Package: "collaborative-whiteboard/backend/internal/room" })}\n`,
		);
		writeJson("external/correctness-full-external-results.json", {
			run: { id: runId, sourceRevision: revision, dirtyPatchSha256: dirtyHash },
			summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
			results: [{ id: "correctness-smoke", status: "passed", environment: "headless", durationMs: 100 }],
		});

		const manifest: RunManifest = {
			schemaVersion: 2,
			runId,
			profile: "ci",
			mode: "ci",
			status: "passed",
			source: { revision, dirtyPatchSha256: dirtyHash },
			startedAt: "2026-11-25T00:00:00Z",
			finishedAt: "2026-11-25T00:01:00Z",
			expectedSteps: ["change-obligations", "frontend-test", "go-test", "external-e2e"],
			steps: [
				{ id: "change-obligations", title: "Obligations", status: "passed" },
				{ id: "frontend-test", title: "Vitest", status: "passed" },
				{ id: "go-test", title: "Go", status: "passed" },
				{ id: "external-e2e", title: "E2E", status: "passed" },
			],
			expectedArtifacts: [
				{ id: "change-obligations", stepId: "change-obligations", kind: "change-obligations", path: "catalog/change-obligations.json" },
				{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" },
				{ id: "go-test", stepId: "go-test", kind: "go-test", path: "backend/go-tests.jsonl" },
				{ id: "external-correctness", stepId: "external-e2e", kind: "external", path: "external/correctness-full-external-results.json" },
			],
			validity: { status: "valid", aborted: false, reasons: [] },
			recorded: true,
		};

		const okReport = buildAggregate(manifest, runDir);
		expect(okReport.status).toBe("passed");

		// Now drop correctness-smoke from actual E2E results and confirm fail-closed failure
		writeJson("external/correctness-full-external-results.json", {
			run: { id: runId, sourceRevision: revision, dirtyPatchSha256: dirtyHash },
			summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
			results: [{ id: "harness-health", status: "passed", environment: "headless", durationMs: 50 }],
		});
		const missingE2EReport = buildAggregate(manifest, runDir);
		expect(missingE2EReport.status).toBe("failed");
		expect(missingE2EReport.failures.some((msg) => msg.includes("correctness-smoke"))).toBe(true);
	});
});
