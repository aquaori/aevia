// File role: fail-closed aggregation of current-run evidence plus the lab measurement gate.
import fs from "node:fs";
import path from "node:path";
import type {
	ExpectedArtifact,
	GateCase,
	GateScenario,
	LabInventoryObligation,
	RunManifest,
	ValidityReason,
} from "./contract";
import { isLabMode, isRerunScope, isValidityCode, isValidityStatus } from "./contract";
import { writeLabReport } from "./lab-report";

export type ArtifactResult = {
	id: string;
	stepId: string;
	kind: string;
	status: "passed" | "failed" | "missing" | "invalid";
	total: number;
	passed: number;
	failed: number;
	sourceCount?: number;
	coverageMetrics?: Record<string, { total: number; covered: number; percent: number }>;
	coverageByPackage?: Record<string, { total: number; covered: number; percent: number }>;
	featureInventory?: {
		scope: string;
		sourceSurfaceCount: number;
		stateCounts: Record<string, number>;
		unresolvedIds: string[];
	};
	caseIds?: string[];
	gate?: {
		status: string;
		aborted: boolean;
		caseCount: number;
		scenarioKeys: string[];
	};
	inventory?: {
		total: number;
		covered: number;
		partial: number;
		uncovered: number;
		excluded: number;
		unresolvedIds: string[];
	};
	error?: string;
};

export type AggregateReport = {
	schemaVersion: 2;
	runId: string;
	status: "passed" | "failed";
	generatedAt: string;
	manifest: string;
	profile: string;
	mode: string;
	validity: RunManifest["validity"];
	recorded: boolean;
	source: RunManifest["source"];
	steps: RunManifest["steps"];
	artifacts: ArtifactResult[];
	failures: string[];
};

const readJson = (filePath: string): unknown => {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const finiteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

const stringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const missingResult = (
	expected: ExpectedArtifact,
	status: ArtifactResult["status"],
	error: string
): ArtifactResult => ({
	id: expected.id,
	stepId: expected.stepId,
	kind: expected.kind,
	status,
	total: 0,
	passed: 0,
	failed: 1,
	error,
});

const validateVitest = (expected: ExpectedArtifact, payload: unknown): ArtifactResult => {
	if (!isRecord(payload) || payload.success !== true) {
		return missingResult(expected, "invalid", "Vitest report is invalid or did not complete successfully");
	}
	const total = payload.numTotalTests;
	const failed = payload.numFailedTests;
	const skipped = Number(payload.numPendingTests ?? 0) + Number(payload.numTodoTests ?? 0);
	if (!finiteNumber(total) || !finiteNumber(failed) || !finiteNumber(skipped) || total <= 0) {
		return missingResult(expected, "invalid", "Vitest report has missing or empty test counts");
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: failed > 0 || skipped > 0 ? "failed" : "passed",
		total,
		passed: Math.max(0, total - failed - skipped),
		failed: failed + skipped,
		error: failed > 0 ? `${failed} tests failed` : skipped > 0 ? `${skipped} tests did not run` : undefined,
	};
};

const validateGoTests = (expected: ExpectedArtifact, text: string): ArtifactResult => {
	const packages = new Set<string>();
	let failed = false;
	let malformed = false;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event: unknown = JSON.parse(line);
			if (!isRecord(event)) {
				malformed = true;
				continue;
			}
			if (event.Action === "fail") failed = true;
			if (event.Action === "pass" && typeof event.Package === "string") packages.add(event.Package);
		} catch {
			malformed = true;
		}
	}
	if (packages.size === 0 || malformed) {
		return missingResult(expected, "invalid", "Go JSON test output is missing, malformed, or empty");
	}
	const expectedPackages = expected.expectedCases || [];
	const missing = expectedPackages.filter((item) => !packages.has(item));
	const unexpected = [...packages].filter((item) => expectedPackages.length > 0 && !expectedPackages.includes(item));
	if (missing.length > 0 || unexpected.length > 0) {
		return missingResult(
			expected,
			"failed",
			[
				missing.length ? `missing Go packages: ${missing.join(", ")}` : "",
				unexpected.length ? `unexpected Go packages: ${unexpected.join(", ")}` : "",
			].filter(Boolean).join("; ")
		);
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: failed ? "failed" : "passed",
		total: packages.size,
		passed: failed ? packages.size - 1 : packages.size,
		failed: failed ? 1 : 0,
		error: failed ? "One or more Go packages failed" : undefined,
	};
};

const validatePackageList = (expected: ExpectedArtifact, text: string): ArtifactResult => {
	const packages = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
	if (packages.length === 0 || new Set(packages).size !== packages.length) {
		return missingResult(expected, "invalid", "Go package inventory is empty or contains duplicates");
	}
	return { id: expected.id, stepId: expected.stepId, kind: expected.kind, status: "passed", total: packages.length, passed: packages.length, failed: 0 };
};

