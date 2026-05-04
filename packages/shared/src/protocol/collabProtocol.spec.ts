import { describe, expect, it } from "vitest";
import {
	commandToProtocol,
	normalizeCommandsFromProtocol,
	normalizeLoadedPageIds,
	protocolPageToState,
	statePageToProtocol,
} from "./collabProtocol";

describe("collab protocol normalization", () => {
	it("normalizes page ids across protocol boundaries", () => {
		expect(protocolPageToState("3.9")).toBe(3.9);
		expect(protocolPageToState("bad")).toBe(0);
		expect(statePageToProtocol(3.9)).toBe(3);
		expect(statePageToProtocol(-2)).toBe(0);
	});

	it("deduplicates and sorts loaded page ids", () => {
		expect(normalizeLoadedPageIds(["2", 1, "2", -1, "bad"])).toEqual([0, 1, 2]);
	});

	it("normalizes command page ids without changing command payload shape", () => {
		const commands = normalizeCommandsFromProtocol([
			{ id: "a", type: "path", pageId: "4", points: [] },
		]);
		expect(commands[0]).toMatchObject({ id: "a", pageId: 4 });
		expect(commandToProtocol({ id: "a", pageId: 4.9 })).toMatchObject({ id: "a", pageId: 4 });
	});
});
