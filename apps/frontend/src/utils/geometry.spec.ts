import { describe, expect, it } from "vitest";
import { getCommandBoundingBox, getGroupBoundingBox } from "./geometry";
import type { Command } from "./type";

const command = (overrides: Partial<Command>): Command => ({
	id: "cmd-1",
	type: "path",
	points: [],
	timestamp: 0,
	userId: "user-1",
	roomId: "room-1",
	pageId: 0,
	isDeleted: false,
	lamport: 1,
	box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
	...overrides,
});

describe("geometry helpers", () => {
	it("calculates command bounds with padding", () => {
		expect(
			getCommandBoundingBox(
				command({
					points: [
						{ x: 0.2, y: 0.4, p: 0.5, lamport: 1 },
						{ x: 0.7, y: 0.1, p: 0.5, lamport: 2 },
					],
				}),
				0.1
			)
		).toEqual({
			minX: 0.1,
			minY: 0,
			maxX: 0.7999999999999999,
			maxY: 0.5,
			width: 0.7,
			height: 0.5,
		});
	});

	it("ignores deleted and off-page commands in group bounds", () => {
		const commands = [
			command({ id: "a", points: [{ x: 0.1, y: 0.2, p: 1, lamport: 1 }] }),
			command({
				id: "b",
				isDeleted: true,
				points: [{ x: 0.9, y: 0.9, p: 1, lamport: 1 }],
			}),
			command({
				id: "c",
				pageId: 1,
				points: [{ x: 0.8, y: 0.8, p: 1, lamport: 1 }],
			}),
		];

		expect(getGroupBoundingBox(new Set(["a", "b", "c"]), commands, 0)).toMatchObject({
			minX: 0.1,
			minY: 0.2,
			maxX: 0.1,
			maxY: 0.2,
			width: 0,
			height: 0,
		});
	});
});
