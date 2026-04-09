import fs from "fs";
import path from "path";
import type {
	BenchmarkBaselineEntry,
	BenchmarkCaseResult,
	BenchmarkCliOptions,
} from "./core-types";
import { DEFAULT_THRESHOLDS, ensureDir, writeJson } from "./core-utils";

const BASELINE_DIR = path.join(process.cwd(), "tests", "e2e", "benchmarks", "baselines");
const BASELINE_FILE = path.join(BASELINE_DIR, "benchmark-baseline.json");
const VERSION = "v2";

interface BenchmarkBaselineFile {
	version: string;
	generatedAt: string;
	entries: BenchmarkBaselineEntry[];
}

const loadBaselineFile = (): BenchmarkBaselineFile | null => {
	if (!fs.existsSync(BASELINE_FILE)) return null;
	return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as BenchmarkBaselineFile;
};

const toBaselineEntry = (result: BenchmarkCaseResult): BenchmarkBaselineEntry => ({
	version: VERSION,
	runMode: result.runMode,
	environment: result.environment,
	caseId: result.id,
	category: result.category,
	shape: result.shape,
	scale: result.scale,
	aggregates: result.aggregate.numeric,
	booleanChecks: result.aggregate.boolean,
	thresholds: DEFAULT_THRESHOLDS,
});

const buildBaselineKey = (entry: {
	runMode: string;
	environment: string;
	caseId: string;
	shape: string;
	scale: number | null;
}) => `${entry.runMode}::${entry.environment}::${entry.caseId}::${entry.shape}::${entry.scale ?? "na"}`;

const findBaselineEntry = (result: BenchmarkCaseResult) => {
	const file = loadBaselineFile();
	if (!file) return undefined;
	const key = buildBaselineKey(result);
	return file.entries.find((entry) => buildBaselineKey(entry) === key);
};

const updateBaselineFile = (results: BenchmarkCaseResult[], options: BenchmarkCliOptions) => {
	const previous = loadBaselineFile();
	const existing = new Map<string, BenchmarkBaselineEntry>();
	for (const entry of previous?.entries || []) {
		existing.set(buildBaselineKey(entry), entry);
	}

	for (const result of results) {
		existing.set(buildBaselineKey(result), toBaselineEntry(result));
	}

	const nextFile: BenchmarkBaselineFile = {
		version: VERSION,
		generatedAt: new Date().toISOString(),
		entries: Array.from(existing.values()).sort((a, b) =>
			buildBaselineKey(a).localeCompare(buildBaselineKey(b))
		),
	};

	ensureDir(BASELINE_DIR);
	writeJson(BASELINE_FILE, nextFile);
	console.log(
		`[benchmark] baseline updated (${results.length} cases, mode=${options.mode}) -> ${BASELINE_FILE}`
	);
};

export { BASELINE_FILE, findBaselineEntry, loadBaselineFile, updateBaselineFile };
