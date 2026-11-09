import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("builds one matrix index and fails closed when a report is missing", () => {
	const root = mkdtempSync(path.join(tmpdir(), "aevia-matrix-"));
	try {
		for (const os of ["ubuntu-24.04", "windows-latest", "macos-latest"]) for (const browser of ["chromium", "firefox", "webkit"]) {
			const run = path.join(root, `aevia-test-evidence-${os}-${browser}`, "run-1");
			mkdirSync(run, { recursive: true });
			writeFileSync(path.join(run, "lab-report.json"), JSON.stringify({ run: { status: "passed" }, gate: { cases: [{}] }, failures: [] }));
			writeFileSync(path.join(run, "lab-report.html"), "report");
		}
		const script = path.resolve("scripts/ci-matrix-report.mjs");
		expect(spawnSync(process.execPath, [script, root]).status).toBe(0);
		const html = readFileSync(path.join(root, "index.html"), "utf8");
		expect(html).toContain("通过 9/9");
		expect(html).toContain("aevia-test-evidence-macos-latest-webkit/run-1/lab-report.html");
		rmSync(path.join(root, "aevia-test-evidence-macos-latest-webkit", "run-1", "lab-report.json"));
		expect(spawnSync(process.execPath, [script, root]).status).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
