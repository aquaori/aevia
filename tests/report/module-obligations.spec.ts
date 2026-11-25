import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTERNAL_CASES } from "../catalog/external-cases";
import type { ModuleEvidenceItem } from "./contract";

const repoRoot = path.resolve(__dirname, "../..");
const catalogPath = path.join(repoRoot, "tests/catalog/module-obligations.json");
const featureCatalogPath = path.join(repoRoot, "tests/catalog/feature-obligations.json");

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const walkFiles = (rootRel: string, matcher: (rel: string) => boolean): string[] => {
	const abs = path.join(repoRoot, rootRel);
	if (!fs.existsSync(abs)) return [];
	const out: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			const rel = toPosix(path.relative(repoRoot, full));
			if (matcher(rel)) out.push(rel);
		}
	};
	visit(abs);
	return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

const knownExternalCaseIds = new Set(Object.values(EXTERNAL_CASES).map((item) => item.id));

const loadFeatureObligations = (): Map<string, { evidence: string[] }> => {
	const parsed = JSON.parse(fs.readFileSync(featureCatalogPath, "utf8")) as {
		obligations?: Array<{ id?: unknown; evidence?: unknown }>;
	};
	const map = new Map<string, { evidence: string[] }>();
	for (const entry of parsed.obligations ?? []) {
		if (typeof entry.id === "string") {
			const evidence = Array.isArray(entry.evidence) ? entry.evidence.filter((e): e is string => typeof e === "string") : [];
			map.set(entry.id, { evidence });
		}
	}
	return map;
};

export const validateModuleEvidenceItem = (
	obligationId: string,
	item: ModuleEvidenceItem,
	featureObligations: Map<string, { evidence: string[] }>,
	problems: string[],
	label: string,
): void => {
	if (item.kind === "vitest") {
		if (!item.file || !/\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(item.file)) {
			problems.push(`${obligationId} ${label} vitest target is not a valid spec file: ${String(item.file)}`);
			return;
		}
		if (!fs.existsSync(path.join(repoRoot, item.file))) {
			problems.push(`${obligationId} ${label} vitest file does not exist: ${item.file}`);
		}
		return;
	}
	if (item.kind === "browser") {
		if (!item.file || !/\.browser\.spec\.ts$/.test(item.file)) {
			problems.push(`${obligationId} ${label} browser target is not a .browser.spec.ts file: ${String(item.file)}`);
			return;
		}
		if (!fs.existsSync(path.join(repoRoot, item.file))) {
			problems.push(`${obligationId} ${label} browser file does not exist: ${item.file}`);
		}
		return;
	}
	if (item.kind === "go") {
		if (!item.package || (!item.package.startsWith("./") && item.package !== ".")) {
			problems.push(`${obligationId} ${label} go package must start with ./ or be '.': ${String(item.package)}`);
			return;
		}
		const pkgDirRel = item.package === "." ? "apps/backend" : path.posix.join("apps/backend", item.package.slice(2));
		const pkgDirAbs = path.join(repoRoot, pkgDirRel);
		if (!fs.existsSync(pkgDirAbs) || !fs.statSync(pkgDirAbs).isDirectory()) {
			problems.push(`${obligationId} ${label} go package dir does not exist: ${pkgDirRel}`);
			return;
		}
		const testFiles = fs.readdirSync(pkgDirAbs).filter((name) => name.endsWith("_test.go"));
		if (testFiles.length === 0) {
			problems.push(`${obligationId} ${label} go package has no *_test.go files: ${pkgDirRel}`);
			return;
		}
		if (item.file) {
			if (!item.file.endsWith("_test.go") || !fs.existsSync(path.join(repoRoot, item.file))) {
				problems.push(`${obligationId} ${label} go test file does not exist: ${item.file}`);
				return;
			}
			if (toPosix(path.posix.dirname(item.file)) !== pkgDirRel) {
				problems.push(`${obligationId} ${label} go file ${item.file} does not belong to package ${item.package}`);
			}
		}
		if (item.runPattern && /^[A-Za-z0-9_]+$/.test(item.runPattern)) {
			const combined = testFiles.map((f) => fs.readFileSync(path.join(pkgDirAbs, f), "utf8")).join("\n");
			if (!combined.includes(`func ${item.runPattern}(`)) {
				problems.push(`${obligationId} ${label} go runPattern function not found in ${pkgDirRel}: ${item.runPattern}`);
			}
		}
		return;
	}
	if (item.kind === "external") {
		if (!knownExternalCaseIds.has(item.caseId)) {
			problems.push(`${obligationId} ${label} unknown external caseId: ${String(item.caseId)}`);
		}
		return;
	}
	if (item.kind === "feature") {
		const feature = featureObligations.get(item.obligationId);
		if (!feature) {
			problems.push(`${obligationId} ${label} unknown feature obligationId: ${String(item.obligationId)}`);
			return;
		}
		if (feature.evidence.length === 0) {
			problems.push(`${obligationId} ${label} feature ${item.obligationId} has no bound evidence`);
		}
		return;
	}
	problems.push(`${obligationId} ${label} has unknown evidence kind`);
};

