import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXTERNAL_CASES } from "../catalog/external-cases";
import type {
	ChangeObligationFileCategory,
	ChangeObligationFileRecord,
	ChangeObligationsReport,
	ChangeObligationTarget,
	ChangeObligationViolation,
	LabInventoryKind,
	LabInventoryObligation,
	LabInventoryReport,
	ModuleEvidenceItem,
} from "../report/contract";

export type GitDiffStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export type GitDiffEntry = {
	status: GitDiffStatus;
	path: string;
	previousPath?: string;
};

export type AnalyzeChangeObligationsInput = {
	rootDir?: string;
	baseSha?: string;
	headSha?: string;
	stagedOnly?: boolean;
	catalogOverride?: LabInventoryReport;
	baseCatalogOverride?: LabInventoryReport | null;
	diffEntriesOverride?: GitDiffEntry[];
};

export type RawSelectedTarget =
	| { kind: "vitest"; file: string; testNamePattern?: string }
	| { kind: "browser"; file: string; testNamePattern?: string }
	| { kind: "go"; package: string; runPattern?: string }
	| { kind: "external"; caseId: string };

export type ChangeObligationsAnalysis = {
	report: ChangeObligationsReport;
	rawTargets: RawSelectedTarget[];
	markdown: string;
};

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const ALL_ZERO_SHA = /^0+$/;