const validateFeatureCatalog = (expected: ExpectedArtifact, payload: unknown): ArtifactResult => {
	if (!isRecord(payload) || payload.schemaVersion !== 1 || typeof payload.scope !== "string" || !payload.scope.trim() ||
		!Array.isArray(payload.obligations) || payload.obligations.length === 0) {
		return missingResult(expected, "invalid", "Feature catalog is missing a supported schema or obligations");
	}
	const ids = new Set<string>();
	const sourceSurfaces = new Set<string>();
	const stateCounts: Record<string, number> = {};
	const unresolvedIds: string[] = [];
	const allowedKinds = new Set(["http", "ws", "scene", "frontend"]);
	const allowedStates = new Set(["obligation_verified", "partial", "uncovered", "rejection_contract_verified"]);
	for (const rawObligation of payload.obligations) {
		if (!isRecord(rawObligation) || typeof rawObligation.id !== "string" || !rawObligation.id.trim() ||
			typeof rawObligation.kind !== "string" || !allowedKinds.has(rawObligation.kind) ||
			typeof rawObligation.surface !== "string" || !rawObligation.surface.trim() ||
			typeof rawObligation.state !== "string" || !allowedStates.has(rawObligation.state) ||
			typeof rawObligation.oracle !== "string" || !rawObligation.oracle.trim() || !Array.isArray(rawObligation.evidence) ||
			rawObligation.evidence.some((evidence) => typeof evidence !== "string")) {
			return missingResult(expected, "invalid", "Feature catalog contains a malformed surface or obligation");
		}
		if (ids.has(rawObligation.id)) return missingResult(expected, "invalid", `Feature catalog contains duplicate id ${rawObligation.id}`);
		ids.add(rawObligation.id);
		sourceSurfaces.add(`${rawObligation.kind}:${rawObligation.surface}`);
		stateCounts[rawObligation.state] = (stateCounts[rawObligation.state] || 0) + 1;
		if (rawObligation.state === "partial" || rawObligation.state === "uncovered") unresolvedIds.push(rawObligation.id);
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total: ids.size,
		passed: ids.size,
		failed: 0,
		featureInventory: { scope: payload.scope, sourceSurfaceCount: sourceSurfaces.size, stateCounts, unresolvedIds },
	};
};

const sourcePathKey = (value: string) => {
	const resolved = path.resolve(value).replaceAll("\\", "/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const validateCoverage = (expected: ExpectedArtifact, payload: unknown): ArtifactResult => {
	if (!isRecord(payload) || !isRecord(payload.total) || !isRecord(payload.total.statements)) {
		return missingResult(expected, "invalid", "Coverage summary is missing its statement denominator");
	}
	const expectedSources = expected.expectedSources || [];
	if (expectedSources.length === 0 || new Set(expectedSources).size !== expectedSources.length) {
		return missingResult(expected, "invalid", "Coverage manifest has an empty or duplicate source inventory");
	}
	const actualSources = Object.keys(payload).filter((key) => key !== "total");
	const expectedKeys = new Set(expectedSources.map(sourcePathKey));
	const actualKeys = new Set(actualSources.map(sourcePathKey));
	const missingSources = expectedSources.filter((source) => !actualKeys.has(sourcePathKey(source)));
	const unexpectedSources = actualSources.filter((source) => !expectedKeys.has(sourcePathKey(source)));
	if (missingSources.length > 0 || unexpectedSources.length > 0) {
		return missingResult(
			expected,
			"invalid",
			[
				missingSources.length ? `missing source files: ${missingSources.join(", ")}` : "",
				unexpectedSources.length ? `unexpected source files: ${unexpectedSources.join(", ")}` : "",
			].filter(Boolean).join("; ")
		);
	}
	const coverageMetrics: NonNullable<ArtifactResult["coverageMetrics"]> = {};
	for (const name of ["statements", "functions", "branches", "lines"]) {
		const metric = payload.total[name];
		if (!isRecord(metric) || !finiteNumber(metric.total) || !finiteNumber(metric.covered) ||
			metric.total <= 0 || metric.covered < 0 || metric.covered > metric.total) {
			return missingResult(expected, "invalid", `Coverage report has an invalid or empty denominator for ${name}`);
		}
		coverageMetrics[name] = {
			total: metric.total,
			covered: metric.covered,
			percent: Number(((metric.covered / metric.total) * 100).toFixed(2)),
		};
	}
	const { total, covered } = coverageMetrics.statements!;
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total,
		passed: covered,
		failed: total - covered,
		sourceCount: actualSources.length,
		coverageMetrics,
	};
};

const caseKeyOf = (result: Record<string, unknown>) => {
	if (typeof result.caseKey === "string" && result.caseKey) return result.caseKey;
	const id = typeof result.id === "string" ? result.id : "";
	const environment = typeof result.environment === "string" ? result.environment : "";
	const scale = result.scale == null ? "" : String(result.scale);
	return `${id}|${environment}|${scale}`;
};