describe("module obligations catalog integrity", () => {
	it("covers every managed frontend, backend go, and shared source file cleanly", () => {
		const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
			schemaVersion?: unknown;
			obligations?: Array<{
				id?: unknown;
				kind?: unknown;
				path?: unknown;
				state?: unknown;
				owner?: unknown;
				evidence?: unknown;
				recommendedEvidence?: unknown;
				reason?: unknown;
				alternativeEvidence?: unknown;
			}>;
		};

		expect(catalog.schemaVersion).toBe(2);
		expect(Array.isArray(catalog.obligations)).toBe(true);

		const featureObligations = loadFeatureObligations();
		const obligations = catalog.obligations ?? [];

		const expectedPaths = new Set([
			...walkFiles(
				"apps/frontend/src",
				(rel) => /\.(ts|tsx|vue)$/.test(rel) && !rel.endsWith(".d.ts") && !/\.(spec|unit\.spec|browser\.spec|bench)\.(ts|tsx)$/.test(rel),
			),
			...walkFiles("apps/backend", (rel) => rel.endsWith(".go") && !rel.endsWith("_test.go")),
			...walkFiles(
				"packages/shared/src",
				(rel) => /\.(ts|tsx)$/.test(rel) && !rel.endsWith(".d.ts") && !/\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(rel),
			),
		]);

		const problems: string[] = [];
		const seenPaths = new Set<string>();

		for (const obligation of obligations) {
			const { id, kind, path: filePath, state, owner, evidence, reason, alternativeEvidence } = obligation;
			if (typeof id !== "string" || typeof filePath !== "string") {
				problems.push(`malformed id/path: ${JSON.stringify(obligation)}`);
				continue;
			}
			if (kind !== "frontend" && kind !== "go" && kind !== "shared") {
				problems.push(`unexpected kind for ${id}: ${String(kind)}`);
				continue;
			}
			if (id !== `${kind}:${filePath}`) {
				problems.push(`id/kind/path mismatch: ${id} vs ${kind}:${filePath}`);
			}
			if (!expectedPaths.has(filePath)) {
				problems.push(`catalog entry does not map to an existing managed source file: ${id}`);
			}
			if (seenPaths.has(filePath)) {
				problems.push(`duplicate catalog path: ${filePath}`);
			}
			seenPaths.add(filePath);

			if (state === "excluded") {
				if (owner !== undefined) problems.push(`excluded entries must not claim an owner: ${id}`);
				if (evidence !== undefined) problems.push(`excluded entries must not claim direct evidence: ${id}`);
				if (typeof reason !== "string" || !reason.trim()) problems.push(`excluded entry missing reason: ${id}`);
				if (!Array.isArray(alternativeEvidence) || alternativeEvidence.length === 0) {
					problems.push(`excluded entry missing alternativeEvidence: ${id}`);
				} else {
					for (const item of alternativeEvidence as ModuleEvidenceItem[]) {
						validateModuleEvidenceItem(id, item, featureObligations, problems, "alternativeEvidence");
					}
				}
				continue;
			}

			if (state === "uncovered") {
				if (owner !== undefined) problems.push(`uncovered entries must not claim an owner: ${id}`);
				if (evidence !== undefined) problems.push(`uncovered entries must not claim confirmed evidence: ${id}`);
				continue;
			}

			if (state !== "covered" && state !== "partial") {
				problems.push(`unexpected state for ${id}: ${String(state)}`);
				continue;
			}

			if (!Array.isArray(evidence) || evidence.length === 0) {
				problems.push(`${state} entry missing evidence array: ${id}`);
			} else {
				for (const item of evidence as ModuleEvidenceItem[]) {
					validateModuleEvidenceItem(id, item, featureObligations, problems, "evidence");
				}
			}

			if (typeof owner === "string" && owner.trim() && !fs.existsSync(path.join(repoRoot, owner))) {
				problems.push(`legacy owner file does not exist: ${id} -> ${owner}`);
			}
		}

		for (const filePath of expectedPaths) {
			if (!seenPaths.has(filePath)) {
				problems.push(`managed source file missing from module-obligations.json: ${filePath}`);
			}
		}

		expect(problems).toEqual([]);
	});

	it("matches the output of scripts/lab-inventory.mjs --check", () => {
		const result = spawnSync(process.execPath, ["scripts/lab-inventory.mjs", "--check"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});
});
