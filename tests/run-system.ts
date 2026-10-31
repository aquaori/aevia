import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { writeAggregateReport } from "./report/aggregate";
import { VALIDITY_CODES } from "./report/contract";
import type { LabMode, RunManifest, RunStep, ValidityReason } from "./report/contract";
import { readSourceIdentity } from "./report/provenance";
import { browserAvailability, selectedBrowser } from "./browser-launch";
import { CI_REQUIRED_EXTERNAL_CASE_IDS } from "./catalog/external-cases";
import { resolveOnlySelectors, resolveSinceRef, type LabResolveResult } from "./lab/resolve-only";
import { buildLabEvidencePlan, type LabPlanContext } from "./lab/evidence-plan";
import { isLiveConsoleEnabled, startLiveConsole, type LiveConsole } from "./lab/live-console";

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
type ManagedProfile = "quick" | "ci" | "full" | "smoke" | "nightly" | "single";
type Profile = ManagedProfile | "standard" | "boundary-small" | "boundary-full" | "custom";

type CoreProfile = "quick" | "ci" | "full";
const CORE_PROFILES: readonly CoreProfile[] = ["quick", "ci", "full"];
const MANAGED_PROFILES: readonly ManagedProfile[] = ["quick", "ci", "full", "smoke", "nightly", "single"];
const isManagedProfile = (value: Profile): value is ManagedProfile =>
	(MANAGED_PROFILES as readonly string[]).includes(value);
const isCoreProfile = (value: ManagedProfile): value is CoreProfile =>
	(CORE_PROFILES as readonly string[]).includes(value);

const managedModeOf = (profile: ManagedProfile): LabMode => {
	if (profile === "single") return "single";
	if (profile === "quick" || profile === "smoke") return "smoke";
	if (profile === "ci") return "ci";
	return "nightly";
};

type EvidenceStep = {
	id: string;
	title: string;
	description: string;
	command?: string;
	cwd?: string;
	timeoutMs?: number;
	stdoutArtifact?: string;
	env?: NodeJS.ProcessEnv;
	requiresServices?: boolean;
	/** Restart the isolated services with a brand-new SQLite file before this step. */
	freshServices?: boolean;
	action?: "source-check";
};

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
let activeServicesDbPath: string | undefined;
let activeTestProcess: ChildProcess | undefined;
let interruptedSignal: "SIGINT" | "SIGTERM" | undefined;
let activeLiveConsole: LiveConsole | undefined;

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
		detached: process.platform !== "win32",
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
	stopProcessTree(service.child);
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
	activeServicesDbPath = databasePath;
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

/**
 * Restart the isolated backend/frontend with a clean SQLite file. Multi-million-point
 * boundary seeding grows the database past the point where create-room starts failing
 * with HTTP 500, so the boundary step runs on a fresh store instead of inheriting the
 * accumulated rows of the correctness/performance steps.
 */
const resetExternalServices = async () => {
	const dbPath = activeServicesDbPath;
	await stopExternalServices();
	if (dbPath) {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				rmSync(`${dbPath}${suffix}`, { force: true });
			} catch {
				// Windows may still hold the file for a moment; the next start recreates it.
			}
		}
		print("    [services] resetting the isolated database for this step");
	}
	await startExternalServices();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		interruptedSignal = signal;
		if (activeTestProcess) stopProcessTree(activeTestProcess);
		void stopExternalServices();
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

const argValues = (name: string) => {
	const prefix = `--${name}=`;
	return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
};

const liveConsoleRequested = (mode: string) => {
	const raw = (argValue("live") || "").trim().toLowerCase();
	if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return false;
	if (raw === "on" || raw === "true" || raw === "1" || raw === "yes") return true;
	return isLiveConsoleEnabled(mode);
};

const liveConsoleOptions = () => ({
	port: Math.max(0, Number(argValue("live-port") || process.env.AEVIA_LIVE_PORT || 0)) || 0,
	open: hasArg("live-open") || process.env.AEVIA_LIVE_OPEN === "1",
	graceMs: Math.max(0, Number(argValue("live-grace-ms") || process.env.AEVIA_LIVE_GRACE_MS || 30_000)) || 0,
});

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
	if (!value) return "standard";
	if ((MANAGED_PROFILES as readonly string[]).includes(value)) return value as ManagedProfile;
	if (value === "standard" || value === "boundary-small" || value === "boundary-full" || value === "custom") return value;
	return "standard";
};