const validateExternal = (
	expected: ExpectedArtifact,
	payload: unknown,
	runId: string,
	sourceRevision: string,
	dirtyPatchSha256: string
): ArtifactResult => {
	if (!isRecord(payload) || !isRecord(payload.run) || !isRecord(payload.summary) || !Array.isArray(payload.results)) {
		return missingResult(expected, "invalid", "External report is missing run identity or results");
	}
	if (
		payload.run.id !== runId ||
		payload.run.sourceRevision !== sourceRevision ||
		payload.run.dirtyPatchSha256 !== dirtyPatchSha256
	) {
		return missingResult(expected, "invalid", "External report run or source identity does not match the manifest");
	}
	if ("validity" in payload) {
		const validity = payload.validity;
		if (!isRecord(validity) || validity.status !== "valid" || validity.aborted === true) {
			return missingResult(expected, "invalid", "External report reports invalid or aborted measurement collection");
		}
	}
	const results = payload.results.filter(isRecord);
	const caseKeys = results.map(caseKeyOf);
	const duplicateKeys = caseKeys.length !== new Set(caseKeys).size;
	const ids = results.map((result) => result.id).filter((id): id is string => typeof id === "string");
	const uniqueIds = [...new Set(ids)];
	const expectedCases = expected.expectedCases || [];
	const seen = new Set(ids);
	const missing = expectedCases.filter((id) => !seen.has(id));
	const unexpected = expectedCases.length > 0 ? uniqueIds.filter((id) => !expectedCases.includes(id)) : [];
	const failed = results.filter((result) => result.status !== "passed").length;
	const total = Number(payload.summary.total);
	const summaryPassed = Number(payload.summary.passed);
	const summaryFailed = Number(payload.summary.failed);
	if (
		!finiteNumber(total) || total !== results.length || duplicateKeys || failed > 0 ||
		missing.length > 0 || unexpected.length > 0 || ids.length !== results.length ||
		summaryPassed !== results.length || summaryFailed !== 0
	) {
		const issues = [
			duplicateKeys ? "duplicate case keys" : "",
			missing.length ? `missing cases: ${missing.join(", ")}` : "",
			unexpected.length ? `unexpected cases: ${unexpected.join(", ")}` : "",
			failed ? `${failed} cases did not pass` : "",
			!finiteNumber(total) || total !== results.length ? "invalid total" : "",
			summaryPassed !== results.length || summaryFailed !== 0 ? "summary counts do not match case results" : "",
		].filter(Boolean);
		return missingResult(expected, "failed", issues.join("; ") || "External report is incomplete");
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total,
		passed: total,
		failed: 0,
		caseIds: uniqueIds,
	};
};

const validityReasonSummary = (reasons: readonly ValidityReason[]) =>
	reasons
		.map((reason) => `${reason.scope}:${reason.id}:${reason.code}${reason.detail ? `(${reason.detail})` : ""}`)
		.join(", ");

const codeSummary = (codes: readonly string[]) => [...new Set(codes)].join(", ");

