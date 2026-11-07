import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiBaseUrl } from "../config/endpoints";

const axiosMock = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
}));

vi.mock("axios", () => ({ default: axiosMock }));

import {
	fetchProtectedPageOverview,
	generateShareInvite,
	getInviteMeta,
	renewRoomSession,
} from "./sessionApi";

describe("session API", () => {
	beforeEach(() => {
		axiosMock.get.mockReset();
		axiosMock.post.mockReset();
	});

	it("fetches invite metadata with an encoded invite token", async () => {
		const payload = {
			roomId: "room-1",
			roomName: "Room",
			roomCreatedAt: 1700000000000,
			passwordRequired: false,
		};
		axiosMock.get.mockResolvedValue({ data: { data: payload } });

		await expect(getInviteMeta("invite token/1")).resolves.toEqual(payload);
		expect(axiosMock.get).toHaveBeenCalledWith(
			`${apiBaseUrl}/get-token-info?token=${encodeURIComponent("invite token/1")}`
		);
	});

	it("renews a room session with the bearer token header", async () => {
		const payload = { sessionToken: "next-token", expiresAt: 1700000001000 };
		axiosMock.post.mockResolvedValue({ data: { data: payload } });

		await expect(renewRoomSession("session-token")).resolves.toEqual(payload);
		expect(axiosMock.post).toHaveBeenCalledWith(
			`${apiBaseUrl}/renew-room-session`,
			{},
			{ headers: { Authorization: "Bearer session-token" } }
		);
	});

	it("generates a share invite for an encoded room id", async () => {
		const payload = { inviteToken: "invite-token", passwordRequired: true };
		axiosMock.get.mockResolvedValue({ data: { data: payload } });

		await expect(generateShareInvite("room/1", "session-token")).resolves.toEqual(payload);
		expect(axiosMock.get).toHaveBeenCalledWith(
			`${apiBaseUrl}/generate-share-token?roomId=${encodeURIComponent("room/1")}`,
			{ headers: { Authorization: "Bearer session-token" } }
		);
	});

	it("fetches the protected page overview and unwraps the data envelope", async () => {
		axiosMock.get.mockResolvedValue({ data: { data: { totalPage: 2, pages: [] } } });

		await expect(fetchProtectedPageOverview("room-1", "session-token")).resolves.toEqual({
			totalPage: 2,
			pages: [],
		});
		expect(axiosMock.get).toHaveBeenCalledWith(
			`${apiBaseUrl}/get-page-review?roomId=${encodeURIComponent("room-1")}`,
			{ headers: { Authorization: "Bearer session-token" } }
		);

		axiosMock.get.mockResolvedValue({ data: null });
		await expect(fetchProtectedPageOverview("room-1", "session-token")).resolves.toEqual({});
	});

	it("propagates 401/403 failures unchanged for transport-level handling", async () => {
		axiosMock.post.mockRejectedValue({ response: { status: 401 } });
		await expect(renewRoomSession("expired")).rejects.toMatchObject({ response: { status: 401 } });

		axiosMock.get.mockRejectedValue({ response: { status: 403 } });
		await expect(generateShareInvite("room", "expired")).rejects.toMatchObject({
			response: { status: 403 },
		});
	});
});
