import { describe, expect, it } from "vitest";
import { SpatialGridIndex } from "./spatialGridIndex";

const cellBounds = (cellX: number) => ({
	minX: (cellX + 0.1) / 32,
	minY: 0.1 / 32,
	maxX: (cellX + 0.9) / 32,
	maxY: 0.9 / 32,
	width: 0.8 / 32,
	height: 0.8 / 32,
});

describe("SpatialGridIndex", () => {
	it("keeps earlier chunks registered when an element crosses the chunk cell limit", () => {
		const index = new SpatialGridIndex();
		for (let cell = 0; cell < 9; cell += 1) index.addAtom("stroke", cell, cellBounds(cell));

		expect(index.query(cellBounds(0)).atomRefs).toContain(0);
		expect(index.query(cellBounds(8)).atomRefs).toContain(8);
		expect(index.stats().chunks).toBe(2);
	});
});
