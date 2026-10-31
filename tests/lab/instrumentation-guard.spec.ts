import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as labMarkNames from "../../apps/frontend/src/instrumentation/labMarkNames";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const frontendSourceRoot = path.join(projectRoot, "apps", "frontend", "src");
const instrumentationRoot = path.join(frontendSourceRoot, "instrumentation");
const scannedExtensions = new Set([".ts", ".tsx", ".vue", ".js"]);

const collectSourceFiles = (directory: string): string[] => {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(entryPath));
			continue;
		}
		if (entry.isFile() && scannedExtensions.has(path.extname(entry.name))) {
			files.push(entryPath);
		}
	}
	return files;
};

const isInsideInstrumentation = (filePath: string) => {
	const relative = path.relative(instrumentationRoot, filePath);
	return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const exportedNames = Object.entries(labMarkNames).filter(
	(entry): entry is [string, string] => typeof entry[1] === "string"
);

describe("lab instrumentation guard", () => {
	it("only the instrumentation modules publish performance marks", () => {
		const offenders = collectSourceFiles(frontendSourceRoot)
			.filter((filePath) => !isInsideInstrumentation(filePath))
			.filter((filePath) => fs.readFileSync(filePath, "utf8").includes("performance.mark("))
			.map((filePath) => path.relative(projectRoot, filePath));

		expect(offenders).toEqual([]);
	});

	it("exports aevia-prefixed, unique mark names", () => {
		expect(exportedNames.length).toBeGreaterThan(0);

		const unprefixed = exportedNames
			.filter(([, value]) => !value.startsWith("aevia."))
			.map(([key, value]) => `${key}=${value}`);
		expect(unprefixed).toEqual([]);

		const values = exportedNames.map(([, value]) => value);
		const duplicated = values.filter((value, index) => values.indexOf(value) !== index);
		expect(duplicated).toEqual([]);
	});
});