const runGit = (rootDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => {
	try {
		const stdout = execFileSync("git", args, {
			cwd: rootDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? err.message ?? "git failed",
		};
	}
};

const isManagedFrontendSource = (rel: string): boolean =>
	rel.startsWith("apps/frontend/src/") &&
	/\.(ts|tsx|vue)$/.test(rel) &&
	!rel.endsWith(".d.ts") &&
	!/\.(spec|unit\.spec|browser\.spec|bench)\.(ts|tsx)$/.test(rel);

const isManagedGoSource = (rel: string): boolean =>
	rel.startsWith("apps/backend/") && rel.endsWith(".go") && !rel.endsWith("_test.go");

const isManagedSharedSource = (rel: string): boolean =>
	rel.startsWith("packages/shared/src/") &&
	/\.(ts|tsx)$/.test(rel) &&
	!rel.endsWith(".d.ts") &&
	!/\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(rel);

export const getManagedSourceKind = (rel: string): LabInventoryKind | null => {
	if (isManagedFrontendSource(rel)) return "frontend";
	if (isManagedGoSource(rel)) return "go";
	if (isManagedSharedSource(rel)) return "shared";
	return null;
};

export const isTestFilePath = (rel: string): boolean => {
	if (rel.startsWith("packages/shared/src/") && /\.spec\.(ts|tsx)$/.test(rel)) return true;
	if (rel.startsWith("apps/frontend/src/") && /\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(rel)) return true;
	if (rel.startsWith("apps/frontend/tests/browser/") && /\.browser\.spec\.ts$/.test(rel)) return true;
	if (rel.startsWith("apps/frontend/tests/e2e/")) return true;
	if (rel.startsWith("apps/backend/") && rel.endsWith("_test.go")) return true;
	if ((rel.startsWith("tests/lab/") || rel.startsWith("tests/report/")) && /\.spec\.ts$/.test(rel)) return true;
	return false;
};

export const isHighImpactConfigPath = (rel: string): boolean => {
	if (
		rel === "package.json" ||
		rel === "package-lock.json" ||
		rel === "vitest.config.ts" ||
		rel === "apps/backend/go.mod" ||
		rel === "apps/backend/go.sum" ||
		/^tsconfig(\..+)?\.json$/.test(rel) ||
		/^apps\/frontend\/tsconfig(\..+)?\.json$/.test(rel) ||
		/^packages\/shared\/tsconfig(\..+)?\.json$/.test(rel)
	) {
		return true;
	}
	if (rel.startsWith(".github/workflows/")) return true;
	if (rel.startsWith("scripts/") && !rel.startsWith("scripts/lab-inventory")) return true;
	if ((rel.startsWith("tests/lab/") || rel.startsWith("tests/report/")) && !/\.spec\.ts$/.test(rel)) return true;
	return false;
};

export const isDocsOrAssetsPath = (rel: string): boolean =>
	rel.startsWith("docs/") ||
	rel.startsWith("assets/") ||
	rel.startsWith(".agents/") ||
	rel.startsWith(".codex/") ||
	rel === ".gitignore" ||
	/\.md$/i.test(rel);

export const classifyChangedPath = (rel: string): ChangeObligationFileCategory => {
	if (getManagedSourceKind(rel)) return "managed-source";
	if (isTestFilePath(rel)) return "test";
	if (isHighImpactConfigPath(rel)) return "high-impact-config";
	if (isDocsOrAssetsPath(rel)) return "docs-or-assets";
	return "other";
};

export const parseGitNameStatusZ = (raw: string): GitDiffEntry[] => {
	const tokens = raw.split("\0");
	const entries: GitDiffEntry[] = [];
	let i = 0;
	while (i < tokens.length) {
		const statusToken = tokens[i];
		i += 1;
		if (!statusToken) continue;
		const code = statusToken[0] as GitDiffStatus;
		if (code === "R" || code === "C") {
			const prevPath = toPosix(tokens[i] ?? "");
			const nextPath = toPosix(tokens[i + 1] ?? "");
			i += 2;
			if (nextPath) entries.push({ status: code, previousPath: prevPath, path: nextPath });
			continue;
		}
		const filePath = toPosix(tokens[i] ?? "");
		i += 1;
		if (filePath) entries.push({ status: code, path: filePath });
	}
	return entries;
};

const loadJsonIfExists = <T>(absPath: string): T | null => {
	if (!fs.existsSync(absPath)) return null;
	try {
		return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
	} catch {
		return null;
	}
};

const loadGitJsonAtRef = <T>(rootDir: string, refSpec: string): T | null => {
	const res = runGit(rootDir, ["show", refSpec]);
	if (!res.ok) return null;
	try {
		return JSON.parse(res.stdout) as T;
	} catch {
		return null;
	}
};

const collectGoTestInfo = (rootDir: string): { pkgFuncs: Map<string, Set<string>>; funcToPkgs: Map<string, Set<string>> } => {
	const pkgFuncs = new Map<string, Set<string>>();
	const funcToPkgs = new Map<string, Set<string>>();
	const backendAbs = path.join(rootDir, "apps/backend");
	if (!fs.existsSync(backendAbs)) return { pkgFuncs, funcToPkgs };

	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			if (!entry.name.endsWith("_test.go")) continue;
			const dirRel = toPosix(path.relative(backendAbs, path.dirname(full)));
			const pkg = dirRel === "" || dirRel === "." ? "./" : `./${dirRel}`;
			const normalizedPkg = pkg === "./" ? "." : pkg;
			const funcs = pkgFuncs.get(normalizedPkg) ?? new Set<string>();
			const content = fs.readFileSync(full, "utf8");
			for (const match of content.matchAll(/^func\s+(Test[A-Za-z0-9_]+)\s*\(/gm)) {
				const fnName = match[1];
				funcs.add(fnName);
				const pkgs = funcToPkgs.get(fnName) ?? new Set<string>();
				pkgs.add(normalizedPkg);
				funcToPkgs.set(fnName, pkgs);
			}
			pkgFuncs.set(normalizedPkg, funcs);
		}
	};
	visit(backendAbs);
	return { pkgFuncs, funcToPkgs };
};

const loadFeatureMap = (rootDir: string): Map<string, string[]> => {
	const parsed = loadJsonIfExists<{ obligations?: Array<{ id?: unknown; evidence?: unknown }> }>(
		path.join(rootDir, "tests/catalog/feature-obligations.json"),
	);
	const map = new Map<string, string[]>();
	for (const entry of parsed?.obligations ?? []) {
		if (typeof entry.id === "string") {
			map.set(
				entry.id,
				Array.isArray(entry.evidence) ? entry.evidence.filter((item): item is string => typeof item === "string") : [],
			);
		}
	}
	return map;
};

const knownExternalCaseIds = new Set(Object.values(EXTERNAL_CASES).map((item) => item.id));

const validateEvidenceItemOnDisk = (
	rootDir: string,
	item: ModuleEvidenceItem,
	featureMap: Map<string, string[]>,
	goInfo: { pkgFuncs: Map<string, Set<string>> },
): string | null => {
	if (item.kind === "vitest") {
		if (!item.file || !/\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(item.file)) {
			return `无效的 Vitest 测试路径: ${String(item.file)}`;
		}
		if (!fs.existsSync(path.join(rootDir, item.file))) {
			return `引用的 Vitest 测试文件不存在: ${item.file}`;
		}
		return null;
	}
	if (item.kind === "browser") {
		if (!item.file || !/\.browser\.spec\.ts$/.test(item.file)) {
			return `无效的 Browser 测试路径: ${String(item.file)}`;
		}
		if (!fs.existsSync(path.join(rootDir, item.file))) {
			return `引用的 Browser 测试文件不存在: ${item.file}`;
		}
		return null;
	}
	if (item.kind === "go") {
		if (!item.package || (!item.package.startsWith("./") && item.package !== ".")) {
			return `无效的 Go package 路径: ${String(item.package)}`;
		}
		const pkgDirRel = item.package === "." ? "apps/backend" : path.posix.join("apps/backend", item.package.slice(2));
		const pkgDirAbs = path.join(rootDir, pkgDirRel);
		if (!fs.existsSync(pkgDirAbs) || !fs.statSync(pkgDirAbs).isDirectory()) {
			return `引用的 Go package 目录不存在: ${pkgDirRel}`;
		}
		const hasTests = fs.readdirSync(pkgDirAbs).some((name) => name.endsWith("_test.go"));
		if (!hasTests) {
			return `Go package ${item.package} 下不存在 *_test.go 文件`;
		}
		if (item.file && !fs.existsSync(path.join(rootDir, item.file))) {
			return `引用的 Go 测试文件不存在: ${item.file}`;
		}
		if (item.runPattern && /^[A-Za-z0-9_]+$/.test(item.runPattern)) {
			const funcs = goInfo.pkgFuncs.get(item.package);
			if (!funcs || !funcs.has(item.runPattern)) {
				return `Go package ${item.package} 中未找到测试函数 ${item.runPattern}`;
			}
		}
		return null;
	}
	if (item.kind === "external") {
		if (!knownExternalCaseIds.has(item.caseId)) {
			return `未知的 external E2E 用例 ID: ${String(item.caseId)}`;
		}
		return null;
	}
	if (item.kind === "feature") {
		const featureEvidence = featureMap.get(item.obligationId);
		if (!featureEvidence) {
			return `未知的 feature obligation ID: ${String(item.obligationId)}`;
		}
		if (featureEvidence.length === 0) {
			return `feature obligation ${item.obligationId} 未绑定可执行证据`;
		}
		return null;
	}
	return "未知的 evidence 类型";
};

const getConfirmedEvidence = (entry: LabInventoryObligation): ModuleEvidenceItem[] => {
	if (Array.isArray(entry.evidence) && entry.evidence.length > 0) return entry.evidence;
	if (typeof entry.owner === "string" && entry.owner.trim()) {
		if (entry.kind === "go") {
			const dirRel = path.posix.relative("apps/backend", path.posix.dirname(entry.path));
			return [{ kind: "go", package: dirRel === "" || dirRel === "." ? "." : `./${dirRel}`, file: entry.owner }];
		}
		if (entry.owner.endsWith(".browser.spec.ts")) {
			return [{ kind: "browser", file: entry.owner }];
		}
		return [{ kind: "vitest", file: entry.owner }];
	}
	return [];
};

const resolveEvidenceToRawTargets = (
	items: ModuleEvidenceItem[],
	featureMap: Map<string, string[]>,
	goInfo: { funcToPkgs: Map<string, Set<string>> },
): RawSelectedTarget[] => {
	const out: RawSelectedTarget[] = [];
	for (const item of items) {
		if (item.kind === "vitest") {
			out.push({ kind: "vitest", file: item.file, testNamePattern: item.testNamePattern });
		} else if (item.kind === "browser") {
			out.push({ kind: "browser", file: item.file, testNamePattern: item.testNamePattern });
		} else if (item.kind === "go") {
			out.push({ kind: "go", package: item.package, runPattern: item.runPattern });
		} else if (item.kind === "external") {
			out.push({ kind: "external", caseId: item.caseId });
		} else if (item.kind === "feature") {
			for (const ref of featureMap.get(item.obligationId) ?? []) {
				if (ref.startsWith("go:")) {
					const fnName = ref.slice("go:".length);
					const pkgs = goInfo.funcToPkgs.get(fnName);
					if (pkgs) {
						for (const pkg of pkgs) {
							out.push({ kind: "go", package: pkg, runPattern: fnName });
						}
					}
				} else if (ref.startsWith("external:")) {
					out.push({ kind: "external", caseId: ref.slice("external:".length) });
				} else if (ref.startsWith("vitest:")) {
					out.push({ kind: "vitest", file: ref.slice("vitest:".length) });
				} else if (ref.startsWith("browser:")) {
					out.push({ kind: "browser", file: ref.slice("browser:".length) });
				}
			}
		}
	}
	return out;
};

const referencesDeletedTestFile = (item: ModuleEvidenceItem, deletedTestPaths: Set<string>): boolean => {
	if ((item.kind === "vitest" || item.kind === "browser") && deletedTestPaths.has(item.file)) return true;
	if (item.kind === "go" && item.file && deletedTestPaths.has(item.file)) return true;
	return false;
};

const walkSpecsUnder = (rootDir: string, relDir: string, pattern: RegExp): string[] => {
	const abs = path.join(rootDir, relDir);
	if (!fs.existsSync(abs)) return [];
	const results: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else {
				const rel = toPosix(path.relative(rootDir, full));
				if (pattern.test(rel)) results.push(rel);
			}
		}
	};
	visit(abs);
	return results.sort();
};

