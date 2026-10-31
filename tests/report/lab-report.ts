// File role: unified lab report model. Reads one managed run directory (manifest v2 +
// evidence artifacts + optional lab-gate/inventory files) into a single durable
// `lab-report.json`, then renders the standalone HTML report via `lab-html.ts`.
//
// Every optional artifact is best-effort: a missing frontend vitest report, external
// report, gate file, coverage summary or log must degrade to null / [] / {} and never
// throw. Only the final writes are allowed to fail.
import fs from "node:fs";
import path from "node:path";
import type { AggregateReport, ArtifactResult } from "./aggregate";
import type {
	GateCase,
	GateScenario,
	RunManifest,
	RunStep,
	ValidityReason,
	ValidityStatus,
} from "./contract";
import { renderLabHtml } from "./lab-html";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type LabInstrumentation = {
	enabled: boolean;
	contractVersion: number | null;
	missingMarks: string[];
};

export type LabRunBlock = {
	id: string;
	mode: string;
	profile: string;
	status: string;
	validity: { status: string; aborted: boolean; reasons: ValidityReason[] };
	recorded: boolean;
	source: RunManifest["source"];
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	rerunOf: string | null;
	rerunScope: string | null;
	rerunIds: string[];
	policy: string;
};

export type LabGateBlock = {
	status: ValidityStatus | "unknown";
	aborted: boolean;
	policy: { warnRatio: number; abortRatio: number } | null;
	cases: GateCase[];
	scenarios: GateScenario[];
	instrumentation: LabInstrumentation;
	reasons: ValidityReason[];
	sources: string[];
	/** true when no `*-lab-gate.json` existed and the block was derived from manifest + external reports. */
	derived: boolean;
};

export type LabTestStatus = "passed" | "failed" | "skipped";

export type LabTestCase = {
	caseKey: string;
	id: string;
	title: string;
	file: string;
	status: LabTestStatus;
	durationMs: number;
	failureMessages: string[];
	rerunScope: "case";
	rerunIds: string[];
	rerunnable: boolean;
};

export type LabSuiteSummary = {
	id: "unit" | "integration" | "browser";
	title: string;
	status: "passed" | "failed" | "skipped" | "missing";
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	durationMs: number;
	files: string[];
	cases: LabTestCase[];
	note?: string;
};

export type LabGoPackage = {
	package: string;
	status: string;
	tests: number;
	failed: number;
	skipped: number;
	elapsedMs: number | null;
};

export type LabGoSummary = {
	id: "go";
	title: string;
	status: "passed" | "failed" | "skipped" | "missing";
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	durationMs: number;
	packages: LabGoPackage[];
	cases: LabTestCase[];
};

export type LabExternalCase = {
	caseKey: string;
	id: string;
	title: string;
	suite: string;
	environment: string | null;
	scale: number | null;
	status: "passed" | "failed";
	failureType: string;
	durationMs: number;
	error: string | null;
	metrics: Record<string, number | string | boolean | null>;
	regressionChecks: Array<Record<string, unknown>>;
	learningChecks: Array<Record<string, unknown>>;
	learningStatus: string | null;
	artifacts: string[];
	rerunIds: string[];
	rerunnable: boolean;
};

export type LabExternalSuite = {
	id: string;
	suite: string;
	caseSet: string | null;
	reportPath: string;
	generatedAt: string | null;
	mode: string | null;
	environment: string | null;
	total: number;
	passed: number;
	failed: number;
	cases: LabExternalCase[];
};

export type LabExternalSummary = {
	suites: LabExternalSuite[];
	total: number;
	passed: number;
	failed: number;
};

export type LabMeasurement = {
	caseKey: string;
	id: string;
	suite: string;
	env: string | null;
	scale: number | null;
	metric: string;
	value: number | null;
	external: number | null;
	instrumented: number | null;
	witnessDeltaMs: number | null;
	source: "instrumented" | "external" | "missing";
	baseline: number | null;
	budget: number | null;
	learned: number | null;
	deltaPercent: number | null;
	verdict: string;
	validity: string;
};

export type LabCoverageMetric = { total: number; covered: number; percent: number };

export type LabCoverageEntry = {
	name: string;
	metrics: Record<string, LabCoverageMetric>;
};

export type LabCoverageBlock = {
	kind: "frontend" | "go";
	generatedAt: string | null;
	total: LabCoverageMetric | null;
	metrics: Record<string, LabCoverageMetric>;
	entries: LabCoverageEntry[];
};

export type LabCoverage = {
	frontend: LabCoverageBlock | null;
	go: LabCoverageBlock | null;
};

export type LabFeatureObligations = {
	scope: string;
	total: number;
	sourceSurfaceCount: number;
	stateCounts: Record<string, number>;
	unresolvedIds: string[];
};

export type LabInventoryObligations = {
	scope: string;
	total: number;
	covered: number;
	partial: number;
	uncovered: number;
	excluded: number;
	unresolvedIds: string[];
};

export type LabObligations = {
	featureCatalog: LabFeatureObligations | null;
	inventory: LabInventoryObligations | null;
};

export type LabGalleryItem = {
	label: string;
	path: string;
	kind: "image" | "file";
	exists: boolean;
};

export type LabRerunCase = {
	caseKey: string;
	id: string;
	suite: string;
	title: string;
};

export type LabRerunScenario = {
	scenarioKey: string;
	suite: string;
	verdict: string;
	ids: string[];
};

export type LabRerunIndex = {
	cases: LabRerunCase[];
	scenarios: LabRerunScenario[];
};

export type LabReport = {
	schemaVersion: 2;
	generatedAt: string;
	run: LabRunBlock;
	steps: RunStep[];
	artifacts: ArtifactResult[];
	gate: LabGateBlock;
	instrumentation: LabInstrumentation;
	suites: {
		unit: LabSuiteSummary;
		integration: LabSuiteSummary;
		browser: LabSuiteSummary;
		go: LabGoSummary;
		e2e: LabExternalSummary;
		performance: LabExternalSummary;
	};
	cases: LabTestCase[];
	measurements: LabMeasurement[];
	coverage: LabCoverage;
	obligations: LabObligations;
	failures: string[];
	logs: Record<string, string>;
	gallery: LabGalleryItem[];
	rerun: LabRerunIndex;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toPosix = (value: string) => value.replaceAll("\\", "/");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const numberOrNull = (value: unknown): number | null => (finite(value) ? value : null);

const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");

const stringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const recordArray = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value) ? value.filter(isRecord) : [];

