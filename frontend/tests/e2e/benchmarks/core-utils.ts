import fs from "fs";
import path from "path";
import type {
	BenchmarkAggregate,
	BenchmarkDiffResult,
	BenchmarkRunSample,
	NumericAggregate,
} from "./core-types";

const DEFAULT_THRESHOLDS = {
	durationWarnPct: 15,
	durationFailPct: 25,
	fpsWarnPct: 10,
	fpsFailPct: 20,
};

const percentile = (values: number[], p: number) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
};

const aggregateNumbers = (values: number[]): NumericAggregate => {
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
			: (sorted[mid] ?? 0);
	return {
		min: sorted[0] ?? 0,
		median,
		mean: sorted.length ? sum / sorted.length : 0,
		p95: percentile(sorted, 95),
		max: sorted[sorted.length - 1] ?? 0,
	};
};

const aggregateSamples = (samples: BenchmarkRunSample[]): BenchmarkAggregate => {
	const passedSamples = samples.filter((sample) => sample.status === "passed");
	const numericBuckets = new Map<string, number[]>();
	const booleanBuckets = new Map<string, boolean[]>();
	const stringBuckets = new Map<string, string>();

	for (const sample of passedSamples) {
		for (const [key, value] of Object.entries(sample.metrics)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				numericBuckets.set(key, [...(numericBuckets.get(key) || []), value]);
			} else if (typeof value === "boolean") {
				booleanBuckets.set(key, [...(booleanBuckets.get(key) || []), value]);
			} else if (typeof value === "string") {
				stringBuckets.set(key, value);
			}
		}
	}

	return {
		numeric: Object.fromEntries(
			Array.from(numericBuckets.entries()).map(([key, values]) => [key, aggregateNumbers(values)])
		),
		boolean: Object.fromEntries(
			Array.from(booleanBuckets.entries()).map(([key, values]) => [key, values.every(Boolean)])
		),
		lastString: Object.fromEntries(stringBuckets.entries()),
		sampleCount: passedSamples.length,
		failureCount: samples.length - passedSamples.length,
	};
};

const compareWithBaseline = (
	aggregate: BenchmarkAggregate,
	baseline:
		| {
				aggregates: Record<string, NumericAggregate>;
				booleanChecks: Record<string, boolean>;
				thresholds?: typeof DEFAULT_THRESHOLDS;
		  }
		| undefined
): BenchmarkDiffResult => {
	if (!baseline) {
		return { status: "no-baseline", reasons: ["missing baseline"], metricDiffPct: {} };
	}

	const thresholds = baseline.thresholds || DEFAULT_THRESHOLDS;
	const reasons: string[] = [];
	const metricDiffPct: Record<string, number> = {};
	let status: BenchmarkDiffResult["status"] = "ok";

	for (const [key, current] of Object.entries(aggregate.numeric)) {
		const previous = baseline.aggregates[key];
		if (!previous || previous.median === 0) continue;
		const diffPct = ((current.median - previous.median) / previous.median) * 100;
		metricDiffPct[key] = Number(diffPct.toFixed(2));
		const lowerKey = key.toLowerCase();
		const isFpsMetric = lowerKey.includes("fps");
		const warnPct = isFpsMetric ? thresholds.fpsWarnPct : thresholds.durationWarnPct;
		const failPct = isFpsMetric ? thresholds.fpsFailPct : thresholds.durationFailPct;
		if (isFpsMetric) {
			if (diffPct <= -failPct) {
				status = "fail";
				reasons.push(`${key} median regressed ${diffPct.toFixed(2)}%`);
			} else if (diffPct <= -warnPct && status !== "fail") {
				status = "warn";
				reasons.push(`${key} median regressed ${diffPct.toFixed(2)}%`);
			}
			continue;
		}
		if (diffPct >= failPct) {
			status = "fail";
			reasons.push(`${key} median regressed +${diffPct.toFixed(2)}%`);
		} else if (diffPct >= warnPct && status !== "fail") {
			status = "warn";
			reasons.push(`${key} median regressed +${diffPct.toFixed(2)}%`);
		}
	}

	for (const [key, value] of Object.entries(aggregate.boolean)) {
		if (value === false) {
			status = "fail";
			reasons.push(`${key} boolean check failed`);
			continue;
		}
		if (baseline.booleanChecks[key] === false) continue;
	}

	return {
		status,
		reasons: reasons.length ? reasons : ["within baseline threshold"],
		metricDiffPct,
	};
};

const ensureDir = (dir: string) => {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
};

const writeJson = (filePath: string, value: unknown) => {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const formatDateTag = () => new Date().toISOString().replace(/[:.]/g, "-");

export {
	DEFAULT_THRESHOLDS,
	aggregateSamples,
	compareWithBaseline,
	ensureDir,
	formatDateTag,
	writeJson,
};
