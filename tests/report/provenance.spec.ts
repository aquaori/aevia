import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readSourceIdentity } from "./provenance";
import { describeSourceDrift } from "../lab/source-drift";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("runtime history provenance", () => {
	it("detects history edits without marking an unchanged source tree dirty", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aevia-provenance-"));
		try {
			const history = path.join(root, "tests/reports/lab-history/performance-external.history.jsonl");
			fs.mkdirSync(path.dirname(history), { recursive: true });
			fs.writeFileSync(history, "first\n");
			vi.mocked(execFileSync).mockImplementation((_command, args) => {
				const words = args as string[];
				if (words.includes("--show-toplevel")) return root;
				if (words.includes("--verify")) return "a".repeat(40);
				return Buffer.from("");
			});
			const before = readSourceIdentity(root);
			fs.writeFileSync(history, "second\n");
			const after = readSourceIdentity(root);
			expect(after.dirtyPatchSha256).toBe(before.dirtyPatchSha256);
			expect(after.trackedChanges).toEqual([]);
			expect(describeSourceDrift(before, after).inPlaceContentChanged).toEqual([
				"tests/reports/lab-history/performance-external.history.jsonl",
			]);
			expect(describeSourceDrift(before, after).fingerprintChanged).toBe(true);
		} finally {
			vi.mocked(execFileSync).mockReset();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
