import type { CaseResult, EnvironmentId, ExternalConfig } from "./types";

const startedAt = performance.now();

const environmentLabelMap: Record<EnvironmentId, string> = {
	gpu_cpuHigh: "GPU on / CPU high",
	gpu_cpuLow: "GPU on / CPU throttled 4x",
	noGpu_cpuHigh: "GPU off / CPU high",
	noGpu_cpuLow: "GPU off / CPU throttled 4x",
};

const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;

const line = (icon: string, message: string) => {
	console.log(`${icon} [${elapsed()}] ${message}`);
};

export const describeEnvironment = (environment: EnvironmentId) =>
	environmentLabelMap[environment] || environment;

export const logRunHeader = (config: ExternalConfig) => {
	console.log("");
	console.log("Aevia external test runner");
	console.log("=".repeat(48));
	line("•", `suite=${config.suite} caseSet=${config.caseSet} mode=${config.mode}`);
	line("•", `scales=${config.scales.join(",")} boundaryScales=${config.boundaryScales.join(",")}`);
	line("•", `concurrency=${config.concurrencyLevels.join(",")} latencies=${config.latencies.join(",")}`);
	line("•", `caseTimeout=${config.caseTimeoutMs}ms seedTimeout=${config.seedTimeoutMs}ms boundaryPointsPerStroke=${config.boundaryPointsPerStroke}`);
	console.log("");
};

export const logEnvironment = (config: ExternalConfig, index?: number, total?: number) => {
	const progress = index && total ? ` (${index}/${total})` : "";
	line(
		"▶",
		`environment${progress}: ${describeEnvironment(config.environment)} / browser=${config.mode} / gpu=${config.gpu} / cpuThrottle=${config.cpuThrottle}`
	);
};

export const logCaseStart = (
	id: string,
	title?: string,
	description?: string,
	detail?: string
) => {
	line("▶", `${title || id}${detail ? ` | ${detail}` : ""}`);
	if (description) {
		line(" ", description);
	}
};

export const logCaseEnd = (result: CaseResult) => {
	const status = result.status === "passed" ? "✓" : "✕";
	const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
	line(status, `${result.id} ${result.status} (${duration})`);
};

export const logStep = (message: string) => {
	line("•", message);
};

export const logReport = (reportPath: string) => {
	line("✓", `report written: ${reportPath}`);
};