const validateLabGate = (expected: ExpectedArtifact, payload: unknown): ArtifactResult => {
	if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.policy) || !isRecord(payload.instrumentation) ||
		!Array.isArray(payload.cases) || !Array.isArray(payload.scenarios) || !Array.isArray(payload.reasons) ||
		!isValidityStatus(payload.status) || typeof payload.aborted !== "boolean") {
		return missingResult(expected, "invalid", "Lab gate report is missing its schema, policy, cases, or scenarios");
	}
	const policy = payload.policy;
	if (!finiteNumber(policy.warnRatio) || !finiteNumber(policy.abortRatio)) {
		return missingResult(expected, "invalid", "Lab gate report has no numeric warn/abort ratio");
	}
	const instrumentation = payload.instrumentation;
	if (typeof instrumentation.enabled !== "boolean" || !stringArray(instrumentation.missingMarks) ||
		!(instrumentation.contractVersion === null || finiteNumber(instrumentation.contractVersion))) {
		return missingResult(expected, "invalid", "Lab gate report has a malformed instrumentation block");
	}
	const cases: GateCase[] = [];
	const caseKeys = new Set<string>();
	for (const rawCase of payload.cases) {
		if (!isRecord(rawCase) || typeof rawCase.scenarioKey !== "string" || !rawCase.scenarioKey.trim() ||
			typeof rawCase.caseKey !== "string" || !rawCase.caseKey.trim() ||
			typeof rawCase.id !== "string" || !rawCase.id.trim() ||
			typeof rawCase.suite !== "string" || !rawCase.suite.trim() ||
			(rawCase.status !== "valid" && rawCase.status !== "invalid") ||
			!Array.isArray(rawCase.codes) || rawCase.codes.some((code) => !isValidityCode(code)) ||
			!stringArray(rawCase.details)) {
			return missingResult(expected, "invalid", "Lab gate report contains a malformed case entry");
		}
		if (caseKeys.has(rawCase.caseKey)) {
			return missingResult(expected, "invalid", `Lab gate report contains duplicate case key ${rawCase.caseKey}`);
		}
		caseKeys.add(rawCase.caseKey);
		cases.push({
			scenarioKey: rawCase.scenarioKey,
			caseKey: rawCase.caseKey,
			id: rawCase.id,
			suite: rawCase.suite,
			status: rawCase.status,
			codes: rawCase.codes,
			details: rawCase.details,
		});
	}
	const scenarios: GateScenario[] = [];
	const scenarioKeys = new Set<string>();
	for (const rawScenario of payload.scenarios) {
		if (!isRecord(rawScenario) || typeof rawScenario.scenarioKey !== "string" || !rawScenario.scenarioKey.trim() ||
			typeof rawScenario.suite !== "string" || !rawScenario.suite.trim() ||
			!finiteNumber(rawScenario.attempted) || !finiteNumber(rawScenario.valid) || !finiteNumber(rawScenario.invalid) ||
			rawScenario.attempted < 0 || rawScenario.valid < 0 || rawScenario.invalid < 0 ||
			(rawScenario.verdict !== "passed" && rawScenario.verdict !== "invalid" && rawScenario.verdict !== "aborted")) {
			return missingResult(expected, "invalid", "Lab gate report contains a malformed scenario entry");
		}
		if (scenarioKeys.has(rawScenario.scenarioKey)) {
			return missingResult(expected, "invalid", `Lab gate report contains duplicate scenario key ${rawScenario.scenarioKey}`);
		}
		scenarioKeys.add(rawScenario.scenarioKey);
		scenarios.push({
			scenarioKey: rawScenario.scenarioKey,
			suite: rawScenario.suite,
			attempted: rawScenario.attempted,
			valid: rawScenario.valid,
			invalid: rawScenario.invalid,
			verdict: rawScenario.verdict,
		});
	}
	for (const reason of payload.reasons) {
		if (!isRecord(reason) || typeof reason.id !== "string" || !isValidityCode(reason.code) ||
			(reason.scope !== "case" && reason.scope !== "scenario" && reason.scope !== "run")) {
			return missingResult(expected, "invalid", "Lab gate report contains a malformed validity reason");
		}
	}
	for (const scenario of scenarios) {
		if (scenario.valid + scenario.invalid !== scenario.attempted) {
			return missingResult(expected, "invalid", `Lab gate scenario ${scenario.scenarioKey} counts do not add up`);
		}
		const scenarioCases = cases.filter((item) => item.scenarioKey === scenario.scenarioKey);
		const validCount = scenarioCases.filter((item) => item.status === "valid").length;
		if (scenarioCases.length !== scenario.attempted || validCount !== scenario.valid) {
			return missingResult(expected, "invalid", `Lab gate scenario ${scenario.scenarioKey} does not match its case list`);
		}
	}
	const unmatched = cases.filter((item) => !scenarioKeys.has(item.scenarioKey));
	if (unmatched.length > 0) {
		return missingResult(expected, "invalid", `Lab gate has cases outside any scenario: ${unmatched.map((item) => item.caseKey).join(", ")}`);
	}
	const invalidCases = cases.filter((item) => item.status === "invalid");
	const caseIds = [...new Set(cases.map((item) => item.id))];
	const gate = {
		status: payload.status,
		aborted: payload.aborted,
		caseCount: cases.length,
		scenarioKeys: [...scenarioKeys],
	};
	if (payload.status === "invalid" || payload.aborted) {
		const reasons = (payload.reasons as ValidityReason[]).map((reason) => reason);
		return {
			id: expected.id,
			stepId: expected.stepId,
			kind: expected.kind,
			status: "failed",
			total: cases.length,
			passed: cases.length - invalidCases.length,
			failed: Math.max(1, invalidCases.length),
			caseIds,
			gate,
			error: `Lab gate aborted because measurement collection failed: ${validityReasonSummary(reasons) || codeSummary(invalidCases.flatMap((item) => item.codes)) || "no reason recorded"}`,
		};
	}
	if (invalidCases.length > 0) {
		return {
			id: expected.id,
			stepId: expected.stepId,
			kind: expected.kind,
			status: "failed",
			total: cases.length,
			passed: cases.length - invalidCases.length,
			failed: invalidCases.length,
			caseIds,
			gate,
			error: `${invalidCases.length} case(s) had invalid measurements (${codeSummary(invalidCases.flatMap((item) => item.codes))}): ${invalidCases.map((item) => item.caseKey).join(", ")}`,
		};
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total: cases.length,
		passed: cases.length,
		failed: 0,
		caseIds,
		gate,
	};
};

