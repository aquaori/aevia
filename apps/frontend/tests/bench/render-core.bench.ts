import { bench, describe } from "vitest";
import { getCommandBoundingBox } from "../../src/utils/geometry";
import { encodeCmdUpdateBinary, decodeRealtimeBinaryMessage } from "../../src/service/realtimeBinary";
import type { Command } from "@collaborative-whiteboard/shared";

const points = Array.from({ length: 512 }, (_, index) => ({
	x: (index % 128) / 128,
	y: Math.floor(index / 128) / 4,
	p: 0.5,
	lamport: index,
}));

const command: Command = {
	id: "bench-command",
	type: "path",
	tool: "pen",
	color: "#111111",
	size: 4,
	points,
	timestamp: 0,
	userId: "bench-user",
	roomId: "bench-room",
	pageId: 0,
	isDeleted: false,
	lamport: 1,
	box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
};

const encoded = encodeCmdUpdateBinary({ cmdId: command.id, points });

describe("render core micro benchmarks", () => {
	bench("geometry bounding box", () => {
		getCommandBoundingBox(command, command.size);
	});

	bench("binary command encode", () => {
		encodeCmdUpdateBinary({ cmdId: command.id, points });
	});

	bench("binary command decode", () => {
		decodeRealtimeBinaryMessage(encoded);
	});
});