const readJson = (filePath: string): unknown => {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
};

const readText = (filePath: string): string | null => {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
};

const exists = (filePath: string) => {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
};

const listDirectory = (directory: string): string[] => {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
};

/** Recursively list files as POSIX paths relative to `root` (boundary suites live in subdirectories). */
const listFilesRecursive = (root: string, relativeDir = ""): string[] => {
	const directory = path.join(root, relativeDir);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...listFilesRecursive(root, relative));
		else files.push(relative);
	}
	return files.sort();
};

const relativeSource = (repoRoot: string, value: string): string => {
	const normalized = toPosix(value);
	if (!path.isAbsolute(value)) return normalized;
	const relative = path.relative(repoRoot, value);
	if (!relative || relative.startsWith("..")) return normalized;
	return toPosix(relative);
};

const relativeArtifact = (runDir: string, value: string): string => {
	const normalized = toPosix(value);
	if (!path.isAbsolute(value)) return normalized;
	const relative = path.relative(runDir, value);
	if (!relative || relative.startsWith("..")) return normalized;
	return toPosix(relative);
};

const repoRootOf = (runDir: string) => path.resolve(runDir, "..", "..", "..", "..", "..");

const modeOf = (manifest: RunManifest): string => {
	const declared = (manifest as RunManifest & { mode?: unknown }).mode;
	if (typeof declared === "string" && declared.length > 0) return declared;
	const profile = stringValue(manifest.profile);
	if (profile === "single") return "single";
	if (profile === "smoke" || profile === "quick") return "smoke";
	if (profile === "ci") return "ci";
	return "custom";
};

const validityOf = (manifest: RunManifest): LabRunBlock["validity"] => {
	const raw = (manifest as RunManifest & { validity?: unknown }).validity;
	if (isRecord(raw) && typeof raw.status === "string" && typeof raw.aborted === "boolean") {
		return {
			status: raw.status,
			aborted: raw.aborted,
			reasons: Array.isArray(raw.reasons) ? (raw.reasons as ValidityReason[]) : [],
		};
	}
	return { status: "valid", aborted: false, reasons: [] };
};

const recordedOf = (manifest: RunManifest): boolean => {
	const raw = (manifest as RunManifest & { recorded?: unknown }).recorded;
	return typeof raw === "boolean" ? raw : true;
};

const capturePolicyOf = (manifest: RunManifest): string => {
	const raw = (manifest as RunManifest & { measurement?: unknown }).measurement;
	if (isRecord(raw) && typeof raw.policy === "string") return raw.policy;
	return "prefer-instrumented";
};

const durationBetween = (startedAt: string, finishedAt: string | null): number | null => {
	if (!finishedAt) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return end - start;
};

const atomicWrite = (filePath: string, content: string) => {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, content, "utf8");
	fs.rmSync(filePath, { force: true });
	fs.renameSync(temporaryPath, filePath);
};

// ---------------------------------------------------------------------------
// Vitest reports (frontend unit / module / browser / harness)
// ---------------------------------------------------------------------------

const vitestStatus = (value: unknown): LabTestStatus => {
	if (value === "passed") return "passed";
	if (value === "failed") return "failed";
	return "skipped";
};

const classifyVitestFile = (file: string): "unit" | "integration" | "browser" => {
	if (file.includes("/tests/browser/") || /\.browser\.spec\.ts$/.test(file)) return "browser";
	if (file.includes("/src/store/")) return "integration";
	if (file.includes("/src/service/") && !/\.unit\.spec\.ts$/.test(file)) return "integration";
	return "unit";
};

type VitestParsed = { cases: LabTestCase[]; files: string[] };

const parseVitestReport = (payload: unknown, repoRoot: string): VitestParsed => {
	const cases: LabTestCase[] = [];
	const files = new Set<string>();
	if (!isRecord(payload) || !Array.isArray(payload.testResults)) return { cases, files: [] };
	for (const rawResult of payload.testResults) {
		if (!isRecord(rawResult) || typeof rawResult.name !== "string") continue;
		const file = relativeSource(repoRoot, rawResult.name);
		files.add(file);
		const assertions = Array.isArray(rawResult.assertionResults) ? rawResult.assertionResults : [];
		for (const rawAssertion of assertions) {
			if (!isRecord(rawAssertion)) continue;
			const title = stringValue(rawAssertion.fullName) || stringValue(rawAssertion.title) || "(unnamed test)";
			const status = vitestStatus(rawAssertion.status);
			cases.push({
				caseKey: `vitest::${file}::${title}`,
				id: file,
				title,
				file,
				status,
				durationMs: finite(rawAssertion.duration) ? Number(rawAssertion.duration) : 0,
				failureMessages: stringArray(rawAssertion.failureMessages).slice(0, 5),
				rerunScope: "case",
				rerunIds: [file],
				rerunnable: true,
			});
		}
	}
	return { cases, files: [...files] };
};

const summariseVitest = (
	id: LabSuiteSummary["id"],
	title: string,
	parsed: VitestParsed,
	note?: string
): LabSuiteSummary => {
	const failed = parsed.cases.filter((item) => item.status === "failed").length;
	const skipped = parsed.cases.filter((item) => item.status === "skipped").length;
	const passed = parsed.cases.filter((item) => item.status === "passed").length;
	return {
		id,
		title,
		status: parsed.cases.length === 0 ? "missing" : failed > 0 ? "failed" : "passed",
		total: parsed.cases.length,
		passed,
		failed,
		skipped,
		durationMs: parsed.cases.reduce((sum, item) => sum + item.durationMs, 0),
		files: parsed.files,
		cases: parsed.cases,
		note,
	};
};

// ---------------------------------------------------------------------------
// Go test JSONL
// ---------------------------------------------------------------------------