const presetAnswers = (profile: Profile): Answers => ({
	profile,
	mode: "headless",
	runs: 3,
	warmup: 1,
	matrix: profile === "nightly",
	includeBuild: profile !== "custom" && profile !== "quick",
	includeUnit: profile !== "custom",
	includeIntegration: profile !== "custom",
	includeBrowser: profile !== "custom" && profile !== "quick",
	includeSmoke: profile !== "custom" && profile !== "quick",
	includeStandardBenchmark: profile === "standard" || profile === "boundary-small" || profile === "boundary-full" || profile === "nightly",
	includeResilience: profile === "nightly",
	includeBoundary: profile === "boundary-small" || profile === "boundary-full" || profile === "nightly",
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
		activeLiveConsole?.stepStart(`legacy-${index}`);
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
			detached: process.platform !== "win32",
		});
		activeTestProcess = child;

		const collect = (chunk: Buffer, isError = false) => {
			for (const line of chunk.toString().split(/\r?\n/)) {
				if (!line.trim()) continue;
				if (step.streamOutput) {
					process.stdout.write(`\r${" ".repeat(100)}\r`);
					print(`    ${line}`);
				}
				tail.push(`${isError ? "stderr" : "stdout"}: ${line}`);
				if (tail.length > 30) tail.shift();
				activeLiveConsole?.log(`legacy-${index}`, line, isError ? "stderr" : "stdout");
			}
		};

		child.stdout?.on("data", (chunk) => collect(chunk));
		child.stderr?.on("data", (chunk) => collect(chunk, true));
		child.on("error", (error) => {
			clearInterval(timer);
			if (activeTestProcess === child) activeTestProcess = undefined;
			process.stdout.write(`\r${" ".repeat(100)}\r`);
			activeLiveConsole?.stepEnd({
				id: `legacy-${index}`,
				status: "failed",
				durationMs: Date.now() - stepStartedAt,
				error: error.message,
			});
			reject(error);
		});
		child.on("close", (code) => {
			clearInterval(timer);
			if (activeTestProcess === child) activeTestProcess = undefined;
			process.stdout.write(`\r${" ".repeat(100)}\r`);
			if (code === 0) {
				print(`    ✓ completed in ${formatDuration(Date.now() - stepStartedAt)}`);
				activeLiveConsole?.stepEnd({
					id: `legacy-${index}`,
					status: "passed",
					durationMs: Date.now() - stepStartedAt,
				});
				resolve();
				return;
			}
			print(`    ✕ failed in ${formatDuration(Date.now() - stepStartedAt)} (exit ${code})`);
			activeLiveConsole?.stepEnd({
				id: `legacy-${index}`,
				status: "failed",
				durationMs: Date.now() - stepStartedAt,
				error: `exited with code ${code}`,
			});
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
	return steps;
};

const shellQuote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;

const listCoverageSources = () => {
	const files: string[] = [];
	const extensions = new Set([".ts", ".tsx", ".vue"]);
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolutePath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(absolutePath);
			else if (
				entry.isFile() && extensions.has(path.extname(entry.name)) &&
				!entry.name.endsWith(".d.ts") && !entry.name.endsWith(".spec.ts")
			) files.push(absolutePath);
		}
	};
	for (const directory of ["apps/frontend/src", "packages/shared/src"]) {
		visit(path.join(canonicalRootDir, directory));
	}
	return files.sort();
};

