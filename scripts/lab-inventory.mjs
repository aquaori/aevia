// File role: generate or check the module-level test inventory that the lab runner treats as test debt.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(repoRoot, "tests", "catalog", "module-obligations.json");
const sourceRoots = [
	{ kind: "frontend", root: "apps/frontend/src", extensions: [".ts", ".tsx", ".vue"] },
	{ kind: "go", root: "apps/backend", extensions: [".go"] },
];

const toPosix = (value) => value.replaceAll("\\", "/");

const walk = (root, extensions) => {
	const files = [];
	const visit = (relativeDir) => {
		const absoluteDir = path.join(repoRoot, relativeDir);
		if (!existsSync(absoluteDir)) return;
		for (const entry of readdirSync(absoluteDir).sort()) {
			if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
			const relative = toPosix(path.posix.join(relativeDir, entry));
			const absolute = path.join(repoRoot, relative);
			let stats;
			try {
				stats = statSync(absolute);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				visit(relative);
				continue;
			}
			if (!extensions.some((extension) => entry.endsWith(extension))) continue;
			if (/\.spec\.ts$|\.test\.ts$|\.bench\.ts$|\.unit\.spec\.ts$/.test(entry)) continue;
			if (entry.endsWith(".d.ts")) continue;
			if (entry.endsWith("_test.go")) continue;
			files.push(relative);
		}
	};
	visit(root);
	return files;
};

const collectOwners = () => {
	const frontendSpecs = [];
	const walkSpecs = (relativeDir) => {
		const absoluteDir = path.join(repoRoot, relativeDir);
		if (!existsSync(absoluteDir)) return;
		for (const entry of readdirSync(absoluteDir).sort()) {
			if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
			const relative = toPosix(path.posix.join(relativeDir, entry));
			const stats = statSync(path.join(repoRoot, relative));
			if (stats.isDirectory()) {
				walkSpecs(relative);
			} else if (/\.(spec|bench)\.ts$/.test(entry)) {
				frontendSpecs.push(relative);
			}
		}
	};
	for (const root of ["apps/frontend/src", "apps/frontend/tests", "packages/shared/src", "tests"]) walkSpecs(root);
	return frontendSpecs;
};

const ownerForFrontend = (sourceFile, specs) => {
	const withoutExt = sourceFile.replace(/\.(ts|tsx|vue)$/i, "");
	for (const candidate of [`${withoutExt}.spec.ts`, `${withoutExt}.unit.spec.ts`]) {
		if (existsSync(path.join(repoRoot, candidate))) return candidate;
	}
	const basename = path.posix.basename(withoutExt);
	const referencing = specs.find((spec) => {
		try {
			const content = readFileSync(path.join(repoRoot, spec), "utf8");
			return content.includes(`/${basename}"`) || content.includes(`/${basename}.ts"`);
		} catch {
			return false;
		}
	});
	return referencing || null;
};

const ownerForGo = (sourceFile) => {
	const packageDir = path.posix.dirname(sourceFile);
	const absoluteDir = path.join(repoRoot, packageDir);
	if (!existsSync(absoluteDir)) return null;
	const testFile = readdirSync(absoluteDir).find((entry) => entry.endsWith("_test.go"));
	return testFile ? path.posix.join(packageDir, testFile) : null;
};

const EXCLUDED = new Map([
	["apps/frontend/src/main.ts", "Vue 应用装配入口，只有副作用式 bootstrap，由 e2e 间接覆盖"],
	["apps/frontend/src/vite-env.d.ts", "类型声明文件，无运行时行为"],
	["apps/frontend/src/style.css", "全局样式入口，无可断言逻辑"],
]);

const buildObligations = () => {
	const specs = collectOwners();
	const obligations = [];
	for (const sourceRoot of sourceRoots) {
		for (const file of walk(sourceRoot.root, sourceRoot.extensions)) {
			const excludedReason = EXCLUDED.get(file);
			const owner = excludedReason ? null : sourceRoot.kind === "frontend" ? ownerForFrontend(file, specs) : ownerForGo(file);
			const entry = {
				id: `${sourceRoot.kind}:${file}`,
				kind: sourceRoot.kind,
				path: file,
				state: excludedReason ? "excluded" : owner ? "covered" : "uncovered",
			};
			if (excludedReason) entry.reason = excludedReason;
			else if (owner) entry.owner = owner;
			obligations.push(entry);
		}
	}
	return obligations.sort((left, right) => left.id.localeCompare(right.id));
};

const buildCatalog = () => ({
	schemaVersion: 1,
	scope: "Every frontend source module and every Go source file must be either owned by a test or explicitly excluded with a reason.",
	obligations: buildObligations(),
});

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const checkMode = args.includes("--check");
const payload = buildCatalog();
const text = `${JSON.stringify(payload, null, 2)}\n`;

if (outIndex >= 0) {
	const outPath = path.resolve(repoRoot, args[outIndex + 1] || "");
	mkdirSync(path.dirname(outPath), { recursive: true });
	writeFileSync(outPath, text, "utf8");
	console.log(`[lab-inventory] wrote ${path.relative(repoRoot, outPath)} (${payload.obligations.length} obligations)`);
	process.exit(0);
}

if (checkMode) {
	const current = existsSync(catalogPath) ? readFileSync(catalogPath, "utf8") : "";
	if (current !== text) {
		console.error("[lab-inventory] catalog is stale; run `npm run lab:inventory` and commit tests/catalog/module-obligations.json");
		process.exit(1);
	}
	console.log(`[lab-inventory] catalog is current (${payload.obligations.length} obligations)`);
	process.exit(0);
}

writeFileSync(catalogPath, text, "utf8");
const counts = payload.obligations.reduce((accumulator, item) => {
	accumulator[item.state] = (accumulator[item.state] || 0) + 1;
	return accumulator;
}, {});
console.log(`[lab-inventory] wrote tests/catalog/module-obligations.json (${payload.obligations.length} obligations)`);
console.log(`[lab-inventory] states: ${JSON.stringify(counts)}`);
