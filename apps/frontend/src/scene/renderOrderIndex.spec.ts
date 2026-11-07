import { describe, expect, it } from "vitest";
import type { RenderOrderKey } from "@collaborative-whiteboard/shared";
import { RenderOrderIndex } from "./renderOrderIndex";

const key = (lamport: number, opId: string, sourceIndex = 0, subIndex = 0): RenderOrderKey => ({
	lamport,
	opId,
	sourceIndex,
	subIndex,
});

const indexFor = (keys: RenderOrderKey[], blockSize?: number) =>
	new RenderOrderIndex((ref) => keys[ref]!, blockSize);

describe("RenderOrderIndex", () => {
	it("keeps refs sorted when inserted out of order", () => {
		const keys = [key(3, "c"), key(1, "a"), key(4, "d"), key(2, "b")];
		const index = indexFor(keys);
		[0, 1, 2, 3].forEach((ref) => index.insert(ref));

		expect(index.toArray()).toEqual([1, 3, 0, 2]);
		expect(index.blockCount).toBe(1);
	});

	it("uses the render tie-break chain, not insertion order", () => {
		const keys = [
			key(2, "op-b"),
			key(2, "op-a", 9, 9),
			key(2, "op-a", 0, 1),
			key(2, "op-a", 0, 0),
			key(1, "op-z"),
		];
		const index = indexFor(keys);
		[3, 0, 2, 4, 1].forEach((ref) => index.insert(ref));

		expect(index.toArray()).toEqual([4, 3, 2, 1, 0]);
	});

	it("splits oversized blocks and still traverses in order", () => {
		const keys = Array.from({ length: 8 }, (_, i) => key(8 - i, `op-${i}`));
		const index = indexFor(keys, 2);
		// Insert newest-first (descending keys) so every insertion goes through
		// the binary path and the block overflows into a split.
		for (let ref = 0; ref < keys.length; ref += 1) index.insert(ref);

		expect(index.blockCount).toBeGreaterThan(1);
		const ordered = index.toArray();
		expect(ordered).toHaveLength(keys.length);
		for (let position = 1; position < ordered.length; position += 1) {
			const previous = keys[ordered[position - 1]!]!;
			const current = keys[ordered[position]!]!;
			expect(
				current.lamport - previous.lamport ||
					current.opId.localeCompare(previous.opId) ||
					current.sourceIndex - previous.sourceIndex ||
					current.subIndex - previous.subIndex
			).toBeGreaterThanOrEqual(0);
		}
	});

	it("appends through the fast path when keys arrive in order", () => {
		const keys = [key(1, "a"), key(2, "b"), key(3, "c")];
		const index = indexFor(keys, 2);
		index.insert(0);
		index.insert(1);
		index.insert(2);

		expect(index.toArray()).toEqual([0, 1, 2]);
		expect(index.blockCount).toBe(2);
	});

	it("iterates every ref exactly once and clears", () => {
		const keys = [key(2, "b"), key(1, "a"), key(3, "c")];
		const index = indexFor(keys);
		[0, 1, 2].forEach((ref) => index.insert(ref));

		const visited: number[] = [];
		index.forEach((ref) => visited.push(ref));
		expect([...visited].sort()).toEqual([0, 1, 2]);
		expect(index.toArray()).toEqual([1, 0, 2]);

		index.clear();
		expect(index.toArray()).toEqual([]);
		expect(index.blockCount).toBe(0);
	});
});