const managedEvidencePlan = (profile: "quick" | "ci" | "full", runDir: string, runId: string, source: RunManifest["source"]) => {
	const frontendReport = path.join(runDir, "frontend", "vitest.json");
	const browserReport = path.join(runDir, "frontend", "browser.json");
	const coverageDir = path.join(runDir, "frontend", "coverage");
	const packageList = path.join(runDir, "backend", "packages.txt");
	const goTests = path.join(runDir, "backend", "go-tests.jsonl");
	const goCoverage = path.join(runDir, "backend", "coverage.out");
	const externalDir = path.join(runDir, "external");
	const quick = profile === "quick";
	const artifacts: RunManifest["expectedArtifacts"] = quick
		? [
			{ id: "feature-obligations", stepId: "catalog-check", kind: "feature-catalog", path: "catalog/feature-obligations.json" },
			{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" },
		]
		: [
			{ id: "feature-obligations", stepId: "go-test", kind: "feature-catalog", path: "catalog/feature-obligations.json" },
			{ id: "go-package-inventory", stepId: "go-package-list", kind: "package-list", path: "backend/packages.txt" },
			{ id: "go-test", stepId: "go-test", kind: "go-test", path: "backend/go-tests.jsonl" },
			{ id: "go-coverage", stepId: "go-test", kind: "go-coverage", path: "backend/coverage.out", expectedCases: [] },
			{ id: "frontend-vitest", stepId: "frontend-test", kind: "vitest", path: "frontend/vitest.json" },
			{
				id: "frontend-coverage",
				stepId: "frontend-test",
				kind: "coverage",
				path: "frontend/coverage/coverage-summary.json",
				expectedSources: listCoverageSources(),
			},
			{ id: "frontend-browser", stepId: "browser-test", kind: "vitest", path: "frontend/browser.json" },
			{
				id: "external-correctness",
				stepId: "external-e2e",
				kind: "external",
				path: "external/correctness-full-external-results.json",
				expectedCases: CI_REQUIRED_EXTERNAL_CASE_IDS,
			},
			{
				id: "external-correctness-gate",
				stepId: "external-e2e",
				kind: "lab-gate",
				path: "external/correctness-full-lab-gate.json",
			},
		];
	const steps: EvidenceStep[] = quick
		? [
			{
				id: "catalog-check",
				title: "Backend feature inventory",
				description: "Checking backend HTTP/WS/scene and frontend route/tool surfaces against the reviewed catalog.",
				command: "go test ./internal/gateway -run \"TestFeatureSurfaceCatalogMatchesBackendSources|TestCatalogSurfacePathsAreValidHTTPPatterns|TestV2PlaceholdersExplicitlyRejectUntilImplemented\" -count=1",
				cwd: backendDir,
				timeoutMs: 180000,
			},
			{
				id: "frontend-test",
				title: "Quick frontend and shared regression",
				description: "Running deterministic unit, module and test-harness checks.",
				command: `${shellQuote(process.execPath)} ${shellQuote(path.join(canonicalRootDir, "node_modules", "vitest", "vitest.mjs"))} run --project=shared-unit --project=frontend-unit --project=frontend-module --project=harness-unit --reporter=json --outputFile=${shellQuote(frontendReport)}`,
				cwd: canonicalRootDir,
				stdoutArtifact: undefined,
				timeoutMs: 180000,
			},
			{ id: "source-check", title: "Source identity check", description: "Confirming source files did not change during this run.", action: "source-check" },
		]
		: [
			{ id: "build", title: "Production build", description: "Building the backend and typechecking/building the frontend.", command: "npm --silent run build", timeoutMs: 300000 },
			{ id: "go-vet", title: "Go static analysis", description: "Running go vet across all backend packages.", command: "go vet ./...", cwd: backendDir, timeoutMs: 180000 },
			{
				id: "go-package-list",
				title: "Go package inventory",
				description: "Recording the exact backend packages required in this run.",
				command: "go list ./...",
				cwd: backendDir,
				stdoutArtifact: packageList,
				timeoutMs: 60000,
			},
			{
				id: "go-test",
				title: "Go tests and coverage",
				description: "Running every Go package once with cross-package statement coverage.",
				command: `go test -json -coverpkg=./... -coverprofile=${shellQuote(goCoverage)} ./...`,
				cwd: backendDir,
				stdoutArtifact: goTests,
				timeoutMs: 600000,
			},
			{
				id: "frontend-test",
				title: "Frontend and shared coverage tests",
				description: "Running unit, module and harness suites with source coverage.",
				command: `${shellQuote(process.execPath)} ${shellQuote(path.join(canonicalRootDir, "node_modules", "vitest", "vitest.mjs"))} run --project=shared-unit --project=frontend-unit --project=frontend-module --project=harness-unit --coverage --reporter=json --outputFile=${shellQuote(frontendReport)} --coverage.reportsDirectory=${shellQuote(coverageDir)}`,
				cwd: canonicalRootDir,
				timeoutMs: 600000,
			},
			{
				id: "browser-test",
				title: "Browser component tests",
				description: "Running the browser component project in an isolated Vitest process.",
				command: `${shellQuote(process.execPath)} ${shellQuote(path.join(canonicalRootDir, "node_modules", "vitest", "vitest.mjs"))} run --project=frontend-browser --reporter=json --outputFile=${shellQuote(browserReport)}`,
				cwd: canonicalRootDir,
				timeoutMs: 300000,
			},
			{
				id: "external-e2e",
				title: "External correctness E2E",
				description: "Running the CI-required correctness subset in the selected browser against isolated services.",
				command: `${shellQuote(process.execPath)} ${shellQuote(path.join(canonicalRootDir, "node_modules", "tsx", "dist", "cli.mjs"))} tests/e2e/external/runner.ts --suite=correctness-full --case-ids=${CI_REQUIRED_EXTERNAL_CASE_IDS.join(",")} --mode=headless --reporter=json --report-dir=${shellQuote(externalDir)}`,
				cwd: frontendDir,
				requiresServices: true,
				timeoutMs: 600000,
				env: {
					AEVIA_TEST_RUN_ID: runId,
					AEVIA_TEST_SOURCE_REVISION: source.revision || "",
					AEVIA_TEST_DIRTY_SHA256: source.dirtyPatchSha256,
				},
			},
			{ id: "source-check", title: "Source identity check", description: "Confirming source files did not change during this run.", action: "source-check" },
		];
	if (profile === "full") {
		steps.splice(steps.length - 1, 0,
			{
				id: "go-race",
				title: "Go race detector",
				description: "Running the backend suite with the Go race detector on this host and platform.",
				command: "go test -race ./...",
				cwd: backendDir,
				timeoutMs: 900000,
			},
			{
				id: "go-fuzz",
				title: "Scene payload fuzz smoke",
				description: "Fuzzing the public scene payload validator for 30 seconds with a bounded worker count.",
				command: "go test ./internal/gateway -run=^$ -fuzz=FuzzValidateScenePayloadNeverPanics -fuzztime=30s -parallel=2",
				cwd: backendDir,
				timeoutMs: 180000,
			}
		);
	}
	return { steps, artifacts };
};

const persistManifest = (manifestPath: string, manifest: RunManifest) => {
	const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), "utf8");
	renameSync(temporaryPath, manifestPath);
};