const coalesceRawTargets = (rawTargets: RawSelectedTarget[]): ChangeObligationTarget[] => {
	const vitestMap = new Map<string, { full: boolean; patterns: Set<string> }>();
	const browserMap = new Map<string, { full: boolean; patterns: Set<string> }>();
	const goMap = new Map<string, { full: boolean; patterns: Set<string> }>();
	const externalSet = new Set<string>();

	const record = (map: Map<string, { full: boolean; patterns: Set<string> }>, key: string, pattern?: string) => {
		const slot = map.get(key) ?? { full: false, patterns: new Set<string>() };
		if (!pattern) slot.full = true;
		else slot.patterns.add(pattern);
		map.set(key, slot);
	};

	for (const target of rawTargets) {
		if (target.kind === "vitest") record(vitestMap, target.file, target.testNamePattern);
		else if (target.kind === "browser") record(browserMap, target.file, target.testNamePattern);
		else if (target.kind === "go") record(goMap, target.package, target.runPattern);
		else if (target.kind === "external") externalSet.add(target.caseId);
	}

	const targets: ChangeObligationTarget[] = [];
	for (const file of [...vitestMap.keys()].sort()) {
		const slot = vitestMap.get(file)!;
		targets.push({
			kind: "vitest",
			file,
			testNamePatterns: slot.full || slot.patterns.size === 0 ? undefined : [...slot.patterns].sort(),
			executionMode: "selected",
		});
	}
	for (const file of [...browserMap.keys()].sort()) {
		const slot = browserMap.get(file)!;
		targets.push({
			kind: "browser",
			file,
			testNamePatterns: slot.full || slot.patterns.size === 0 ? undefined : [...slot.patterns].sort(),
			executionMode: "selected",
		});
	}
	for (const pkg of [...goMap.keys()].sort()) {
		const slot = goMap.get(pkg)!;
		targets.push({
			kind: "go",
			package: pkg,
			runPatterns: slot.full || slot.patterns.size === 0 ? undefined : [...slot.patterns].sort(),
			executionMode: "selected",
		});
	}
	for (const caseId of [...externalSet].sort()) {
		targets.push({
			kind: "external",
			caseId,
			executionMode: "selected",
		});
	}
	return targets;
};

