import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertReportEligible } from "../../apps/frontend/tests/e2e/external/report-eligibility";
const report = () => ({ validity: { status: "valid", aborted: false }, run: { dirtyPatchSha256: createHash("sha256").update("").digest("hex") }, results: [{ status: "passed" }] });
describe("history and baseline eligibility", () => {
	it("accepts valid clean complete reports", () => expect(() => assertReportEligible(report())).not.toThrow());
	it.each(["degraded", "invalid"])("rejects %s reports", status => expect(() => assertReportEligible({ ...report(), validity: { status } })).toThrow());
	it("rejects dirty, empty and partially failing reports", () => {
		expect(() => assertReportEligible({ ...report(), run: { dirtyPatchSha256: "dirty" } })).toThrow();
		expect(() => assertReportEligible({ ...report(), results: [] })).toThrow();
		expect(() => assertReportEligible({ ...report(), results: [{ status: "passed" }, { status: "failed" }] })).toThrow();
	});
});
