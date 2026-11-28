#!/usr/bin/env node
// Read-only branch inventory: which branches exist, where they point, whether they
// are pushed, merged (by ancestry OR by patch-id so squashed merges are recognised),
// stale, and which worktree holds them. This script never writes to the repository.
import { spawnSync } from "node:child_process";

const ARGS = new Set(process.argv.slice(2));
const AS_JSON = ARGS.has("--json");
const ONLY_MERGED = ARGS.has("--merged");
const ONLY_STALE = ARGS.has("--stale");
const STALE_DAYS = 30;
const BASE = process.env.BRANCH_STATUS_BASE || "origin/main";

function run(args, options = {}) {
	return spawnSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
}

function git(args) {
	const result = run(args);
	if (result.error) throw new Error(`git ${args.join(" ")}: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
	return result.stdout;
}

const DAY = 86_400_000;
const now = Date.now();

const branches = git(["for-each-ref", "refs/heads", "--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(upstream:short)%00%(contents:subject)"])
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		const [name, sha, date, upstream, subject] = line.split("\0");
		return { name, sha, date, upstream, subject };
	});

const remoteInfo = new Map();
for (const line of git(["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(contents:subject)"]).split("\n").filter(Boolean)) {
	const [ref, sha, date, subject] = line.split("\0");
	if (ref === "origin" || ref === "origin/HEAD") continue;
	remoteInfo.set(ref.replace(/^origin./, ""), { sha, date, subject });
}

// A CI checkout has no local branch for most remotes, so remote-only branches are
// listed too; that keeps the report useful outside a developer machine.
const localNames = new Set(branches.map((branch) => branch.name));
for (const [name, info] of remoteInfo) {
	if (!localNames.has(name)) {
		branches.push({ name, sha: info.sha, date: info.date, upstream: `origin/${name}`, subject: info.subject, remoteOnly: true });
	}
}

const worktrees = new Map();
for (const block of git(["worktree", "list", "--porcelain"]).split("\n\n")) {
	const lines = block.split("\n");
	const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
	const head = lines.find((l) => l.startsWith("branch "))?.slice("branch refs/heads/".length);
	if (path && head) worktrees.set(head, path.split(/[/\\]/).slice(-2).join("/"));
}

function aheadBehind(ref) {
	const out = run(["rev-list", "--left-right", "--count", `${BASE}...${ref}`]);
	if (out.status !== 0) return { behind: 0, ahead: 0 };
	const [behind, ahead] = out.stdout.trim().split(/\s+/).map(Number);
	return { behind, ahead };
}

// A branch counts as merged when its tip is an ancestor of the base, or when every
// commit carries a patch id the base already has (what a squash merge leaves behind).
function mergedState(ref) {
	if (ref === "main") return { merged: true, how: "ancestor" };
	if (run(["merge-base", "--is-ancestor", ref, BASE]).status === 0) return { merged: true, how: "ancestor" };
	const cherry = run(["cherry", BASE, ref]);
	if (cherry.status === 0) {
		const lines = cherry.stdout.split("\n").filter(Boolean);
		if (lines.length > 0 && lines.every((line) => line.startsWith("-"))) return { merged: true, how: "patch-id" };
	}
	return { merged: false, how: "" };
}

const rows = branches.map((branch) => {
	const remoteSha = remoteInfo.get(branch.name)?.sha;
	const pushed = Boolean(remoteSha);
	// Judge merge status against the remote tip when the local branch lags behind it.
	const judgeRef = branch.remoteOnly || (pushed && remoteSha !== branch.sha) ? `origin/${branch.name}` : branch.name;
	const { behind, ahead } = aheadBehind(judgeRef);
	const merge = mergedState(judgeRef);
	const last = Date.parse(branch.date);
	const ageDays = Number.isFinite(last) ? Math.floor((now - last) / DAY) : 0;
	let state;
	if (merge.merged && ahead === 0 && behind === 0) state = "与 main 同步";
	else if (merge.merged) state = "已合并";
	else if (ageDays >= STALE_DAYS) state = `沉寂 ${ageDays} 天`;
	else if (behind > 0) state = "需追平";
	else state = "活跃";
	const sync = branch.remoteOnly ? "仅远端" : !pushed ? "未推送" : remoteSha === branch.sha ? "一致" : "本地旧";
	return {
		name: branch.name,
		sha: branch.sha.slice(0, 7),
		last: branch.date.slice(0, 16).replace("T", " "),
		ageDays,
		ahead,
		behind,
		pushed,
		sync,
		merged: merge.merged,
		mergedHow: merge.how,
		worktree: worktrees.get(branch.name) || "",
		remoteOnly: Boolean(branch.remoteOnly),
		state,
		subject: branch.subject,
	};
});

let shown = rows.sort((a, b) => b.last.localeCompare(a.last));
if (ONLY_MERGED) shown = shown.filter((row) => row.merged);
if (ONLY_STALE) shown = shown.filter((row) => !row.merged && row.ageDays >= STALE_DAYS);

if (AS_JSON) {
	process.stdout.write(`${JSON.stringify({ base: BASE, staleDays: STALE_DAYS, branches: shown }, null, 2)}\n`);
	process.exit(0);
}

if (shown.length === 0) {
	console.log("No branches matched.");
	process.exit(0);
}

// CJK characters occupy two terminal cells.
const width = (text) => [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (text, size) => text + " ".repeat(Math.max(0, size - width(text)));

const headers = ["分支", "最后提交", "领先/落后", "远端", "已合并", "worktree", "状态"];
const cells = shown.map((row) => [
	row.name,
	row.last,
	`+${row.ahead}/-${row.behind}`,
	row.sync,
	row.merged ? (row.mergedHow === "patch-id" ? "是(squash)" : "是") : "否",
	row.worktree || "-",
	row.state,
]);
const widths = headers.map((header, index) => Math.max(width(header), ...cells.map((row) => width(row[index]))));

console.log(`Base: ${BASE}   (stale after ${STALE_DAYS} days)\n`);
console.log(headers.map((header, index) => pad(header, widths[index])).join("  "));
console.log(widths.map((size) => "-".repeat(size)).join("  "));
for (const row of cells) console.log(row.map((cell, index) => pad(cell, widths[index])).join("  "));

const merged = shown.filter((row) => row.merged && row.name !== "main");
const stale = shown.filter((row) => !row.merged && row.ageDays >= STALE_DAYS);
const unpushed = shown.filter((row) => !row.pushed && row.name !== "main");
const parts = [`${shown.length} branches`, `${merged.length} merged`, `${stale.length} stale`, `${unpushed.length} never pushed`];
if (merged.length > 0) parts.push(`merged: ${merged.map((row) => row.name).join(", ")}`);
console.log(`\n${parts.join(" | ")}`);