const parseGoTests = (text: string | null): LabGoSummary => {
	const packages = new Map<string, LabGoPackage>();
	const cases: LabTestCase[] = [];
	if (!text) {
		return {
			id: "go",
			title: "Go",
			status: "missing",
			total: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
			durationMs: 0,
			packages: [],
			cases: [],
		};
	}
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;
		const packagePath = stringValue(event.Package);
		if (!packagePath) continue;
		let entry = packages.get(packagePath);
		if (!entry) {
			entry = { package: packagePath, status: "running", tests: 0, failed: 0, skipped: 0, elapsedMs: null };
			packages.set(packagePath, entry);
		}
		const action = stringValue(event.Action);
		const test = stringValue(event.Test);
		if (action === "pass" || action === "fail" || action === "skip") {
			if (test) {
				entry.tests += 1;
				if (action === "fail") entry.failed += 1;
				if (action === "skip") entry.skipped += 1;
			} else {
				entry.status = action === "pass" ? "passed" : action === "fail" ? "failed" : "skipped";
				if (finite(event.Elapsed)) entry.elapsedMs = Math.round(Number(event.Elapsed) * 1000);
			}
		}
	}
	for (const entry of [...packages.values()].sort((left, right) => left.package.localeCompare(right.package))) {
		const status: LabTestStatus = entry.status === "failed" ? "failed" : entry.status === "passed" ? "passed" : "skipped";
		cases.push({
			caseKey: `go::${entry.package}`,
			id: entry.package,
			title: entry.package,
			file: entry.package,
			status,
			durationMs: entry.elapsedMs ?? 0,
			failureMessages: [],
			rerunScope: "case",
			rerunIds: [],
			rerunnable: false,
		});
	}
	const failed = [...packages.values()].filter((item) => item.status === "failed").length;
	const passed = [...packages.values()].filter((item) => item.status === "passed").length;
	return {
		id: "go",
		title: "Go",
		status: packages.size === 0 ? "missing" : failed > 0 ? "failed" : "passed",
		total: packages.size,
		passed,
		failed,
		skipped: Math.max(0, packages.size - passed - failed),
		durationMs: [...packages.values()].reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0),
		packages: [...packages.values()].sort((left, right) => left.package.localeCompare(right.package)),
		cases,
	};
};

// ---------------------------------------------------------------------------
// External reports
// ---------------------------------------------------------------------------

const metricMap = (value: unknown): Record<string, number | string | boolean | null> => {
	if (!isRecord(value)) return {};
	const out: Record<string, number | string | boolean | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue;
		if (typeof item === "number" || typeof item === "string" || typeof item === "boolean" || item === null) {
			out[key] = item;
		}
	}
	return out;
};

const suiteFromReportName = (fileName: string) => {
	if (fileName.includes("performance")) return "performance-external";
	if (fileName.includes("correctness-smoke")) return "correctness-smoke";
	if (fileName.includes("correctness-full")) return "correctness-full";
	if (fileName.includes("harness")) return "harness-health";
	return fileName.replace(/-external-results\.json$/, "");
};

const externalCaseKey = (environment: string | null, id: string) => `${environment || "default"}::${id}`;

const parseExternalReport = (payload: unknown, reportPath: string, runDir: string): LabExternalSuite | null => {
	if (!isRecord(payload)) return null;
	const config = isRecord(payload.config) ? payload.config : {};
	const suite = stringValue(config.suite) || suiteFromReportName(path.basename(reportPath));
	const environment = stringValue(config.environment) || null;
	const regressions = recordArray(payload.regressions);
	const learned = recordArray(payload.learnedRegressions);
	const results = recordArray(payload.results);
	const cases: LabExternalCase[] = results.map((raw) => {
		const id = stringValue(raw.id);
		const env = stringValue(raw.environment) || environment;
		const status: "passed" | "failed" = raw.status === "failed" ? "failed" : "passed";
		const metrics = metricMap(raw.metrics);
		// Instrumented samples may arrive as a nested object (`instrumented.<metric>`) or as
		// separate `*Instrumented` metric keys; normalise both into the flat metric map.
		const nestedInstrumented =
			(isRecord(raw.instrumented) && raw.instrumented) ||
			(isRecord(raw.metrics) && isRecord((raw.metrics as Record<string, unknown>).instrumented)
				? ((raw.metrics as Record<string, unknown>).instrumented as Record<string, unknown>)
				: null);
		if (nestedInstrumented) {
			for (const [key, value] of Object.entries(nestedInstrumented)) {
				if (!finite(value)) continue;
				const metricKey = `${key}Instrumented`;
				if (!(metricKey in metrics)) metrics[metricKey] = Number(value);
			}
		}
		if (finite(raw.witnessDeltaMs) && metrics.witnessDeltaMs === undefined) {
			metrics.witnessDeltaMs = Number(raw.witnessDeltaMs);
		}
		const regression = isRecord(raw.regression)
			? raw.regression
			: regressions.find((item) => stringValue(item.caseKey) === externalCaseKey(env, id));
		const learning = isRecord(raw.learning)
		? raw.learning
		: learned.find((item) => stringValue(item.caseKey) === externalCaseKey(env, id)) ?? null;
		const artifacts = stringArray(raw.artifacts).map((item) => relativeArtifact(runDir, item));
		return {
			caseKey: externalCaseKey(env, id),
			id,
			title: stringValue(raw.title) || id,
			suite,
			environment: env,
			scale: numberOrNull(raw.scale),
			status,
			failureType: stringValue(raw.failureType) || "none",
			durationMs: finite(raw.durationMs) ? Number(raw.durationMs) : 0,
			error: typeof raw.error === "string" && raw.error.length > 0 ? raw.error : null,
			metrics,
			regressionChecks: regression && Array.isArray(regression.checks) ? recordArray(regression.checks) : [],
			learningChecks: learning && Array.isArray(learning.checks) ? recordArray(learning.checks) : [],
			learningStatus: learning ? stringValue(learning.status) || null : null,
			artifacts,
			rerunIds: id ? [id] : [],
			rerunnable: id.length > 0,
		};
	});
	return {
		id: toPosix(path.relative(runDir, reportPath)),
		suite,
		caseSet: stringValue(config.caseSet) || null,
		reportPath: toPosix(path.relative(runDir, reportPath)),
		generatedAt: stringValue(payload.generatedAt) || null,
		mode: stringValue(config.mode) || null,
		environment,
		total: cases.length,
		passed: cases.filter((item) => item.status === "passed").length,
		failed: cases.filter((item) => item.status === "failed").length,
		cases,
	};
};

const readExternalSuites = (runDir: string): { suites: LabExternalSuite[]; reportFiles: string[] } => {
	const externalDir = path.join(runDir, "external");
	// Boundary steps keep their reports under external/boundary-<case>/; walk recursively so a
	// split step is still part of the unified report.
	const files = listFilesRecursive(externalDir)
		.filter((name) => name.endsWith("-external-results.json"))
		.sort();
	const suites: LabExternalSuite[] = [];
	for (const name of files) {
		const filePath = path.join(externalDir, name);
		const parsed = parseExternalReport(readJson(filePath), filePath, runDir);
		if (parsed) suites.push(parsed);
	}
	const summary = { suites, reportFiles: files.map((name) => `external/${name}`) };
	return summary;
};

