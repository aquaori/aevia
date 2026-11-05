import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (rootDir: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8") =>
	execFileSync("git", args, { cwd: rootDir, encoding, maxBuffer: 64 * 1024 * 1024 });

export type SourceIdentity = {
	revision: string;
	dirtyPatchSha256: string;
	trackedChanges: string[];
	untrackedFiles: string[];
	fileSha256?: Record<string, string>;
};

export const readSourceIdentity = (rootDir: string): SourceIdentity => {
	const repositoryRoot = String(git(rootDir, ["rev-parse", "--show-toplevel"])).trim();
	const revision = String(git(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(revision)) throw new Error("Git did not return a valid source revision");

	const hash = createHash("sha256");
	hash.update(git(repositoryRoot, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."], "buffer"));
	const trackedChanges = String(git(repositoryRoot, ["diff", "--name-only", "HEAD", "--", "."]))
		.split(/\r?\n/)
		.filter(Boolean)
		.sort();
	const untracked = String(git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))
		.split("\0")
		.filter(Boolean)
		.sort();
	for (const relativePath of untracked) {
		const absolutePath = path.resolve(repositoryRoot, relativePath);
		if (!absolutePath.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`)) {
			throw new Error(`Git returned an untracked path outside the repository: ${relativePath}`);
		}
		hash.update(relativePath.replaceAll("\\", "/"));
		hash.update("\0");
		hash.update(fs.readFileSync(absolutePath));
		hash.update("\0");
	}
	const fileSha256: Record<string, string> = {};
	const files = String(git(repositoryRoot, ["ls-files", "-z"])).split("\0").filter(Boolean).concat(untracked);
	// Runtime history is a measurement input; append only after source-check.
	const historyDir = path.join(repositoryRoot, "tests", "reports", "lab-history");
	if (fs.existsSync(historyDir)) {
		for (const file of fs.readdirSync(historyDir).filter(file => file.endsWith(".jsonl")).sort()) {
			files.push(`tests/reports/lab-history/${file}`);
		}
	}
	for (const file of files) {
		const absolute = path.resolve(repositoryRoot, file);
		fileSha256[file] = fs.existsSync(absolute) ? createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : "deleted";
	}
	return { fileSha256, revision, dirtyPatchSha256: hash.digest("hex"), trackedChanges, untrackedFiles: untracked };
};
