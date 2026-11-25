import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const catalogPath = path.join(repoRoot, "tests/catalog/module-obligations.json");

const SCOPE_DESCRIPTION =
	"Every managed frontend, backend Go, and shared source module must be bound to executable test evidence or explicitly excluded with a reason and alternative verification.";

const toPosix = (value) => value.replace(/\\/g, "/");

const walkFiles = (rootRel, matcher) => {
	const absRoot = path.join(repoRoot, rootRel);
	if (!existsSync(absRoot)) return [];
	const results = [];
	const visit = (dir) => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			const rel = toPosix(path.relative(repoRoot, full));
			if (matcher(rel)) results.push(rel);
		}
	};
	visit(absRoot);
	return results;
};

const isManagedFrontendSource = (rel) =>
	/\.(ts|tsx|vue)$/.test(rel) &&
	!rel.endsWith(".d.ts") &&
	!/\.(spec|unit\.spec|browser\.spec|bench)\.(ts|tsx)$/.test(rel);

const isManagedGoSource = (rel) => rel.endsWith(".go") && !rel.endsWith("_test.go");

const isManagedSharedSource = (rel) =>
	/\.(ts|tsx)$/.test(rel) &&
	!rel.endsWith(".d.ts") &&
	!/\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(rel);

const classifyVitestLevel = (filePath) => {
	if (filePath.endsWith(".unit.spec.ts") || filePath.startsWith("packages/shared/src/")) return "unit";
	if (filePath.startsWith("tests/lab/") || filePath.startsWith("tests/report/")) return "harness";
	return "module";
};

const ownerToEvidenceItem = (kind, sourcePath, owner) => {
	if (kind === "go") {
		const dir = path.posix.dirname(sourcePath);
		const relPkg = path.posix.relative("apps/backend", dir);
		const pkg = relPkg === "" || relPkg === "." ? "." : `./${relPkg}`;
		return {
			kind: "go",
			package: pkg,
			file: owner,
			level: "unit",
		};
	}
	if (owner.endsWith(".browser.spec.ts")) {
		return {
			kind: "browser",
			file: owner,
			level: "browser",
		};
	}
	return {
		kind: "vitest",
		file: owner,
		level: classifyVitestLevel(owner),
	};
};

const pickBestGoTestFile = (sourcePath, goTestFilesByDir) => {
	const dir = path.posix.dirname(sourcePath);
	const candidates = goTestFilesByDir.get(dir) ?? [];
	if (candidates.length === 0) return undefined;
	const stem = path.posix.basename(sourcePath, ".go");
	const exact = `${dir}/${stem}_test.go`;
	if (candidates.includes(exact)) return exact;
	const nonBench = candidates.filter((file) => !file.endsWith("_bench_test.go"));
	if (nonBench.length > 0) return nonBench[0];
	return candidates[0];
};