const validateLabInventory = (expected: ExpectedArtifact, payload: unknown): ArtifactResult => {
	if (!isRecord(payload) || payload.schemaVersion !== 1 || typeof payload.scope !== "string" || !payload.scope.trim() ||
		!Array.isArray(payload.obligations) || payload.obligations.length === 0) {
		return missingResult(expected, "invalid", "Lab inventory report is missing its schema, scope, or obligations");
	}
	const obligations: LabInventoryObligation[] = [];
	const ids = new Set<string>();
	const stateCounts = { covered: 0, partial: 0, uncovered: 0, excluded: 0 };
	const unresolvedIds: string[] = [];
	for (const rawObligation of payload.obligations) {
		if (!isRecord(rawObligation) || typeof rawObligation.id !== "string" || !rawObligation.id.trim() ||
			(rawObligation.kind !== "frontend" && rawObligation.kind !== "go") ||
			typeof rawObligation.path !== "string" || !rawObligation.path.trim() ||
			(rawObligation.state !== "covered" && rawObligation.state !== "partial" &&
				rawObligation.state !== "uncovered" && rawObligation.state !== "excluded")) {
			return missingResult(expected, "invalid", "Lab inventory contains a malformed obligation");
		}
		if (ids.has(rawObligation.id)) {
			return missingResult(expected, "invalid", `Lab inventory contains duplicate id ${rawObligation.id}`);
		}
		if (rawObligation.state === "excluded" && (typeof rawObligation.reason !== "string" || !rawObligation.reason.trim())) {
			return missingResult(expected, "invalid", `Lab inventory obligation ${rawObligation.id} is excluded without a reason`);
		}
		if (
			(rawObligation.state === "covered" || rawObligation.state === "partial") &&
			(typeof rawObligation.owner !== "string" || !rawObligation.owner.trim())
		) {
			return missingResult(expected, "invalid", `Lab inventory obligation ${rawObligation.id} has no owning test`);
		}
		ids.add(rawObligation.id);
		stateCounts[rawObligation.state] += 1;
		if (rawObligation.state !== "covered") unresolvedIds.push(rawObligation.id);
		obligations.push({
			id: rawObligation.id,
			kind: rawObligation.kind,
			path: rawObligation.path,
			state: rawObligation.state,
			owner: typeof rawObligation.owner === "string" ? rawObligation.owner : undefined,
			reason: typeof rawObligation.reason === "string" ? rawObligation.reason : undefined,
		});
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total: obligations.length,
		passed: stateCounts.covered,
		failed: obligations.length - stateCounts.covered,
		inventory: {
			total: obligations.length,
			covered: stateCounts.covered,
			partial: stateCounts.partial,
			uncovered: stateCounts.uncovered,
			excluded: stateCounts.excluded,
			unresolvedIds,
		},
	};
};

const validatePerfRequest = (expected: ExpectedArtifact, payload: unknown): ArtifactResult => {
	if (!isRecord(payload) || payload.schemaVersion !== 1 || typeof payload.requestedAt !== "string" ||
		Number.isNaN(Date.parse(payload.requestedAt)) || typeof payload.reason !== "string" || !payload.reason.trim() ||
		!Array.isArray(payload.suites) || payload.suites.length === 0 || payload.suites.some((suite) => typeof suite !== "string")) {
		return missingResult(expected, "invalid", "Performance request is missing its schema, timestamp, reason, or suites");
	}
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total: payload.suites.length,
		passed: payload.suites.length,
		failed: 0,
	};
};

const validateGoCoverage = (expected: ExpectedArtifact, text: string): ArtifactResult => {
	const lines = text.split(/\r?\n/).filter(Boolean);
	if (lines.shift() !== "mode: set") {
		return missingResult(expected, "invalid", "Go coverage profile has no supported mode header");
	}
	let total = 0;
	let covered = 0;
	const packageCoverage = new Map<string, { total: number; covered: number }>();
	for (const line of lines) {
		const match = line.match(/^(.+):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/);
		if (!match) return missingResult(expected, "invalid", "Go coverage profile contains a malformed block");
		const statements = Number(match[2]);
		const count = Number(match[3]);
		if (!Number.isInteger(statements) || statements < 0 || !Number.isInteger(count) || count < 0) {
			return missingResult(expected, "invalid", "Go coverage profile contains invalid counts");
		}
		if (statements === 0) continue;
		total += statements;
		const filePath = match[1]!.replaceAll("\\", "/");
		const packagePath = path.posix.dirname(filePath);
		const current = packageCoverage.get(packagePath) || { total: 0, covered: 0 };
		current.total += statements;
		if (count > 0) {
			covered += statements;
			current.covered += statements;
		}
		packageCoverage.set(packagePath, current);
	}
	if (total <= 0) return missingResult(expected, "invalid", "Go coverage profile has an empty denominator");
	const expectedPackages = expected.expectedCases || [];
	const actualPackages = [...packageCoverage.keys()];
	const missingPackages = expectedPackages.filter((item) => !packageCoverage.has(item));
	const unexpectedPackages = actualPackages.filter((item) => expectedPackages.length > 0 && !expectedPackages.includes(item));
	if (missingPackages.length > 0 || unexpectedPackages.length > 0) {
		return missingResult(
			expected,
			"invalid",
			[
				missingPackages.length ? `missing Go coverage packages: ${missingPackages.join(", ")}` : "",
				unexpectedPackages.length ? `unexpected Go coverage packages: ${unexpectedPackages.join(", ")}` : "",
			].filter(Boolean).join("; ")
		);
	}
	const coverageByPackage = Object.fromEntries([...packageCoverage.entries()].map(([name, coverage]) => [name, {
		...coverage,
		percent: Number(((coverage.covered / coverage.total) * 100).toFixed(2)),
	}]));
	return {
		id: expected.id,
		stepId: expected.stepId,
		kind: expected.kind,
		status: "passed",
		total,
		passed: covered,
		failed: total - covered,
		coverageByPackage,
	};
};

