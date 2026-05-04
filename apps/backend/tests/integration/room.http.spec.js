const request = require("supertest");
const app = require("../../src/app");

describe("room HTTP API", () => {
	it("creates and joins a passwordless room", async () => {
		const roomId = `vitest-${Date.now()}`;

		await request(app)
			.post("/create-room")
			.send({ roomId, roomName: "Vitest Room" })
			.expect(200)
			.expect((response) => {
				expect(response.body).toMatchObject({ code: 200, msg: "success" });
			});

		await request(app)
			.post("/join-room")
			.send({ roomId, userName: "Tester" })
			.expect(200)
			.expect((response) => {
				expect(response.body.data.sessionToken).toEqual(expect.any(String));
				expect(response.body.data.expiresAt).toEqual(expect.any(Number));
			});
	});

	it("generates room ids and rejects protected route calls without auth", async () => {
		await request(app)
			.get("/generate-room-id")
			.expect(200)
			.expect((response) => {
				expect(response.body.data.roomId).toMatch(/^\d{6}$/);
			});

		await request(app).get("/generate-share-token").query({ roomId: "missing" }).expect(401);
	});
});
