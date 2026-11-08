import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareCommandIds, compareCommandOrder } from "./collabProtocol";
import { compareRenderOrder, sceneOperationOrderKey } from "./sceneProtocol";
import type { RenderOrderKey } from "../types/scene";

// Golden vectors shared with the Go backend:
// apps/backend/internal/domain/types_test.go reads this exact file and asserts
// domain.CompareFlatPoint agrees with the command groups. Editing an expected
// order here therefore changes a cross-runtime contract, not just a test.
interface CommandVector {
	labels: string[];
	expectedOrder: string[];
	items: { id: string; lamport: number }[];
}

interface RenderVector {
	labels: string[];
	expectedOrder: string[];
	items: RenderOrderKey[];
}

interface OrderVectors {
	schemaVersion: number;
	description?: string;
	commands: CommandVector[];
	renderKeys: RenderVector[];
}

const loadVectors = (): OrderVectors =>
	JSON.parse(
		readFileSync(new URL("./__fixtures__/order-vectors.json", import.meta.url), "utf8")
	) as OrderVectors;

const sortCommands = (items: CommandVector["items"]) =>
	[...items].sort(compareCommandOrder).map((item) => item.id);

const sortRenderKeys = (vector: RenderVector) => {
	const labelled = vector.items.map((item, index) => ({ key: item, label: vector.labels[index]! }));
	labelled.sort((left, right) => compareRenderOrder(left.key, right.key));
	return labelled.map((entry) => entry.label);
};

describe("cross-runtime order golden vectors", () => {
	const vectors = loadVectors();

	it("keeps the documented fixture shape", () => {
		expect(vectors.schemaVersion).toBe(1);
		expect(vectors.commands.length).toBeGreaterThanOrEqual(9);
		expect(vectors.renderKeys.length).toBeGreaterThanOrEqual(9);
		for (const vector of [...vectors.commands, ...vectors.renderKeys]) {
			expect(vector.labels).toHaveLength(vector.items.length);
			expect([...vector.expectedOrder].sort()).toEqual([...vector.labels].sort());
		}
	});

	it("orders legacy non-ASCII IDs by UTF-8 bytes", () => {
		expect(compareCommandIds("\ue000", "\ud800\udc00")).toBeLessThan(0);
	});

	it("orders command ids with compareCommandOrder", () => {
		for (const vector of vectors.commands) {
			expect(sortCommands(vector.items)).toEqual(vector.expectedOrder);
		}
	});

	it("orders render keys with compareRenderOrder", () => {
		for (const vector of vectors.renderKeys) {
			expect(sortRenderKeys(vector)).toEqual(vector.expectedOrder);
			// Sorting the reversed input must converge to the same order.
			const reversed: RenderVector = {
				...vector,
				labels: [...vector.labels].reverse(),
				items: [...vector.items].reverse(),
			};
			expect(sortRenderKeys(reversed)).toEqual(vector.expectedOrder);
		}
	});

	it("is a total order: antisymmetric and tie-free for distinct ids", () => {
		const ids = ["A", "a", "ab", "a0", "cmd-1", "cmd-10", "cmd-2", "z", "10", "9"];
		for (const left of ids) {
			expect(compareCommandIds(left, left)).toBe(0);
			for (const right of ids) {
				if (left === right) continue;
				expect(Math.sign(compareCommandIds(left, right))).toBe(
					-Math.sign(compareCommandIds(right, left))
				);
			}
		}
	});

	it("agrees with the command comparator on lamport ties", () => {
		for (const vector of vectors.commands) {
			for (const left of vector.items) {
				for (const right of vector.items) {
					if (left.lamport !== right.lamport) continue;
					expect(Math.sign(compareCommandOrder(left, right))).toBe(
						Math.sign(compareCommandIds(left.id, right.id))
					);
				}
			}
		}
	});

	it("derives scene operation keys that sort by the render contract", () => {
		const operation = { lamport: 42, opId: "op-7" };
		expect(sceneOperationOrderKey(operation)).toEqual({
			lamport: 42,
			opId: "op-7",
			sourceIndex: 0,
			subIndex: 0,
		});
		expect(sceneOperationOrderKey(operation, 3, 4)).toEqual({
			lamport: 42,
			opId: "op-7",
			sourceIndex: 3,
			subIndex: 4,
		});
		expect(compareRenderOrder(sceneOperationOrderKey(operation), sceneOperationOrderKey(operation))).toBe(0);
	});
});
