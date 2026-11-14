import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const base = process.env.CI_BASE;
if (!base) throw new Error("CI_BASE is required");
const diff = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRD", "-z", base, "HEAD"], { encoding: "utf8" });
if (diff.status !== 0) throw new Error(diff.stderr || "Unable to read changed files");
const files = diff.stdout.split("\0").filter(Boolean);
function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status || 1);
}
const js = files.filter((file) => existsSync(file) && /\.(js|cjs|mjs|ts|tsx|vue)$/.test(file));
if (js.length) run(process.execPath, ["node_modules/eslint/bin/eslint.js", "--no-warn-ignored", ...js]);
const workflows = files.filter((file) => existsSync(file) && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
if (workflows.length) run("go", ["run", "github.com/rhysd/actionlint/cmd/actionlint@v1.7.7", ...workflows]);
const go = files.filter((file) => existsSync(file) && file.endsWith(".go"));
if (go.length) {
	const result = spawnSync("gofmt", ["-l", ...go], { encoding: "utf8" });
	if (result.status !== 0 || result.stdout.trim()) {
		console.error(result.stderr || `Unformatted Go files:\n${result.stdout}`);
		process.exit(1);
	}
}
const shared = files.some((file) => /^(package(-lock)?\.json|tsconfig[^/]*\.json|vitest\.config\.ts|eslint\.config\.mjs|\.github\/workflows\/[^/]+\.ya?ml)$/.test(file));
const frontend = shared || files.some((file) => /^(apps\/frontend\/|packages\/shared\/|tests\/|scripts\/).+\.(ts|tsx|js|mjs|cjs|vue|json|html|css|scss|sass|less)$/.test(file));
const backend = shared || files.some((file) => /^apps\/backend\/.+\.(go|mod|sum)$/.test(file) || file === "scripts/go.mjs");
appendFileSync(process.env.GITHUB_OUTPUT, `frontend=${frontend}\nbackend=${backend}\n`);
