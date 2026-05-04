import path from "path";
import type {
	EnvironmentId,
	ExternalConfig,
	FailOnPerformance,
	ReportFormat,
	RunMode,
	RunnerAction,
	SuiteId,
} from "./types";

try {
	(process as any).loadEnvFile();
} catch {
	// Optional on older Node versions.
}

const parseList = (value: string | undefined) =>
	value
		? value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
		: [];

const envValue = (...keys: string[]) => {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
};

export const parseConfig = (argv: string[]): ExternalConfig => {
	const args = new Map<string, string>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const [key, value] = arg.slice(2).split("=");
		args.set(key, value ?? "true");
	}

	const action = (args.get("action") || "run") as RunnerAction;
	const suite = (args.get("suite") || "correctness-smoke") as SuiteId;
	const mode = (args.get("mode") || "headless") as RunMode;
	const reportFormat = (args.get("reporter") || args.get("report-format") || "both") as ReportFormat;
	const scales = parseList(args.get("scales")).map(Number).filter(Number.isFinite);
	const isPerformance = suite === "performance-external";
	const environment = (args.get("environment") || "gpu_cpuHigh") as EnvironmentId;
	const gpu = environment.startsWith("noGpu") || args.get("gpu") === "off" ? "off" : "on";
	const cpuThrottle = environment.endsWith("cpuLow") ? 4 : 1;
	const externalRoot = path.join(process.cwd(), "tests", "e2e", "external");
	const baselineSource =
		args.get("baseline-source") ||
		args.get("source") ||
		envValue("npm_config_baseline_source", "npm_config_source", "BASELINE_SOURCE");
	const failOnPerformance = (args.get("fail-on-performance") || "confirmed") as FailOnPerformance;

	return {
		action,
		apiUrl: (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_API_URL ||
			"http://localhost:4646",
		wsUrl: process.env.VITE_WS_URL || "ws://localhost:4646/ws",
		frontendUrl: process.env.VITE_FRONTEND_URL || "http://localhost:5173",
		reportDir:
			args.get("report-dir") ||
			path.join(externalRoot, "reports", "latest"),
		reportFormat,
		mode,
		suite,
		scales: scales.length > 0 ? scales : [10000, 50000, 100000],
		runs: Math.max(1, Number(args.get("runs") || (isPerformance ? "3" : "1"))),
		warmup: Math.max(0, Number(args.get("warmup") || (isPerformance ? "1" : "0"))),
		matrix: args.get("matrix") ? args.get("matrix") !== "false" : isPerformance,
		environment,
		cpuThrottle: Math.max(1, Number(args.get("cpu-throttle") || String(cpuThrottle))),
		gpu,
		baselineFile:
			args.get("baseline-file") ||
			path.join(externalRoot, "baselines", `${suite}.baseline.json`),
		baselineSource,
		saveBaseline: args.get("save-baseline") === "true",
		budgetsFile: args.get("budgets-file") || path.join(externalRoot, "budgets.json"),
		historyFile:
			args.get("history-file") ||
			path.join(externalRoot, "history", `${suite}.history.jsonl`),
		noisePercent: Math.max(0, Number(args.get("noise-percent") || "10")),
		regressionPercent: Math.max(0, Number(args.get("regression-percent") || "20")),
		regressionAbsoluteMs: Math.max(0, Number(args.get("regression-absolute-ms") || "8")),
		learnWindow: Math.max(3, Number(args.get("learn-window") || "25")),
		learnMinSamples: Math.max(3, Number(args.get("learn-min-samples") || "8")),
		learnZScore: Math.max(0.5, Number(args.get("learn-z") || "3")),
		confirmWindow: Math.max(2, Number(args.get("confirm-window") || "3")),
		confirmMinFailures: Math.max(1, Number(args.get("confirm-min-failures") || "2")),
		stableImprovementRuns: Math.max(2, Number(args.get("stable-improvement-runs") || "5")),
		failOnPerformance,
		importCurrentToHistory: args.get("import-current-to-history") === "true",
	};
};

export const dateTag = () => new Date().toISOString().replace(/[:.]/g, "-");
