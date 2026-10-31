// File role: deterministic coverage for the managed-run source drift explainer.
import { describe, expect, it } from "vitest";
import { describeSourceDrift, describeSourceDriftLines, isGeneratedEvidencePath } from "./source-drift";

const identity = (overrides: Partial<Parameters<typeof describeSourceDrift>[0]> = {}) => ({
	revision: "a".repeat(40),
	dirtyPatchSha256: "b".repeat(64),
	trackedChanges: [] as string[],
	untrackedFiles: [] as string[],
	...overrides,
});

describe("source drift explainer", () => {
	it("reports no drift for an unchanged tree", () => {
		const drift = describeSourceDrift(identity(), identity());
		expect(drift.revisionChanged).toBe(false);
		expect(drift.fingerprintChanged).toBe(false);
		expect(describeSourceDriftLines(drift, identity())).toEqual([]);
	});

	it("names tracked files that became dirty mid-run", () => {
		const before = identity({ trackedChanges: [] });
		const after = identity({ trackedChanges: ["apps/frontend/tests/e2e/external/suites.ts"] });
		const drift = describeSourceDrift(before, after);
		expect(drift.trackedAdded).toEqual(["apps/frontend/tests/e2e/external/suites.ts"]);
		const lines = describeSourceDriftLines(drift, before).join("\n");
		expect(lines).toContain("tracked files became dirty");
		expect(lines).toContain("suites.ts");
		expect(lines).toContain("do not edit");
	});

	it("distinguishes an in-place content change from a new file", () => {
		const before = identity({ trackedChanges: ["tests/run-system.ts"] });
		const after = identity({ trackedChanges: ["tests/run-system.ts"], dirtyPatchSha256: "c".repeat(64) });
		const drift = describeSourceDrift(before, after);
		expect(drift.trackedAdded).toEqual([]);
		expect(drift.inPlaceContentChanged).toEqual(["tests/run-system.ts"]);
		expect(describeSourceDriftLines(drift, before).join("\n")).toContain("content changed in place");
	});

	it("reports untracked additions and removals", () => {
		const before = identity({ untrackedFiles: ["tests/.tmp/old.log"] });
		const after = identity({ untrackedFiles: ["tests/.tmp/new.log"] });
		const drift = describeSourceDrift(before, after);
		const lines = describeSourceDriftLines(drift, before).join("\n");
		expect(lines).toContain("new untracked files: tests/.tmp/new.log");
		expect(lines).toContain("removed untracked files: tests/.tmp/old.log");
	});

	it("reports a HEAD move", () => {
		const before = identity();
		const after = identity({ revision: "d".repeat(40) });
		const lines = describeSourceDriftLines(describeSourceDrift(before, after), before).join("\n");
		expect(lines).toContain("HEAD changed");
	});

	it("does not count generated history/baseline evidence the run itself wrote", () => {
		const historyPath = "apps/frontend/tests/e2e/external/history/performance-external.history.jsonl";
		const before = identity({ trackedChanges: [] });
		const after = identity({
			trackedChanges: [historyPath],
			dirtyPatchSha256: "e".repeat(64),
		});
		const drift = describeSourceDrift(before, after, { isIgnoredPath: isGeneratedEvidencePath });
		expect(drift.fingerprintChanged).toBe(false);
		expect(drift.trackedAdded).toEqual([]);
		expect(drift.ignoredGeneratedPaths).toEqual([historyPath]);
		expect(describeSourceDriftLines(drift, before).join("\n")).toContain("generated evidence changed by the run");
	});

	it("still fails when a real source file changes next to an ignored evidence file", () => {
		const historyPath = "apps/frontend/tests/e2e/external/history/performance-external.history.jsonl";
		const before = identity();
		const after = identity({
			trackedChanges: [historyPath, "apps/frontend/tests/e2e/external/suites.ts"],
			dirtyPatchSha256: "f".repeat(64),
		});
		const drift = describeSourceDrift(before, after, { isIgnoredPath: isGeneratedEvidencePath });
		expect(drift.fingerprintChanged).toBe(true);
		expect(drift.trackedAdded).toEqual(["apps/frontend/tests/e2e/external/suites.ts"]);
		expect(drift.ignoredGeneratedPaths).toEqual([historyPath]);
	});
});
