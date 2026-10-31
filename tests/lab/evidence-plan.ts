// File role: managed evidence plans for the lab runner modes that extend the core quick/ci/full profiles.
import path from "node:path";
import type { ExpectedArtifact } from "../report/contract";
import { CI_REQUIRED_EXTERNAL_CASE_IDS } from "../catalog/external-cases";
import type { LabResolveResult } from "./resolve-only";

export type LabEvidenceStep = {
	id: string;
	title: string;
	description: string;
	command?: string;
	cwd?: string;
	timeoutMs?: number;
	stdoutArtifact?: string;
	env?: NodeJS.ProcessEnv;
	requiresServices?: boolean;
	action?: "source-check";
};

export type LabPlanContext = {
	runDir: string;
	rootDir: string;
	frontendDir: string;
	backendDir: string;
	canonicalRootDir: string;
	shellQuote: (value: string) => string;
	listCoverageSources: () => string[];
	externalEnv: NodeJS.ProcessEnv;
	cleanTree: boolean;
	perfRequest: boolean;
};

export type LabEvidencePlan = {
	steps: LabEvidenceStep[];
	artifacts: ExpectedArtifact[];
};

const q = (ctx: LabPlanContext, value: string) => ctx.shellQuote(value);

const vitestRun = (ctx: LabPlanContext, args: string) =>
	`${q(ctx, process.execPath)} ${q(ctx, path.join(ctx.canonicalRootDir, "node_modules", "vitest", "vitest.mjs"))} ${args}`;

const externalRun = (ctx: LabPlanContext, suite: string, extra = "") =>
	`${q(ctx, process.execPath)} ${q(ctx, path.join(ctx.canonicalRootDir, "node_modules", "tsx", "dist", "cli.mjs"))} tests/e2e/external/runner.ts --suite=${suite} --mode=headless --reporter=json --report-dir=${q(ctx, path.join(ctx.runDir, "external"))} --lab=on${extra}`;

const sourceCheckStep = (): LabEvidenceStep => ({
	id: "source-check",
	title: "Source identity check",
	description: "Confirming source files did not change during this run.",
	action: "source-check",
});

const catalogCheckStep = (ctx: LabPlanContext): LabEvidenceStep => ({
	id: "catalog-check",
	title: "Backend feature inventory",
	description: "Checking backend HTTP/WS/scene and frontend route/tool surfaces against the reviewed catalog.",
	command: "go test ./internal/gateway -run \"TestFeatureSurfaceCatalogMatchesBackendSources|TestCatalogSurfacePathsAreValidHTTPPatterns|TestV2PlaceholdersExplicitlyRejectUntilImplemented\" -count=1",
	cwd: ctx.backendDir,
	timeoutMs: 180000,
});

const perfRequestStep = (ctx: LabPlanContext): LabEvidenceStep => ({
	id: "perf-request",
	title: "Performance gate request",
	description: "Recording that this run asks for a separate performance gate instead of running it inline.",
	command: `node tests/lab/write-perf-request.mjs ${q(ctx, path.join(ctx.runDir, "perf-request.json"))}`,
	cwd: ctx.canonicalRootDir,
	timeoutMs: 30000,
});