const buildSharedBaselineEvidence = () => ({
	"packages/shared/src/index.ts": {
		state: "covered",
		owner: "packages/shared/src/protocol/collabProtocol.spec.ts",
		evidence: [
			{ kind: "vitest", file: "packages/shared/src/protocol/collabProtocol.spec.ts", level: "unit" },
			{ kind: "vitest", file: "packages/shared/src/protocol/orderVectors.spec.ts", level: "unit" },
			{ kind: "vitest", file: "apps/frontend/src/service/collabProtocol.spec.ts", level: "module" },
		],
	},
	"packages/shared/src/protocol/collabProtocol.ts": {
		state: "covered",
		owner: "packages/shared/src/protocol/collabProtocol.spec.ts",
		evidence: [
			{ kind: "vitest", file: "packages/shared/src/protocol/collabProtocol.spec.ts", level: "unit" },
			{ kind: "vitest", file: "packages/shared/src/protocol/orderVectors.spec.ts", level: "unit" },
			{ kind: "vitest", file: "apps/frontend/src/service/collabProtocol.spec.ts", level: "module" },
		],
	},
	"packages/shared/src/protocol/sceneProtocol.ts": {
		state: "covered",
		owner: "packages/shared/src/protocol/orderVectors.spec.ts",
		evidence: [
			{ kind: "vitest", file: "packages/shared/src/protocol/orderVectors.spec.ts", level: "unit" },
			{ kind: "vitest", file: "apps/frontend/src/scene/sceneCore.spec.ts", level: "module" },
		],
	},
	"packages/shared/src/types/collab.ts": {
		state: "covered",
		owner: "packages/shared/src/protocol/collabProtocol.spec.ts",
		evidence: [
			{ kind: "vitest", file: "packages/shared/src/protocol/collabProtocol.spec.ts", level: "unit" },
			{ kind: "vitest", file: "apps/frontend/src/service/collabProtocol.spec.ts", level: "module" },
			{ kind: "go", package: "./internal/domain", file: "apps/backend/internal/domain/types_test.go", level: "unit" },
		],
	},
	"packages/shared/src/types/scene.ts": {
		state: "covered",
		owner: "packages/shared/src/protocol/orderVectors.spec.ts",
		evidence: [
			{ kind: "vitest", file: "packages/shared/src/protocol/orderVectors.spec.ts", level: "unit" },
			{ kind: "vitest", file: "apps/frontend/src/scene/renderOrderIndex.spec.ts", level: "module" },
			{ kind: "vitest", file: "apps/frontend/src/scene/sceneCore.spec.ts", level: "module" },
		],
	},
});

const collectRecommendedEvidence = (kind, sourcePath, vitestFiles, goTestFilesByDir) => {
	if (kind === "go") {
		const candidate = pickBestGoTestFile(sourcePath, goTestFilesByDir);
		if (!candidate) return undefined;
		return [ownerToEvidenceItem("go", sourcePath, candidate)];
	}
	const dir = path.posix.dirname(sourcePath);
	const rawBase = path.posix.basename(sourcePath);
	const stem = rawBase.replace(/\.(vue|tsx|ts)$/, "");
	const candidates = [
		`${dir}/${stem}.unit.spec.ts`,
		`${dir}/${stem}.spec.ts`,
		`apps/frontend/tests/browser/${stem}.browser.spec.ts`,
	];
	const hits = [];
	for (const candidate of candidates) {
		if (vitestFiles.has(candidate)) {
			hits.push(ownerToEvidenceItem(kind, sourcePath, candidate));
		}
	}
	return hits.length > 0 ? hits : undefined;
};

const primaryOwnerFromEvidence = (entry) => {
	if (typeof entry.owner === "string" && entry.owner.trim()) return entry.owner;
	if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) return undefined;
	for (const item of entry.evidence) {
		if (item && (item.kind === "vitest" || item.kind === "browser" || item.kind === "go") && typeof item.file === "string" && item.file.trim()) {
			return item.file;
		}
	}
	return undefined;
};

const normalizeEntry = (entry) => {
	const out = {
		id: entry.id,
		kind: entry.kind,
		path: entry.path,
		state: entry.state,
	};
	const owner = primaryOwnerFromEvidence(entry);
	if ((entry.state === "covered" || entry.state === "partial") && owner) {
		out.owner = owner;
	}
	if (Array.isArray(entry.evidence) && entry.evidence.length > 0) {
		out.evidence = entry.evidence;
	}
	if (entry.state === "uncovered" && Array.isArray(entry.recommendedEvidence) && entry.recommendedEvidence.length > 0) {
		out.recommendedEvidence = entry.recommendedEvidence;
	}
	if (typeof entry.reason === "string" && entry.reason.trim()) {
		out.reason = entry.reason;
	}
	if (Array.isArray(entry.alternativeEvidence) && entry.alternativeEvidence.length > 0) {
		out.alternativeEvidence = entry.alternativeEvidence;
	}
	return out;
};