const validateArtifact = (
	expected: ExpectedArtifact,
	runDir: string,
	runId: string,
	sourceRevision: string,
	dirtyPatchSha256: string
): ArtifactResult => {
	const filePath = path.resolve(runDir, expected.path);
	if (!filePath.startsWith(`${path.resolve(runDir)}${path.sep}`) || !fs.existsSync(filePath)) {
		return missingResult(expected, "missing", "Expected current-run artifact is missing");
	}
	switch (expected.kind) {
		case "vitest":
			return validateVitest(expected, readJson(filePath));
		case "go-test":
			return validateGoTests(expected, fs.readFileSync(filePath, "utf8"));
		case "coverage":
			return validateCoverage(expected, readJson(filePath));
		case "external":
			return validateExternal(expected, readJson(filePath), runId, sourceRevision, dirtyPatchSha256);
		case "go-coverage":
			return validateGoCoverage(expected, fs.readFileSync(filePath, "utf8"));
		case "package-list":
			return validatePackageList(expected, fs.readFileSync(filePath, "utf8"));
		case "feature-catalog":
			return validateFeatureCatalog(expected, readJson(filePath));
		case "lab-gate":
			return validateLabGate(expected, readJson(filePath));
		case "lab-inventory":
			return validateLabInventory(expected, readJson(filePath));
		case "perf-request":
			return validatePerfRequest(expected, readJson(filePath));
	}
};

const validateManifestValidity = (manifest: RunManifest, failures: string[]) => {
	if (!isLabMode(manifest.mode)) failures.push(`Run manifest has unsupported lab mode: ${String(manifest.mode)}`);
	if (typeof manifest.recorded !== "boolean") failures.push("Run manifest has no recorded flag");
	if (!isRecord(manifest.validity) || !isValidityStatus(manifest.validity.status) ||
		typeof manifest.validity.aborted !== "boolean" || !Array.isArray(manifest.validity.reasons)) {
		failures.push("Run manifest has no valid measurement validity block");
		return;
	}
	if (manifest.validity.status === "invalid") {
		failures.push(`Run measurement validity is invalid: ${validityReasonSummary(manifest.validity.reasons) || "no reason recorded"}`);
	}
	if (manifest.validity.aborted) {
		failures.push("Run was aborted because measurement collection failed; this run must not be recorded");
	}
	if (manifest.rerun != null) {
		if (!isRecord(manifest.rerun) || typeof manifest.rerun.ofRunId !== "string" || !manifest.rerun.ofRunId.trim() ||
			!isRerunScope(manifest.rerun.scope) || !stringArray(manifest.rerun.ids)) {
			failures.push("Run manifest has a malformed rerun block");
		}
	}
	if (manifest.measurement != null) {
		if (!isRecord(manifest.measurement) || (manifest.measurement.policy !== "prefer-instrumented" && manifest.measurement.policy !== "external-only")) {
			failures.push("Run manifest has a malformed measurement policy");
		}
	}
};