export const buildSmokePlan = (ctx: LabPlanContext): LabEvidencePlan => {
	const steps: LabEvidenceStep[] = [
		catalogCheckStep(ctx),
		{
			id: "frontend-test",
			title: "Quick frontend and shared regression",
			description: "Running deterministic unit, module and test-harness checks.",
			command: vitestRun(
				ctx,
				`run --project=shared-unit --project=frontend-unit --project=frontend-module --project=harness-unit --reporter=json --outputFile=${q(ctx, path.join(ctx.runDir, "frontend", "vitest.json"))}`
			),
			cwd: ctx.canonicalRootDir,
			timeoutMs: 240000,
		},
		{
			id: "external-smoke",
			title: "Correctness smoke E2E",
			description: "Running the smoke correctness suite against isolated services.",
			command: externalRun(ctx, "correctness-smoke"),
			cwd: ctx.frontendDir,
			requiresServices: true,
			timeoutMs: 600000,
			env: ctx.externalEnv,
		},
		sourceCheckStep(),
	];
	const artifacts: ExpectedArtifact[] = [
		{ id: "feature-obligations", stepId: "catalog-check", kind: "feature-catalog", path: "catalog/feature-obligations.json" },
		{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" },
		{ id: "correctness-smoke-external", stepId: "external-smoke", kind: "external", path: "external/correctness-smoke-external-results.json" },
	];
	return { steps, artifacts };
};

export const buildNightlyPlan = (ctx: LabPlanContext): LabEvidencePlan => {
	const frontendReport = path.join(ctx.runDir, "frontend", "vitest.json");
	const browserReport = path.join(ctx.runDir, "frontend", "browser.json");
	const packageList = path.join(ctx.runDir, "backend", "packages.txt");
	const goTests = path.join(ctx.runDir, "backend", "go-tests.jsonl");
	const goCoverage = path.join(ctx.runDir, "backend", "coverage.out");
	const historyFlag = ctx.cleanTree ? " --import-current-to-history=true" : "";
	const steps: LabEvidenceStep[] = [
		{ id: "build", title: "Production build", description: "Building the backend and typechecking/building the frontend.", command: "npm --silent run build", timeoutMs: 300000 },
		{ id: "go-vet", title: "Go static analysis", description: "Running go vet across all backend packages.", command: "go vet ./...", cwd: ctx.backendDir, timeoutMs: 180000 },
		{
			id: "go-package-list",
			title: "Go package inventory",
			description: "Recording the exact backend packages required in this run.",
			command: "go list ./...",
			cwd: ctx.backendDir,
			stdoutArtifact: packageList,
			timeoutMs: 60000,
		},
		{
			id: "go-test",
			title: "Go tests and coverage",
			description: "Running every Go package once with cross-package statement coverage.",
			command: `go test -json -coverpkg=./... -coverprofile=${q(ctx, goCoverage)} ./...`,
			cwd: ctx.backendDir,
			stdoutArtifact: goTests,
			timeoutMs: 600000,
		},
		{
			id: "frontend-test",
			title: "Frontend and shared coverage tests",
			description: "Running unit, module and harness suites with source coverage.",
			command: vitestRun(
				ctx,
				`run --project=shared-unit --project=frontend-unit --project=frontend-module --project=harness-unit --coverage --reporter=json --outputFile=${q(ctx, frontendReport)} --coverage.reportsDirectory=${q(ctx, path.join(ctx.runDir, "frontend", "coverage"))}`
			),
			cwd: ctx.canonicalRootDir,
			timeoutMs: 600000,
		},
		{
			id: "browser-test",
			title: "Browser component tests",
			description: "Running the browser component project in an isolated Vitest process.",
			command: vitestRun(ctx, `run --project=frontend-browser --reporter=json --outputFile=${q(ctx, browserReport)}`),
			cwd: ctx.canonicalRootDir,
			timeoutMs: 300000,
		},
		{
			id: "external-performance",
			title: "Performance matrix E2E",
			description: "Running the sampled performance matrix with instrumented measurement collection.",
			command: externalRun(ctx, "performance-external", ` --case-set=all --matrix=true --runs=3 --warmup=1${historyFlag}`),
			cwd: ctx.frontendDir,
			requiresServices: true,
			timeoutMs: 3600000,
			env: ctx.externalEnv,
		},
		{
			id: "external-e2e",
			title: "External correctness E2E",
			description: "Running the full correctness suite in the selected browser against isolated services.",
			command: externalRun(ctx, "correctness-full"),
			cwd: ctx.frontendDir,
			requiresServices: true,
			timeoutMs: 900000,
			env: ctx.externalEnv,
		},
		{
			id: "go-race",
			title: "Go race detector",
			description: "Running the backend suite with the Go race detector on this host and platform.",
			command: "go test -race ./...",
			cwd: ctx.backendDir,
			timeoutMs: 900000,
		},
		{
			id: "go-fuzz",
			title: "Scene payload fuzz smoke",
			description: "Fuzzing the public scene payload validator for 30 seconds with a bounded worker count.",
			command: "go test ./internal/gateway -run=^$ -fuzz=FuzzValidateScenePayloadNeverPanics -fuzztime=30s -parallel=2",
			cwd: ctx.backendDir,
			timeoutMs: 180000,
		},
		sourceCheckStep(),
	];
	const artifacts: ExpectedArtifact[] = [
		{ id: "feature-obligations", stepId: "go-test", kind: "feature-catalog", path: "catalog/feature-obligations.json" },
		{ id: "go-package-inventory", stepId: "go-package-list", kind: "package-list", path: "backend/packages.txt" },
		{ id: "go-test", stepId: "go-test", kind: "go-test", path: "backend/go-tests.jsonl" },
		{ id: "go-coverage", stepId: "go-test", kind: "go-coverage", path: "backend/coverage.out", expectedCases: [] },
		{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" },
		{
			id: "frontend-coverage",
			stepId: "frontend-test",
			kind: "coverage",
			path: "frontend/coverage/coverage-summary.json",
			expectedSources: ctx.listCoverageSources(),
		},
		{ id: "frontend-browser", stepId: "browser-test", kind: "vitest", path: "frontend/browser.json" },
		{
			id: "performance-external",
			stepId: "external-performance",
			kind: "external",
			path: "external/performance-external-all-external-results.json",
		},
		{
			id: "external-correctness",
			stepId: "external-e2e",
			kind: "external",
			path: "external/correctness-full-external-results.json",
			expectedCases: CI_REQUIRED_EXTERNAL_CASE_IDS,
		},
	];
	return { steps, artifacts };
};

export const buildSinglePlan = (ctx: LabPlanContext, selection?: LabResolveResult): LabEvidencePlan => {
	const steps: LabEvidenceStep[] = [];
	const artifacts: ExpectedArtifact[] = [];
	if (!selection || selection.selections.length === 0) {
		throw new Error(
			`single mode has no resolvable targets; pass --only=<file:path|case:id|test:name|go:pkg> or --since=<git-ref>${
				selection?.unresolved.length ? ` (unresolved: ${selection.unresolved.join(", ")})` : ""
			}`
		);
	}
	const vitest = selection.selections.find((item) => item.kind === "vitest");
	if (vitest && (vitest.files.length > 0 || vitest.testNamePattern)) {
		const pattern = vitest.testNamePattern ? ` -t ${q(ctx, vitest.testNamePattern)}` : "";
		const files = vitest.files.map((file) => q(ctx, file)).join(" ");
		steps.push({
			id: "frontend-test",
			title: `Focused Vitest (${vitest.files.length} file(s))`,
			description: "Running only the tests selected for this single-point verification.",
			command: vitestRun(ctx, `run ${files}${pattern} --reporter=json --outputFile=${q(ctx, path.join(ctx.runDir, "frontend", "vitest.json"))}`),
			cwd: ctx.canonicalRootDir,
			timeoutMs: 600000,
		});
		artifacts.push({ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" });
	}
	const go = selection.selections.find((item) => item.kind === "go");
	if (go && go.packages.length > 0) {
		const pattern = go.runPattern ? `-run ${q(ctx, go.runPattern)} ` : "";
		steps.push({
			id: "go-test",
			title: `Focused Go test (${go.packages.join(", ")})`,
			description: "Running only the Go packages selected for this single-point verification.",
			command: `go test ${pattern}${go.packages.join(" ")}`,
			cwd: ctx.backendDir,
			stdoutArtifact: path.join(ctx.runDir, "backend", "go-tests.jsonl"),
			timeoutMs: 600000,
		});
		artifacts.push({ id: "go-test", stepId: "go-test", kind: "go-test", path: "backend/go-tests.jsonl" });
	}
	const external = selection.selections.find((item) => item.kind === "external");
	if (external && external.caseIds.length > 0) {
		steps.push({
			id: "external-focused",
			title: `Focused external case (${external.caseIds.length})`,
			description: "Running only the external cases selected for this single-point verification.",
			command: externalRun(ctx, "correctness-full", ` --case-ids=${external.caseIds.join(",")}`),
			cwd: ctx.frontendDir,
			requiresServices: true,
			timeoutMs: 900000,
			env: ctx.externalEnv,
		});
		artifacts.push({
			id: "external-focused",
			stepId: "external-focused",
			kind: "external",
			path: "external/correctness-full-external-results.json",
			expectedCases: external.caseIds,
		});
	}
	steps.push(sourceCheckStep());
	return { steps, artifacts };
};

export const buildLabEvidencePlan = (
	profile: "smoke" | "nightly" | "single",
	ctx: LabPlanContext,
	selection?: LabResolveResult
): LabEvidencePlan => {
	if (profile === "smoke") return withOptionalPerfRequest(buildSmokePlan(ctx), ctx);
	if (profile === "nightly") return withOptionalPerfRequest(buildNightlyPlan(ctx), ctx);
	return buildSinglePlan(ctx, selection);
};

const withOptionalPerfRequest = (plan: LabEvidencePlan, ctx: LabPlanContext): LabEvidencePlan => {
	if (!ctx.perfRequest) return plan;
	const steps = [...plan.steps];
	steps.splice(steps.length - 1, 0, perfRequestStep(ctx));
	return {
		steps,
		artifacts: [...plan.artifacts, { id: "perf-request", stepId: "perf-request", kind: "perf-request", path: "perf-request.json" }],
	};
};
