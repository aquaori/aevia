import fs from "node:fs";
import path from "node:path";
import type { ExpectedArtifact, RunManifest } from "./contract";

type ArtifactResult = {
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
	error?: string;
};

type AggregateReport = {
	schemaVersion: 1;
	runId: string;
	status: "passed" | "failed";
	generatedAt: string;
	manifest: string;
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

const finiteNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value);

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
	const results = payload.results.filter(isRecord);
	const ids = results.map((result) => result.id).filter((id): id is string => typeof id === "string");
	const duplicates = ids.length !== new Set(ids).size;
	const expectedCases = expected.expectedCases || [];
	const seen = new Set(ids);
	const missing = expectedCases.filter((id) => !seen.has(id));
	const unexpected = ids.filter((id) => !expectedCases.includes(id));
	const failed = results.filter((result) => result.status !== "passed").length;
	const total = Number(payload.summary.total);
	const summaryPassed = Number(payload.summary.passed);
	const summaryFailed = Number(payload.summary.failed);
	if (
		!finiteNumber(total) || total !== results.length || duplicates || failed > 0 ||
		missing.length > 0 || unexpected.length > 0 || ids.length !== results.length ||
		summaryPassed !== results.length || summaryFailed !== 0
	) {
		const issues = [
			duplicates ? "duplicate cases" : "",
			missing.length ? `missing cases: ${missing.join(", ")}` : "",
			unexpected.length ? `unexpected cases: ${unexpected.join(", ")}` : "",
			failed ? `${failed} cases did not pass` : "",
			!finiteNumber(total) || total !== results.length ? "invalid total" : "",
			summaryPassed !== results.length || summaryFailed !== 0 ? "summary counts do not match case results" : "",
		].filter(Boolean);
		return missingResult(expected, "failed", issues.join("; ") || "External report is incomplete");
	}
	return { id: expected.id, stepId: expected.stepId, kind: expected.kind, status: "passed", total, passed: total, failed: 0 };
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
	}
};

export const buildAggregate = (manifest: RunManifest, runDir: string): AggregateReport => {
	const failures: string[] = [];
	const stepIds = manifest.steps.map((step) => step.id);
	if (manifest.schemaVersion !== 1) failures.push("Unsupported run manifest schema");
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
	return {
		schemaVersion: 1,
		runId: manifest.runId,
		status: failures.length === 0 ? "passed" : "failed",
		generatedAt: new Date().toISOString(),
		manifest: "run-manifest.json",
		source: manifest.source,
		steps: manifest.steps,
		artifacts,
		failures,
	};
};

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const reportHtml = (report: AggregateReport) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aevia 测试运行报告</title>
<style>body{font:14px/1.55 system-ui,sans-serif;color:#19212b;margin:32px auto;padding:0 18px;max-width:1100px}h1{font-size:24px}.state{font-weight:700}.failed{color:#a12622}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border-bottom:1px solid #d8dee7;text-align:left;padding:9px}th{background:#f4f6f8}.errors{white-space:pre-wrap;color:#a12622}</style></head>
<body><h1>Aevia 测试运行</h1><p>运行 <code>${escapeHtml(report.runId)}</code> · 源码 <code>${escapeHtml(report.source.revision || "unknown")}</code></p><p class="state ${report.status}">${report.status === "passed" ? "通过" : "失败"}</p>
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
	const details = artifact.error || [coverageDetails, packageDetails, sourceDetails, featureDetails].filter(Boolean).join("; ");
	const countLabel = artifact.featureInventory ? `${artifact.total} obligations` : `${artifact.passed}/${artifact.total}`;
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
	if (manifest.finishedAt) publishLatestPointer(process.cwd(), manifest.runId, manifest.finishedAt);
	return report;
};

const runCli = () => {
	const manifestArg = process.argv.slice(2).find((arg) => arg.startsWith("--manifest="));
	const manifestPath = manifestArg?.slice("--manifest=".length) || process.env.AEVIA_TEST_MANIFEST;
	if (!manifestPath) throw new Error("Pass --manifest=<current-run-manifest.json>; historical latest reports are not inputs");
	const report = writeAggregateReport(manifestPath);
	console.log(`[test-report] run=${report.runId} status=${report.status} artifacts=${report.artifacts.length}`);
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
