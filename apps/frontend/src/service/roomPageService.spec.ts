import { ref, type Ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorTool } from "@collaborative-whiteboard/shared";

const emitHookMock = vi.hoisted(() => vi.fn());

vi.mock("./roomSessionContext", () => ({
	useRoomSessionEmitHook: () => emitHookMock,
}));

import { createRoomPageService } from "./roomPageService";

const createService = () => {
	const currentPageId = ref(0);
	const totalPages = ref(3);
	const loadedPageIds = ref([0, 1]);
	const username = ref("alice");
	const userId = ref("u1");
	const currentTool = ref<EditorTool>("pen");
	const send = vi.fn<(type: string, data: unknown) => boolean>(() => true);
	const closeOverview = vi.fn();
	const renderCanvas = vi.fn();
	const setTool = vi.fn();

	const service = createRoomPageService({
		currentPageId,
		totalPages,
		loadedPageIds,
		username,
		userId,
		closeOverview,
		renderCanvas,
		setTool,
		currentTool,
		send,
	});

	return {
		service,
		currentPageId,
		totalPages,
		loadedPageIds,
		username,
		userId,
		currentTool,
		send,
		closeOverview,
		renderCanvas,
		setTool,
	};
};

describe("room page service", () => {
	beforeEach(() => {
		emitHookMock.mockReset();
	});

	it("requests a page change with the loaded page window and updates local state", () => {
		const fixture = createService();

		const result = fixture.service.goToPage(2);

		expect(result).toBe(true);
		expect(fixture.send).toHaveBeenCalledWith("page-change", {
			requestId: 1,
			pageId: 2,
			prevPageId: 0,
			nextPageId: 2,
			clientLoadedPageIds: [0, 1],
		});
		expect(fixture.currentPageId.value).toBe(2);
		expect(fixture.closeOverview).toHaveBeenCalledOnce();
		expect(fixture.renderCanvas).toHaveBeenCalledOnce();
		expect(fixture.setTool).toHaveBeenCalledWith("pen");
		expect(emitHookMock).toHaveBeenCalledWith("page:changed", { pageId: 2 });
		expect(fixture.service.getActivePageChangeRequestId()).toBe(1);
		expect(fixture.service.getActivePageChangeTargetId()).toBe(2);
	});

	it("reports the send failure while keeping the optimistic local page", () => {
		const fixture = createService();
		fixture.send.mockReturnValue(false);

		expect(fixture.service.goToPage(1)).toBe(false);
		expect(fixture.currentPageId.value).toBe(1);
		expect(fixture.service.getActivePageChangeRequestId()).toBe(1);
	});

	it("forces an empty client page window when resyncing the current page", () => {
		const fixture = createService();
		fixture.currentPageId.value = 2;

		fixture.service.requestCurrentPageResync();

		expect(fixture.send).toHaveBeenCalledWith(
			"page-change",
			expect.objectContaining({ pageId: 2, clientLoadedPageIds: [] })
		);
	});

	it("clamps remote total pages and only renders when not deferred", () => {
		const fixture = createService();

		fixture.service.applyRemotePageChange(4, 0);
		expect(fixture.totalPages.value).toBe(1);
		expect(fixture.currentPageId.value).toBe(4);
		expect(fixture.renderCanvas).toHaveBeenCalledOnce();
		expect(fixture.setTool).toHaveBeenCalledOnce();
		expect(emitHookMock).toHaveBeenCalledWith("page:changed", { pageId: 4 });

		fixture.service.applyRemotePageChange(2, 5, { deferRender: true });
		expect(fixture.totalPages.value).toBe(5);
		expect(fixture.currentPageId.value).toBe(2);
		expect(fixture.renderCanvas).toHaveBeenCalledOnce();
		expect(fixture.closeOverview).toHaveBeenCalledTimes(2);
	});

	it("clears the active request id only for the matching non-deferred acknowledgement", () => {
		const fixture = createService();
		fixture.service.goToPage(1);

		fixture.service.applyRemotePageChange(1, undefined, { deferRender: true, requestId: 1 });
		expect(fixture.service.getActivePageChangeRequestId()).toBe(1);

		fixture.service.applyRemotePageChange(1, undefined, { requestId: 99 });
		expect(fixture.service.getActivePageChangeRequestId()).toBe(1);

		fixture.service.applyRemotePageChange(1, undefined, { requestId: 1 });
		expect(fixture.service.getActivePageChangeRequestId()).toBeNull();
		expect(fixture.service.getActivePageChangeTargetId()).toBe(1);
	});

	it("clears active requests by id or unconditionally", () => {
		const fixture = createService();
		fixture.service.goToPage(0);
		fixture.service.clearActivePageChangeRequest(2);
		expect(fixture.service.getActivePageChangeRequestId()).toBe(1);

		fixture.service.clearActivePageChangeRequest();
		expect(fixture.service.getActivePageChangeRequestId()).toBeNull();
		expect(fixture.service.getActivePageChangeTargetId()).toBeNull();
	});

	it("ignores previous-page navigation at the first page", () => {
		const fixture = createService();

		expect(fixture.service.prevPage()).toBe(false);
		expect(fixture.send).not.toHaveBeenCalled();

		fixture.currentPageId.value = 1;
		expect(fixture.service.prevPage()).toBe(true);
		expect(fixture.send).toHaveBeenCalledWith("page-change", expect.objectContaining({ pageId: 0 }));
	});

	it("opens the next page, or adds a page when already on the last one", () => {
		const fixture = createService();
		fixture.currentPageId.value = 1;

		expect(fixture.service.nextPage()).toBe(true);
		expect(fixture.send).toHaveBeenCalledWith("page-change", expect.objectContaining({ pageId: 2 }));

		fixture.send.mockClear();
		fixture.currentPageId.value = 2;
		expect(fixture.service.nextPage()).toBe(true);
		expect(fixture.send).toHaveBeenNthCalledWith(1, "cmd-page-add", {
			userId: "u1",
			username: "alice",
			totalPages: 4,
		});
		expect(fixture.send).toHaveBeenNthCalledWith(2, "page-change", expect.objectContaining({ pageId: 3 }));
		expect(fixture.totalPages.value).toBe(4);
	});

	it("does not add a page when the create request is rejected", () => {
		const fixture = createService();
		fixture.currentPageId.value = 2;
		fixture.send.mockImplementation((type: string) => type !== "cmd-page-add");

		expect(fixture.service.nextPage()).toBe(false);
		expect(fixture.totalPages.value).toBe(3);
		expect(fixture.currentPageId.value).toBe(2);
	});

	it("unwraps array-shaped usernames for the page-add payload", () => {
		const fixture = createService();
		fixture.username = ref(["alice-array"]) as unknown as Ref<string>;
		const service = createRoomPageService({
			currentPageId: fixture.currentPageId,
			totalPages: fixture.totalPages,
			loadedPageIds: fixture.loadedPageIds,
			username: fixture.username,
			userId: fixture.userId,
			closeOverview: fixture.closeOverview,
			renderCanvas: fixture.renderCanvas,
			setTool: fixture.setTool,
			currentTool: fixture.currentTool,
			send: fixture.send,
		});

		service.addPageAndOpenLast();

		expect(fixture.send).toHaveBeenCalledWith(
			"cmd-page-add",
			expect.objectContaining({ username: "alice-array" })
		);
	});
});
