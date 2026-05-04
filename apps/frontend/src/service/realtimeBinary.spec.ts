import { describe, expect, it } from "vitest";
import {
	decodeRealtimeBinaryMessage,
	encodeCmdUpdateBinary,
	encodeMouseMoveBinary,
	hasRealtimeBinaryMagic,
} from "./realtimeBinary";

describe("frontend realtime binary codec", () => {
	it("encodes client mouse move frames with the realtime magic header", () => {
		const payload = encodeMouseMoveBinary({ pageId: 3, x: 0.25, y: 0.75 });

		expect(hasRealtimeBinaryMagic(payload)).toBe(true);
	});

	it("round trips command update frames", () => {
		const payload = encodeCmdUpdateBinary({
			cmdId: "cmd-1",
			points: [{ x: 0.1, y: 0.2, p: 0.5, lamport: 7 }],
		});

		expect(decodeRealtimeBinaryMessage(payload)).toMatchObject({
			type: "push-cmd",
			pushType: "update",
			data: {
				cmdId: "cmd-1",
				points: [
					{
						x: expect.closeTo(0.1, 5),
						y: expect.closeTo(0.2, 5),
						p: expect.closeTo(0.5, 5),
						lamport: 7,
					},
				],
			},
		});
	});
});
