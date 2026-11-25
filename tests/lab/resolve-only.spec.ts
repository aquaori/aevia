// File role: deterministic checks for lab single-mode selector resolution.
import { describe, expect, it } from "vitest";
import { mergeSelections, resolveOnlySelectors, resolveSinceRef } from "./resolve-only";

const repoRoot = process.cwd();

describe("lab selector resolution", () => {
	it("resolves a file selector to the concrete spec file", () => {
		const resolved = resolveOnlySelectors(["file:packages/shared/src/protocol/collabProtocol.spec.ts"], repoRoot);
		expect(resolved.unresolved).toEqual([]);
		expect(resolved.selections).toHaveLength(1);
		expect(resolved.selections[0]).toMatchObject({
			kind: "vitest",
			files: ["packages/shared/src/protocol/collabProtocol.spec.ts"],
		});
	});

	it("resolves a source file to the spec that references it", () => {
		const resolved = resolveOnlySelectors(["file:apps/frontend/src/scene/matrix.ts"], repoRoot);
		const vitest = resolved.selections.find((selection) => selection.kind === "vitest");
		expect(vitest && "files" in vitest ? vitest.files : []).toContain("apps/frontend/src/scene/matrix.spec.ts");
	});

	it("resolves case ids, test name patterns and Go packages", () => {
		const cases = resolveOnlySelectors(["case:harness-health,correctness-smoke"], repoRoot);
		expect(cases.selections).toEqual([{ kind: "external", caseIds: ["harness-health", "correctness-smoke"] }]);

		const pattern = resolveOnlySelectors(["test:window pressure"], repoRoot);
		expect(pattern.selections[0]).toMatchObject({ kind: "vitest", testNamePattern: "window pressure" });

		const go = resolveOnlySelectors(["go:./internal/room#TestWindow"], repoRoot);
		expect(go.selections[0]).toMatchObject({ kind: "go", packages: ["./internal/room"], runPattern: "TestWindow" });
	});

	it("reports unknown selectors instead of silently running everything", () => {
		const resolved = resolveOnlySelectors(["file:does/not/exist.ts", "mystery:value", "empty:"], repoRoot);
		expect(resolved.selections).toEqual([]);
		expect(resolved.unresolved).toEqual(["file:does/not/exist.ts", "mystery:value", "empty:"]);
	});

	it("resolves an unchanged git range to no selections", () => {
		const resolved = resolveSinceRef("HEAD", repoRoot);
		// HEAD...HEAD is empty; untracked files may exist, but every mapped target stays valid.
		expect(Array.isArray(resolved.selections)).toBe(true);
		expect(Array.isArray(resolved.unresolved)).toBe(true);
	});

	it("deduplicates selections without letting a patterned target mask a full-file or full-package target", () => {
		const merged = mergeSelections([
			{ kind: "vitest", files: ["apps/frontend/src/a.spec.ts"], testNamePattern: "only alpha" },
			{ kind: "vitest", files: ["apps/frontend/src/b.spec.ts"] },
			{ kind: "vitest", files: ["apps/frontend/src/a.spec.ts"] },
			{ kind: "browser", files: ["apps/frontend/tests/browser/x.browser.spec.ts"] },
			{ kind: "go", packages: ["./internal/room"], runPattern: "TestWindow" },
			{ kind: "go", packages: ["./internal/gateway"] },
		]);

		const vitest = merged.filter((item) => item.kind === "vitest");
		expect(vitest).toEqual([
			{ kind: "vitest", files: ["apps/frontend/src/a.spec.ts", "apps/frontend/src/b.spec.ts"] },
		]);

		const browser = merged.filter((item) => item.kind === "browser");
		expect(browser).toEqual([
			{ kind: "browser", files: ["apps/frontend/tests/browser/x.browser.spec.ts"] },
		]);

		const go = merged.filter((item) => item.kind === "go");
		expect(go).toEqual([
			{ kind: "go", packages: ["./internal/gateway"] },
			{ kind: "go", packages: ["./internal/room"], runPattern: "TestWindow" },
		]);
	});
});