export const formatChangeObligationsMarkdown = (report: ChangeObligationsReport): string => {
	const lines: string[] = [];
	lines.push("## 本次变更关联检查 (Change Test Obligations)");
	lines.push("");
	lines.push(`- 对比范围：\`${report.stagedOnly ? "STAGED (HEAD -> Index)" : `${report.baseSha.slice(0, 12)}..${report.headSha.slice(0, 12)}`}\``);
	lines.push(`- 检查结果：**${report.passed ? "通过 (PASSED)" : "失败 (FAILED)"}**`);
	lines.push(
		`- 变更统计：改动受管源码 ${report.summary.changedSources} 个，改动测试 ${report.summary.changedTests} 个，新增未覆盖 ${report.summary.newUncovered} 个，历史测试债务 ${report.summary.historicalDebt} 项`,
	);
	lines.push(
		`- 选测计划：共选中 ${report.summary.selectedCount} 项（复用核心检查 ${report.summary.reusedCount} 项，独立/补充执行 ${report.summary.executedExtraCount} 项，回退级别 \`${report.fallbackMode}\`）`,
	);

	if (report.fallbackReasons.length > 0) {
		lines.push(`- 回退说明：${report.fallbackReasons.join("；")}`);
	}

	const sourceChanges = report.changedFiles.filter((f) => f.category === "managed-source");
	if (sourceChanges.length > 0) {
		lines.push("");
		lines.push("| 状态 | 源码文件 | 清单状态 | 已绑定证据数 |");
		lines.push("| --- | --- | --- | --- |");
		for (const item of sourceChanges.slice(0, 40)) {
			lines.push(
				`| \`${item.status}\` | \`${item.path}\` | \`${item.state ?? "missing"}\` | ${item.evidenceCount ?? 0} |`,
			);
		}
		if (sourceChanges.length > 40) {
			lines.push(`| ... | 另有 ${sourceChanges.length - 40} 个文件 | ... | ... |`);
		}
	}

	if (report.violations.length > 0) {
		lines.push("");
		lines.push("### 需要修复的测试义务问题");
		for (const v of report.violations) {
			lines.push("");
			lines.push(`- **[${v.code}] \`${v.path}\`** (${v.status}): ${v.message}`);
			for (let idx = 0; idx < v.remediation.length; idx += 1) {
				lines.push(`  ${idx + 1}. ${v.remediation[idx]}`);
			}
		}
	}

	return lines.join("\n");
};

