// File role: fail-closed checks for the module-level test-debt inventory used by the lab runner.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd());
const catalogPath = path.join(repoRoot, "tests", "catalog", "module-obligations.json");

type RawObligation = {
	id?: unknown;
	kind?: unknown;
	path?: unknown;
	state?: unknown;
	owner?: unknown;
	reason?: unknown;
};

const toPosix = (value: string) => value.replaceAll("\\", "/");

const walkSourceFiles = (root: string, extensions: string[]) => {
	const files: string[] = [];
	const visit = (relativeDir: string) => {
		const absoluteDir = path.join(repoRoot, relativeDir);
		if (!fs.existsSync(absoluteDir)) return;
		for (const entry of fs.readdirSync(absoluteDir).sort()) {
			if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
			const relative = toPosix(path.posix.join(relativeDir, entry));
			const stats = fs.statSync(path.join(repoRoot, relative));
			if (stats.isDirectory()) {
				visit(relative);
				continue;
			}
			if (!extensions.some((extension) => entry.endsWith(extension))) continue;
			if (/\.(spec|bench|unit\.spec)\.ts$/.test(entry) || entry.endsWith(".d.ts") || entry.endsWith("_test.go")) continue;
			files.push(relative);
		}
	};
	visit(root);
	return files;
};

const expectedSurfaces = () => {
	const surfaces = new Set<string>();
	for (const file of walkSourceFiles("apps/frontend/src", [".ts", ".tsx", ".vue"])) surfaces.add(`frontend:${file}`);
	for (const file of walkSourceFiles("apps/backend", [".go"])) surfaces.add(`go:${file}`);
	return surfaces;
};

const readCatalog = () => JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
	schemaVersion?: unknown;
	scope?: unknown;
	obligations?: unknown;
};

describe("lab module inventory", () => {
	it("covers every source module exactly once", () => {
		const catalog = readCatalog();
		expect(catalog.schemaVersion).toBe(1);
		expect(typeof catalog.scope).toBe("string");
		expect(Array.isArray(catalog.obligations)).toBe(true);
		const obligations = catalog.obligations as RawObligation[];
		const ids = obligations.map((item) => item.id).filter((id): id is string => typeof id === "string");
		expect(ids.length).toBe(obligations.length);
		expect(new Set(ids).size).toBe(ids.length);

		const declared = new Set(ids);
		const expected = expectedSurfaces();
		const missing = [...expected].filter((id) => !declared.has(id));
		const stale = [...declared].filter((id) => !expected.has(id));
		expect(missing).toEqual([]);
		expect(stale).toEqual([]);
	});

	it("keeps every obligation honest about its owning test", () => {
		const catalog = readCatalog();
		const obligations = catalog.obligations as RawObligation[];
		const problems: string[] = [];
		const allowedStates = new Set(["covered", "partial", "uncovered", "excluded"]);
		for (const obligation of obligations) {
			const { id, kind, path: filePath, state, owner, reason } = obligation;
			if (typeof id !== "string" || typeof filePath !== "string" || (kind !== "frontend" && kind !== "go")) {
				problems.push(`malformed entry: ${JSON.stringify(obligation)}`);
				continue;
			}
			if (id !== `${kind}:${filePath}`) problems.push(`id does not match path: ${id}`);
			if (typeof state !== "string" || !allowedStates.has(state)) {
				problems.push(`unknown state for ${id}: ${String(state)}`);
				continue;
			}
			if (state === "excluded") {
				if (typeof reason !== "string" || !reason.trim()) problems.push(`excluded without reason: ${id}`);
				if (owner !== undefined) problems.push(`excluded entries must not claim an owner: ${id}`);
				continue;
			}
			if (state === "uncovered") {
				if (owner !== undefined) problems.push(`uncovered entries must not claim an owner: ${id}`);
				continue;
			}
			if (typeof owner !== "string" || !owner.trim()) {
				problems.push(`${state} without an owner: ${id}`);
				continue;
			}
			const ownerPath = path.join(repoRoot, owner);
			if (!fs.existsSync(ownerPath)) {
				problems.push(`owner does not exist: ${id} -> ${owner}`);
				continue;
			}
			if (kind === "frontend" && !/\.(spec|unit\.spec|bench)\.ts$/.test(owner)) {
				problems.push(`frontend owner is not a vitest spec: ${id} -> ${owner}`);
			}
			if (kind === "go") {
				if (!owner.endsWith("_test.go")) problems.push(`go owner is not a test file: ${id} -> ${owner}`);
				if (path.posix.dirname(owner) !== path.posix.dirname(filePath)) {
					problems.push(`go owner is outside the package: ${id} -> ${owner}`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	it("fails when the committed inventory is stale", () => {
		const result = spawnSync(process.execPath, ["scripts/lab-inventory.mjs", "--check"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});
});
