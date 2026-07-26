import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const children = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(repoRoot, "apps", "frontend");
const goCache = path.join(repoRoot, ".cache", "go-build");
const goModCache = path.join(repoRoot, ".cache", "go-mod");
const runTag = new Date().toISOString().replace(/[:.]/g, "-");
const cliArgs = process.argv.slice(2);
const cliArgValue = (name) => {
  const prefix = `--${name}=`;
  const match = cliArgs.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
};
const backendPort = process.env.GO_BENCH_BACKEND_PORT || process.env.GO_BACKEND_PORT || "4647";
const frontendPort = process.env.GO_BENCH_FRONTEND_PORT || "5173";
const frontendUrl = process.env.GO_BENCH_FRONTEND_URL || process.env.VITE_FRONTEND_URL || `http://127.0.0.1:${frontendPort}`;
const apiUrl = process.env.GO_BENCH_API_URL || process.env.VITE_API_URL || `http://127.0.0.1:${backendPort}`;
const wsUrl = process.env.GO_BENCH_WS_URL || process.env.VITE_WS_URL || `ws://127.0.0.1:${backendPort}/ws`;
const pprofEnabled = process.env.GO_BENCH_PPROF !== "0";
const pprofAddr = process.env.GO_BENCH_PPROF_ADDR || process.env.PPROF_ADDR || "127.0.0.1:6060";
const pprofUrl = `http://${pprofAddr}`;
const pprofCpuSeconds = Math.max(1, Number(process.env.GO_BENCH_PPROF_CPU_SECONDS || "30"));
const pprofDir =
  process.env.GO_BENCH_PPROF_DIR ||
  path.join(frontendDir, "tests", "e2e", "external", "reports", "pprof-go", runTag);
const reportSearchRoot = path.resolve(frontendDir, cliArgValue("report-dir") || path.join("tests", "e2e", "external", "reports", "latest"));
const observability = {
  source: "go-pprof",
  enabled: pprofEnabled,
  pprofUrl: pprofEnabled ? pprofUrl : undefined,
  cpuProfileSeconds: pprofEnabled ? pprofCpuSeconds : undefined,
  outputDir: pprofEnabled ? pprofDir : undefined,
  startedAt: new Date().toISOString(),
  artifacts: [],
  errors: [],
};

const commandForPlatform = (command, args) => {
  if (process.platform !== "win32") {
    return { command, args };
  }
  return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
};