export const buildAggregate = (manifest: RunManifest, runDir: string): AggregateReport => {
	const failures: string[] = [];
	const stepIds = manifest.steps.map((step) => step.id);
	if (manifest.schemaVersion !== 2) failures.push("Unsupported run manifest schema: expected 2 (re-run with the current lab runner)");
	validateManifestValidity(manifest, failures);
	if (manifest.status !== "passed" || !manifest.finishedAt) failures.push("Run manifest has no successful terminal state");
	if (!isRecord(manifest.source) || !/^[0-9a-f]{40,64}$/i.test(manifest.source.revision || "")) failures.push("Run manifest has no valid source revision");
	if (!isRecord(manifest.source) || !/^[0-9a-f]{64}$/i.test(manifest.source.dirtyPatchSha256 || "")) failures.push("Run manifest has no valid dirty-source fingerprint");
	const expectedStepIds = new Set(manifest.expectedSteps);
	if (expectedStepIds.size !== manifest.expectedSteps.length) failures.push("Run manifest contains duplicate required steps");
	for (const expectedId of manifest.expectedSteps) {
		const matches = manifest.steps.filter((step) => step.id === expectedId);
		if (matches.length !== 1 || matches[0]?.status !== "passed") {
			failures.push(`Required step did not pass exactly once: ${expectedId}`);
		}
	}
	for (const stepId of stepIds) {
		if (!expectedStepIds.has(stepId)) failures.push(`Unexpected step result: ${stepId}`);
		if (manifest.steps.filter((step) => step.id === stepId).length !== 1) {
			failures.push(`Duplicate step result: ${stepId}`);
		}
	}
	const artifactIds = manifest.expectedArtifacts.map((artifact) => artifact.id);
	if (new Set(artifactIds).size !== artifactIds.length) failures.push("Run manifest contains duplicate artifact IDs");
	const artifacts = manifest.expectedArtifacts.map((expected) => {
		const step = manifest.steps.find((candidate) => candidate.id === expected.stepId);
		if (!step || step.status !== "passed") {
			return missingResult(expected, "missing", `Required step did not pass: ${expected.stepId}`);
		}
		return validateArtifact(
			expected,
			runDir,
			manifest.runId,
			manifest.source.revision || "",
			manifest.source.dirtyPatchSha256 || ""
		);
	});
	for (const artifact of artifacts) {
		if (artifact.status !== "passed") {
			failures.push(`${artifact.id}: ${artifact.error || artifact.status}`);
		}
	}
	const externalArtifacts = artifacts.filter((artifact) => artifact.kind === "external" && artifact.status === "passed");
	const gateArtifacts = artifacts.filter((artifact) => artifact.kind === "lab-gate" && artifact.status === "passed");
	for (const externalArtifact of externalArtifacts) {
		const gateArtifact = gateArtifacts.find((artifact) => artifact.stepId === externalArtifact.stepId);
		if (!externalArtifact.caseIds || !gateArtifact?.caseIds) continue;
		const externalIds = new Set(externalArtifact.caseIds);
		const gateIds = new Set(gateArtifact.caseIds);
		const onlyExternal = [...externalIds].filter((id) => !gateIds.has(id));
		const onlyGate = [...gateIds].filter((id) => !externalIds.has(id));
		if (onlyExternal.length > 0 || onlyGate.length > 0) {
			failures.push(
				`lab-gate case coverage does not match external results for step ${externalArtifact.stepId}: ${[
					onlyExternal.length ? `missing in gate: ${onlyExternal.join(", ")}` : "",
					onlyGate.length ? `unexpected in gate: ${onlyGate.join(", ")}` : "",
				].filter(Boolean).join("; ")}`
			);
		}
	}
	return {
		schemaVersion: 2,
		runId: manifest.runId,
		status: failures.length === 0 ? "passed" : "failed",
		generatedAt: new Date().toISOString(),
		manifest: "run-manifest.json",
		profile: manifest.profile,
		mode: manifest.mode,
		validity: manifest.validity,
		recorded: manifest.recorded,
		source: manifest.source,
		steps: manifest.steps,
		artifacts,
		failures,
	};
};

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const validityLabel = (validity: RunManifest["validity"]) => {
	if (!validity) return "unknown";
	if (validity.aborted) return "aborted";
	return validity.status;
};