const buildCatalog = (renameMap) => {
	const existingRaw = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, "utf8")) : null;
	const existingVersion = existingRaw?.schemaVersion ?? 1;
	const existingByPath = new Map();
	if (Array.isArray(existingRaw?.obligations)) {
		for (const item of existingRaw.obligations) {
			if (!item || typeof item.path !== "string") continue;
			const targetPath = renameMap.get(item.path) ?? item.path;
			existingByPath.set(targetPath, item);
		}
	}

	const frontendSources = walkFiles("apps/frontend/src", isManagedFrontendSource);
	const goSources = walkFiles("apps/backend", isManagedGoSource);
	const sharedSources = walkFiles("packages/shared/src", isManagedSharedSource);

	const vitestFiles = new Set([
		...walkFiles("apps/frontend/src", (rel) => /\.(spec|unit\.spec|bench)\.(ts|tsx)$/.test(rel)),
		...walkFiles("apps/frontend/tests/browser", (rel) => /\.browser\.spec\.ts$/.test(rel)),
		...walkFiles("packages/shared/src", (rel) => /\.spec\.ts$/.test(rel)),
		...walkFiles("tests/lab", (rel) => /\.spec\.ts$/.test(rel)),
		...walkFiles("tests/report", (rel) => /\.spec\.ts$/.test(rel)),
	]);
	const goTestFilesByDir = new Map();
	for (const testFile of walkFiles("apps/backend", (rel) => rel.endsWith("_test.go"))) {
		const dir = path.posix.dirname(testFile);
		const list = goTestFilesByDir.get(dir) ?? [];
		list.push(testFile);
		goTestFilesByDir.set(dir, list);
	}

	const sharedBaseline = buildSharedBaselineEvidence();

	const sources = [
		...frontendSources.map((rel) => ({ kind: "frontend", path: rel })),
		...goSources.map((rel) => ({ kind: "go", path: rel })),
		...sharedSources.map((rel) => ({ kind: "shared", path: rel })),
	];

	const obligations = sources.map(({ kind, path: sourcePath }) => {
		const id = `${kind}:${sourcePath}`;
		const existing = existingByPath.get(sourcePath);

		if (existing && existingVersion >= 2) {
			const merged = {
				...existing,
				id,
				kind,
				path: sourcePath,
			};
			if (merged.state === "uncovered" && !merged.recommendedEvidence) {
				merged.recommendedEvidence = collectRecommendedEvidence(kind, sourcePath, vitestFiles, goTestFilesByDir);
			}
			return normalizeEntry(merged);
		}

		// Migrate v1 entry cleanly or seed initial baseline for newly tracked shared files
		if (existing && existingVersion === 1) {
			if (existing.state === "excluded") {
				const alt = Array.isArray(existing.alternativeEvidence) && existing.alternativeEvidence.length > 0
					? existing.alternativeEvidence
					: sourcePath === "apps/frontend/src/main.ts"
						? [{ kind: "external", caseId: "harness-health", level: "e2e" }]
						: undefined;
				return normalizeEntry({
					id,
					kind,
					path: sourcePath,
					state: "excluded",
					reason: existing.reason,
					alternativeEvidence: alt,
				});
			}
			if ((existing.state === "covered" || existing.state === "partial") && typeof existing.owner === "string" && existing.owner.trim()) {
				const chosenFile = kind === "go" ? pickBestGoTestFile(sourcePath, goTestFilesByDir) ?? existing.owner : existing.owner;
				const item = ownerToEvidenceItem(kind, sourcePath, chosenFile);
				return normalizeEntry({
					id,
					kind,
					path: sourcePath,
					state: existing.state,
					owner: chosenFile,
					evidence: [item],
					reason: existing.reason,
				});
			}
			return normalizeEntry({
				id,
				kind,
				path: sourcePath,
				state: "uncovered",
				recommendedEvidence: collectRecommendedEvidence(kind, sourcePath, vitestFiles, goTestFilesByDir),
			});
		}

		if (kind === "shared" && sharedBaseline[sourcePath] && existingVersion < 2) {
			return normalizeEntry({
				id,
				kind,
				path: sourcePath,
				...sharedBaseline[sourcePath],
			});
		}

		return normalizeEntry({
			id,
			kind,
			path: sourcePath,
			state: "uncovered",
			recommendedEvidence: collectRecommendedEvidence(kind, sourcePath, vitestFiles, goTestFilesByDir),
		});
	});

	obligations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	return {
		schemaVersion: 2,
		scope: SCOPE_DESCRIPTION,
		obligations,
	};
};

