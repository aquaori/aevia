import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Command } from "@collaborative-whiteboard/shared";
import { useCommandStore } from "./commandStore";

const makeCommand = (id: string, lamport: number, pageId = 0): Command =>
	({
		id,
		type: "path",
		tool: "pen",
		color: "#000",
		size: 4,
		points: [],
		timestamp: lamport,
		userId: "u1",
		roomId: "r1",
		pageId,
		isDeleted: false,
		lamport,
	}) as unknown as Command;

const makeBox = (minX: number, minY: number): Command["box"] => ({
	minX,
	minY,
	maxX: minX + 0.1,
	maxY: minY + 0.1,
	width: 0.1,
	height: 0.1,
});

describe("commandStore ordering", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it("keeps commands ordered by lamport regardless of arrival order", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);

		[5, 1, 4, 2, 3].forEach((lamport) => {
			store.insertCommand(makeCommand(`cmd-${lamport}`, lamport));
		});

		expect(store.commands.map((cmd) => cmd.lamport)).toEqual([1, 2, 3, 4, 5]);
	});

	it("breaks lamport ties by command id deterministically", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);

		// Insert in reverse id order; the resulting order must be id-ascending.
		["ccc", "aaa", "bbb"].forEach((id) => store.insertCommand(makeCommand(id, 10)));

		expect(store.commands.map((cmd) => cmd.id)).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("orders identically no matter what order commands arrive in", () => {
		// The convergence guarantee: two clients receiving the same set in
		// different orders must end up with the same sequence.
		const ids = ["b2", "a1", "c3", "a2", "b1"];
		const lamports = [7, 7, 7, 8, 6];

		const orderFor = (indices: number[]) => {
			setActivePinia(createPinia());
			const store = useCommandStore();
			store.replaceLoadedPageWindow([0], []);
			indices.forEach((index) => {
				store.insertCommand(makeCommand(ids[index]!, lamports[index]!));
			});
			return store.commands.map((cmd) => cmd.id);
		};

		const forward = orderFor([0, 1, 2, 3, 4]);
		const reversed = orderFor([4, 3, 2, 1, 0]);
		const shuffled = orderFor([2, 0, 4, 1, 3]);

		expect(reversed).toEqual(forward);
		expect(shuffled).toEqual(forward);
		// b1 has the lowest lamport, a2 the highest; the 7s sort by id.
		expect(forward).toEqual(["b1", "a1", "b2", "c3", "a2"]);
	});

	it("merges commands across loaded pages in global order", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0, 1], []);

		store.insertCommand(makeCommand("p0-late", 30, 0));
		store.insertCommand(makeCommand("p1-early", 10, 1));
		store.insertCommand(makeCommand("p0-early", 20, 0));

		expect(store.commands.map((cmd) => cmd.id)).toEqual(["p1-early", "p0-early", "p0-late"]);
	});

	it("ignores duplicate command ids", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);

		store.insertCommand(makeCommand("dup", 1));
		store.insertCommand(makeCommand("dup", 99));

		expect(store.commands).toHaveLength(1);
		expect(store.commands[0]!.lamport).toBe(1);
	});

	it("reflects insertions and removals in the merged view", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);

		store.insertCommand(makeCommand("a", 1));
		expect(store.commands.map((cmd) => cmd.id)).toEqual(["a"]);

		// In-place bucket mutation must still invalidate the cached merge.
		store.insertCommand(makeCommand("b", 2));
		expect(store.commands.map((cmd) => cmd.id)).toEqual(["a", "b"]);

		store.removeCommand("a");
		expect(store.commands.map((cmd) => cmd.id)).toEqual(["b"]);
	});

	it("drops commands for pages outside the loaded window", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);

		store.insertCommand(makeCommand("off-window", 1, 5));

		expect(store.commands).toHaveLength(0);
	});

	it("resolveConflict agrees with the sorted order", () => {
		const store = useCommandStore();
		const lower = makeCommand("aaa", 5);
		const higher = makeCommand("bbb", 5);

		expect(store.resolveConflict(lower, higher)).toBe(lower);
		expect(store.resolveConflict(higher, lower)).toBe(lower);
		expect(store.resolveConflict(makeCommand("zzz", 1), higher).id).toBe("zzz");
	});

	it("stores immutable scene operations without rewriting path geometry", () => {
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);
		const path = {
			...makeCommand("path", 1),
			points: [{ x: 0.1, y: 0.2, p: 1, lamport: 1 }],
			box: makeBox(0.1, 0.2),
		};
		const transform: Command = {
			...makeCommand("transform-op", 2),
			type: "scene-op",
			points: [],
			schemaVersion: 2,
			sceneOperation: {
				schemaVersion: 2,
				opId: "transform-op",
				elementId: path.id,
				actorId: "user-1",
				roomId: "room-1",
				pageId: 0,
				lamport: 2,
				historyGroupId: "transform-op",
				kind: "element.transform",
				payload: { targets: [{ elementId: path.id, deltaMatrix: [1, 0, 0, 1, 0.6, 0.6] }] },
			},
			box: makeBox(0, 0),
		};

		store.insertCommand(path);
		store.insertCommand(transform);
		expect(path.points?.[0]?.x).toBe(0.1);
		expect(path.box.minX).toBe(0.1);
		expect(store.commandMap.get("transform-op")?.sceneOperation?.kind).toBe("element.transform");
	});
});
