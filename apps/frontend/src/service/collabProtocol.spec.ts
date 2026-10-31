import { describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Command } from "@collaborative-whiteboard/shared";
import {
	commandToProtocol as sharedCommandToProtocol,
	compareCommandOrder,
	normalizeCommandFromProtocol as sharedNormalizeCommandFromProtocol,
	normalizeCommandsFromProtocol as sharedNormalizeCommandsFromProtocol,
	normalizeLoadedPageIds as sharedNormalizeLoadedPageIds,
	protocolPageToState as sharedProtocolPageToState,
	statePageToProtocol as sharedStatePageToProtocol,
} from "@collaborative-whiteboard/shared";
import {
	commandToProtocol,
	normalizeCommandFromProtocol,
	normalizeCommandsFromProtocol,
	normalizeLoadedPageIds,
	protocolPageToState,
	statePageToProtocol,
} from "./collabProtocol";
import { useCommandStore } from "../store/commandStore";

// The frontend keeps its own copy of the protocol normalizers (they predate the
// shared package and run on the hot transport path). These tests are a
// characterisation contract: the local copy and @collaborative-whiteboard/shared
// must agree on the same inputs, including malformed ones.

const pageInputs: unknown[] = [
	0,
	3.9,
	"4.9",
	"bad",
	"",
	"0x10",
	null,
	undefined,
	true,
	false,
	[],
	{},
	-2,
	-0.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
];

const makeCommand = (id: string, lamport: number, pageId: number): Command =>
	({
		id,
		type: "path",
		tool: "pen",
		color: "#111111",
		size: 4,
		points: [],
		timestamp: lamport,
		userId: "user-1",
		roomId: "room-1",
		pageId,
		isDeleted: false,
		lamport,
	}) as unknown as Command;

describe("frontend collab protocol matches the shared implementation", () => {
	it("normalizes protocol pages identically", () => {
		for (const input of pageInputs) {
			expect(protocolPageToState(input)).toEqual(sharedProtocolPageToState(input));
		}
	});

	it("normalizes state pages identically", () => {
		for (const input of [0, 3.9, -2, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(statePageToProtocol(input)).toEqual(sharedStatePageToProtocol(input));
		}
	});

	it("normalizes loaded page id lists identically", () => {
		const inputs: unknown[] = [
			["2", 1, "2", -1, "bad"],
			["3.9", 3.9, 0, null, undefined],
			[true, false, 2],
			[Number.NaN, Number.POSITIVE_INFINITY],
			[],
			null,
			undefined,
			"3",
			{},
			[5, 5, 4],
		];
		for (const input of inputs) {
			expect(normalizeLoadedPageIds(input)).toEqual(sharedNormalizeLoadedPageIds(input));
		}
	});

	it("normalizes command page ids identically without mutating the input", () => {
		const inputs = [
			{ id: "a", type: "path", pageId: "4", points: [] },
			{ id: "b", type: "path", pageId: 4.9, points: [] },
			{ id: "c", type: "path", pageId: -1, points: [] },
			{ id: "d", type: "path", pageId: undefined, points: [] },
		] as unknown as Partial<Command>[];
		for (const input of inputs) {
			const before = input.pageId;
			expect(normalizeCommandFromProtocol(input)).toEqual(sharedNormalizeCommandFromProtocol(input));
			expect(input.pageId).toBe(before);
		}

		expect(normalizeCommandsFromProtocol(inputs)).toEqual(sharedNormalizeCommandsFromProtocol(inputs));
		for (const nonArray of [null, undefined, "commands", 42, {}]) {
			expect(normalizeCommandsFromProtocol(nonArray)).toEqual(
				sharedNormalizeCommandsFromProtocol(nonArray)
			);
		}
	});

	it("converts commands to protocol form identically", () => {
		const inputs = [
			{ id: "a", type: "path", pageId: 3.9 },
			{ id: "b", type: "path", pageId: -2 },
			{ id: "c", type: "path", pageId: "5" },
			{ id: "d", type: "path", pageId: Number.NaN },
		] as unknown as Partial<Command>[];
		for (const input of inputs) {
			expect(commandToProtocol(input)).toEqual(sharedCommandToProtocol(input));
		}
	});

	it("sorts commands through the store with the shared comparator", () => {
		setActivePinia(createPinia());
		const store = useCommandStore();
		store.replaceLoadedPageWindow([0], []);

		const items = [
			{ id: "b2", lamport: 3 },
			{ id: "a1", lamport: 1 },
			{ id: "c3", lamport: 2 },
			{ id: "a2", lamport: 1 },
			{ id: "B1", lamport: 1 },
		];
		for (const item of items) store.insertCommand(makeCommand(item.id, item.lamport, 0));

		const expected = [...items].sort(compareCommandOrder).map((item) => item.id);
		expect(store.commands.map((command) => command.id)).toEqual(expected);
		expect(expected[0]).toBe("B1");
		expect(expected.slice(1, 3)).toEqual(["a1", "a2"]);
	});
});
