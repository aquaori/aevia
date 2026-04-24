import path from "path";
import type { BenchmarkCliOptions, DatasetShape } from "./core-types";

const DEFAULT_SCALES = [10000, 50000, 100000];
const DEFAULT_SHAPES: DatasetShape[] = ["many-short-strokes"];

const parseList = (value: string | undefined) =>
	value
		? value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
		: null;

const parseCliOptions = (argv: string[]): BenchmarkCliOptions => {
	const argMap = new Map<string, string>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const [key, rawValue] = arg.slice(2).split("=");
		argMap.set(key, rawValue ?? "true");
	}

	const smoke = argMap.get("smoke") === "true";
	const mode = (argMap.get("mode") as BenchmarkCliOptions["mode"]) || "headless";
	const suites = parseList(argMap.get("suite"));
	const scales = (parseList(argMap.get("scales")) || DEFAULT_SCALES.map(String)).map((value) =>
		Number(value)
	);
	const shapes = ((parseList(argMap.get("shapes")) as DatasetShape[] | null) || DEFAULT_SHAPES).filter(
		Boolean
	);
	const runs = Number(argMap.get("runs") || (smoke ? 1 : 5));
	const warmup = Number(argMap.get("warmup") || (smoke ? 0 : 1));
	const caseTimeoutMs = Number(argMap.get("case-timeout-ms") || (smoke ? 120000 : 300000));
	const updateBaseline = argMap.get("update-baseline") === "true";
	const reportDir =
		argMap.get("report-dir") ||
		path.join(process.cwd(), "tests", "e2e", "benchmarks", "reports", "latest");

	return {
		mode,
		suites,
		scales,
		shapes,
		runs,
		warmup,
		caseTimeoutMs,
		updateBaseline,
		reportDir,
		smoke,
	};
};

export { DEFAULT_SCALES, DEFAULT_SHAPES, parseCliOptions };