const summariseExternal = (suites: LabExternalSuite[]): LabExternalSummary => ({
	suites,
	total: suites.reduce((sum, item) => sum + item.total, 0),
	passed: suites.reduce((sum, item) => sum + item.passed, 0),
	failed: suites.reduce((sum, item) => sum + item.failed, 0),
});

// ---------------------------------------------------------------------------
// Lab gate
// ---------------------------------------------------------------------------

const normaliseInstrumentation = (value: unknown): LabInstrumentation | null => {
	if (!isRecord(value)) return null;
	return {
		enabled: value.enabled === true,
		contractVersion: finite(value.contractVersion) ? Number(value.contractVersion) : null,
		missingMarks: stringArray(value.missingMarks),
	};
};

const readGateBlock = (
	runDir: string,
	manifest: RunManifest,
	externalSuites: LabExternalSuite[]
): LabGateBlock => {
	const externalDir = path.join(runDir, "external");
	const sources = listFilesRecursive(externalDir)
		.filter((name) => name.endsWith("-lab-gate.json"))
		.sort()
		.map((name) => `external/${name}`);
	const cases: GateCase[] = [];
	const scenarios: GateScenario[] = [];
	const reasons: ValidityReason[] = [];
	const seenCases = new Set<string>();
	let policy: LabGateBlock["policy"] = null;
	let status: LabGateBlock["status"] | null = null;
	let aborted = false;
	let instrumentation: LabInstrumentation = { enabled: false, contractVersion: null, missingMarks: [] };

	for (const relativeFile of sources) {
		const payload = readJson(path.join(runDir, relativeFile));
		if (!isRecord(payload)) continue;
		if (isRecord(payload.policy) && finite(payload.policy.warnRatio) && finite(payload.policy.abortRatio)) {
			policy = { warnRatio: Number(payload.policy.warnRatio), abortRatio: Number(payload.policy.abortRatio) };
		}
		const declaredStatus = stringValue(payload.status);
		if (declaredStatus === "valid" || declaredStatus === "degraded" || declaredStatus === "invalid") {
			if (!status || (status === "valid" && declaredStatus !== "valid") || declaredStatus === "invalid") status = declaredStatus;
		}
		if (payload.aborted === true) aborted = true;
		const parsedInstrumentation = normaliseInstrumentation(payload.instrumentation);
		if (parsedInstrumentation) {
			instrumentation = {
				enabled: instrumentation.enabled || parsedInstrumentation.enabled,
				contractVersion: parsedInstrumentation.contractVersion ?? instrumentation.contractVersion,
				missingMarks: [...new Set([...instrumentation.missingMarks, ...parsedInstrumentation.missingMarks])],
			};
		}
		for (const rawCase of recordArray(payload.cases)) {
			const caseKey = stringValue(rawCase.caseKey);
			if (!caseKey || seenCases.has(caseKey)) continue;
			const caseStatus = rawCase.status === "invalid" ? "invalid" : "valid";
			seenCases.add(caseKey);
			cases.push({
				scenarioKey: stringValue(rawCase.scenarioKey),
				caseKey,
				id: stringValue(rawCase.id) || caseKey,
				suite: stringValue(rawCase.suite),
				status: caseStatus,
				codes: Array.isArray(rawCase.codes) ? (rawCase.codes as GateCase["codes"]) : [],
				details: stringArray(rawCase.details),
			});
		}
		for (const rawScenario of recordArray(payload.scenarios)) {
			const scenarioKey = stringValue(rawScenario.scenarioKey);
			if (!scenarioKey) continue;
			const verdict: GateScenario["verdict"] =
				rawScenario.verdict === "invalid" ? "invalid" : rawScenario.verdict === "aborted" ? "aborted" : "passed";
			const attempted = finite(rawScenario.attempted) ? Number(rawScenario.attempted) : 0;
			const valid = finite(rawScenario.valid) ? Number(rawScenario.valid) : 0;
			const invalid = finite(rawScenario.invalid) ? Number(rawScenario.invalid) : 0;
			// Split boundary steps each report a one-case scenario with the same suite/caseSet key;
			// merge their counts instead of dropping all but the first gate file.
			const existing = scenarios.find((item) => item.scenarioKey === scenarioKey);
			if (existing) {
				existing.attempted += attempted;
				existing.valid += valid;
				existing.invalid += invalid;
				existing.verdict =
					existing.verdict === "aborted" || verdict === "aborted"
						? "aborted"
						: existing.verdict === "invalid" || verdict === "invalid"
							? "invalid"
							: "passed";
				continue;
			}
			scenarios.push({
				scenarioKey,
				suite: stringValue(rawScenario.suite),
				attempted,
				valid,
				invalid,
				verdict,
			});
		}
		for (const rawReason of recordArray(payload.reasons)) {
			const scope = rawReason.scope === "case" || rawReason.scope === "scenario" ? rawReason.scope : "run";
			reasons.push({
				scope,
				id: stringValue(rawReason.id) || manifest.runId,
				code: (typeof rawReason.code === "string" ? rawReason.code : "GATE_ABORTED") as ValidityReason["code"],
				detail: typeof rawReason.detail === "string" ? rawReason.detail : undefined,
			});
		}
	}

	const derived = sources.length === 0;
	const validity = validityOf(manifest);
	const effectiveStatus: LabGateBlock["status"] =
		status ?? (validity.status === "invalid" ? "invalid" : validity.status === "degraded" ? "degraded" : "valid");

	if (derived) {
		aborted = validity.aborted;
		for (const suite of externalSuites) {
			const scenarioKey = `${suite.suite}:${suite.caseSet || "all"}`;
			if (seenScenarios.has(scenarioKey)) continue;
			seenScenarios.add(scenarioKey);
			scenarios.push({
				scenarioKey,
				suite: suite.suite,
				attempted: suite.total,
				valid: suite.passed,
				invalid: suite.failed,
				verdict: suite.failed > 0 ? "invalid" : "passed",
			});
		}
	}

	return {
		status: effectiveStatus,
		aborted,
		policy,
		cases,
		scenarios,
		instrumentation,
		reasons: [...validity.reasons, ...reasons].slice(0, 200),
		sources,
		derived,
	};
};

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

