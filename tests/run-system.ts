import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

type Step = {
	title: string;
	description: string;
	command: string;
	cwd?: string;
	streamOutput?: boolean;
	failureReport?: string;
	requiresServices?: boolean;
};

type ManagedService = {
	name: string;
	child: ChildProcess;
	tail: string[];
};

type ExternalServices = {
	frontendUrl: string;
	apiUrl: string;
	wsUrl: string;
	stop: () => Promise<void>;
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
	scales: string;
	boundaryScales: string;
	concurrencyLevels: string;
	latencies: string;
	seedTimeoutMs: number;
	boundaryPointsPerStroke: number;
};

const rootDir = process.cwd();
const canonicalRootDir = realpathSync(rootDir);
const frontendDir = path.join(canonicalRootDir, "apps", "frontend");
const backendDir = path.join(canonicalRootDir, "apps", "backend");
const testTempDir = path.join(canonicalRootDir, "tests", ".tmp");
const startedAt = Date.now();
const spinnerFrames = ["-", "\\", "|", "/"];
let activeExternalServices: ExternalServices | undefined;

const dateTag = () => new Date().toISOString().replace(/[:.]/g, "-");
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const formatDuration = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const print = (message = "") => process.stdout.write(`${message}\n`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const findAvailablePort = (preferredPort = 0) =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(preferredPort, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Unable to allocate a local test port"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});

const resolveServicePort = async (envName: string) => {
	const configured = process.env[envName];
	if (!configured) return findAvailablePort();
	const port = Number(configured);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${envName} must be a valid TCP port`);
	}
	return findAvailablePort(port);
};

const startManagedService = (
	name: string,
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv }
): ManagedService => {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const service: ManagedService = { name, child, tail: [] };
	const collect = (chunk: Buffer, source: "stdout" | "stderr") => {
		for (const line of chunk.toString().split(/\r?\n/)) {
			if (!line.trim()) continue;
			service.tail.push(`${source}: ${line}`);
			if (service.tail.length > 30) service.tail.shift();
		}
	};
	child.stdout?.on("data", (chunk) => collect(chunk, "stdout"));
	child.stderr?.on("data", (chunk) => collect(chunk, "stderr"));
	child.on("error", (error) => {
		service.tail.push(`error: ${error.message}`);
	});
	return service;
};

const serviceFailure = (service: ManagedService) => {
	const output = service.tail.length > 0
		? `\n${service.tail.map((line) => `      ${line}`).join("\n")}`
		: "";
	return new Error(`${service.name} exited before becoming ready${output}`);
};

const waitForService = async (
	url: string,
	name: string,
	services: ManagedService[],
	timeoutMs = 90000
) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const service of services) {
			if (service.child.exitCode !== null || service.child.signalCode !== null) {
				throw serviceFailure(service);
			}
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return;
		} catch {
			// Service is still starting.
		}
		await sleep(250);
	}
	const tails = services.flatMap((service) =>
		service.tail.map((line) => `      ${service.name} ${line}`)
	);
	throw new Error(
		`${name} did not become ready at ${url}${tails.length > 0 ? `\n${tails.join("\n")}` : ""}`
	);
};

const stopManagedService = async (service: ManagedService) => {
	const pid = service.child.pid;
	if (!pid || service.child.exitCode !== null || service.child.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 3000);
		timer.unref();
		service.child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	service.child.kill("SIGTERM");
	await closed;
	service.child.stdout?.destroy();
	service.child.stderr?.destroy();
	service.child.unref();
};

const startExternalServices = async (): Promise<ExternalServices> => {
	mkdirSync(testTempDir, { recursive: true });
	mkdirSync(path.join(canonicalRootDir, ".cache", "go-build"), { recursive: true });
	mkdirSync(path.join(canonicalRootDir, ".cache", "go-mod"), { recursive: true });

	const backendPort = await resolveServicePort("AEVIA_TEST_BACKEND_PORT");
	let frontendPort = await resolveServicePort("AEVIA_TEST_FRONTEND_PORT");
	if (frontendPort === backendPort) {
		if (process.env.AEVIA_TEST_FRONTEND_PORT) {
			throw new Error("AEVIA_TEST_FRONTEND_PORT and AEVIA_TEST_BACKEND_PORT must differ");
		}
		frontendPort = await findAvailablePort();
	}
	const frontendUrl = `http://127.0.0.1:${frontendPort}`;
	const apiUrl = `http://127.0.0.1:${backendPort}`;
	const wsUrl = `ws://127.0.0.1:${backendPort}/ws`;
	const databasePath = path.join(testTempDir, `aevia-system-${process.pid}.sqlite`);
	const backendExecutable = path.join(
		testTempDir,
		`aevia-backend-${process.pid}${process.platform === "win32" ? ".exe" : ""}`
	);
	const goEnv = {
		...process.env,
		GOCACHE: process.env.GOCACHE || path.join(canonicalRootDir, ".cache", "go-build"),
		GOMODCACHE: process.env.GOMODCACHE || path.join(canonicalRootDir, ".cache", "go-mod"),
	};
	const backendBuild = spawnSync(
		"go",
		["build", "-o", backendExecutable, "./cmd/aevia-backend"],
		{
			cwd: backendDir,
			env: goEnv,
			encoding: "utf8",
			timeout: 90000,
			windowsHide: true,
		}
	);
	if (backendBuild.error || backendBuild.status !== 0) {
		rmSync(backendExecutable, { force: true });
		throw new Error(
			`Unable to build the isolated test backend: ${backendBuild.error?.message || backendBuild.stderr || `exit ${backendBuild.status}`}`
		);
	}

	const backend = startManagedService("backend", backendExecutable, [], {
		cwd: backendDir,
		env: {
			...goEnv,
			HOST: "127.0.0.1",
			PORT: String(backendPort),
			DB_PATH: databasePath,
			LOG_FORMAT: "console",
			HTTP_REQUESTS_PER_SECOND: "5000",
			HTTP_REQUESTS_BURST: "10000",
			WS_RELIABLE_PER_SECOND: "5000",
			WS_RELIABLE_BURST: "10000",
		},
	});
	const frontend = startManagedService(
		"frontend",
		process.execPath,
		[
			path.join(canonicalRootDir, "node_modules", "vite", "bin", "vite.js"),
			"--force",
			"--host",
			"127.0.0.1",
			"--port",
			String(frontendPort),
			"--strictPort",
		],
		{
			cwd: frontendDir,
			env: {
				...process.env,
				BROWSERSLIST_IGNORE_OLD_DATA: "1",
				VITE_API_URL: apiUrl,
				VITE_WS_URL: wsUrl,
			},
		}
	);
	const managedServices = [frontend, backend];
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await Promise.all(managedServices.map(stopManagedService));
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				rmSync(`${databasePath}${suffix}`, { force: true });
			} catch {
				// A force-killed Windows process can release SQLite handles asynchronously.
			}
		}
		rmSync(backendExecutable, { force: true });
		try {
			rmdirSync(testTempDir);
		} catch {
			// Other test runs may still own files in this directory.
		}
	};
	const services = { frontendUrl, apiUrl, wsUrl, stop };
	activeExternalServices = services;

	try {
		await waitForService(`${apiUrl}/health/ready`, "backend", managedServices);
		await waitForService(frontendUrl, "frontend", managedServices);
		process.env.VITE_FRONTEND_URL = frontendUrl;
		process.env.VITE_API_URL = apiUrl;
		process.env.VITE_WS_URL = wsUrl;
		return services;
	} catch (error) {
		await stop();
		activeExternalServices = undefined;
		throw error;
	}
};

