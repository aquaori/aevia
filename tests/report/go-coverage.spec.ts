import { describe, expect, it } from "vitest";
import { mergeGoCoverageBlocks } from "./go-coverage";
describe("Go coverage block union", () => {
	it("unions repeated blocks without multiplying the denominator", () => {
		expect(mergeGoCoverageBlocks(["p/a.go:1.1,2.1 2 0", "p/a.go:1.1,2.1 2 1", "p/a.go:3.1,4.1 3 0"])).toEqual(["p/a.go:1.1,2.1 2 1", "p/a.go:3.1,4.1 3 0"]);
	});
	it("rejects conflicting block sizes", () => expect(() => mergeGoCoverageBlocks(["p/a.go:1.1,2.1 2 0", "p/a.go:1.1,2.1 3 1"])).toThrow());
});
