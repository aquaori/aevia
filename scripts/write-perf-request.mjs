// File role: write the optional CI performance-gate request artifact without shell quoting hazards.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = process.argv[2];
if (!outputPath) {
	console.error("[lab] usage: node tests/lab/write-perf-request.mjs <output-path>");
	process.exit(2);
}

const payload = {
	schemaVersion: 1,
	requestedAt: new Date().toISOString(),
	reason: "ci-connectivity-only: performance gate requested separately",
	suites: ["performance-external"],
	cases: [],
};

mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
writeFileSync(path.resolve(outputPath), JSON.stringify(payload, null, 2), "utf8");
console.log(`[lab] performance gate request written: ${outputPath}`);