const reportHtml = (report: AggregateReport) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aevia 测试运行报告</title>
<style>body{font:14px/1.55 system-ui,sans-serif;color:#19212b;margin:32px auto;padding:0 18px;max-width:1100px}h1{font-size:24px}.state{font-weight:700}.failed{color:#a12622}.passed{color:#1c6b3a}.degraded{color:#8a6100}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border-bottom:1px solid #d8dee7;text-align:left;padding:9px}th{background:#f4f6f8}.errors{white-space:pre-wrap;color:#a12622}</style></head>
<body><h1>Aevia 测试运行</h1><p>运行 <code>${escapeHtml(report.runId)}</code> · 模式 <code>${escapeHtml(report.mode)}</code> · profile <code>${escapeHtml(report.profile)}</code> · 源码 <code>${escapeHtml(report.source.revision || "unknown")}</code></p>
<p class="state ${report.status}">${report.status === "passed" ? "通过" : "失败"}</p>
<p>采集有效性 <code>${escapeHtml(validityLabel(report.validity))}</code> · 记录 <code>${report.recorded ? "是" : "否"}</code></p>
<h2>步骤</h2><table><thead><tr><th>步骤</th><th>状态</th><th>耗时</th><th>原因</th></tr></thead><tbody>${report.steps.map((step) => `<tr><td>${escapeHtml(step.title)}</td><td>${step.status}</td><td>${step.durationMs == null ? "" : `${(step.durationMs / 1000).toFixed(1)}s`}</td><td>${escapeHtml(step.error || "")}</td></tr>`).join("")}</tbody></table>
<h2>证据</h2><table><thead><tr><th>产物</th><th>类型</th><th>状态</th><th>覆盖或用例数</th><th>失败</th><th>详情</th></tr></thead><tbody>${report.artifacts.map((artifact) => {
	const packageDetails = artifact.coverageByPackage
		? Object.entries(artifact.coverageByPackage).map(([name, coverage]) => `${name} ${coverage.covered}/${coverage.total} (${coverage.percent}%)`).join("; ")
		: "";
	const coverageDetails = artifact.coverageMetrics
		? Object.entries(artifact.coverageMetrics).map(([name, metric]) => `${name} ${metric.percent}%`).join("; ")
		: "";
	const sourceDetails = artifact.sourceCount == null ? "" : `source inventory: ${artifact.sourceCount} files`;
	const featureDetails = artifact.featureInventory
		? [
			artifact.featureInventory.scope,
			`${artifact.featureInventory.sourceSurfaceCount} source surfaces; ${artifact.total} individual obligations`,
			`coverage state: ${Object.entries(artifact.featureInventory.stateCounts).map(([state, count]) => `${state} ${count}`).join(", ")}`,
			`partial or uncovered obligations: ${artifact.featureInventory.unresolvedIds.length}`,
		].join("; ")
		: "";
	const gateDetails = artifact.gate
		? `gate ${artifact.gate.status}${artifact.gate.aborted ? " (aborted)" : ""}; ${artifact.gate.caseCount} cases in ${artifact.gate.scenarioKeys.length} scenario(s)`
		: "";
	const inventoryDetails = artifact.inventory
		? `${artifact.inventory.total} modules: covered ${artifact.inventory.covered}, partial ${artifact.inventory.partial}, excluded ${artifact.inventory.excluded}; unresolved ${artifact.inventory.unresolvedIds.length}`
		: "";
	const details = artifact.error || [coverageDetails, packageDetails, sourceDetails, featureDetails, gateDetails, inventoryDetails].filter(Boolean).join("; ");
	const countLabel = artifact.featureInventory ? `${artifact.total} obligations` : artifact.inventory ? `${artifact.inventory.total} modules` : `${artifact.passed}/${artifact.total}`;
	return `<tr><td>${escapeHtml(artifact.id)}</td><td>${artifact.kind}</td><td>${artifact.status}</td><td>${countLabel}</td><td>${artifact.failed}</td><td>${escapeHtml(details)}</td></tr>`;
}).join("")}</tbody></table>
<h2>判定</h2><p class="errors">${escapeHtml(report.failures.join("\n") || "本次必跑步骤及证据完整。")}</p></body></html>`;

const atomicWrite = (filePath: string, content: string) => {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, content, "utf8");
	fs.rmSync(filePath, { force: true });
	fs.renameSync(temporaryPath, filePath);
};

/**
 * The `latest` pointer is evidence of the most recent trustworthy run. Invalid, aborted,
 * or explicitly unrecorded runs must not move it — that is what "不记录" means.
 */
export const shouldPublishLatest = (manifest: RunManifest, report: AggregateReport): boolean =>
	report.status === "passed" &&
	manifest.validity?.status !== "invalid" &&
	manifest.validity?.aborted !== true &&
	manifest.recorded !== false;

const publishLatestPointer = (rootDir: string, runId: string, finishedAt: string) => {
	const latestDir = path.join(rootDir, "tests", "reports", "summary");
	const pointerPath = path.join(latestDir, "latest.json");
	const old = readJson(pointerPath);
	if (isRecord(old) && typeof old.finishedAt === "string" && old.finishedAt > finishedAt) return;
	fs.mkdirSync(latestDir, { recursive: true });
	fs.writeFileSync(pointerPath, JSON.stringify({
		runId,
		finishedAt,
		path: path.relative(latestDir, path.join(latestDir, "runs", runId, "test-report.html")),
	}, null, 2), "utf8");
};

export const writeAggregateReport = (manifestPath: string) => {
	const absoluteManifestPath = path.resolve(manifestPath);
	const manifest = readJson(absoluteManifestPath) as RunManifest | null;
	if (
		!isRecord(manifest) || typeof manifest.runId !== "string" || !Array.isArray(manifest.steps) ||
		!Array.isArray(manifest.expectedSteps) || !Array.isArray(manifest.expectedArtifacts) || !isRecord(manifest.source)
	) {
		throw new Error(`Run manifest is missing or invalid: ${absoluteManifestPath}`);
	}
	const runDir = path.dirname(absoluteManifestPath);
	const report = buildAggregate(manifest, runDir);
	atomicWrite(path.join(runDir, "test-report.json"), JSON.stringify(report, null, 2));
	atomicWrite(path.join(runDir, "test-report.html"), reportHtml(report));
	try {
		writeLabReport({ runDir, manifest, aggregate: report });
	} catch (error) {
		console.error(
			`[test-report] unified lab report generation failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (manifest.finishedAt && shouldPublishLatest(manifest, report)) {
		publishLatestPointer(process.cwd(), manifest.runId, manifest.finishedAt);
	}
	return report;
};

const runCli = () => {
	const manifestArg = process.argv.slice(2).find((arg) => arg.startsWith("--manifest="));
	const manifestPath = manifestArg?.slice("--manifest=".length) || process.env.AEVIA_TEST_MANIFEST;
	if (!manifestPath) throw new Error("Pass --manifest=<current-run-manifest.json>; historical latest reports are not inputs");
	const report = writeAggregateReport(manifestPath);
	console.log(`[test-report] run=${report.runId} mode=${report.mode} status=${report.status} artifacts=${report.artifacts.length}`);
	for (const failure of report.failures) console.error(`[test-report] ${failure}`);
	console.log(`[test-report] ${path.join(path.dirname(path.resolve(manifestPath)), "test-report.html")}`);
	if (report.status !== "passed") process.exitCode = 1;
};

if (process.argv[1] && path.resolve(process.argv[1]).replaceAll("\\", "/").endsWith("/tests/report/aggregate.ts")) {
	try {
		runCli();
	} catch (error) {
		console.error(`[test-report] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
