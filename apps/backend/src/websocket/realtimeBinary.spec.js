const {
	encodeCmdUpdateBinary,
	encodeMouseMoveClientBinary,
	decodeRealtimeBinaryMessage,
	hasRealtimeBinaryMagic,
} = require("./realtimeBinary");

describe("backend realtime binary codec", () => {
	it("round trips client mouse move frames", () => {
		const payload = encodeMouseMoveClientBinary({ pageId: 2, x: 0.25, y: 0.75 });

		expect(hasRealtimeBinaryMagic(payload)).toBe(true);
		expect(decodeRealtimeBinaryMessage(payload)).toMatchObject({
			type: "mouseMove",
			data: {
				pageId: 2,
				x: expect.closeTo(0.25, 5),
				y: expect.closeTo(0.75, 5),
				__binary: true,
			},
		});
	});

	it("round trips command update frames", () => {
		const payload = encodeCmdUpdateBinary({
			cmdId: "cmd-1",
			points: [{ x: 0.1, y: 0.2, p: 0.5, lamport: 42 }],
		});

		expect(decodeRealtimeBinaryMessage(payload)).toMatchObject({
			type: "cmd-update",
			data: {
				cmdId: "cmd-1",
				points: [
					{
						x: expect.closeTo(0.1, 5),
						y: expect.closeTo(0.2, 5),
						p: expect.closeTo(0.5, 5),
						lamport: 42,
					},
				],
				__binary: true,
			},
		});
	});
});
