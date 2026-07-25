import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "@collaborative-whiteboard/shared";
import { canvasRef, filterDirtyRenderPoints } from "./canvas";
import { getCommandDirtyRect } from "./commandDirtyRect";

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
	box: { minX: 0.25, minY: 0.25, maxX: 0.5, maxY: 0.5, width: 0.25, height: 0.25 },
	...overrides,
});

describe("command dirty rect", () => {
	afterEach(() => {
		canvasRef.value = null;
	});

	it("converts normalized command boxes into logical canvas bounds", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 1000;
		canvas.height = 500;
		canvasRef.value = canvas;

		expect(getCommandDirtyRect(command({ size: 4 }))).toEqual({
			minX: 236,
			minY: 111,
			maxX: 514,
			maxY: 264,
			width: 278,
			height: 153,
			candidateCommandIds: ["cmd-1"],
		});
	});

	it("ignores commands that cannot affect the canvas", () => {
		canvasRef.value = document.createElement("canvas");

		expect(getCommandDirtyRect(command({ type: "clear" }))).toBeNull();
		expect(getCommandDirtyRect(command({ box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 } }))).toBeNull();
	});

	it("includes a command whose segment crosses the dirty rect without a sample inside it", () => {
		const points = [
			{ x: 0.1, y: 0.5, p: 0.5, lamport: 1, cmdId: "crossing", pageId: 0, userId: "user-1", tool: "pen" as const, color: "#000", size: 3, isDeleted: false },
			{ x: 0.9, y: 0.5, p: 0.5, lamport: 2, cmdId: "crossing", pageId: 0, userId: "user-1", tool: "pen" as const, color: "#000", size: 3, isDeleted: false },
		];

		expect(
			filterDirtyRenderPoints(
				points,
				{ minX: 490, minY: 240, width: 20, height: 20 },
				1000,
				500,
				undefined,
				0
			)
		).toHaveLength(2);
	});
});