const KNOWN_METRICS: Record<string, string[]> = {
	"full-render": ["firstNonBlankMsMedian", "visuallyStableMsMedian"],
	"incremental-remote-first-pixel": ["remoteFirstPixelMsMedian", "framesToFirstPixelMedian"],
	"local-realtime-first-pixel": ["inputToFirstPixelMsMedian", "inputToFirstPixelFramesMedian"],
};

const IDENTITY_METRIC_KEYS = new Set([
	"environment",
	"runMode",
	"runs",
	"warmup",
	"validSampleCount",
	"invalidSampleCount",
	"scaleMedian",
	"roiDiffRatio",
	"inputDelayMs",
]);

const metricKeysFor = (id: string, metrics: Record<string, number | string | boolean | null>): string[] => {
	const base = id.startsWith("full-render-") ? "full-render" : id;
	const known = KNOWN_METRICS[base] ?? [];
	const instrumentedBases = Object.keys(metrics)
		.filter((key) => key.endsWith("Instrumented"))
		.map((key) => key.slice(0, -"Instrumented".length));
	const extra = Object.keys(metrics).filter(
		(key) =>
			/(MsMedian|FramesMedian|Ms|Frames|Ratio|Count|Mb)$/.test(key) &&
			!IDENTITY_METRIC_KEYS.has(key) &&
			!key.endsWith("Instrumented") &&
			typeof metrics[key] === "number"
	);
	return [...new Set([...known, ...instrumentedBases, ...extra])];
};

const metricMatch = (check: Record<string, unknown>, metric: string): boolean => {
	const checkMetric = stringValue(check.metric);
	return checkMetric === metric || checkMetric === `${metric}Median` || `${checkMetric}Median` === metric;
};

const numberFromMetricMap = (
	metrics: Record<string, number | string | boolean | null>,
	key: string
): number | null => {
	const direct = metrics[key];
	return finite(direct) ? direct : null;
};

const buildMeasurements = (
	externalSuites: LabExternalSuite[],
	gate: LabGateBlock
): LabMeasurement[] => {
	const gateByCaseKey = new Map(gate.cases.map((item) => [item.caseKey, item]));
	const gateById = new Map<string, GateCase>();
	for (const item of gate.cases) gateById.set(item.id, item);
	const measurements: LabMeasurement[] = [];
	for (const suite of externalSuites) {
		for (const externalCase of suite.cases) {
			const gateCase = gateByCaseKey.get(externalCase.caseKey) ?? gateById.get(externalCase.id);
			const validity = gateCase
				? gateCase.status === "invalid"
					? `invalid:${gateCase.codes.join("+") || "unknown"}`
					: "valid"
				: externalCase.status === "failed"
					? "failed"
					: "valid";
			for (const metric of metricKeysFor(externalCase.id, externalCase.metrics)) {
				const direct = numberFromMetricMap(externalCase.metrics, metric);
				const median = numberFromMetricMap(externalCase.metrics, `${metric}Median`);
				const externalValue = direct ?? median;
				const instrumentedBase = metric.endsWith("Median") ? metric.slice(0, -"Median".length) : metric;
				const instrumentedValue =
					numberFromMetricMap(externalCase.metrics, `${metric}Instrumented`) ??
					numberFromMetricMap(externalCase.metrics, `${instrumentedBase}Instrumented`) ??
					numberFromMetricMap(externalCase.metrics, `instrumented_${metric}`);
				if (externalValue === null && instrumentedValue === null) continue;
				const baselineCheck = externalCase.regressionChecks.find(
					(check) => stringValue(check.source) === "baseline" && metricMatch(check, metric)
				);
				const budgetCheck = externalCase.regressionChecks.find(
					(check) => stringValue(check.source) === "budget" && metricMatch(check, metric)
				);
				const learningCheck = externalCase.learningChecks.find((check) => metricMatch(check, metric));
				const witnessFromMetrics = numberFromMetricMap(externalCase.metrics, "witnessDeltaMs");
				const witnessDeltaMs =
					witnessFromMetrics ??
					(instrumentedValue !== null && externalValue !== null ? instrumentedValue - externalValue : null);
				const value = instrumentedValue ?? externalValue;
				const deltaPercent =
					numberOrNull(baselineCheck?.deltaPercent) ??
					numberOrNull(budgetCheck?.deltaPercent) ??
					(baselineCheck && finite(baselineCheck.baseline) && value !== null && Number(baselineCheck.baseline) !== 0
						? ((value - Number(baselineCheck.baseline)) / Number(baselineCheck.baseline)) * 100
						: null);
				let verdict = "ok";
				if (externalCase.status === "failed") verdict = "failed";
				else if (baselineCheck?.status === "failed" || budgetCheck?.status === "failed") verdict = "regressed";
				else if (externalCase.learningStatus === "confirmed") verdict = "confirmed";
				else if (externalCase.learningStatus === "suspected") verdict = "suspected";
				measurements.push({
					caseKey: externalCase.caseKey,
					id: externalCase.id,
					suite: suite.suite,
					env: externalCase.environment,
					scale: externalCase.scale,
					metric,
					value,
					external: externalValue,
					instrumented: instrumentedValue,
					witnessDeltaMs,
					source: instrumentedValue !== null ? "instrumented" : externalValue !== null ? "external" : "missing",
					baseline: baselineCheck && finite(baselineCheck.baseline) ? Number(baselineCheck.baseline) : null,
					budget: budgetCheck && finite(budgetCheck.allowedMax) ? Number(budgetCheck.allowedMax) : null,
					learned:
						learningCheck && finite(learningCheck.learnedMedian)
							? Number(learningCheck.learnedMedian)
							: learningCheck && finite(learningCheck.learnedUpperBound)
								? Number(learningCheck.learnedUpperBound)
								: null,
					deltaPercent,
					verdict,
					validity,
				});
			}
		}
	}
	return measurements;
};

// ---------------------------------------------------------------------------
// Coverage / obligations / gallery / logs
// ---------------------------------------------------------------------------

const coverageMetric = (value: unknown): LabCoverageMetric | null => {
	if (!isRecord(value)) return null;
	const total = numberOrNull(value.total);
	const covered = numberOrNull(value.covered);
	if (total === null || covered === null || total <= 0 || covered < 0 || covered > total) return null;
	const percent = finite(value.pct) ? Number(value.pct) : Number(((covered / total) * 100).toFixed(2));
	return { total, covered, percent };
};

