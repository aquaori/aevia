import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const git = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"], { encoding: "utf8" });
if (git.status !== 0) process.exit(git.status || 1);
const files = git.stdout.split("\0").filter(Boolean);
const deleted = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=D", "-z"], { encoding: "utf8" });
if (deleted.status !== 0) process.exit(deleted.status || 1);
const deletedFiles = new Set(deleted.stdout.split("\0").filter(Boolean));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const start = Date.now();
function run(command, args, cwd = process.cwd()) {
	const timeout = Math.max(1, 90000 - (Date.now() - start));
	const result = spawnSync(command, args, { cwd, stdio: "inherit", timeout, shell: process.platform === "win32" && command === npm });
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status || 1);
}
if (!existsSync("node_modules/.bin/lint-staged")) {
	console.error("Missing local dependencies; run npm install before committing.");
	process.exit(1);
}
run(process.execPath, ["node_modules/lint-staged/bin/lint-staged.js"]);
const shared = files.some((file) => /^(package(-lock)?\.json|tsconfig[^/]*\.json|vitest\.config\.ts|eslint\.config\.mjs|\.github\/workflows\/[^/]+\.ya?ml)$/.test(file));
const frontend = shared || files.some((file) => /^(apps\/frontend\/|packages\/shared\/|tests\/|scripts\/).+\.(ts|tsx|js|mjs|cjs|vue|json|html|css|scss|sass|less)$/.test(file));
const backend = shared || files.some((file) => /^apps\/backend\/.+\.(go|mod|sum)$/.test(file) || file === "scripts/go.mjs");
for (const file of files.filter((file) => file.endsWith(".go") && !deletedFiles.has(file))) {
	// Read the index, not the working tree: partially staged files are common.
	const staged = spawnSync("git", ["show", `:${file}`], { encoding: "utf8", timeout: Math.max(1, 90000 - (Date.now() - start)) });
	const format = spawnSync("gofmt", [], { input: staged.stdout, encoding: "utf8", timeout: Math.max(1, 90000 - (Date.now() - start)) });
	if (staged.status !== 0 || format.error || format.status !== 0 || staged.stdout !== format.stdout) {
		console.error(format.error?.message || `Unformatted staged Go file: ${file}`);
		process.exit(1);
	}
}
if (frontend) run(npm, ["run", "test:quick:suite"]);
if (backend) run(npm, ["run", "test:go"]);
