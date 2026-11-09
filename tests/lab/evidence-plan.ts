// File role: managed evidence plans for the lab runner modes that extend the core quick/ci/full profiles.
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExpectedArtifact } from "../report/contract";
import { CORRECTNESS_FULL_EXTERNAL_CASE_IDS, EXTERNAL_CASES } from "../catalog/external-cases";
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
	freshServices?: boolean;
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
	goRaceSupported?: boolean;
	goRaceRequired?: boolean;
	lane?: "all" | "quality" | "performance" | "performance-standard" | "performance-boundary";
};

export type LabEvidencePlan = {
	steps: LabEvidenceStep[];
	artifacts: ExpectedArtifact[];
};

const q = (ctx: LabPlanContext, value: string) => ctx.shellQuote(value);

const vitestRun = (ctx: LabPlanContext, args: string) =>
	`${q(ctx, process.execPath)} ${q(ctx, path.join(ctx.canonicalRootDir, "node_modules", "vitest", "vitest.mjs"))} ${args}`;

const externalRun = (ctx: LabPlanContext, suite: string, extra = "", reportSubdir = "") =>
	`${q(ctx, process.execPath)} ${q(ctx, path.join(ctx.canonicalRootDir, "node_modules", "tsx", "dist", "cli.mjs"))} tests/e2e/external/runner.ts --suite=${suite} --mode=headless --reporter=${suite === "performance-external" ? "both" : "json"} --report-dir=${q(ctx, path.join(ctx.runDir, "external", reportSubdir))} --lab=on${extra}`;

/**
 * Boundary cases seed millions of points each; two of them in one database already pushes
 * create-room into HTTP 500. Each case therefore runs as its own step on a freshly reset store.
 */
const BOUNDARY_CASES = [
	{ suffix: "full-render", id: EXTERNAL_CASES.fullRenderBoundary.id },
	{ suffix: "heap-growth", id: EXTERNAL_CASES.heapGrowthBoundary.id },
	{ suffix: "redraw-freeze", id: EXTERNAL_CASES.redrawFreezeBoundary.id },
] as const;

/** Optional local/nightly-run shortcut; production nightly keeps the full default ladder. */
const boundaryScalesOverride = () => {
	const scales = (process.env.AEVIA_NIGHTLY_BOUNDARY_SCALES || "").trim();
	return scales ? ` --boundary-scales=${scales}` : "";
};

/**
 * `go test -race` needs a working CGO toolchain. Some Windows hosts ship a MinGW gcc that
 * cannot even compile Go's own cgo shim, and failing nightly on that is an environment
 * problem rather than a product regression. Probe once per run and omit the step when the
 * detector cannot be built at all.
 */
export type GoRaceCapability = { supported: boolean; exitCode: number | null; detail: string };
const raceProbeCache = new Map<string, GoRaceCapability>();
export const probeGoRaceDetector = (backendDir: string): GoRaceCapability => {
	const cached = raceProbeCache.get(backendDir);
	if (cached) return cached;
	const probe = spawnSync("go", ["test", "-race", "-run=^$", "./internal/config"], { cwd: backendDir, encoding: "utf8", timeout: 30000, windowsHide: true });
	const capability = { supported: probe.status === 0, exitCode: probe.status, detail: probe.error?.message || probe.stderr || probe.stdout || `exit ${probe.status}` };
	raceProbeCache.set(backendDir, capability);
	return capability;
};
export const supportsGoRaceDetector = (backendDir: string): boolean => probeGoRaceDetector(backendDir).supported;

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
	command: `node scripts/write-perf-request.mjs ${q(ctx, path.join(ctx.runDir, "perf-request.json"))}`,
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
		{ id: "correctness-smoke-gate", stepId: "external-smoke", kind: "lab-gate", path: "external/correctness-smoke-lab-gate.json" },
	];
	return { steps, artifacts };
};