const stopProcessTree = (child: ChildProcess) => {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try { process.kill(-child.pid, "SIGTERM"); }
	catch { child.kill("SIGTERM"); }
	const pid = child.pid;
	const forceTimer = setTimeout(() => {
		try { process.kill(-pid, "SIGKILL"); } catch { /* Process already exited. */ }
	}, 2500);
	forceTimer.unref();
};

type RawGate = {
	status?: unknown;
	aborted?: unknown;
	cases?: unknown;
	reasons?: unknown;
};

const GATE_FILE_BY_STEP: Record<string, string> = {
	"external-smoke": "correctness-smoke-lab-gate.json",
	"external-e2e": "correctness-full-lab-gate.json",
	"external-performance": "performance-external-all-lab-gate.json",
	"external-focused": "correctness-full-lab-gate.json",
};

const readGateForStep = (runDir: string, stepId: string): RawGate | null => {
	const externalDir = path.join(runDir, "external");
	const expected = GATE_FILE_BY_STEP[stepId];
	const candidates = expected
		? [path.join(externalDir, expected)]
		: existsSync(externalDir)
			? readdirSync(externalDir).filter((name) => name.endsWith("-lab-gate.json")).map((name) => path.join(externalDir, name))
			: [];
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			return JSON.parse(readFileSync(filePath, "utf8")) as RawGate;
		} catch {
			return null;
		}
	}
	return null;
};

const validityCodeOf = (value: unknown, fallback: ValidityReason["code"]): ValidityReason["code"] =>
	typeof value === "string" && (VALIDITY_CODES as readonly string[]).includes(value) ? (value as ValidityReason["code"]) : fallback;

const applyGateValidity = (runDir: string, manifest: RunManifest, stepId: string, exitCode: number | null) => {
	const gate = readGateForStep(runDir, stepId);
	const aborted = gate?.aborted === true || gate?.status === "invalid" || exitCode === 3;
	if (!gate) {
		if (aborted) {
			manifest.validity = {
				status: "invalid",
				aborted: true,
				reasons: [{ scope: "run", id: manifest.runId, code: "GATE_ABORTED", detail: "external harness aborted without a gate artifact" }],
			};
			manifest.recorded = false;
		}
		return;
	}
	const reasons: ValidityReason[] = [];
	if (Array.isArray(gate.reasons)) {
		for (const raw of gate.reasons) {
			if (!raw || typeof raw !== "object") continue;
			const reason = raw as Record<string, unknown>;
			reasons.push({
				scope: reason.scope === "case" || reason.scope === "scenario" ? reason.scope : "run",
				id: typeof reason.id === "string" ? reason.id : manifest.runId,
				code: validityCodeOf(reason.code, "GATE_ABORTED"),
				detail: typeof reason.detail === "string" ? reason.detail : undefined,
			});
		}
	}
	const invalidCases = Array.isArray(gate.cases)
		? gate.cases.filter(
				(item): item is Record<string, unknown> =>
					Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).status === "invalid"
			)
		: [];
	if (aborted) {
		if (reasons.length === 0) {
			for (const invalidCase of invalidCases.slice(0, 50)) {
				reasons.push({
					scope: "case",
					id: typeof invalidCase.caseKey === "string" ? invalidCase.caseKey : manifest.runId,
					code: validityCodeOf(Array.isArray(invalidCase.codes) ? invalidCase.codes[0] : undefined, "GATE_ABORTED"),
					detail: Array.isArray(invalidCase.details) ? invalidCase.details.join("; ") : undefined,
				});
			}
		}
		manifest.validity = {
			status: "invalid",
			aborted: true,
			reasons: reasons.length > 0
				? reasons.slice(0, 50)
				: [{ scope: "run", id: manifest.runId, code: "GATE_ABORTED", detail: "external harness aborted" }],
		};
		manifest.recorded = false;
		return;
	}
	if (invalidCases.length > 0) {
		manifest.validity = {
			status: "degraded",
			aborted: false,
			reasons: invalidCases.slice(0, 50).map((invalidCase) => ({
				scope: "case" as const,
				id: typeof invalidCase.caseKey === "string" ? invalidCase.caseKey : manifest.runId,
				code: validityCodeOf(Array.isArray(invalidCase.codes) ? invalidCase.codes[0] : undefined, "MISSING_MARK"),
				detail: Array.isArray(invalidCase.details) ? invalidCase.details.join("; ") : undefined,
			})),
		};
	}
};