const spawnChild = (name, command, args, options = {}) => {
  const resolved = commandForPlatform(command, args);
  const child = spawn(resolved.command, resolved.args, {
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
  });
  child.on("exit", (code) => {
    if (options.allowExit) return;
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
};

const shutdown = (code = 0) => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
};

const waitForUrl = async (url, name, timeoutMs = 60000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not become ready: ${url}`);
};

const fetchToFile = async (url, file) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(file, buffer);
  return buffer.length;
};

const recordArtifact = async ({ kind, label, file, endpoint, bytes }) => {
  let size = bytes;
  if (typeof size !== "number") {
    try {
      size = (await fs.stat(file)).size;
    } catch {
      size = undefined;
    }
  }
  observability.artifacts.push({
    kind,
    label,
    path: file,
    bytes: size,
    endpoint,
    collectedAt: new Date().toISOString(),
  });
};

const notePprofError = (message) => {
  observability.errors.push(`${new Date().toISOString()} ${message}`);
};

const runCommandToFile = async (name, command, args, file) =>
  new Promise((resolve) => {
    const resolved = commandForPlatform(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", async (error) => {
      const message = `${name} failed: ${(error && error.message) || error}`;
      console.warn(`[benchmark:go] ${message}`);
      notePprofError(message);
      resolve(false);
    });
    child.on("close", async (code) => {
      if (code === 0) {
        await fs.writeFile(file, Buffer.concat(stdout));
        await recordArtifact({ kind: "pprof-top", label: name, file });
        resolve(true);
        return;
      }
      const message = `${name} exited with code ${code}: ${Buffer.concat(stderr).toString("utf-8").trim()}`;
      console.warn(`[benchmark:go] ${message}`);
      notePprofError(message);
      resolve(false);
    });
  });

const collectPprofTopReports = async () => {
  if (!pprofEnabled) return;
  const topTargets = [
    ["cpu", `cpu-${pprofCpuSeconds}s.pprof`, `cpu-${pprofCpuSeconds}s-top.txt`],
    ["after-heap", "after-heap.pprof", "after-heap-top.txt"],
    ["after-allocs", "after-allocs.pprof", "after-allocs-top.txt"],
  ];
  for (const [label, sourceName, outputName] of topTargets) {
    const source = path.join(pprofDir, sourceName);
    try {
      await fs.access(source);
    } catch {
      continue;
    }
    await runCommandToFile(
      label,
      "go",
      ["tool", "pprof", "-top", "-nodecount=20", source],
      path.join(pprofDir, outputName)
    );
  }
};

const collectPprofSnapshot = async (label) => {
  if (!pprofEnabled) return;
  await fs.mkdir(pprofDir, { recursive: true });
  const targets = [
    ["heap", "/debug/pprof/heap"],
    ["goroutine", "/debug/pprof/goroutine?debug=2"],
    ["allocs", "/debug/pprof/allocs"],
    ["threadcreate", "/debug/pprof/threadcreate"],
  ];
  for (const [name, endpoint] of targets) {
    const file = path.join(pprofDir, `${label}-${name}.pprof`);
    try {
      const bytes = await fetchToFile(`${pprofUrl}${endpoint}`, file);
      await recordArtifact({ kind: "pprof-profile", label: `${label}-${name}`, file, endpoint, bytes });
    } catch (error) {
      const message = `pprof ${label}-${name} collection failed: ${(error && error.message) || error}`;
      console.warn(`[benchmark:go] ${message}`);
      notePprofError(message);
    }
  }
};

const startCPUProfile = async () => {
  if (!pprofEnabled) return null;
  await fs.mkdir(pprofDir, { recursive: true });
  const file = path.join(pprofDir, `cpu-${pprofCpuSeconds}s.pprof`);
  const profile = fetchToFile(`${pprofUrl}/debug/pprof/profile?seconds=${pprofCpuSeconds}`, file)
    .then((bytes) => recordArtifact({
      kind: "pprof-profile",
      label: `cpu-${pprofCpuSeconds}s`,
      file,
      endpoint: `/debug/pprof/profile?seconds=${pprofCpuSeconds}`,
      bytes,
    }))
    .then(() => console.log(`[benchmark:go] pprof cpu=${file}`))
    .catch((error) => {
      const message = `pprof cpu collection failed: ${(error && error.message) || error}`;
      console.warn(`[benchmark:go] ${message}`);
      notePprofError(message);
    });
  return profile;
};

const findLatestReportJson = async (root) => {
  const candidates = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith("-external-results.json")) {
        const stat = await fs.stat(fullPath);
        candidates.push({ file: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.file;
};

const writeObservabilityManifest = async () => {
  if (!pprofEnabled) return null;
  observability.finishedAt ||= new Date().toISOString();
  await fs.mkdir(pprofDir, { recursive: true });
  const manifestPath = path.join(pprofDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(observability, null, 2), "utf-8");
  console.log(`[benchmark:go] pprof-manifest=${manifestPath}`);
  return manifestPath;
};

const attachObservabilityToReport = async () => {
  if (!pprofEnabled) return;
  const reportPath = await findLatestReportJson(reportSearchRoot);
  if (!reportPath) {
    const message = `external report json not found under ${reportSearchRoot}`;
    console.warn(`[benchmark:go] ${message}`);
    notePprofError(message);
    return;
  }
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    const report = JSON.parse(raw);
    report.observability = observability;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`[benchmark:go] report-observability=${reportPath}`);
  } catch (error) {
    const message = `failed to attach pprof observability to report: ${(error && error.message) || error}`;
    console.warn(`[benchmark:go] ${message}`);
    notePprofError(message);
  }
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Benchmark runs seed millions of points and never cleaned up, so the scratch
// database grew unboundedly across runs (a single tree here reached 2.7 GB).
// Start each run from an empty database unless --keep-db is passed, and support
// --clean to reclaim the space without running a benchmark.
const benchDbPath = path.resolve(
  repoRoot,
  "data",
  path.basename(
    process.env.GO_BENCH_DB_PATH ||
      process.env.GO_BACKEND_DB_PATH ||
      process.env.DB_PATH ||
      "whiteboard-go-benchmark.sqlite"
  )
);

const removeBenchDatabase = async () => {
  let reclaimed = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${benchDbPath}${suffix}`;
    try {
      const stat = await fs.stat(target);
      reclaimed += stat.size;
      await fs.rm(target, { force: true });
    } catch {
      // Nothing to remove.
    }
  }
  if (reclaimed > 0) {
    console.log(
      `[benchmark:go] removed benchmark database (${(reclaimed / 1024 / 1024).toFixed(1)} MB)`
    );
  }
};