export const buildNightlyPlan = (ctx: LabPlanContext): LabEvidencePlan => {
	const frontendReport = path.join(ctx.runDir, "frontend", "vitest.json");
	const browserReport = path.join(ctx.runDir, "frontend", "browser.json");
	const packageList = path.join(ctx.runDir, "backend", "packages.txt");
	const goTests = path.join(ctx.runDir, "backend", "go-tests.jsonl");
	const goCoverage = path.join(ctx.runDir, "backend", "coverage.out");
	const historyFlag = ""; // The parent publishes only after the entire run passes source-check.
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
			id: "external-performance-standard",
			title: "Performance matrix E2E (standard)",
			description: "Running the sampled full-render/incremental/local matrix with instrumented measurement collection.",
			command: externalRun(
				ctx,
				"performance-external",
				` --case-set=standard --matrix=true --runs=3 --warmup=1${historyFlag}`
			),
			cwd: ctx.frontendDir,
			requiresServices: true,
			timeoutMs: 2400000,
			env: ctx.externalEnv,
		},
		{
			id: "external-performance-resilience",
			title: "Resilience matrix E2E",
			description: "Running weak-network recovery sampling against the isolated services.",
			command: externalRun(ctx, "performance-external", " --case-set=resilience --matrix=false --runs=1 --warmup=0"),
			cwd: ctx.frontendDir,
			requiresServices: true,
			timeoutMs: 1200000,
			env: ctx.externalEnv,
		},
		...BOUNDARY_CASES.map((boundaryCase) => ({
			id: `external-performance-boundary-${boundaryCase.suffix}`,
			title: `Boundary stress E2E: ${boundaryCase.suffix} (fresh database)`,
			description:
				"Running one multi-million-point boundary case on a freshly reset SQLite store so accumulated rows cannot turn create-room into HTTP 500.",
			command: externalRun(
				ctx,
				"performance-external",
				` --case-set=boundary --case-ids=${boundaryCase.id} --matrix=false --runs=1 --warmup=0${boundaryScalesOverride()}`,
				`boundary-${boundaryCase.suffix}`
			),
			cwd: ctx.frontendDir,
			requiresServices: true,
			freshServices: true,
			timeoutMs: 2400000,
			env: ctx.externalEnv,
		})),
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
		...((ctx.goRaceSupported === true || ctx.goRaceRequired === true)
			? [
					{
						id: "go-race",
						title: "Go race detector",
						description: "Running the backend suite with the Go race detector on this host and platform.",
						command: "go test -race ./...",
						cwd: ctx.backendDir,
						timeoutMs: 900000,
					},
				]
			: []),
		{
			id: "go-fuzz",
			title: "Scene payload fuzz",
			description: "Fuzzing the public scene payload validator for five minutes with a bounded worker count.",
			command: "go test ./internal/gateway -run=^$ -fuzz=FuzzValidateScenePayloadNeverPanics -fuzztime=5m -parallel=2",
			cwd: ctx.backendDir,
			env: { GOCACHE: path.join(ctx.rootDir, "tests", ".tmp", "go-fuzz-cache") },
			timeoutMs: 600000,
		},
		{
			id: "lab-inventory",
			title: "Module test-debt inventory",
			description: "Recording every frontend module and Go source file with its owning test or its uncovered status.",
			command: `node scripts/lab-inventory.mjs --out ${q(ctx, path.join(ctx.runDir, "catalog", "lab-inventory.json"))}`,
			cwd: ctx.canonicalRootDir,
			timeoutMs: 60000,
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
			id: "performance-external-standard",
			stepId: "external-performance-standard",
			kind: "external",
			path: "external/performance-external-standard-external-results.json",
			expectedCaseKeys: ["gpu_cpuHigh", "gpu_cpuLow", "noGpu_cpuHigh", "noGpu_cpuLow"].flatMap(env => [
				...[10000, 50000, 100000].map(scale => `full-render-${scale}|${env}|${scale}`),
				`incremental-remote-first-pixel|${env}|`, `local-realtime-first-pixel|${env}|`,
			]),
		},
		{
			id: "performance-external-resilience",
			stepId: "external-performance-resilience",
			kind: "external",
			path: "external/performance-external-resilience-external-results.json",
		},
		...BOUNDARY_CASES.map((boundaryCase) => ({
			id: `performance-external-boundary-${boundaryCase.suffix}`,
			stepId: `external-performance-boundary-${boundaryCase.suffix}`,
			kind: "external" as const,
			path: `external/boundary-${boundaryCase.suffix}/performance-external-boundary-external-results.json`,
			expectedCases: [boundaryCase.id],
		})),
		{
			id: "external-correctness",
			stepId: "external-e2e",
			kind: "external",
			path: "external/correctness-full-external-results.json",
			expectedCases: CORRECTNESS_FULL_EXTERNAL_CASE_IDS,
		},
		{
			id: "performance-external-standard-gate",
			stepId: "external-performance-standard",
			kind: "lab-gate",
			path: "external/performance-external-standard-lab-gate.json",
		},
		{
			id: "performance-external-resilience-gate",
			stepId: "external-performance-resilience",
			kind: "lab-gate",
			path: "external/performance-external-resilience-lab-gate.json",
		},
		...BOUNDARY_CASES.map((boundaryCase) => ({
			id: `performance-external-boundary-${boundaryCase.suffix}-gate`,
			stepId: `external-performance-boundary-${boundaryCase.suffix}`,
			kind: "lab-gate" as const,
			path: `external/boundary-${boundaryCase.suffix}/performance-external-boundary-lab-gate.json`,
		})),
		{
			id: "external-correctness-gate",
			stepId: "external-e2e",
			kind: "lab-gate",
			path: "external/correctness-full-lab-gate.json",
		},
		{ id: "lab-inventory", stepId: "lab-inventory", kind: "lab-inventory", path: "catalog/lab-inventory.json" },
	];
	const performanceSteps = steps.filter(step => step.id !== "go-race" && step.id !== "go-fuzz");
	const selectedSteps = ctx.lane === "quality" ? steps.filter(step => !step.id.startsWith("external-performance")) : ctx.lane === "performance" ? performanceSteps : ctx.lane === "performance-standard" ? performanceSteps.filter(step => !step.id.startsWith("external-performance-boundary-")) : ctx.lane === "performance-boundary" ? performanceSteps.filter(step => !["external-performance-standard", "external-performance-resilience", "external-e2e"].includes(step.id)) : [
		...steps.filter(step => !step.id.startsWith("external-performance") && step.id !== "source-check"),
		...steps.filter(step => step.id.startsWith("external-performance")),
		...steps.filter(step => step.id === "source-check"),
	];
	const selectedIds = new Set(selectedSteps.map(step => step.id));
	return { steps: selectedSteps, artifacts: artifacts.filter(artifact => selectedIds.has(artifact.stepId)) };
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
			command: `go test -json ${pattern}${go.packages.join(" ")}`,
			cwd: ctx.backendDir,
			stdoutArtifact: path.join(ctx.runDir, "backend", "go-tests.jsonl"),
			timeoutMs: 600000,
		});
		artifacts.push({ id: "go-test", stepId: "go-test", kind: "go-test", path: "backend/go-tests.jsonl" });
	}
	const external = selection.selections.find((item) => item.kind === "external");
	if (external && external.caseIds.length > 0) {
		const families = new Map<string, string[]>();
		for (const id of external.caseIds) {
			const definition = Object.values(EXTERNAL_CASES).find(item => item.id === id || (item.id === "full-render" && /^full-render-\d+$/.test(id)));
			if (!definition) throw new Error(`Unknown external case: ${id}`);
			const family = id.startsWith("boundary-") ? id : id === EXTERNAL_CASES.networkRecovery.id ? "resilience" :
				id.startsWith("full-render-") || id === EXTERNAL_CASES.remoteFirstPixelPerformance.id || id === EXTERNAL_CASES.localFirstPixelPerformance.id ? "standard" : "correctness";
			families.set(family, [...(families.get(family) ?? []), id]);
		}
		for (const [family, ids] of families) {
			const correctness = family === "correctness";
			const suite = correctness ? "correctness-full" : "performance-external";
			const caseSet = family.startsWith("boundary-") ? "boundary" : family;
			const stepId = correctness ? "external-focused" : `external-focused-${family}`;
			const reportDir = correctness ? "" : family;
			const tag = correctness ? suite : `${suite}-${caseSet}`;
			const keys = external.caseKeys?.filter(key => ids.includes(key.split("|")[0]!)) ?? [];
			const scales = ids.filter(id => /^full-render-\d+$/.test(id)).map(id => Number(id.slice("full-render-".length)));
			const selectionFlags = `${keys.length ? ` --case-keys=${q(ctx, keys.join(","))}` : ""}${scales.length ? ` --scales=${scales.join(",")}` : ""}`;
			steps.push({
				id: stepId, title: `Focused external case (${ids.length})`, description: "Running selected cases in their owning suite.",
				command: externalRun(ctx, suite, ` --case-ids=${ids.join(",")}${selectionFlags}${correctness ? "" : ` --case-set=${caseSet} --matrix=${caseSet === "standard"}${caseSet === "boundary" ? boundaryScalesOverride() : ""}`}`, reportDir),
				cwd: ctx.frontendDir, requiresServices: true, freshServices: caseSet === "boundary", timeoutMs: 900000, env: ctx.externalEnv
			});
			const prefix = `external/${reportDir ? reportDir + "/" : ""}${tag}`;
			artifacts.push({ id: stepId, stepId, kind: "external", path: `${prefix}-external-results.json`, expectedCases: ids, expectedCaseKeys: keys.length ? keys : undefined });
			artifacts.push({ id: `${stepId}-gate`, stepId, kind: "lab-gate", path: `${prefix}-lab-gate.json` });
		}
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

export const withCanvasOracle = (plan: LabEvidencePlan, ctx: LabPlanContext): LabEvidencePlan => {
	const steps = [...plan.steps];
	const before = steps.findIndex(step => step.id === "browser-test");
	steps.splice(before < 0 ? steps.length - 1 : before, 0, {
		id: "canvas-oracle", title: "Canvas blank oracle sensitivity", description: "Checking an empty canvas and a one-pixel faint residual in a real browser.",
		command: `${q(ctx, process.execPath)} ${q(ctx, path.join(ctx.canonicalRootDir, "node_modules/tsx/dist/cli.mjs"))} tests/lab/check-blank-oracle.ts --output=${q(ctx, path.join(ctx.runDir, "frontend/blank-oracle.json"))}`,
		cwd: ctx.canonicalRootDir, timeoutMs: 60000,
	});
	return { steps, artifacts: [...plan.artifacts, { id: "canvas-oracle", stepId: "canvas-oracle", kind: "oracle-check", path: "frontend/blank-oracle.json", expectedCases: ["blank", "faint-residual", "staged-render"] }] };
};