const stopExternalServices = async () => {
	if (!activeExternalServices) return;
	await activeExternalServices.stop();
	activeExternalServices = undefined;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void stopExternalServices().finally(() => {
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	});
}

const printVitestFailures = (reportPath: string) => {
	if (!existsSync(reportPath)) return false;
	try {
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
			testResults?: Array<{
				name?: string;
				status?: string;
				message?: string;
				assertionResults?: Array<{
					status?: string;
					fullName?: string;
					failureMessages?: string[];
				}>;
			}>;
		};
		const failed = (report.testResults ?? []).filter((result) => result.status === "failed");
		if (failed.length === 0) return false;
		print("    failure details:");
		for (const result of failed.slice(0, 12)) {
			const name = result.name
				? path.relative(canonicalRootDir, result.name).replaceAll("\\", "/")
				: "unknown test file";
			const assertions = (result.assertionResults ?? []).filter(
				(assertion) => assertion.status === "failed"
			);
			if (assertions.length === 0) {
				print(`      - ${name}`);
				for (const line of (result.message || "Unknown test module failure").split(/\r?\n/).slice(0, 8)) {
					print(`        ${line}`);
				}
				continue;
			}
			for (const assertion of assertions) {
				print(`      - ${assertion.fullName || name}`);
				const message = assertion.failureMessages?.find(Boolean);
				if (!message) continue;
				for (const line of message.split(/\r?\n/).slice(0, 8)) print(`        ${line}`);
			}
		}
		if (failed.length > 12) print(`      ... and ${failed.length - 12} more failed files`);
		return true;
	} catch {
		return false;
	}
};

