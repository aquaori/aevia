import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionApiMock = vi.hoisted(() => ({
	fetchProtectedPageOverview: vi.fn(),
}));

vi.mock("./sessionApi", () => sessionApiMock);

import { fetchPageOverview } from "./pageOverviewService";

describe("page overview service", () => {
	beforeEach(() => {
		sessionApiMock.fetchProtectedPageOverview.mockReset();
	});

	it("maps the page review payload into overview metadata", async () => {
		sessionApiMock.fetchProtectedPageOverview.mockResolvedValue({
			roomId: "room",
			totalPage: 3,
			pages: [
				{ pageId: 0, pageNumber: 1, collaboratorCount: 2 },
				{ pageId: 2, pageNumber: 3, collaboratorCount: 0 },
			],
		});

		const overview = await fetchPageOverview("room", "session-token");

		expect(sessionApiMock.fetchProtectedPageOverview).toHaveBeenCalledWith("room", "session-token");
		expect(overview).toEqual({
			totalPages: 3,
			pages: [
				{ pageId: 0, pageNumber: 1, collaboratorCount: 2 },
				{ pageId: 2, pageNumber: 3, collaboratorCount: 0 },
			],
		});
	});

	it("falls back to an empty overview when the payload has no data", async () => {
		sessionApiMock.fetchProtectedPageOverview.mockResolvedValue({});
		await expect(fetchPageOverview("room", "token")).resolves.toEqual({ totalPages: 0, pages: [] });

		sessionApiMock.fetchProtectedPageOverview.mockResolvedValue(undefined);
		await expect(fetchPageOverview("room", "token")).resolves.toEqual({ totalPages: 0, pages: [] });
	});

	it("propagates API failures so the caller can show an error state", async () => {
		sessionApiMock.fetchProtectedPageOverview.mockRejectedValue({
			response: { status: 403 },
		});

		await expect(fetchPageOverview("room", "token")).rejects.toMatchObject({
			response: { status: 403 },
		});
	});
});