const FRONTEND_METRICS = ["statements", "branches", "functions", "lines"] as const;

const readFrontendCoverage = (runDir: string, repoRoot: string): LabCoverageBlock | null => {
	const payload = readJson(path.join(runDir, "frontend", "coverage", "coverage-summary.json"));
	if (!isRecord(payload) || !isRecord(payload.total)) return null;
	const metrics: Record<string, LabCoverageMetric> = {};
	for (const name of FRONTEND_METRICS) {
		const metric = coverageMetric(payload.total[name]);
		if (metric) metrics[name] = metric;
	}
	if (Object.keys(metrics).length === 0) return null;
	const entries: LabCoverageEntry[] = [];
	for (const [key, value] of Object.entries(payload)) {
		if (key === "total" || !isRecord(value)) continue;
		const entryMetrics: Record<string, LabCoverageMetric> = {};
		for (const name of FRONTEND_METRICS) {
			const metric = coverageMetric(value[name]);
			if (metric) entryMetrics[name] = metric;
		}
		entries.push({ name: relativeSource(repoRoot, key), metrics: entryMetrics });
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return {
		kind: "frontend",
		generatedAt: stringValue(payload.generatedAt) || null,
		total: metrics.statements ?? metrics.lines ?? null,
		metrics,
		entries,
	};
};

const readGoCoverage = (runDir: string): LabCoverageBlock | null => {
	const text = readText(path.join(runDir, "backend", "coverage.out"));
	if (!text) return null;
	const lines = text.split(/\r?\n/).filter(Boolean);
	if (lines.shift() !== "mode: set") return null;
	const packages = new Map<string, { total: number; covered: number }>();
	let total = 0;
	let covered = 0;
	for (const line of lines) {
		const match = line.match(/^(.+):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/);
		if (!match) return null;
		const statements = Number(match[2]);
		const count = Number(match[3]);
		if (!Number.isInteger(statements) || statements < 0 || !Number.isInteger(count) || count < 0) return null;
		if (statements === 0) continue;
		total += statements;
		const filePath = toPosix(match[1]!).replace(/^.*?apps\/backend\//, "");
		const packagePath = path.posix.dirname(filePath);
		const entry = packages.get(packagePath) ?? { total: 0, covered: 0 };
		entry.total += statements;
		if (count > 0) {
			covered += statements;
			entry.covered += statements;
		}
		packages.set(packagePath, entry);
	}
	if (total <= 0) return null;
	const entries: LabCoverageEntry[] = [...packages.entries()]
		.sort((left, right) => left[0].localeCompare(right[0]))
		.map(([name, entry]) => ({
			name,
			metrics: {
				statements: {
					total: entry.total,
					covered: entry.covered,
					percent: Number(((entry.covered / entry.total) * 100).toFixed(2)),
				},
			},
		}));
	return {
		kind: "go",
		generatedAt: null,
		total: { total, covered, percent: Number(((covered / total) * 100).toFixed(2)) },
		metrics: {
			statements: { total, covered, percent: Number(((covered / total) * 100).toFixed(2)) },
		},
		entries,
	};
};

const readObligations = (runDir: string, repoRoot: string): LabObligations => {
	const featurePayload = readJson(path.join(runDir, "catalog", "feature-obligations.json"));
	let featureCatalog: LabFeatureObligations | null = null;
	if (isRecord(featurePayload) && Array.isArray(featurePayload.obligations)) {
		const stateCounts: Record<string, number> = {};
		const unresolvedIds: string[] = [];
		const surfaces = new Set<string>();
		let total = 0;
		for (const raw of recordArray(featurePayload.obligations)) {
			const state = stringValue(raw.state) || "unknown";
			stateCounts[state] = (stateCounts[state] ?? 0) + 1;
			total += 1;
			if (state === "partial" || state === "uncovered") unresolvedIds.push(stringValue(raw.id));
			const kind = stringValue(raw.kind);
			const surface = stringValue(raw.surface);
			if (surface) surfaces.add(`${kind}:${surface}`);
		}
		featureCatalog = {
			scope: stringValue(featurePayload.scope),
			total,
			sourceSurfaceCount: surfaces.size,
			stateCounts,
			unresolvedIds,
		};
	}

	const inventoryCandidates = [
		path.join(runDir, "catalog", "lab-inventory.json"),
		path.join(repoRoot, "tests", "catalog", "lab-inventory.json"),
	];
	let inventory: LabInventoryObligations | null = null;
	for (const candidate of inventoryCandidates) {
		const payload = readJson(candidate);
		if (!isRecord(payload) || !Array.isArray(payload.obligations)) continue;
		const counts = { covered: 0, partial: 0, uncovered: 0, excluded: 0 };
		const unresolvedIds: string[] = [];
		const obligations = recordArray(payload.obligations);
		for (const raw of obligations) {
			const state = stringValue(raw.state);
			if (state === "covered" || state === "partial" || state === "uncovered" || state === "excluded") {
				counts[state] += 1;
			}
			if (state !== "covered") unresolvedIds.push(stringValue(raw.id));
		}
		inventory = {
			scope: stringValue(payload.scope),
			total: obligations.length,
			...counts,
			unresolvedIds,
		};
		break;
	}
	return { featureCatalog, inventory };
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

const collectImages = (directory: string, limit: number): string[] => {
	const found: string[] = [];
	const walk = (current: string) => {
		if (found.length >= limit) return;
		for (const entry of listDirectory(current)) {
			if (found.length >= limit) return;
			if (entry === "node_modules" || entry === ".git") continue;
			const filePath = path.join(current, entry);
			let stats: fs.Stats;
			try {
				stats = fs.statSync(filePath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				walk(filePath);
				continue;
			}
			if (stats.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase())) found.push(filePath);
		}
	};
	walk(directory);
	return found;
};

const buildGallery = (runDir: string, externalSuites: LabExternalSuite[]): LabGalleryItem[] => {
	const items = new Map<string, LabGalleryItem>();
	const addImage = (filePath: string, label: string) => {
		const relative = relativeArtifact(runDir, filePath);
		if (items.has(relative)) return;
		items.set(relative, { label, path: relative, kind: "image", exists: exists(filePath) });
	};
	for (const suite of externalSuites) {
		for (const externalCase of suite.cases) {
			for (const artifact of externalCase.artifacts) {
				const absolute = path.resolve(runDir, artifact);
				if (IMAGE_EXTENSIONS.has(path.extname(artifact).toLowerCase()) && exists(absolute)) {
					addImage(absolute, `${externalCase.id} · ${path.basename(artifact)}`);
				}
			}
		}
	}
	for (const filePath of collectImages(runDir, 160)) {
		addImage(filePath, path.relative(runDir, filePath));
	}
	const files: LabGalleryItem[] = [];
	for (const relative of ["lab-report.json", "test-report.json", "perf-request.json"]) {
		const absolute = path.join(runDir, relative);
		if (exists(absolute)) files.push({ label: relative, path: relative, kind: "file", exists: true });
	}
	const externalDir = path.join(runDir, "external");
	for (const relativePath of listFilesRecursive(externalDir)) {
		if (!/(external-results\.json|-lab-gate\.json|external-summary\.md)$/.test(relativePath)) continue;
		const relative = `external/${relativePath}`;
		files.push({ label: relative, path: relative, kind: "file", exists: true });
	}
	return [...items.values(), ...files];
};

const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_FILES = 40;

const readLogs = (runDir: string): Record<string, string> => {
	const logsDir = path.join(runDir, "logs");
	const logs: Record<string, string> = {};
	for (const name of listDirectory(logsDir).filter((item) => item.endsWith(".log")).sort()) {
		if (Object.keys(logs).length >= MAX_LOG_FILES) break;
		const filePath = path.join(logsDir, name);
		let stats: fs.Stats;
		try {
			stats = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;
		const content = readText(filePath);
		if (content === null) continue;
		logs[toPosix(path.relative(runDir, filePath))] =
			content.length > MAX_LOG_BYTES
				? `[lab-report] 日志已截断（仅保留末尾 ${Math.round(MAX_LOG_BYTES / 1024)} KB）\n${content.slice(-MAX_LOG_BYTES)}`
				: content;
	}
	return logs;
};

// ---------------------------------------------------------------------------
// Failures / rerun index
// ---------------------------------------------------------------------------

const buildFailures = (
	manifest: RunManifest,
	aggregate: AggregateReport,
	gate: LabGateBlock,
	externalSuites: LabExternalSuite[],
	measurements: LabMeasurement[],
	unit: LabSuiteSummary,
	integration: LabSuiteSummary,
	browser: LabSuiteSummary,
	goSuite: LabGoSummary
): string[] => {
	const failures: string[] = [];
	const push = (message: string) => {
		if (message && !failures.includes(message)) failures.push(message);
	};
	for (const failure of Array.isArray(aggregate.failures) ? aggregate.failures : []) push(failure);
	for (const step of manifest.steps ?? []) {
		if (step.status === "failed" || step.status === "cancelled") {
			push(`${step.id}: ${step.error || step.status}`);
		}
	}
	for (const reason of gate.reasons) {
		push(`${reason.scope}:${reason.id} ${reason.code}${reason.detail ? ` (${reason.detail})` : ""}`);
	}
	for (const suite of [unit, integration, browser]) {
		for (const testCase of suite.cases.filter((item) => item.status === "failed").slice(0, 30)) {
			push(`${suite.id}: ${testCase.file} · ${testCase.title}`);
		}
	}
	for (const entry of goSuite.packages.filter((item) => item.status === "failed").slice(0, 30)) {
		push(`go: ${entry.package}`);
	}
	for (const suite of externalSuites) {
		for (const externalCase of suite.cases.filter((item) => item.status === "failed").slice(0, 30)) {
			push(`${suite.suite}/${externalCase.id}: ${externalCase.failureType}${externalCase.error ? ` · ${externalCase.error}` : ""}`);
		}
	}
	for (const measurement of measurements.filter((item) => item.validity.startsWith("invalid")).slice(0, 50)) {
		push(`${measurement.caseKey}/${measurement.metric}: ${measurement.validity}`);
	}
	return failures;
};

const buildRerunIndex = (
	gates: LabGateBlock,
	unit: LabSuiteSummary,
	integration: LabSuiteSummary,
	browser: LabSuiteSummary,
	externalSuites: LabExternalSuite[]
): LabRerunIndex => {
	const cases = new Map<string, LabRerunCase>();
	const addCase = (entry: LabRerunCase) => {
		if (!cases.has(`${entry.suite}::${entry.caseKey}`)) cases.set(`${entry.suite}::${entry.caseKey}`, entry);
	};
	for (const suite of [unit, integration, browser]) {
		for (const testCase of suite.cases) {
			addCase({ caseKey: testCase.caseKey, id: testCase.id, suite: suite.id, title: testCase.title });
		}
	}
	for (const suite of externalSuites) {
		for (const externalCase of suite.cases) {
			if (!externalCase.rerunnable) continue;
			addCase({ caseKey: externalCase.caseKey, id: externalCase.id, suite: suite.suite, title: externalCase.title });
		}
	}
	const scenarios: LabRerunScenario[] = [];
	const scenarioById = new Map<string, LabRerunScenario>();
	for (const scenario of gates.scenarios) {
		const ids = new Set<string>();
		for (const gateCase of gates.cases.filter((item) => item.scenarioKey === scenario.scenarioKey)) {
			if (gateCase.id) ids.add(gateCase.id);
		}
		if (ids.size === 0) {
			for (const suite of externalSuites) {
				if (suite.suite !== scenario.suite && !scenario.scenarioKey.includes(suite.suite)) continue;
				for (const externalCase of suite.cases) if (externalCase.rerunnable) ids.add(externalCase.id);
			}
		}
		scenarioById.set(scenario.scenarioKey, {
			scenarioKey: scenario.scenarioKey,
			suite: scenario.suite,
			verdict: scenario.verdict,
			ids: [...ids],
		});
	}
	scenarios.push(...scenarioById.values());
	return { cases: [...cases.values()], scenarios };
};

// ---------------------------------------------------------------------------
// Report assembly + writer
// ---------------------------------------------------------------------------

export const buildLabReport = (
	runDir: string,
	manifest: RunManifest,
	aggregate: AggregateReport
): LabReport => {
	const absoluteRunDir = path.resolve(runDir);
	const repoRoot = repoRootOf(absoluteRunDir);

	const vitestPayload = readJson(path.join(absoluteRunDir, "frontend", "vitest.json"));
	const browserPayload = readJson(path.join(absoluteRunDir, "frontend", "browser.json"));
	const parsedVitest = parseVitestReport(vitestPayload, repoRoot);
	const parsedBrowser = parseVitestReport(browserPayload, repoRoot);

	const unitCases: LabTestCase[] = [];
	const integrationCases: LabTestCase[] = [];
	for (const testCase of parsedVitest.cases) {
		if (classifyVitestFile(testCase.file) === "integration") integrationCases.push(testCase);
		else unitCases.push(testCase);
	}
	unitCases.sort((left, right) => left.file.localeCompare(right.file) || left.title.localeCompare(right.title));
	integrationCases.sort((left, right) => left.file.localeCompare(right.file) || left.title.localeCompare(right.title));
	parsedBrowser.cases.sort((left, right) => left.file.localeCompare(right.file) || left.title.localeCompare(right.title));

	const unit = summariseVitest("unit", "前端单元与 shared / harness", {
		cases: unitCases,
		files: [...new Set(unitCases.map((item) => item.file))],
	});
	const integration = summariseVitest("integration", "前端模块集成（service / store）", {
		cases: integrationCases,
		files: [...new Set(integrationCases.map((item) => item.file))],
	});
	const browser = summariseVitest("browser", "浏览器组件（Vitest browser / Playwright）", parsedBrowser);

	const goSuite = parseGoTests(readText(path.join(absoluteRunDir, "backend", "go-tests.jsonl")));

	const { suites: externalSuites } = readExternalSuites(absoluteRunDir);
	const performanceSuites = externalSuites.filter((item) => item.suite === "performance-external");
	const e2eSuites = externalSuites.filter((item) => item.suite !== "performance-external");
	const e2e = summariseExternal(e2eSuites);
	const performance = summariseExternal(performanceSuites);

	const gate = readGateBlock(absoluteRunDir, manifest, externalSuites);
	const measurements = buildMeasurements(externalSuites, gate);
	const coverage: LabCoverage = {
		frontend: readFrontendCoverage(absoluteRunDir, repoRoot),
		go: readGoCoverage(absoluteRunDir),
	};
	const obligations = readObligations(absoluteRunDir, repoRoot);
	const logs = readLogs(absoluteRunDir);
	const gallery = buildGallery(absoluteRunDir, externalSuites);

	const run: LabRunBlock = {
		id: stringValue(manifest.runId),
		mode: modeOf(manifest),
		profile: stringValue(manifest.profile),
		status: stringValue(manifest.status),
		validity: validityOf(manifest),
		recorded: recordedOf(manifest),
		source: (manifest.source ?? {
			revision: null,
			dirtyPatchSha256: "",
		}) as RunManifest["source"],
		startedAt: stringValue(manifest.startedAt),
		finishedAt: typeof manifest.finishedAt === "string" ? manifest.finishedAt : null,
		durationMs: durationBetween(stringValue(manifest.startedAt), typeof manifest.finishedAt === "string" ? manifest.finishedAt : null),
		rerunOf: isRecord(manifest.rerun) ? stringValue(manifest.rerun.ofRunId) || null : null,
		rerunScope: isRecord(manifest.rerun) ? stringValue(manifest.rerun.scope) || null : null,
		rerunIds: isRecord(manifest.rerun) ? stringArray(manifest.rerun.ids) : [],
		policy: capturePolicyOf(manifest),
	};

	const suites = { unit, integration, browser, go: goSuite, e2e, performance };
	const failures = buildFailures(
		manifest,
		aggregate,
		gate,
		externalSuites,
		measurements,
		unit,
		integration,
		browser,
		goSuite
	);
	const rerun = buildRerunIndex(gate, unit, integration, browser, externalSuites);
	const cases = [...unit.cases, ...integration.cases, ...browser.cases, ...goSuite.cases];

	return {
		schemaVersion: 2,
		generatedAt: new Date().toISOString(),
		run,
		steps: Array.isArray(manifest.steps) ? manifest.steps : [],
		artifacts: Array.isArray(aggregate.artifacts) ? aggregate.artifacts : [],
		gate,
		instrumentation: gate.instrumentation,
		suites,
		cases,
		measurements,
		coverage,
		obligations,
		failures,
		logs,
		gallery,
		rerun,
	};
};

/**
 * Build the unified lab report, then write:
 *   - `<runDir>/lab-report.json`  (machine-readable model)
 *   - `<runDir>/lab-report.html`  (lab report page)
 *   - `<runDir>/test-report.html` (same content, keeps the legacy entry point working)
 */
export const writeLabReport = (input: {
	runDir: string;
	manifest: RunManifest;
	aggregate: AggregateReport;
}): LabReport => {
	const runDir = path.resolve(input.runDir);
	const report = buildLabReport(runDir, input.manifest, input.aggregate);
	atomicWrite(path.join(runDir, "lab-report.json"), `${JSON.stringify(report, null, 2)}\n`);
	const html = renderLabHtml(report);
	atomicWrite(path.join(runDir, "lab-report.html"), html);
	atomicWrite(path.join(runDir, "test-report.html"), html);
	return report;
};

const runCli = async () => {
	const args = process.argv.slice(2);
	const argValue = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
	const runId = argValue("run-id") || process.env.AEVIA_LAB_RUN_ID;
	const runDirArg = argValue("run-dir");
	const runDir = runDirArg
		? path.resolve(runDirArg)
		: runId
			? path.join(process.cwd(), "tests", "reports", "summary", "runs", runId)
			: "";
	if (!runDir) {
		throw new Error("用法: tsx tests/report/lab-report.ts --run-id=<uuid> 或 --run-dir=<run 目录>");
	}
	const manifestPath = path.join(runDir, "run-manifest.json");
	if (!exists(manifestPath)) throw new Error(`run manifest 不存在: ${manifestPath}`);
	const manifest = JSON.parse(readText(manifestPath) ?? "{}") as RunManifest;
	const { writeAggregateReport } = await import("./aggregate");
	const aggregate = writeAggregateReport(manifestPath);
	const report = writeLabReport({ runDir, manifest, aggregate });
	console.log(
		`[lab-report] run=${report.run.id} mode=${report.run.mode} status=${report.run.status} validity=${report.run.validity.status} measurements=${report.measurements.length}`
	);
	console.log(`[lab-report] ${path.join(runDir, "lab-report.html")}`);
};

if (process.argv[1] && path.resolve(process.argv[1]).replaceAll("\\", "/").endsWith("/tests/report/lab-report.ts")) {
	runCli().catch((error) => {
		console.error(`[lab-report] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