export const analyzeChangeObligations = (input: AnalyzeChangeObligationsInput = {}): ChangeObligationsAnalysis => {
	const rootDir = input.rootDir ?? process.cwd();
	const stagedOnly = Boolean(input.stagedOnly);
	let resolvedBaseSha = (input.baseSha ?? "").trim();
	let resolvedHeadSha = (input.headSha ?? "HEAD").trim() || "HEAD";
	const violations: ChangeObligationViolation[] = [];

	let diffEntries: GitDiffEntry[] = [];
	if (input.diffEntriesOverride) {
		diffEntries = input.diffEntriesOverride;
	} else if (stagedOnly) {
		resolvedBaseSha = "HEAD";
		resolvedHeadSha = "STAGED";
		const hasHead = runGit(rootDir, ["rev-parse", "--verify", "HEAD"]).ok;
		const diffArgs = hasHead
			? ["diff", "--cached", "--name-status", "-M", "-C", "-z"]
			: ["diff", "--cached", "--name-status", "-M", "-C", "-z", "--root"];
		const diffRes = runGit(rootDir, diffArgs);
		if (!diffRes.ok) {
			violations.push({
				code: "GIT_DIFF_FAILED",
				path: ".",
				status: "ERROR",
				message: `无法读取暂存区差异: ${diffRes.stderr.trim()}`,
				remediation: ["确认当前处于有效的 Git 仓库中并检查 git status。"],
			});
		} else {
			diffEntries = parseGitNameStatusZ(diffRes.stdout);
		}
	} else {
		const headRes = runGit(rootDir, ["rev-parse", resolvedHeadSha]);
		if (headRes.ok) resolvedHeadSha = headRes.stdout.trim();

		let baseValid = Boolean(resolvedBaseSha) && !ALL_ZERO_SHA.test(resolvedBaseSha) && runGit(rootDir, ["cat-file", "-e", `${resolvedBaseSha}^{commit}`]).ok;
		if (!baseValid) {
			const mergeOrigin = runGit(rootDir, ["merge-base", resolvedHeadSha, "origin/main"]);
			if (mergeOrigin.ok && mergeOrigin.stdout.trim()) {
				resolvedBaseSha = mergeOrigin.stdout.trim();
				baseValid = true;
			} else {
				const mergeLocal = runGit(rootDir, ["merge-base", resolvedHeadSha, "main"]);
				if (mergeLocal.ok && mergeLocal.stdout.trim()) {
					resolvedBaseSha = mergeLocal.stdout.trim();
					baseValid = true;
				}
			}
		}

		if (!baseValid) {
			violations.push({
				code: "MISSING_BASE_SHA",
				path: ".",
				status: "ERROR",
				message: "无法确定有效的比较基准提交（baseSha / origin/main），按 Fail-Closed 原则拒绝静默放行。",
				remediation: [
					"在 CI 中将 actions/checkout 的 fetch-depth 设为 0。",
					"或显式传入有效的 --base=<sha> 参数（例如 --base=origin/main）。",
				],
			});
		} else {
			const baseRev = runGit(rootDir, ["rev-parse", resolvedBaseSha]);
			if (baseRev.ok) resolvedBaseSha = baseRev.stdout.trim();
			const diffRes = runGit(rootDir, ["diff", "--name-status", "-M", "-C", "-z", resolvedBaseSha, resolvedHeadSha]);
			if (!diffRes.ok) {
				violations.push({
					code: "GIT_DIFF_FAILED",
					path: ".",
					status: "ERROR",
					message: `无法计算 ${resolvedBaseSha}..${resolvedHeadSha} 的 Git 差异: ${diffRes.stderr.trim()}`,
					remediation: ["确认本地/CI 已拉取完整的 base 提交历史（fetch-depth: 0）。"],
				});
			} else {
				diffEntries = parseGitNameStatusZ(diffRes.stdout);
			}
		}
	}

	// Load current catalog (from staged blob when --staged is set, if staged)
	let currentCatalog = input.catalogOverride;
	if (!currentCatalog && stagedOnly) {
		currentCatalog = loadGitJsonAtRef<LabInventoryReport>(rootDir, ":tests/catalog/module-obligations.json") ?? undefined;
	}
	if (!currentCatalog) {
		currentCatalog = loadJsonIfExists<LabInventoryReport>(path.join(rootDir, "tests/catalog/module-obligations.json")) ?? undefined;
	}

	let baseCatalog: LabInventoryReport | null = input.baseCatalogOverride ?? null;
	if (input.baseCatalogOverride === undefined && resolvedBaseSha && resolvedBaseSha !== resolvedHeadSha) {
		baseCatalog = loadGitJsonAtRef<LabInventoryReport>(rootDir, `${resolvedBaseSha}:tests/catalog/module-obligations.json`);
	}

	const catalogByPath = new Map<string, LabInventoryObligation>();
	for (const item of currentCatalog?.obligations ?? []) {
		catalogByPath.set(item.path, item);
	}
	const baseByPath = new Map<string, LabInventoryObligation>();
	for (const item of baseCatalog?.obligations ?? []) {
		baseByPath.set(item.path, item);
	}

	if (!currentCatalog) {
		violations.push({
			code: "MISSING_CATALOG",
			path: "tests/catalog/module-obligations.json",
			status: "ERROR",
			message: "缺少模块测试义务清单 tests/catalog/module-obligations.json。",
			remediation: ["运行 `npm run lab:inventory` 生成测试义务清单。"],
		});
	}

	const featureMap = loadFeatureMap(rootDir);
	const goInfo = collectGoTestInfo(rootDir);

	const changedFiles: ChangeObligationFileRecord[] = [];
	const rawTargets: RawSelectedTarget[] = [];
	const deletedTestPaths = new Set<string>();
	const fallbackReasons = new Set<string>();
	let fallbackMode: "none" | "targeted" | "core-suite" = "none";

	let changedSources = 0;
	let changedTests = 0;
	let newUncovered = 0;

	const promoteFallback = (next: "targeted" | "core-suite", reason: string) => {
		if (next === "core-suite") fallbackMode = "core-suite";
		else if (fallbackMode === "none") fallbackMode = "targeted";
		fallbackReasons.add(reason);
	};

	for (const entry of diffEntries) {
		const category = classifyChangedPath(entry.path);
		const obligation = catalogByPath.get(entry.path);
		const confirmedEvidence = obligation ? getConfirmedEvidence(obligation) : [];

		changedFiles.push({
			status: entry.status,
			path: entry.path,
			previousPath: entry.previousPath,
			category,
			obligationId: obligation?.id,
			state: obligation?.state,
			evidenceCount:
				obligation?.state === "excluded"
					? obligation.alternativeEvidence?.length ?? 0
					: confirmedEvidence.length,
		});

		// Deleted or renamed-away test file tracking
		if (entry.status === "D" && isTestFilePath(entry.path)) {
			deletedTestPaths.add(entry.path);
		}
		if (entry.status === "R" && entry.previousPath && isTestFilePath(entry.previousPath)) {
			deletedTestPaths.add(entry.previousPath);
		}

		// Handle deletions of managed sources (Rule 6.3)
		if (entry.status === "D" && getManagedSourceKind(entry.path)) {
			changedSources += 1;
			if (catalogByPath.has(entry.path)) {
				violations.push({
					code: "STALE_DELETED_SOURCE",
					path: entry.path,
					status: entry.status,
					message: `已删除的受管源码 ${entry.path} 仍残留在 tests/catalog/module-obligations.json 中。`,
					remediation: [
						"运行 `npm run lab:inventory` 自动清理已删除源码的清单条目。",
						"将更新后的 `tests/catalog/module-obligations.json` 一并加入暂存区/提交。",
					],
				});
			}
			// Trigger historical obligations from base catalog for regression safety
			const prevEntry = baseByPath.get(entry.path);
			if (prevEntry) {
				const prevEvidence = prevEntry.state === "excluded" ? prevEntry.alternativeEvidence ?? [] : getConfirmedEvidence(prevEntry);
				rawTargets.push(...resolveEvidenceToRawTargets(prevEvidence, featureMap, goInfo));
			}
			continue;
		}

		// Rule 6.1 & 6.2 & 6.6: Added / Modified / Renamed / Copied managed source
		const managedKind = getManagedSourceKind(entry.path);
		if (managedKind && (entry.status === "A" || entry.status === "M" || entry.status === "R" || entry.status === "C")) {
			changedSources += 1;
			if (entry.status === "R" && entry.previousPath && catalogByPath.has(entry.previousPath)) {
				violations.push({
					code: "STALE_RENAMED_SOURCE",
					path: entry.previousPath,
					status: "R",
					message: `重命名前的旧路径 ${entry.previousPath} 仍残留在 tests/catalog/module-obligations.json 中。`,
					remediation: [
						`运行 \`npm run lab:inventory -- --rename ${entry.previousPath}=${entry.path}\` 迁移义务映射并清理旧路径。`,
					],
				});
			}

			if (!obligation) {
				newUncovered += 1;
				violations.push({
					code: "MISSING_SOURCE_OBLIGATION",
					path: entry.path,
					status: entry.status,
					message: `受管源码 ${entry.path} 尚未登记在 tests/catalog/module-obligations.json 中。`,
					remediation: [
						"运行 `npm run lab:inventory` 将该文件加入测试义务清单（如有同名测试会写入 recommendedEvidence）。",
						"在 `tests/catalog/module-obligations.json` 中将 state 设为 `covered`（或 `partial`）并填入有效 `evidence`；如确实无需单测，设为 `excluded` 并填写 `reason` 和 `alternativeEvidence`。",
						"重新运行 `npm run lab:obligations:check` 确认通过。",
					],
				});
				continue;
			}

			if (obligation.state === "uncovered") {
				newUncovered += 1;
				const recHint =
					Array.isArray(obligation.recommendedEvidence) && obligation.recommendedEvidence.length > 0
						? `系统已发现候选测试 recommendedEvidence：${JSON.stringify(obligation.recommendedEvidence)}，请核实后将其移入 \`evidence\`。`
						: "为该模块编写单元测试、组件测试，或关联已有覆盖它的测试 / feature / external E2E。";
				violations.push({
					code: entry.status === "A" ? "NEW_FILE_UNCOVERED" : "MODIFIED_UNCOVERED_MODULE",
					path: entry.path,
					status: entry.status,
					message:
						entry.status === "A"
							? `新增源码 ${entry.path} 处于 uncovered 状态（仅有 recommendedEvidence 也不视为已确认）。`
							: `本次修改了历史未覆盖源码 ${entry.path}，按门禁规则修改已有 uncovered 文件必须补齐有效测试证据或登记受控例外。`,
					remediation: [
						recHint,
						"在 `tests/catalog/module-obligations.json` 中更新该条目为 `covered`/`partial` + `evidence`，或 `excluded` + `reason` + `alternativeEvidence`。",
						"运行 `npm run lab:obligations:check` 确认检查通过。",
					],
				});
				continue;
			}

			// Check coverage regression vs baseCatalog
			const prevLookupPath = entry.status === "R" && entry.previousPath ? entry.previousPath : entry.path;
			const baseEntry = baseByPath.get(prevLookupPath);
			if (
				baseEntry &&
				(baseEntry.state === "covered" || baseEntry.state === "partial") &&
				obligation.state === "excluded" &&
				(!Array.isArray(obligation.alternativeEvidence) || obligation.alternativeEvidence.length === 0)
			) {
				violations.push({
					code: "COVERAGE_REGRESSION",
					path: entry.path,
					status: entry.status,
					message: `${entry.path} 原先已绑定测试覆盖，不允许无替代验证降级为 excluded。`,
					remediation: ["恢复原有 `evidence`，或明确给出有效的 `alternativeEvidence` 与 `reason`。"],
				});
			}

			if (obligation.state === "excluded") {
				const reasonValid = typeof obligation.reason === "string" && obligation.reason.trim().length > 0;
				const alt = obligation.alternativeEvidence ?? [];
				if (!reasonValid || alt.length === 0) {
					violations.push({
						code: "INVALID_EXCLUDED_OBLIGATION",
						path: entry.path,
						status: entry.status,
						message: `源码 ${entry.path} 标记为 excluded，但缺少非空 reason 或 alternativeEvidence。`,
						remediation: [
							"在 `tests/catalog/module-obligations.json` 中为该条目补充清晰的 `reason` 说明与至少一项 `alternativeEvidence`（如 `{ \"kind\": \"external\", \"caseId\": \"harness-health\" }`）。",
						],
					});
					continue;
				}
				for (const item of alt) {
					const err = validateEvidenceItemOnDisk(rootDir, item, featureMap, goInfo);
					if (err) {
						violations.push({
							code: "INVALID_EVIDENCE_TARGET",
							path: entry.path,
							status: entry.status,
							message: `源码 ${entry.path} 的 alternativeEvidence 无效：${err}`,
							remediation: ["修正 `tests/catalog/module-obligations.json` 中对应的测试文件路径、package 或 caseId。"],
						});
					}
				}
				rawTargets.push(...resolveEvidenceToRawTargets(alt, featureMap, goInfo));
			} else {
				if (confirmedEvidence.length === 0) {
					violations.push({
						code: "MISSING_CONFIRMED_EVIDENCE",
						path: entry.path,
						status: entry.status,
						message: `源码 ${entry.path} 标记为 ${obligation.state}，但缺少有效的 evidence 数组。`,
						remediation: ["在 `tests/catalog/module-obligations.json` 中为该条目填写至少一项可执行 `evidence`。"],
					});
					continue;
				}
				for (const item of confirmedEvidence) {
					const err = validateEvidenceItemOnDisk(rootDir, item, featureMap, goInfo);
					if (err) {
						violations.push({
							code: "INVALID_EVIDENCE_TARGET",
							path: entry.path,
							status: entry.status,
							message: `源码 ${entry.path} 的 evidence 无效：${err}`,
							remediation: ["检查并修正 `tests/catalog/module-obligations.json` 中指向的测试目标。"],
						});
					}
				}
				rawTargets.push(...resolveEvidenceToRawTargets(confirmedEvidence, featureMap, goInfo));
			}

			// Conservative Fallbacks for critical directories
			if (entry.path.startsWith("packages/shared/src/")) {
				promoteFallback("targeted", "改动 packages/shared/src 共享协议/类型，扩大至跨端契约校验");
				for (const spec of walkSpecsUnder(rootDir, "packages/shared/src", /\.spec\.ts$/)) {
					rawTargets.push({ kind: "vitest", file: spec });
				}
				for (const feSpec of [
					"apps/frontend/src/service/collabProtocol.spec.ts",
					"apps/frontend/src/scene/sceneCore.spec.ts",
					"apps/frontend/src/scene/renderOrderIndex.spec.ts",
				]) {
					if (fs.existsSync(path.join(rootDir, feSpec))) rawTargets.push({ kind: "vitest", file: feSpec });
				}
				for (const pkg of ["./internal/domain", "./internal/gateway", "./internal/room"]) {
					rawTargets.push({ kind: "go", package: pkg });
				}
				rawTargets.push({ kind: "external", caseId: "correctness-smoke" });
			} else if (entry.path.startsWith("apps/backend/internal/gateway/")) {
				promoteFallback("targeted", "改动 Go gateway 核心通信逻辑，补充核心 E2E 验证");
				rawTargets.push({ kind: "go", package: "./internal/gateway" });
				rawTargets.push({ kind: "external", caseId: "harness-health" });
				rawTargets.push({ kind: "external", caseId: "correctness-smoke" });
			} else if (entry.path.startsWith("apps/backend/internal/room/")) {
				promoteFallback("targeted", "改动 Go room 状态同步逻辑，补充核心 E2E 验证");
				rawTargets.push({ kind: "go", package: "./internal/room" });
				rawTargets.push({ kind: "external", caseId: "harness-health" });
				rawTargets.push({ kind: "external", caseId: "correctness-smoke" });
			} else if (
				entry.path.startsWith("apps/frontend/src/scene/") ||
				entry.path.startsWith("apps/frontend/src/workers/") ||
				entry.path.startsWith("apps/frontend/src/service/")
			) {
				promoteFallback("targeted", "改动前端画布/Worker/协同服务核心目录，补充 correctness-smoke 验证");
				rawTargets.push({ kind: "external", caseId: "correctness-smoke" });
			}
			continue;
		}

		// Rule 6.4: Modified or Added test files execute directly
		if (category === "test" && (entry.status === "A" || entry.status === "M" || entry.status === "R" || entry.status === "C")) {
			changedTests += 1;
			if (entry.path.endsWith(".browser.spec.ts")) {
				rawTargets.push({ kind: "browser", file: entry.path });
			} else if (/\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(entry.path)) {
				rawTargets.push({ kind: "vitest", file: entry.path });
			} else if (entry.path.endsWith("_test.go")) {
				const dirRel = toPosix(path.posix.relative("apps/backend", path.posix.dirname(entry.path)));
				rawTargets.push({ kind: "go", package: dirRel === "" || dirRel === "." ? "." : `./${dirRel}` });
			} else if (entry.path.startsWith("apps/frontend/tests/e2e/")) {
				rawTargets.push({ kind: "external", caseId: "correctness-smoke" });
			}
			continue;
		}

		// High-impact config / harness fallback
		if (category === "high-impact-config") {
			promoteFallback("core-suite", `修改高影响配置或测试框架文件 ${entry.path}，触发核心测试集回退`);
			for (const labSpec of walkSpecsUnder(rootDir, "tests/lab", /\.spec\.ts$/)) {
				rawTargets.push({ kind: "vitest", file: labSpec });
			}
			for (const reportSpec of walkSpecsUnder(rootDir, "tests/report", /\.spec\.ts$/)) {
				rawTargets.push({ kind: "vitest", file: reportSpec });
			}
			rawTargets.push({ kind: "external", caseId: "harness-health" });
			rawTargets.push({ kind: "external", caseId: "correctness-smoke" });
		}
	}

	// Rule 6.4: Deleted test files must not leave dangling references in catalog
	if (deletedTestPaths.size > 0 && currentCatalog) {
		for (const item of currentCatalog.obligations) {
			const refs = [...getConfirmedEvidence(item), ...(item.alternativeEvidence ?? [])];
			const broken = refs.filter((ev) => referencesDeletedTestFile(ev, deletedTestPaths));
			if (broken.length > 0 || (item.owner && deletedTestPaths.has(item.owner))) {
				violations.push({
					code: "DANGLING_TEST_REFERENCE",
					path: item.path,
					status: "D",
					message: `测试文件已被删除或移动，但 ${item.id} 仍引用了不存在的测试文件。`,
					remediation: [
						"更新 `tests/catalog/module-obligations.json` 中受影响源码的 `evidence` / `owner`。",
						"确保没有任何源码条目因删除测试而失去有效测试覆盖。",
					],
				});
			}
		}
	}

	// Verify integrity of every modified/added catalog obligation if catalog itself changed
	const catalogChanged = diffEntries.some((entry) => entry.path === "tests/catalog/module-obligations.json");
	if (catalogChanged && currentCatalog) {
		for (const item of currentCatalog.obligations) {
			if (item.state === "covered" || item.state === "partial") {
				const evs = getConfirmedEvidence(item);
				if (evs.length === 0) {
					violations.push({
						code: "CATALOG_MISSING_EVIDENCE",
						path: item.path,
						status: "CATALOG",
						message: `清单条目 ${item.id} (${item.state}) 缺少有效 evidence。`,
						remediation: ["在 `tests/catalog/module-obligations.json` 中补齐至少一项 `evidence`。"],
					});
					continue;
				}
				for (const ev of evs) {
					const err = validateEvidenceItemOnDisk(rootDir, ev, featureMap, goInfo);
					if (err) {
						violations.push({
							code: "CATALOG_INVALID_EVIDENCE",
							path: item.path,
							status: "CATALOG",
							message: `清单条目 ${item.id} 引用失效：${err}`,
							remediation: ["修正 `tests/catalog/module-obligations.json` 中失效的测试引用。"],
						});
					}
				}
			} else if (item.state === "excluded") {
				const alt = item.alternativeEvidence ?? [];
				if (!item.reason?.trim() || alt.length === 0) {
					violations.push({
						code: "CATALOG_INVALID_EXCLUDED",
						path: item.path,
						status: "CATALOG",
						message: `清单条目 ${item.id} 为 excluded，但缺少 reason 或 alternativeEvidence。`,
						remediation: ["为该 `excluded` 条目补充 `reason` 与 `alternativeEvidence`。"],
					});
				}
			}
		}
	}

	// Historical debt counts untouched uncovered/partial obligations in catalog
	const changedManagedSet = new Set(changedFiles.filter((f) => f.category === "managed-source").map((f) => f.path));
	const historicalDebt = (currentCatalog?.obligations ?? []).filter(
		(item) => (item.state === "uncovered" || item.state === "partial") && !changedManagedSet.has(item.path),
	).length;

	const selectedTargets = coalesceRawTargets(rawTargets);
	const report: ChangeObligationsReport = {
		schemaVersion: 1,
		baseSha: resolvedBaseSha,
		headSha: resolvedHeadSha,
		stagedOnly,
		passed: violations.length === 0,
		fallbackMode,
		fallbackReasons: [...fallbackReasons],
		changedFiles,
		violations,
		selectedTargets,
		summary: {
			changedSources,
			changedTests,
			newUncovered,
			historicalDebt,
			selectedCount: selectedTargets.length,
			reusedCount: 0,
			executedExtraCount: selectedTargets.length,
		},
	};

	return {
		report,
		rawTargets,
		markdown: formatChangeObligationsMarkdown(report),
	};
};