const runEvidenceStep = async (
	step: EvidenceStep,
	record: RunStep,
	manifest: RunManifest,
	manifestPath: string,
	runDir: string
) => {
	const startedAt = new Date();
	record.status = "running";
	record.startedAt = startedAt.toISOString();
	persistManifest(manifestPath, manifest);
	activeLiveConsole?.stepStart(step.id);
	const logPath = path.join(runDir, "logs", `${step.id}.log`);
	record.logPath = path.relative(runDir, logPath).replaceAll("\\", "/");
	let stdout = "";
	let stderr = "";
	let errorMessage: string | undefined;
	let exitCode: number | null = 0;
	let timedOut = false;

	try {
		if (step.action === "source-check") {
			const source = readSourceIdentity(canonicalRootDir);
			const addedUntracked = (source.untrackedFiles || []).filter((item) => !(manifest.source.untrackedFiles || []).includes(item));
			const removedUntracked = (manifest.source.untrackedFiles || []).filter((item) => !(source.untrackedFiles || []).includes(item));
			if (
				source.revision !== manifest.source.revision ||
				source.dirtyPatchSha256 !== manifest.source.dirtyPatchSha256
			) throw new Error([
				"Source revision or dirty-file fingerprint changed during the test run",
				`expected=${manifest.source.revision}/${manifest.source.dirtyPatchSha256}`,
				`actual=${source.revision}/${source.dirtyPatchSha256}`,
				addedUntracked.length ? `new untracked files: ${addedUntracked.join(", ")}` : "",
				removedUntracked.length ? `removed untracked files: ${removedUntracked.join(", ")}` : "",
			].filter(Boolean).join("; "));
		} else {
			if (step.freshServices) await resetExternalServices();
			else if (step.requiresServices && !activeExternalServices) await startExternalServices();
			const childEnv = { ...process.env, ...step.env, FORCE_COLOR: "0" };
			if (step.id === "browser-test") childEnv.AEVIA_TEST_BROWSER_PORT = String(await findAvailablePort());
			const child = spawn(step.command || "", {
				cwd: step.cwd || rootDir,
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
				windowsHide: true,
				detached: process.platform !== "win32",
			});
			activeTestProcess = child;
			const timeout = setTimeout(() => {
				timedOut = true;
				stopProcessTree(child);
			}, step.timeoutMs || 300000);
			child.stdout?.on("data", (chunk) => {
				const text = chunk.toString();
				stdout += text;
				activeLiveConsole?.log(step.id, text, "stdout");
			});
			child.stderr?.on("data", (chunk) => {
				const text = chunk.toString();
				stderr += text;
				activeLiveConsole?.log(step.id, text, "stderr");
			});
			try {
				exitCode = await new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code) => resolve(code));
				});
			} finally {
				clearTimeout(timeout);
				if (activeTestProcess === child) activeTestProcess = undefined;
			}
			if (exitCode !== 0) errorMessage = timedOut ? `Timed out after ${step.timeoutMs || 300000} ms` : `Process exited with code ${exitCode}`;
			if (step.stdoutArtifact) {
				mkdirSync(path.dirname(step.stdoutArtifact), { recursive: true });
				writeFileSync(step.stdoutArtifact, stdout, "utf8");
			}
		}
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error);
		exitCode = null;
	}

	mkdirSync(path.dirname(logPath), { recursive: true });
	writeFileSync(logPath, `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}${errorMessage ? `\n[runner] ${errorMessage}\n` : ""}`, "utf8");
	record.finishedAt = new Date().toISOString();
	record.durationMs = Date.now() - startedAt.getTime();
	record.exitCode = exitCode;
	record.status = interruptedSignal ? "cancelled" : errorMessage ? "failed" : "passed";
	if (errorMessage) record.error = errorMessage;
	persistManifest(manifestPath, manifest);
	activeLiveConsole?.stepEnd({
		id: step.id,
		status: record.status,
		durationMs: record.durationMs,
		error: record.error,
	});
	print(`    ${record.status === "passed" ? "✓" : "✕"} ${step.title} (${formatDuration(record.durationMs)})`);
	if (record.status !== "passed" && errorMessage) {
		for (const line of errorMessage.split(/\r?\n/)) print(`      ${line}`);
		for (const line of `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-20)) print(`      ${line}`);
	}
};

type ManagedRunOptions = {
	selection?: LabResolveResult;
	rerunOf?: { ofRunId: string; scope: "run" | "scenario" | "case"; ids: string[] };
};

const runEvidenceProfile = async (profile: ManagedProfile, options: ManagedRunOptions = {}) => {
	const runId = randomUUID();
	const runDir = path.join(canonicalRootDir, "tests", "reports", "summary", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	const source = readSourceIdentity(canonicalRootDir);
	const catalogSnapshot = path.join(runDir, "catalog", "feature-obligations.json");
	mkdirSync(path.dirname(catalogSnapshot), { recursive: true });
	writeFileSync(
		catalogSnapshot,
		readFileSync(path.join(canonicalRootDir, "tests", "catalog", "feature-obligations.json"), "utf8"),
		"utf8"
	);
	const cleanTree = source.dirtyPatchSha256 === createHash("sha256").update("").digest("hex");
	const planContext: LabPlanContext = {
		runDir,
		rootDir,
		frontendDir,
		backendDir,
		canonicalRootDir,
		shellQuote,
		listCoverageSources,
		externalEnv: {
			AEVIA_TEST_RUN_ID: runId,
			AEVIA_TEST_SOURCE_REVISION: source.revision || "",
			AEVIA_TEST_DIRTY_SHA256: source.dirtyPatchSha256,
			AEVIA_LAB: "on",
		},
		cleanTree,
		perfRequest: argValue("perf") === "request",
	};
	const { steps, artifacts } = isCoreProfile(profile)
		? managedEvidencePlan(profile, runDir, runId, source)
		: buildLabEvidencePlan(profile, planContext, options.selection);
	const mode = managedModeOf(profile);
	const recorded = profile !== "single" && options.rerunOf === undefined && (profile !== "nightly" || cleanTree);
	const manifest: RunManifest = {
		schemaVersion: 2,
		runId,
		profile,
		mode,
		status: "running",
		source,
		startedAt: new Date().toISOString(),
		expectedSteps: steps.map((step) => step.id),
		steps: steps.map((step) => ({ id: step.id, title: step.title, status: "pending" })),
		expectedArtifacts: artifacts,
		validity: { status: "valid", aborted: false, reasons: [] },
		recorded,
		rerun: options.rerunOf,
		measurement: { policy: "prefer-instrumented" },
	};
	const manifestPath = path.join(runDir, "run-manifest.json");
	persistManifest(manifestPath, manifest);
	print(`Run ${runId} · profile=${profile} · source=${source.revision}`);
	if (liveConsoleRequested(mode)) {
		try {
			activeLiveConsole = await startLiveConsole({
				runId,
				mode,
				profile,
				revision: source.revision || undefined,
				startedAt: manifest.startedAt,
				steps: steps.map((step) => ({ id: step.id, title: step.title })),
				runDir,
				print,
				...liveConsoleOptions(),
				onCancel: () => {
					if (interruptedSignal) return;
					interruptedSignal = "SIGTERM";
					print("[lab-live] cancellation requested from the live console");
					if (activeTestProcess) stopProcessTree(activeTestProcess);
					void stopExternalServices();
				},
			});
		} catch (error) {
			print(`[lab-live] console disabled: ${error instanceof Error ? error.message : String(error)}`);
			activeLiveConsole = undefined;
		}
	}
	let failed = false;
	try {
		for (const step of steps) {
			const record = manifest.steps.find((candidate) => candidate.id === step.id)!;
			await runEvidenceStep(step, record, manifest, manifestPath, runDir);
			if (record.status !== "passed") {
				failed = true;
				applyGateValidity(runDir, manifest, step.id, record.exitCode);
				break;
			}
			if (step.id === "go-package-list") {
				const packages = readFileSync(path.join(runDir, "backend", "packages.txt"), "utf8")
					.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
				for (const artifact of artifacts.filter((item) => item.kind === "go-test" || item.kind === "go-coverage")) {
					artifact.expectedCases = packages;
				}
			}
		}
	} catch (error) {
		failed = true;
		const runningStep = manifest.steps.find((step) => step.status === "running");
		if (runningStep) {
			runningStep.status = interruptedSignal ? "cancelled" : "failed";
			runningStep.error = error instanceof Error ? error.message : String(error);
			runningStep.finishedAt = new Date().toISOString();
		}
	} finally {
		await stopExternalServices();
		for (const step of manifest.steps) {
			if (step.status === "pending") step.status = interruptedSignal ? "cancelled" : "skipped";
		}
		manifest.status = interruptedSignal ? "cancelled" : failed ? "failed" : "passed";
		manifest.finishedAt = new Date().toISOString();
		persistManifest(manifestPath, manifest);
	}

	try {
		let report = writeAggregateReport(manifestPath);
		if (report.status !== "passed" && manifest.status === "passed") {
			manifest.status = "failed";
			persistManifest(manifestPath, manifest);
			report = writeAggregateReport(manifestPath);
		}
		print(`Report: ${path.join(runDir, "test-report.html")}`);
		print(`Measurement: ${manifest.validity.status}${manifest.validity.aborted ? " (aborted)" : ""}${manifest.recorded ? "" : " · not recorded"}`);
		print(`Result: ${report.status}; ${report.failures.length} evidence issue(s)`);
		if (manifest.validity.aborted) {
			for (const reason of manifest.validity.reasons.slice(0, 10)) {
				print(`[lab][abort] ${reason.scope}:${reason.id} ${reason.code}${reason.detail ? ` (${reason.detail})` : ""}`);
			}
		}
		const liveExitCode = report.status === "passed" ? 0 : manifest.validity.aborted ? 3 : interruptedSignal ? 130 : 1;
		const liveConsole = activeLiveConsole;
		activeLiveConsole = undefined;
		liveConsole?.finish({
			status: manifest.status === "cancelled" ? "cancelled" : report.status === "passed" ? "passed" : "failed",
			validity: manifest.validity.status,
			recorded: manifest.recorded,
			reportPath: path.join(runDir, "test-report.html"),
			exitCode: liveExitCode,
		});
		if (report.status !== "passed") process.exitCode = manifest.validity.aborted ? 3 : interruptedSignal ? 130 : 1;
	} catch (error) {
		activeLiveConsole?.finish({
			status: interruptedSignal ? "cancelled" : "failed",
			validity: manifest.validity.status,
			recorded: manifest.recorded,
		});
		activeLiveConsole = undefined;
		print(`Report generation failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
};

const runDoctor = () => {
	const goVersion = spawnSync("go", ["version"], { cwd: canonicalRootDir, encoding: "utf8" });
	const browserName = selectedBrowser();
	const browser = browserAvailability(browserName);
	const checks = [
		{
			name: "node",
			passed: Number(process.versions.node.split(".")[0]) >= 20,
		detail: process.versions.node,
		},
		{
			name: "git",
			passed: spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: canonicalRootDir, encoding: "utf8" }).status === 0,
			detail: "repository revision is readable",
		},
		{
			name: "go",
			passed: goVersion.status === 0,
			detail: goVersion.stdout?.trim() || "Go is not on PATH",
		},
		{
			name: "dependencies",
			passed: existsSync(path.join(canonicalRootDir, "node_modules", "vitest", "package.json")) &&
				existsSync(path.join(canonicalRootDir, "node_modules", "tsx", "package.json")),
			detail: "Vitest and tsx are installed",
		},
		{
			name: browserName,
			passed: browser.available,
			detail: browser.executablePath,
		},
	];
	const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), checks };
	if (hasArg("json") || process.env.AEVIA_TEST_JSON === "1") print(JSON.stringify(result));
	else {
		print("Aevia test environment");
		for (const check of checks) print(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
	}
	if (checks.some((check) => !check.passed)) process.exitCode = 1;
};

