// Thin wrapper so the Go backend participates in the root npm scripts.
//
// `build:backend` and the backend `test` script used to be console.log
// placeholders, which meant the Go backend — now the primary backend — was
// compiled and tested by nothing in CI.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goBackendDir = path.join(repoRoot, "apps", "go-backend");

const TASKS = {
	build: ["build", "./..."],
	vet: ["vet", "./..."],
	test: ["test", "./..."],
	start: ["run", "./cmd/aevia-go-backend"],
};

const task = process.argv[2];
const args = TASKS[task];

if (!args) {
	console.error(`Usage: node scripts/go.mjs <${Object.keys(TASKS).join("|")}>`);
	process.exit(2);
}

const extra = process.argv.slice(3);
const result = spawnSync("go", [...args, ...extra], {
	cwd: goBackendDir,
	stdio: "inherit",
	shell: process.platform === "win32",
});

if (result.error) {
	console.error(
		`Failed to run "go ${args.join(" ")}". Is the Go toolchain installed and on PATH?`
	);
	console.error(result.error.message);
	process.exit(1);
}

process.exit(result.status ?? 1);
