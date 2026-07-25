import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

type Step = {
	title: string;
	description: string;
	command: string;
	cwd?: string;
	streamOutput?: boolean;
};

type ExternalMode = "headless" | "headed";
type Profile = "standard" | "boundary-small" | "boundary-full" | "nightly" | "custom";

type Answers = {
	profile: Profile;
	mode: ExternalMode;
	runs: number;
	warmup: number;
	matrix: boolean;
	includeBuild: boolean;
	includeUnit: boolean;
	includeIntegration: boolean;
	includeBrowser: boolean;
	includeSmoke: boolean;
	includeStandardBenchmark: boolean;
	includeResilience: boolean;
	includeBoundary: boolean;
	includeReport: boolean;
	boundaryScales: string;
	concurrencyLevels: string;
	latencies: string;
	seedTimeoutMs: number;
	boundaryPointsPerStroke: number;
};

const rootDir = process.cwd();
const frontendDir = path.join(rootDir, "apps", "frontend");
const startedAt = Date.now();
const spinnerFrames = ["-", "\\", "|", "/"];

const dateTag = () => new Date().toISOString().replace(/[:.]/g, "-");
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const formatDuration = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const print = (message = "") => process.stdout.write(`${message}\n`);

const argValue = (name: string) => {
	const prefix = `--${name}=`;
	return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const hasArg = (name: string) => process.argv.includes(`--${name}`);

const ask = async (rl: readline.Interface, question: string, defaultValue: string) => {
	const answer = (await rl.question(`${question} [${defaultValue}]: `)).trim();
	return answer || defaultValue;
};

const askYesNo = async (rl: readline.Interface, question: string, defaultValue: boolean) => {
	const answer = (await ask(rl, `${question} (${defaultValue ? "Y/n" : "y/N"})`, defaultValue ? "y" : "n")).toLowerCase();
	return answer === "y" || answer === "yes";
};

const askNumber = async (rl: readline.Interface, question: string, defaultValue: number) => {
	const answer = Number(await ask(rl, question, String(defaultValue)));
	return Number.isFinite(answer) && answer >= 0 ? answer : defaultValue;
};

const normalizeProfile = (value: string | undefined): Profile => {
	if (
		value === "standard" ||
		value === "boundary-small" ||
		value === "boundary-full" ||
		value === "nightly" ||
		value === "custom"
	) {
		return value;
	}
	return "standard";
};

const presetAnswers = (profile: Profile): Answers => ({
	profile,
	mode: "headless",
	runs: 3,
	warmup: 1,
	matrix: profile === "nightly",
	includeBuild: profile !== "custom",
	includeUnit: profile !== "custom",
	includeIntegration: profile !== "custom",
	includeBrowser: profile !== "custom",
	includeSmoke: profile !== "custom",
	includeStandardBenchmark: profile === "standard" || profile === "boundary-small" || profile === "boundary-full" || profile === "nightly",
	includeResilience: profile === "nightly",
	includeBoundary: profile === "boundary-small" || profile === "boundary-full" || profile === "nightly",
	includeReport: true,
	boundaryScales: profile === "boundary-small" ? "10000,50000" : "100000,250000,500000,1000000,2000000,5000000",
	concurrencyLevels: profile === "boundary-small" ? "5,10" : "10,25,50,100",
	latencies: "200,1000,3000",
	seedTimeoutMs: 600000,
	boundaryPointsPerStroke: 2048,
});

const collectAnswers = async (): Promise<Answers> => {
	const nonInteractiveProfile = argValue("profile");
	if (nonInteractiveProfile || hasArg("yes")) {
		const profile = normalizeProfile(nonInteractiveProfile);
		return {
			...presetAnswers(profile),
			mode: (argValue("mode") as ExternalMode) || "headless",
			runs: Number(argValue("runs") || presetAnswers(profile).runs),
			warmup: Number(argValue("warmup") || presetAnswers(profile).warmup),
			matrix: argValue("matrix") ? argValue("matrix") !== "false" : presetAnswers(profile).matrix,
			boundaryScales: argValue("boundary-scales") || presetAnswers(profile).boundaryScales,
			concurrencyLevels: argValue("concurrency-levels") || presetAnswers(profile).concurrencyLevels,
			latencies: argValue("latencies") || presetAnswers(profile).latencies,
			seedTimeoutMs: Number(argValue("seed-timeout-ms") || presetAnswers(profile).seedTimeoutMs),
			boundaryPointsPerStroke: Number(argValue("boundary-points-per-stroke") || presetAnswers(profile).boundaryPointsPerStroke),
		};
	}

	const rl = readline.createInterface({ input, output });
	try {
		print("");
		print("Aevia Test System");
		print("=".repeat(48));
		print("Choose a profile, then adjust the execution details.");
		print("");
		print("1. standard       build + unit/integration/browser + smoke + standard benchmark");
		print("2. boundary-small standard + small boundary sanity run");
		print("3. boundary-full  standard + full boundary run, single environment");
		print("4. nightly        standard + resilience + boundary matrix across 4 environments");
		print("5. custom         choose every test group manually");
		const profileAnswer = await ask(rl, "Profile", "1");
		const profileMap: Record<string, Profile> = {
			"1": "standard",
			"2": "boundary-small",
			"3": "boundary-full",
			"4": "nightly",
			"5": "custom",
		};
		const profile = profileMap[profileAnswer] || normalizeProfile(profileAnswer);
		const answers = presetAnswers(profile);

		const modeAnswer = await ask(rl, "Browser mode: headless/headed", answers.mode);
		answers.mode = modeAnswer === "headed" ? "headed" : "headless";
		answers.runs = await askNumber(rl, "Measured runs for sampled external cases", answers.runs);
		answers.warmup = await askNumber(rl, "Warmup runs for sampled external cases", answers.warmup);

		if (profile === "custom") {
			answers.includeBuild = await askYesNo(rl, "Run build", true);
			answers.includeUnit = await askYesNo(rl, "Run unit tests", true);
			answers.includeIntegration = await askYesNo(rl, "Run integration/module tests", true);
			answers.includeBrowser = await askYesNo(rl, "Run browser component tests", true);
			answers.includeSmoke = await askYesNo(rl, "Run external smoke", true);
			answers.includeStandardBenchmark = await askYesNo(rl, "Run standard external benchmark", true);
			answers.includeResilience = await askYesNo(rl, "Run network resilience cases", false);
			answers.includeBoundary = await askYesNo(rl, "Run boundary cases", false);
			answers.includeReport = await askYesNo(rl, "Aggregate report at the end", true);
		}

		if (answers.includeStandardBenchmark || answers.includeResilience || answers.includeBoundary) {
			answers.matrix = await askYesNo(rl, "Run 4 environment matrix (GPU on/off x CPU high/throttled)", answers.matrix);
		}
		if (answers.includeBoundary) {
			answers.boundaryScales = await ask(rl, "Boundary scales", answers.boundaryScales);
			answers.concurrencyLevels = await ask(rl, "Boundary concurrency levels", answers.concurrencyLevels);
			answers.seedTimeoutMs = await askNumber(rl, "Boundary data injection timeout ms", answers.seedTimeoutMs);
			answers.boundaryPointsPerStroke = await askNumber(rl, "Boundary points per injected stroke", answers.boundaryPointsPerStroke);
		}
		if (answers.includeResilience) {
			answers.latencies = await ask(rl, "Network latency levels (ms)", answers.latencies);
		}

		return answers;
	} finally {
		rl.close();
	}
};

const runStep = (step: Step, index: number, total: number) =>
	new Promise<void>((resolve, reject) => {
		const stepStartedAt = Date.now();
		const tail: string[] = [];
		let spinnerIndex = 0;
		print("");
		print(`[${index}/${total}] ${step.title}`);
		print(`    ${step.description}`);
		const timer = setInterval(() => {
			const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
			spinnerIndex += 1;
			process.stdout.write(`\r    ${frame} running ${formatDuration(Date.now() - stepStartedAt)} `);
		}, 200);

		const child = spawn(step.command, {
			cwd: step.cwd || rootDir,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0" },
		});

		const collect = (chunk: Buffer, isError = false) => {
			for (const line of chunk.toString().split(/\r?\n/)) {
				if (!line.trim()) continue;
				if (step.streamOutput) {
					process.stdout.write(`\r${" ".repeat(100)}\r`);
					print(`    ${line}`);
				}
				tail.push(`${isError ? "stderr" : "stdout"}: ${line}`);
				if (tail.length > 30) tail.shift();
			}
		};

		child.stdout?.on("data", (chunk) => collect(chunk));
		child.stderr?.on("data", (chunk) => collect(chunk, true));
		child.on("error", (error) => {
			clearInterval(timer);
			process.stdout.write(`\r${" ".repeat(100)}\r`);
			reject(error);
		});
		child.on("close", (code) => {
			clearInterval(timer);
			process.stdout.write(`\r${" ".repeat(100)}\r`);
			if (code === 0) {
				print(`    ✓ completed in ${formatDuration(Date.now() - stepStartedAt)}`);
				resolve();
				return;
			}
			print(`    ✕ failed in ${formatDuration(Date.now() - stepStartedAt)} (exit ${code})`);
			if (!step.streamOutput && tail.length > 0) {
				print("    last output:");
				for (const line of tail) print(`      ${line}`);
			}
			reject(new Error(`${step.title} failed with exit code ${code}`));
		});
	});

const externalCommand = (answers: Answers, caseSet: "standard" | "resilience" | "boundary", reportDir: string) => {
	const parts = [
		"npx tsx tests/e2e/external/runner.ts",
		"--suite=performance-external",
		`--case-set=${caseSet}`,
		`--mode=${answers.mode}`,
		"--reporter=json",
		`--report-dir="${reportDir}"`,
		`--matrix=${answers.matrix ? "true" : "false"}`,
		`--runs=${answers.runs}`,
		`--warmup=${answers.warmup}`,
	];
	if (caseSet === "boundary") {
		parts.push(`--boundary-scales=${answers.boundaryScales}`);
		parts.push(`--concurrency-levels=${answers.concurrencyLevels}`);
		parts.push(`--seed-timeout-ms=${answers.seedTimeoutMs}`);
		parts.push(`--boundary-points-per-stroke=${answers.boundaryPointsPerStroke}`);
	}
	if (caseSet === "resilience") {
		parts.push(`--latencies=${answers.latencies}`);
	}
	return parts.join(" ");
};

const buildSteps = (answers: Answers): Step[] => {
	const steps: Step[] = [];
	const externalReportDir = path.join(
		frontendDir,
		"tests",
		"e2e",
		"external",
		"reports",
		"latest",
		dateTag()
	);
	if (answers.includeBuild) {
		steps.push({
			title: "Prepare build artifacts",
			description: "Building backend placeholder and frontend production bundle with detailed output hidden.",
			command: "npm --silent run build",
		});
	}
	if (answers.includeUnit) {
		steps.push({ title: "Unit tests", description: "Running shared, backend, and frontend unit suites.", command: "npm --silent run test:unit" });
	}
	if (answers.includeIntegration) {
		steps.push({ title: "Integration and module tests", description: "Running backend HTTP integration and frontend module suites.", command: "npm --silent run test:integration" });
	}
	if (answers.includeBrowser) {
		steps.push({ title: "Browser component tests", description: "Running Vitest browser tests in Chromium.", command: "npm --silent run test:browser" });
	}
	if (answers.includeSmoke) {
		steps.push({
			title: "External smoke",
			description: "Checking frontend/backend/WebSocket/canvas external observation path.",
			command: `npx tsx tests/e2e/external/runner.ts --suite=correctness-smoke --mode=${answers.mode} --reporter=json --report-dir="${externalReportDir}"`,
			cwd: frontendDir,
			streamOutput: true,
		});
	}
	if (answers.includeStandardBenchmark) {
		steps.push({
			title: "External standard benchmark",
			description: "Running full-render and first-pixel performance cases.",
			command: externalCommand(answers, "standard", externalReportDir),
			cwd: frontendDir,
			streamOutput: true,
		});
	}
	if (answers.includeResilience) {
		steps.push({
			title: "External resilience cases",
			description: `Running network recovery cases with latencies=${answers.latencies}.`,
			command: externalCommand(answers, "resilience", externalReportDir),
			cwd: frontendDir,
			streamOutput: true,
		});
	}
	if (answers.includeBoundary) {
		steps.push({
			title: "External boundary cases",
			description: `Running boundary cases with scales=${answers.boundaryScales}, concurrency=${answers.concurrencyLevels}.`,
			command: externalCommand(answers, "boundary", externalReportDir),
			cwd: frontendDir,
			streamOutput: true,
		});
	}
	if (answers.includeReport) {
		steps.push({ title: "Aggregate report", description: "Writing the latest combined HTML/JSON report.", command: "npm --silent run test:report" });
	}
	return steps;
};

const main = async () => {
	const answers = await collectAnswers();
	const steps = buildSteps(answers);

	print("");
	print("Execution summary");
	print("=".repeat(48));
	print(`profile=${answers.profile} mode=${answers.mode} runs=${answers.runs} warmup=${answers.warmup} matrix=${answers.matrix}`);
	if (answers.includeBoundary) {
		print(`boundary seedTimeoutMs=${answers.seedTimeoutMs} pointsPerStroke=${answers.boundaryPointsPerStroke}`);
	}
	print(`steps=${steps.length}`);
	print("Detailed build/test tool output is hidden unless a step fails.");

	try {
		for (const [index, step] of steps.entries()) {
			await runStep(step, index + 1, steps.length);
		}
		print("");
		print(`✓ workflow completed in ${elapsed()}`);
		print(`Report: ${path.join(rootDir, "tests", "reports", "summary", "latest", "test-report.html")}`);
	} catch (error: unknown) {
		print("");
		print(`✕ workflow failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
};

void main();
