import { CI_REQUIRED_EXTERNAL_CASE_IDS, EXTERNAL_CASES, validateExternalCaseCatalog } from "../catalog/external-cases";

describe("external case catalog", () => {
	it("contains unique cases with an independent observable oracle", () => {
		expect(validateExternalCaseCatalog()).toEqual([]);
	});

	it("keeps the PR-required external case set explicit", () => {
		expect(CI_REQUIRED_EXTERNAL_CASE_IDS).toEqual([
			"harness-health",
			"correctness-smoke",
			"concurrent-crossing-visual-consistency",
			"late-joiner-visual-consistency",
			"protocol-multipage-isolation",
		]);
		expect(Object.values(EXTERNAL_CASES).length).toBeGreaterThanOrEqual(CI_REQUIRED_EXTERNAL_CASE_IDS.length);
	});
});
