import { describe, expect, it } from "vitest";
import type { Command } from "@collaborative-whiteboard/shared";
import { encodeSceneAppendBinary } from "./realtimeBinary";

describe("V2 append binary frame", () => {
	it("preserves operation metadata and float64 points", () => {
		const command = { sceneOperation: { kind: "element.append", payload: { sourceStart: 4, points: [{ x: 0.125, y: 0.25, p: 0.5, lamport: 42 }], isComplete: true } } } as Command;
		const frame = encodeSceneAppendBinary({ cmd: command });
		const view = new DataView(frame);
		expect(view.getUint32(0)).toBe(0x41563250);
		const length = view.getUint32(4);
		expect(view.getUint32(8)).toBe(1);
		const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 12, length)));
		expect(metadata.cmd.sceneOperation.payload).toEqual({ sourceStart: 4, points: [], isComplete: true });
		expect([0, 8, 16, 24].map((offset) => view.getFloat64(12 + length + offset))).toEqual([0.125, 0.25, 0.5, 42]);
	});
});