const runReplay = async () => {
	const runId = argValue("run-id");
	if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Replay requires --run-id=<UUID> from a prior managed run");
	const manifestPath = path.join(canonicalRootDir, "tests", "reports", "summary", "runs", runId, "run-manifest.json");
	if (!existsSync(manifestPath)) throw new Error(`Run manifest not found: ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
	const source = readSourceIdentity(canonicalRootDir);
	if (
		manifest.runId !== runId ||
		manifest.source.revision !== source.revision ||
		manifest.source.dirtyPatchSha256 !== source.dirtyPatchSha256
	) throw new Error("Replay refused: current source identity differs from the recorded run");
	const replayProfile = manifest.profile as Profile;
	if (!isManagedProfile(replayProfile) || replayProfile === "single") {
		throw new Error(`Replay is not supported for profile: ${manifest.profile}`);
	}
	print(`Re-running profile=${replayProfile} from source-matched run=${runId}`);
	await runEvidenceProfile(replayProfile);
};

const resolveRerunSelection = (scope: "run" | "scenario" | "case", ids: string[]): LabResolveResult | undefined => {
	if (scope === "run" || ids.length === 0) return undefined;
	const selectors: string[] = [];
	for (const id of ids) {
		if (id.includes(".ts") || id.includes(".vue")) {
			selectors.push(`file:${id}`);
			continue;
		}
		const caseId = id.includes("|") ? id.split("|")[0]! : id;
		selectors.push(`case:${caseId}`);
	}
	return selectors.length > 0 ? resolveOnlySelectors(selectors, canonicalRootDir) : undefined;
};

const resolveSingleSelection = (): LabResolveResult => {
	const only = argValues("only");
	const since = argValue("since");
	const resolved = only.length > 0
		? resolveOnlySelectors(only, canonicalRootDir)
		: since
			? resolveSinceRef(since, canonicalRootDir)
			: undefined;
	if (!resolved) throw new Error("single mode requires --only=<selector> or --since=<git-ref>");
	for (const unresolved of resolved.unresolved) print(`[lab] unresolved selector: ${unresolved}`);
	if (resolved.selections.length === 0) {
		throw new Error(
			`single mode resolved no executable targets${
				resolved.unresolved.length > 0 ? ` (unresolved: ${resolved.unresolved.join(", ")})` : ""
			}`
		);
	}
	return resolved;
};

const buildManagedRunOptions = (profile: ManagedProfile): ManagedRunOptions & { effectiveProfile: ManagedProfile } => {
	let selection: LabResolveResult | undefined;
	const rerunId = argValue("rerun-of");
	let rerunOf: ManagedRunOptions["rerunOf"];
	if (rerunId) {
		if (!/^[0-9a-f-]{36}$/i.test(rerunId)) throw new Error("--rerun-of must be a run UUID");
		const scope = argValue("scope") || "run";
		if (scope !== "run" && scope !== "scenario" && scope !== "case") throw new Error("--scope must be run|scenario|case");
		const ids = (argValue("ids") || "").split(",").map((item) => item.trim()).filter(Boolean);
		rerunOf = { ofRunId: rerunId, scope, ids };
		selection = resolveRerunSelection(scope, ids);
	}
	if (profile === "single" && !selection) selection = resolveSingleSelection();
	if (!rerunOf) return { selection, effectiveProfile: profile };
	const effectiveProfile = selection && rerunOf.scope === "case" ? "single" : profile;
	return { selection, rerunOf, effectiveProfile };
};

const main = async () => {
	if (hasArg("doctor")) {
		runDoctor();
		return;
	}
	if (hasArg("replay")) {
		await runReplay();
		return;
	}
	const answers = await collectAnswers();
	if (isManagedProfile(answers.profile)) {
		const options = buildManagedRunOptions(answers.profile);
		await runEvidenceProfile(options.effectiveProfile, options);
		return;
	}
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

	if (liveConsoleRequested("custom")) {
		try {
			activeLiveConsole = await startLiveConsole({
				runId: `legacy-${Date.now().toString(36)}`,
				mode: "custom",
				profile: answers.profile,
				steps: steps.map((step, index) => ({ id: `legacy-${index + 1}`, title: step.title })),
				runDir: canonicalRootDir,
				print,
				...liveConsoleOptions(),
				onCancel: () => {
					if (interruptedSignal) return;
					interruptedSignal = "SIGTERM";
					print("[lab-live] cancellation requested from the live console");
					if (activeTestProcess) stopProcessTree(activeTestProcess);
					void stopExternalServices();
				},
			});
		} catch (error) {
			print(`[lab-live] console disabled: ${error instanceof Error ? error.message : String(error)}`);
			activeLiveConsole = undefined;
		}
	}

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
		print("The legacy interactive run wrote individual suite reports; use test:ci for managed evidence and aggregation.");
	} catch (error: unknown) {
		print("");
		print(`✕ workflow failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	} finally {
		await stopExternalServices();
		const liveConsole = activeLiveConsole;
		activeLiveConsole = undefined;
		liveConsole?.finish({
			status: interruptedSignal ? "cancelled" : process.exitCode ? "failed" : "passed",
		});
	}
};

void main().catch((error) => {
	print(`✕ ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = interruptedSignal ? 130 : 1;
});