const argValue = (name: string) => {
	const prefix = `--${name}=`;
	return [...process.argv].reverse().find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const hasArg = (name: string) => process.argv.includes(`--${name}`);

const argBoolean = (name: string, defaultValue: boolean) => {
	const value = argValue(name);
	return value === undefined ? defaultValue : value !== "false";
};

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
	scales: "10000,50000,100000",
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
		const preset = presetAnswers(profile);
		return {
			...preset,
			mode: (argValue("mode") as ExternalMode) || "headless",
			runs: Number(argValue("runs") || preset.runs),
			warmup: Number(argValue("warmup") || preset.warmup),
			matrix: argBoolean("matrix", preset.matrix),
			includeBuild: argBoolean("build", preset.includeBuild),
			includeUnit: argBoolean("unit", preset.includeUnit),
			includeIntegration: argBoolean("integration", preset.includeIntegration),
			includeBrowser: argBoolean("browser", preset.includeBrowser),
			includeSmoke: argBoolean("smoke", preset.includeSmoke),
			includeStandardBenchmark: argBoolean("benchmark", preset.includeStandardBenchmark),
			includeResilience: argBoolean("resilience", preset.includeResilience),
			includeBoundary: argBoolean("boundary", preset.includeBoundary),
			includeReport: argBoolean("report", preset.includeReport),
			scales: argValue("scales") || preset.scales,
			boundaryScales: argValue("boundary-scales") || preset.boundaryScales,
			concurrencyLevels: argValue("concurrency-levels") || preset.concurrencyLevels,
			latencies: argValue("latencies") || preset.latencies,
			seedTimeoutMs: Number(argValue("seed-timeout-ms") || preset.seedTimeoutMs),
			boundaryPointsPerStroke: Number(argValue("boundary-points-per-stroke") || preset.boundaryPointsPerStroke),
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
			if (step.failureReport) printVitestFailures(step.failureReport);
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
		`--scales=${answers.scales}`,
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
		steps.push({
			title: "Unit tests",
			description: "Running shared, backend, and frontend unit suites.",
			command: "npm --silent run test:unit",
			failureReport: path.join(rootDir, "tests", "reports", "vitest", "unit.json"),
		});
	}
	if (answers.includeIntegration) {
		steps.push({
			title: "Integration and module tests",
			description: "Running backend HTTP integration and frontend module suites.",
			command: "npm --silent run test:integration",
			failureReport: path.join(rootDir, "tests", "reports", "vitest", "integration.json"),
		});
	}
	if (answers.includeBrowser) {
		steps.push({
			title: "Browser component tests",
			description: "Running Vitest browser tests in Chromium.",
			command: "npm --silent run test:browser",
			failureReport: path.join(rootDir, "tests", "reports", "vitest", "browser.json"),
		});
	}
	if (answers.includeSmoke) {
		steps.push({
			title: "External smoke",
			description: "Checking frontend/backend/WebSocket/canvas external observation path.",
			command: `npx tsx tests/e2e/external/runner.ts --suite=correctness-smoke --mode=${answers.mode} --reporter=json --report-dir="${externalReportDir}"`,
			cwd: frontendDir,
			streamOutput: true,
			requiresServices: true,
		});
	}
	if (answers.includeStandardBenchmark) {
		steps.push({
			title: "External standard benchmark",
			description: "Running full-render and first-pixel performance cases.",
			command: externalCommand(answers, "standard", externalReportDir),
			cwd: frontendDir,
			streamOutput: true,
			requiresServices: true,
		});
	}
	if (answers.includeResilience) {
		steps.push({
			title: "External resilience cases",
			description: `Running network recovery cases with latencies=${answers.latencies}.`,
			command: externalCommand(answers, "resilience", externalReportDir),
			cwd: frontendDir,
			streamOutput: true,
			requiresServices: true,
		});
	}
	if (answers.includeBoundary) {
		steps.push({
			title: "External boundary cases",
			description: `Running boundary cases with scales=${answers.boundaryScales}, concurrency=${answers.concurrencyLevels}.`,
			command: externalCommand(answers, "boundary", externalReportDir),
			cwd: frontendDir,
			streamOutput: true,
			requiresServices: true,
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
			if (step.requiresServices && !activeExternalServices) {
				print("");
				print("[services] Starting isolated frontend and backend for external tests...");
				const services = await startExternalServices();
				print(`[services] frontend=${services.frontendUrl}`);
				print(`[services] api=${services.apiUrl}`);
			}
			await runStep(step, index + 1, steps.length);
		}
		print("");
		print(`✓ workflow completed in ${elapsed()}`);
		print(`Report: ${path.join(rootDir, "tests", "reports", "summary", "latest", "test-report.html")}`);
	} catch (error: unknown) {
		print("");
		print(`✕ workflow failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	} finally {
		await stopExternalServices();
	}
};

void main();
