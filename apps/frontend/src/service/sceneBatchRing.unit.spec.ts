import { expect, it } from "vitest";
import { SceneBatchRing } from "../workers/sceneBatchRing";

it("preserves records across wraparound and falls back when full", () => {
	const ring = new SceneBatchRing(new SharedArrayBuffer(16));
	expect(ring.write(Uint8Array.from([1, 2, 3, 4, 5, 6]))).toBe(true);
	expect(ring.write(Uint8Array.from([7, 8, 9]))).toBe(false);
	expect(Array.from(ring.read(6))).toEqual([1, 2, 3, 4, 5, 6]);
	expect(ring.write(Uint8Array.from([7, 8, 9, 10]))).toBe(true);
	expect(Array.from(ring.read(4))).toEqual([7, 8, 9, 10]);
});
