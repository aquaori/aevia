// File role: resolve lab single-mode selectors (--only / --since) and change obligations into deduplicated test targets.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CI_REQUIRED_EXTERNAL_CASE_IDS } from "../catalog/external-cases";
import { analyzeChangeObligations, type ChangeObligationsAnalysis } from "./change-obligations";

export type LabVitestSelection = {
	kind: "vitest";
	files: string[];
	testNamePattern?: string;
};

export type LabBrowserSelection = {
	kind: "browser";
	files: string[];
	testNamePattern?: string;
};

export type LabGoSelection = {
	kind: "go";
	packages: string[];
	runPattern?: string;
};

export type LabExternalSelection = {
	kind: "external";
	caseIds: string[];
	caseKeys?: string[];
};

export type LabSelection =
	| LabVitestSelection
	| LabBrowserSelection
	| LabGoSelection
	| LabExternalSelection;

export type LabResolveResult = {
	selections: LabSelection[];
	unresolved: string[];
};

export type ChangeObligationPlanResult = {
	analysis: ChangeObligationsAnalysis;
	selection: LabResolveResult;
	extraExternalCaseIds: string[];
};

const toPosix = (value: string) => value.replaceAll("\\", "/");

const git = (rootDir: string, args: string[]): string[] => {
	const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
	if (result.status !== 0) return [];
	return (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

const specCandidatesFor = (sourceFile: string) => {
	const withoutExt = sourceFile.replace(/\.(ts|tsx|vue)$/i, "");
	return [`${withoutExt}.spec.ts`, `${withoutExt}.unit.spec.ts`, `${withoutExt}.browser.spec.ts`];
};

const collectSpecFiles = (rootDir: string): string[] => {
	const specs: string[] = [];
	const walk = (relativeDir: string) => {
		const absoluteDir = path.join(rootDir, relativeDir);
		if (!existsSync(absoluteDir)) return;
		for (const entry of readdirSync(absoluteDir)) {
			if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "tests/reports") continue;
			const relative = path.posix.join(relativeDir, entry);
			const absolute = path.join(rootDir, relative);
			let stats;
			try {
				stats = statSync(absolute);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				walk(relative);
			} else if (/\.(spec|bench)\.ts$/.test(entry)) {
				specs.push(relative);
			}
		}
	};
	for (const root of ["apps/frontend/src", "apps/frontend/tests", "packages/shared/src", "tests"]) walk(root);
	return specs;
};

const specsReferencing = (rootDir: string, sourceFile: string, specs: string[]) => {
	const withoutExt = toPosix(sourceFile).replace(/\.(ts|tsx|vue)$/i, "");
	const basename = path.posix.basename(withoutExt);
	return specs.filter((spec) => {
		if (!spec.startsWith("apps/") && !spec.startsWith("packages/") && !spec.startsWith("tests/")) return false;
		try {
			const content = readFileSync(path.join(rootDir, spec), "utf8");
			return content.includes(`/${basename}"`) || content.includes(`/${basename}.ts"`) || content.includes(`./${basename}"`);
		} catch {
			return false;
		}
	});
};

const toVitestOrBrowserSelection = (files: string[], testNamePattern?: string): LabSelection => {
	const browserFiles = files.filter((file) => file.endsWith(".browser.spec.ts"));
	const vitestFiles = files.filter((file) => !file.endsWith(".browser.spec.ts"));
	if (browserFiles.length > 0 && vitestFiles.length === 0) {
		return { kind: "browser", files: browserFiles, testNamePattern };
	}
	return { kind: "vitest", files, testNamePattern };
};

const resolveFile = (rootDir: string, value: string, specs: string[]): LabSelection | null => {
	const absolute = path.resolve(rootDir, value);
	if (!existsSync(absolute)) return null;
	const relative = toPosix(path.relative(rootDir, absolute));
	if (/\.(spec|bench)\.ts$/.test(relative)) {
		return toVitestOrBrowserSelection([relative]);
	}
	for (const candidate of specCandidatesFor(relative)) {
		if (existsSync(path.join(rootDir, candidate))) return toVitestOrBrowserSelection([candidate]);
	}
	const referencing = specsReferencing(rootDir, relative, specs);
	if (referencing.length > 0) return toVitestOrBrowserSelection(referencing.slice(0, 12));
	return null;
};

const resolveChangedFile = (rootDir: string, file: string, specs: string[]): LabSelection | null => {
	if (file.endsWith("_test.go")) return null;
	if (file.startsWith("apps/backend/")) {
		const packageDir = toPosix(path.dirname(file));
		return { kind: "go", packages: [`./${packageDir.replace(/^apps\/backend\//, "")}`] };
	}
	if (file.startsWith("apps/frontend/tests/e2e/")) {
		return { kind: "external", caseIds: ["correctness-smoke"] };
	}
	if (file.endsWith(".go") || file.startsWith("apps/backend")) {
		return null;
	}
	if (/\.(ts|tsx|vue)$/.test(file) && (file.startsWith("apps/") || file.startsWith("packages/") || file.startsWith("tests/"))) {
		return resolveFile(rootDir, file, specs);
	}
	return null;
};

const mergePatternedGroup = <T>(
	entries: Map<string, { full: boolean; patterns: Set<string> }>,
	unboundPatterns: Set<string>,
	buildFull: (items: string[]) => T,
	buildPatterned: (items: string[], pattern: string) => T,
	buildUnbound?: (pattern: string) => T,
): T[] => {
	const out: T[] = [];
	const fullItems: string[] = [];
	const patternBuckets = new Map<string, string[]>();

	if (entries.size === 0 && unboundPatterns.size > 0 && buildUnbound) {
		out.push(buildUnbound([...unboundPatterns].sort().join("|")));
		return out;
	}

	for (const key of [...entries.keys()].sort()) {
		const slot = entries.get(key)!;
		if (slot.full) {
			if (unboundPatterns.size > 0) {
				const joined = [...unboundPatterns].sort().join("|");
				const bucket = patternBuckets.get(joined) ?? [];
				bucket.push(key);
				patternBuckets.set(joined, bucket);
			} else {
				fullItems.push(key);
			}
			continue;
		}
		const mergedSet = new Set([...slot.patterns, ...unboundPatterns]);
		const joined = [...mergedSet].sort().join("|");
		const bucket = patternBuckets.get(joined) ?? [];
		bucket.push(key);
		patternBuckets.set(joined, bucket);
	}

	if (fullItems.length > 0) {
		out.push(buildFull(fullItems));
	}
	for (const pattern of [...patternBuckets.keys()].sort()) {
		out.push(buildPatterned(patternBuckets.get(pattern)!, pattern));
	}
	return out;
};

/**
 * Deduplicate selections while guaranteeing that a testNamePattern/runPattern
 * bound to one file or package never masks another file or package that requires a full run.
 */
export const mergeSelections = (selections: LabSelection[]): LabSelection[] => {
	const vitestEntries = new Map<string, { full: boolean; patterns: Set<string> }>();
	const unboundVitestPatterns = new Set<string>();
	const browserEntries = new Map<string, { full: boolean; patterns: Set<string> }>();
	const goEntries = new Map<string, { full: boolean; patterns: Set<string> }>();
	const caseIds = new Set<string>();
	const caseKeys = new Set<string>();

	const record = (map: Map<string, { full: boolean; patterns: Set<string> }>, key: string, pattern?: string) => {
		const slot = map.get(key) ?? { full: false, patterns: new Set<string>() };
		if (!pattern) slot.full = true;
		else slot.patterns.add(pattern);
		map.set(key, slot);
	};

	for (const selection of selections) {
		if (selection.kind === "vitest") {
			if (selection.files.length === 0 && selection.testNamePattern) {
				unboundVitestPatterns.add(selection.testNamePattern);
			} else {
				for (const file of selection.files) record(vitestEntries, file, selection.testNamePattern);
			}
		} else if (selection.kind === "browser") {
			for (const file of selection.files) record(browserEntries, file, selection.testNamePattern);
		} else if (selection.kind === "go") {
			for (const pkg of selection.packages) record(goEntries, pkg, selection.runPattern);
		} else {
			selection.caseIds.forEach((entry) => caseIds.add(entry));
			selection.caseKeys?.forEach((entry) => caseKeys.add(entry));
		}
	}

	const merged: LabSelection[] = [
		...mergePatternedGroup<LabSelection>(
			vitestEntries,
			unboundVitestPatterns,
			(files) => ({ kind: "vitest", files }),
			(files, testNamePattern) => ({ kind: "vitest", files, testNamePattern }),
			(testNamePattern) => ({ kind: "vitest", files: [], testNamePattern }),
		),
		...mergePatternedGroup<LabSelection>(
			browserEntries,
			new Set(),
			(files) => ({ kind: "browser", files }),
			(files, testNamePattern) => ({ kind: "browser", files, testNamePattern }),
		),
		...mergePatternedGroup<LabSelection>(
			goEntries,
			new Set(),
			(packages) => ({ kind: "go", packages }),
			(packages, runPattern) => ({ kind: "go", packages, runPattern }),
		),
	];

	if (caseIds.size > 0) {
		merged.push({
			kind: "external",
			caseIds: [...caseIds],
			...(caseKeys.size > 0 ? { caseKeys: [...caseKeys] } : {}),
		});
	}
	return merged;
};

/** Resolve `--only=<selector>` entries. Supported: case:<id[,id]>, file:<path>, test:<substring>, go:<pkg>[#Test]. */
export const resolveOnlySelectors = (selectors: string[], rootDir: string): LabResolveResult => {
	let specs: string[] | undefined;
	const selections: LabSelection[] = [];
	const unresolved: string[] = [];
	for (const selector of selectors) {
		const separator = selector.indexOf(":");
		const kind = separator >= 0 ? selector.slice(0, separator) : selector;
		const value = separator >= 0 ? selector.slice(separator + 1) : "";
		if (!value) {
			unresolved.push(selector);
			continue;
		}
		if (kind === "case") {
			const targets = value.split(",").map((item) => item.trim()).filter(Boolean);
			selections.push({
				kind: "external",
				caseIds: targets.map((item) => item.split("|")[0]!),
				caseKeys: targets.filter((item) => item.includes("|")),
			});
			continue;
		}
		if (kind === "test") {
			selections.push({ kind: "vitest", files: [], testNamePattern: value });
			continue;
		}
		if (kind === "go") {
			const [packageName, runPattern] = value.split("#");
			if (packageName && !/^[A-Za-z0-9_./-]+$/.test(packageName)) throw new Error("Invalid Go package selector");
			selections.push({ kind: "go", packages: [packageName || "."], runPattern: runPattern || undefined });
			continue;
		}
		if (kind === "file") {
			const resolved = resolveFile(rootDir, value, specs ??= collectSpecFiles(rootDir));
			if (resolved) selections.push(resolved);
			else unresolved.push(selector);
			continue;
		}
		unresolved.push(selector);
	}
	return { selections: mergeSelections(selections), unresolved };
};

/** Resolve `--since=<git-ref>` into the tests that own the changed files. */
export const resolveSinceRef = (ref: string, rootDir: string): LabResolveResult => {
	const specs = collectSpecFiles(rootDir);
	const changed = [
		...git(rootDir, ["diff", "--name-only", `${ref}...HEAD`]),
		...git(rootDir, ["diff", "--name-only", "HEAD"]),
		...git(rootDir, ["ls-files", "--others", "--exclude-standard"]),
	];
	const selections: LabSelection[] = [];
	const unresolved: string[] = [];
	for (const file of changed) {
		const resolved = resolveChangedFile(rootDir, toPosix(file), specs);
		if (resolved) {
			selections.push(resolved);
		} else if (/^(package\.json|package-lock\.json|vitest\.config\.ts|tsconfig.*\.json|eslint\.config\.mjs|scripts\/|\.github\/)/.test(file)) {
			unresolved.push(file);
		}
	}
	return { selections: mergeSelections(selections), unresolved };
};

/**
 * Analyze git changes against module/feature obligations and return deduplicated Lab selections
 * annotated with core-reuse vs extra-execution accounting.
 */
export const resolveChangeObligationPlan = (options: {
	rootDir?: string;
	baseSha?: string;
	headSha?: string;
	stagedOnly?: boolean;
	isCoreRun?: boolean;
	fixedExternalCaseIds?: readonly string[];
}): ChangeObligationPlanResult => {
	const analysis = analyzeChangeObligations({
		rootDir: options.rootDir,
		baseSha: options.baseSha,
		headSha: options.headSha,
		stagedOnly: options.stagedOnly,
	});

	const fixedExternal = new Set(options.fixedExternalCaseIds ?? CI_REQUIRED_EXTERNAL_CASE_IDS);
	const isCoreRun = Boolean(options.isCoreRun);

	const rawSelections: LabSelection[] = [];
	for (const raw of analysis.rawTargets) {
		if (raw.kind === "vitest") {
			rawSelections.push({ kind: "vitest", files: [raw.file], testNamePattern: raw.testNamePattern });
		} else if (raw.kind === "browser") {
			rawSelections.push({ kind: "browser", files: [raw.file], testNamePattern: raw.testNamePattern });
		} else if (raw.kind === "go") {
			rawSelections.push({ kind: "go", packages: [raw.package], runPattern: raw.runPattern });
		} else if (raw.kind === "external") {
			rawSelections.push({ kind: "external", caseIds: [raw.caseId] });
		}
	}

	const selections = mergeSelections(rawSelections);
	const extraExternalCaseIds: string[] = [];
	let reusedCount = 0;
	let executedExtraCount = 0;

	for (const target of analysis.report.selectedTargets) {
		if (target.kind === "external") {
			if (fixedExternal.has(target.caseId)) {
				target.executionMode = "reused-from-core";
				reusedCount += 1;
			} else {
				target.executionMode = "selected";
				executedExtraCount += 1;
				extraExternalCaseIds.push(target.caseId);
			}
		} else if (isCoreRun) {
			target.executionMode = "reused-from-core";
			reusedCount += 1;
		} else {
			target.executionMode = "selected";
			executedExtraCount += 1;
		}
	}

	analysis.report.summary.reusedCount = reusedCount;
	analysis.report.summary.executedExtraCount = executedExtraCount;

	return {
		analysis,
		selection: { selections, unresolved: [] },
		extraExternalCaseIds: [...new Set(extraExternalCaseIds)].sort(),
	};
};