if (process.argv.includes("--clean")) {
  await removeBenchDatabase();
  process.exit(0);
}

if (!process.argv.includes("--keep-db")) {
  await removeBenchDatabase();
}

spawnChild("backend", "go", ["run", "./cmd/aevia-backend"], {
  cwd: path.join(repoRoot, "apps", "backend"),
  env: {
    ...process.env,
    PORT: backendPort,
    GOCACHE: process.env.GOCACHE || goCache,
    GOMODCACHE: process.env.GOMODCACHE || goModCache,
    LOG_FORMAT: process.env.LOG_FORMAT || "console",
    PPROF_ADDR: pprofEnabled ? pprofAddr : process.env.PPROF_ADDR || "",
    WS_RELIABLE_PER_SECOND:
      process.env.GO_BENCH_WS_RELIABLE_PER_SECOND ||
      process.env.WS_RELIABLE_PER_SECOND ||
      "5000",
    WS_RELIABLE_BURST:
      process.env.GO_BENCH_WS_RELIABLE_BURST ||
      process.env.WS_RELIABLE_BURST ||
      "10000",
    DB_PATH:
      process.env.GO_BENCH_DB_PATH ||
      process.env.GO_BACKEND_DB_PATH ||
      process.env.DB_PATH ||
      "../../data/whiteboard-go-benchmark.sqlite",
  },
});

spawnChild("frontend", "npm", ["run", "dev", "--workspace", "@collaborative-whiteboard/frontend", "--", "--port", frontendPort, "--strictPort"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BROWSERSLIST_IGNORE_OLD_DATA: process.env.BROWSERSLIST_IGNORE_OLD_DATA || "1",
    VITE_API_URL: apiUrl,
    VITE_WS_URL: wsUrl,
  },
});

try {
  await waitForUrl(`${apiUrl}/health/ready`, "backend");
  if (pprofEnabled) {
    await waitForUrl(`${pprofUrl}/debug/pprof/`, "backend pprof");
  }
  await waitForUrl(frontendUrl, "frontend");
  console.log(`[benchmark:go] frontend=${frontendUrl}`);
  console.log(`[benchmark:go] api=${apiUrl}`);
  console.log(`[benchmark:go] ws=${wsUrl}`);
  if (pprofEnabled) {
    console.log(`[benchmark:go] pprof=${pprofUrl}`);
    console.log(`[benchmark:go] pprof-output=${pprofDir}`);
    await collectPprofSnapshot("before");
  }

  const runner = spawnChild(
    "benchmark",
    "npx",
    [
      "tsx",
      "tests/e2e/external/runner.ts",
      "--suite=performance-external",
      "--case-set=all",
      "--mode=headless",
      "--reporter=json",
      "--warmup=1",
      "--runs=5",
      "--matrix=true",
      ...cliArgs,
    ],
    {
      cwd: frontendDir,
      allowExit: true,
      env: {
        ...process.env,
        VITE_FRONTEND_URL: frontendUrl,
        VITE_API_URL: apiUrl,
        VITE_WS_URL: wsUrl,
      },
    }
  );

  const cpuProfile = await startCPUProfile();
  runner.on("exit", async (code) => {
    await cpuProfile;
    await collectPprofSnapshot("after");
    await collectPprofTopReports();
    observability.finishedAt = new Date().toISOString();
    await attachObservabilityToReport();
    await writeObservabilityManifest();
    shutdown(code || 0);
  });
} catch (error) {
  console.error(`[benchmark:go] ${(error && error.message) || error}`);
  shutdown(1);
}
