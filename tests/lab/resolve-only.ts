// File role: resolve lab single-mode selectors (--only / --since) into concrete test targets.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type LabVitestSelection = {
	kind: "vitest";
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

export type LabSelection = LabVitestSelection | LabGoSelection | LabExternalSelection;

export type LabResolveResult = {
	selections: LabSelection[];
	unresolved: string[];
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

const resolveFile = (rootDir: string, value: string, specs: string[]): LabSelection | null => {
	const absolute = path.resolve(rootDir, value);
	if (!existsSync(absolute)) return null;
	const relative = toPosix(path.relative(rootDir, absolute));
	if (/\.(spec|bench)\.ts$/.test(relative)) {
		return { kind: "vitest", files: [relative] };
	}
	for (const candidate of specCandidatesFor(relative)) {
		if (existsSync(path.join(rootDir, candidate))) return { kind: "vitest", files: [candidate] };
	}
	const referencing = specsReferencing(rootDir, relative, specs);
	if (referencing.length > 0) return { kind: "vitest", files: referencing.slice(0, 12) };
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

const mergeSelections = (selections: LabSelection[]): LabSelection[] => {
	const vitestFiles = new Set<string>();
	const vitestPatterns = new Set<string>();
	const goPackages = new Set<string>();
	const goRunPatterns = new Set<string>();
	const caseIds = new Set<string>();
	const caseKeys = new Set<string>();
	for (const selection of selections) {
		if (selection.kind === "vitest") {
			selection.files.forEach((file) => vitestFiles.add(file));
			if (selection.testNamePattern) vitestPatterns.add(selection.testNamePattern);
		} else if (selection.kind === "go") {
			selection.packages.forEach((entry) => goPackages.add(entry));
			if (selection.runPattern) goRunPatterns.add(selection.runPattern);
		} else {
			selection.caseIds.forEach((entry) => caseIds.add(entry));
			selection.caseKeys?.forEach(entry => caseKeys.add(entry));
		}
	}
	const merged: LabSelection[] = [];
	if (vitestFiles.size > 0 || vitestPatterns.size > 0) {
		merged.push({
			kind: "vitest",
			files: [...vitestFiles],
			testNamePattern: vitestPatterns.size > 0 ? [...vitestPatterns].join("|") : undefined,
		});
	}
	if (goPackages.size > 0) {
		merged.push({ kind: "go", packages: [...goPackages], runPattern: goRunPatterns.size > 0 ? [...goRunPatterns].join("|") : undefined });
	}
	if (caseIds.size > 0) {
		merged.push({ kind: "external", caseIds: [...caseIds], caseKeys: caseKeys.size ? [...caseKeys] : undefined });
	}
	return merged;
};

/** Resolve `--only=<selector>` entries. Supported: case:<id[,id]>, file:<path>, test:<substring>, go:<pkg>[#Test]. */
export const resolveOnlySelectors = (selectors: string[], rootDir: string): LabResolveResult => {
	const specs = collectSpecFiles(rootDir);
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
			const targets = value.split(",").map(item => item.trim()).filter(Boolean);
			selections.push({ kind: "external", caseIds: targets.map(item => item.split("|")[0]!), caseKeys: targets.filter(item => item.includes("|")) });
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
			const resolved = resolveFile(rootDir, value, specs);
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