const parseArgs = () => {
	const args = process.argv.slice(2);
	let outPath = null;
	let checkMode = false;
	const renameMap = new Map();

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--check") {
			checkMode = true;
		} else if (arg === "--out" && args[i + 1]) {
			outPath = path.resolve(repoRoot, args[i + 1]);
			i += 1;
		} else if (arg.startsWith("--out=")) {
			outPath = path.resolve(repoRoot, arg.slice("--out=".length));
		} else if (arg === "--rename" && args[i + 1]) {
			const [fromPath, toPath] = args[i + 1].split("=");
			if (fromPath && toPath) renameMap.set(toPosix(fromPath), toPosix(toPath));
			i += 1;
		} else if (arg.startsWith("--rename=")) {
			const [fromPath, toPath] = arg.slice("--rename=".length).split("=");
			if (fromPath && toPath) renameMap.set(toPosix(fromPath), toPosix(toPath));
		}
	}

	return { outPath, checkMode, renameMap };
};

const validateCatalogSync = (expectedCatalog) => {
	if (!existsSync(catalogPath)) {
		return ["tests/catalog/module-obligations.json does not exist"];
	}
	const current = JSON.parse(readFileSync(catalogPath, "utf8"));
	const issues = [];
	if (current.schemaVersion !== 2) {
		issues.push(`expected schemaVersion 2, got ${String(current.schemaVersion)}`);
	}
	const expectedIds = expectedCatalog.obligations.map((o) => o.id);
	const currentIds = Array.isArray(current.obligations) ? current.obligations.map((o) => o?.id) : [];
	const expectedSet = new Set(expectedIds);
	const currentSet = new Set(currentIds);

	for (const id of expectedIds) {
		if (!currentSet.has(id)) issues.push(`missing managed source in catalog: ${id}`);
	}
	for (const id of currentIds) {
		if (!expectedSet.has(id)) issues.push(`stale or unmanaged entry in catalog: ${id}`);
	}
	if (issues.length === 0 && JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
		issues.push("catalog obligations are not canonically sorted by id");
	}
	return issues;
};

const { outPath, checkMode, renameMap } = parseArgs();
const payload = buildCatalog(renameMap);
const text = `${JSON.stringify(payload, null, 2)}\n`;

if (outPath) {
	mkdirSync(path.dirname(outPath), { recursive: true });
	writeFileSync(outPath, text, "utf8");
	console.log(`[lab-inventory] wrote ${toPosix(path.relative(repoRoot, outPath))} (${payload.obligations.length} obligations)`);
	process.exit(0);
}

if (checkMode) {
	const issues = validateCatalogSync(payload);
	if (issues.length > 0) {
		console.error("[lab-inventory] catalog is stale; run `npm run lab:inventory` and commit tests/catalog/module-obligations.json");
		for (const issue of issues.slice(0, 20)) {
			console.error(`  - ${issue}`);
		}
		process.exit(1);
	}
	console.log(`[lab-inventory] catalog is current (${payload.obligations.length} obligations)`);
	process.exit(0);
}

const counts = { covered: 0, partial: 0, uncovered: 0, excluded: 0 };
for (const entry of payload.obligations) {
	counts[entry.state] = (counts[entry.state] ?? 0) + 1;
}
writeFileSync(catalogPath, text, "utf8");
console.log(`[lab-inventory] wrote tests/catalog/module-obligations.json (${payload.obligations.length} obligations)`);
console.log(`[lab-inventory] states: ${JSON.stringify(counts)}`);
