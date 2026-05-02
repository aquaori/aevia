import path from "path";
import type { EnvironmentId, ExternalConfig, RunMode, SuiteId } from "./types";

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

export const parseConfig = (argv: string[]): ExternalConfig => {
	const args = new Map<string, string>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const [key, value] = arg.slice(2).split("=");
		args.set(key, value ?? "true");
	}

	const suite = (args.get("suite") || "correctness-smoke") as SuiteId;
	const mode = (args.get("mode") || "headless") as RunMode;
	const scales = parseList(args.get("scales")).map(Number).filter(Number.isFinite);
	const isPerformance = suite === "performance-external";
	const environment = (args.get("environment") || "gpu_cpuHigh") as EnvironmentId;
	const gpu = environment.startsWith("noGpu") || args.get("gpu") === "off" ? "off" : "on";
	const cpuThrottle = environment.endsWith("cpuLow") ? 4 : 1;

	return {
		apiUrl: process.env.VITE_API_URL || "http://localhost:4646",
		wsUrl: process.env.VITE_WS_URL || "ws://localhost:4646/ws",
		frontendUrl: process.env.VITE_FRONTEND_URL || "http://localhost:5173",
		reportDir:
			args.get("report-dir") ||
			path.join(process.cwd(), "tests", "e2e", "external", "reports", "latest"),
		mode,
		suite,
		scales: scales.length > 0 ? scales : [1000, 50000, 100000],
		runs: Math.max(1, Number(args.get("runs") || (isPerformance ? "3" : "1"))),
		warmup: Math.max(0, Number(args.get("warmup") || (isPerformance ? "1" : "0"))),
		matrix: args.get("matrix") ? args.get("matrix") !== "false" : isPerformance,
		environment,
		cpuThrottle: Math.max(1, Number(args.get("cpu-throttle") || String(cpuThrottle))),
		gpu,
	};
};

export const dateTag = () => new Date().toISOString().replace(/[:.]/g, "-");
