import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("publishes only the qualification from the current valid nightly report", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "aevia-verdict-"));
	try {
		const id = "a7d7a486-b667-4da1-a417-a391189c03a8";
		const reportDir = path.join(dir, "tests", "reports", "summary", "runs", id);
		mkdirSync(reportDir, { recursive: true });
		const pointer = path.join(dir, "run-id");
		const output = path.join(dir, "output");
		writeFileSync(pointer, id);
		const run = { id, profile: "nightly", source: { revision: "abc" }, validity: { status: "valid" }, recorded: true, status: "passed", performanceVerdict: "passed" };
		const check = (candidate: unknown) => {
			writeFileSync(path.join(reportDir, "lab-report.json"), JSON.stringify({ run: candidate }));
			writeFileSync(output, "");
			const result = spawnSync(process.execPath, [path.resolve("scripts/ci-performance-verdict.mjs")], { cwd: dir, env: { ...process.env, AEVIA_CI_RUN_ID_FILE: pointer, GITHUB_OUTPUT: output, GITHUB_SHA: "abc" } });
			expect(result.status).toBe(0);
			return readFileSync(output, "utf8").trim();
		};
		expect(check(run)).toBe("verdict=passed");
		expect(check({ ...run, performanceVerdict: "failed", status: "failed" })).toBe("verdict=failed");
		expect(check({ ...run, source: { revision: "different" } })).toBe("verdict=inconclusive");
		expect(check({ ...run, validity: { status: "invalid" } })).toBe("verdict=inconclusive");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
