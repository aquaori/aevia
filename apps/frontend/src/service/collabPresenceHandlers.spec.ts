import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteCursor } from "@collaborative-whiteboard/shared";
import type { CollabIncomingMessage } from "./collabDispatcherTypes";
import { createCollabPresenceHandlers } from "./collabPresenceHandlers";

const toastMock = vi.hoisted(() => ({
	info: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("vue-sonner", () => ({ toast: toastMock }));

const message = (type: string, data: Record<string, unknown> = {}) =>
	({ type, data } as unknown as CollabIncomingMessage);

const createOptions = () => {
	const userId = ref("me");
	const userName = ref("Me");
	const onlineCount = ref(1);
	const memberList = ref<[string, string][]>([]);
	const remoteCursors = ref<Map<string, RemoteCursor>>(new Map());
	const remoteSelectionRects = ref<Map<string, { x: number; y: number; w: number; h: number }>>(
		new Map()
	);
	return {
		userId,
		onlineCount,
		memberList,
		remoteCursors,
		remoteSelectionRects,
		options: {
			userId,
			username: userName,
			onlineCount,
			memberList,
			remoteCursors,
			remoteSelectionRects,
		},
	};
};

const pendingFrames: FrameRequestCallback[] = [];

const flushFrames = () => {
	while (pendingFrames.length > 0) {
		pendingFrames.shift()?.(performance.now());
	}
};

describe("collab presence handlers", () => {
	beforeEach(() => {
		pendingFrames.length = 0;
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			pendingFrames.push(callback);
			return pendingFrames.length;
		});
		vi.spyOn(Date, "now").mockReturnValue(1700000000000);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		toastMock.info.mockReset();
	});

	it("updates online count and keeps the member list deduplicated on join", () => {
		const { options, onlineCount, memberList } = createOptions();
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleOnlineCountChange(
			message("online-count-change", { onlineCount: 4, userId: "u2", userName: "Bob", type: "join" })
		);
		expect(onlineCount.value).toBe(4);
		expect(memberList.value).toEqual([["u2", "Bob"]]);
		expect(toastMock.info).toHaveBeenCalledWith("Bob 加入了房间");

		handlers.handleOnlineCountChange(
			message("online-count-change", { onlineCount: 5, userId: "u2", userName: "Bob", type: "join" })
		);
		expect(memberList.value).toEqual([["u2", "Bob"]]);
		expect(onlineCount.value).toBe(5);

		handlers.handleOnlineCountChange(
			message("online-count-change", { onlineCount: 4, userId: "u2", userName: "Bob", type: "leave" })
		);
		expect(memberList.value).toEqual([]);
		expect(toastMock.info).toHaveBeenCalledTimes(3);
	});

	it("does not toast for the local user's own join/leave events", () => {
		const { options, memberList } = createOptions();
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleOnlineCountChange(
			message("online-count-change", { onlineCount: 2, userId: "me", userName: "Me", type: "join" })
		);
		handlers.handleOnlineCountChange(
			message("online-count-change", { onlineCount: 1, userId: "me", userName: "Me", type: "leave" })
		);

		expect(toastMock.info).not.toHaveBeenCalled();
		// The self join was added, then the self leave removed it again.
		expect(memberList.value).toEqual([]);
	});

	it("batches cursor updates into one animation frame, keeping the last position per user", () => {
		const { options, remoteCursors } = createOptions();
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleMouseMove(message("mouseMove", { userId: "u2", userName: "Bob", x: 0.1, y: 0.2, pageId: 0 }));
		handlers.handleMouseMove(message("mouseMove", { userId: "u2", userName: "Bob", x: 0.3, y: 0.4, pageId: 1 }));
		handlers.handleMouseMove(message("mouseMove", { userId: "u3", userName: "Carol", x: 0.5, y: 0.6, pageId: 0 }));

		expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
		expect(remoteCursors.value.size).toBe(0);

		flushFrames();

		expect(remoteCursors.value.size).toBe(2);
		expect(remoteCursors.value.get("u2")).toMatchObject({
			userId: "u2",
			userName: "Bob",
			x: 0.3,
			y: 0.4,
			pageId: 1,
			lastUpdate: 1700000000000,
		});
		expect(remoteCursors.value.get("u3")?.x).toBe(0.5);
	});

	it("resolves the cursor name from the member list and assigns a stable color", () => {
		const { options, memberList, remoteCursors } = createOptions();
		memberList.value = [["u3", "Carol"]];
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleMouseMove(message("mouseMove", { userId: "u3", userName: "", x: 0.1, y: 0.1, pageId: 0 }));
		handlers.handleMouseMove(message("mouseMove", { userId: "u3", userName: "", x: 0.2, y: 0.2, pageId: 0 }));
		handlers.handleMouseMove(message("mouseMove", { userId: "unknown-user", userName: "", x: 0.3, y: 0.3, pageId: 0 }));
		flushFrames();

		const carol = remoteCursors.value.get("u3");
		expect(carol?.userName).toBe("Carol");
		expect(carol?.color).toMatch(/^#[0-9a-f]{6}$/);
		expect(remoteCursors.value.get("unknown-user")?.userName).toBe("unknown-user");

		handlers.handleMouseMove(message("mouseMove", { userId: "u3", userName: "", x: 0.4, y: 0.4, pageId: 0 }));
		flushFrames();
		expect(remoteCursors.value.get("u3")?.color).toBe(carol?.color);
	});

	it("clears cursor, pending frame update, and selection rect when a user leaves", () => {
		const { options, remoteCursors, remoteSelectionRects } = createOptions();
		remoteCursors.value.set("u2", {
			userId: "u2",
			userName: "Bob",
			x: 0.1,
			y: 0.1,
			pageId: 0,
			lastUpdate: 1,
		});
		remoteSelectionRects.value.set("u2", { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleMouseMove(message("mouseMove", { userId: "u2", userName: "Bob", x: 0.9, y: 0.9, pageId: 0 }));
		handlers.handleMouseLeave(message("mouseLeave", { userId: "u2" }));
		flushFrames();

		expect(remoteCursors.value.has("u2")).toBe(false);
		expect(remoteSelectionRects.value.has("u2")).toBe(false);
	});

	it("replaces the member list wholesale and falls back to an empty list", () => {
		const { options, memberList } = createOptions();
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleMemberList(message("get-member-list", { memberList: [["a", "A"], ["b", "B"]] }));
		expect(memberList.value).toEqual([["a", "A"], ["b", "B"]]);

		handlers.handleMemberList(message("get-member-list"));
		expect(memberList.value).toEqual([]);
	});

	it("sets and clears remote selection rects", () => {
		const { options, remoteSelectionRects } = createOptions();
		const handlers = createCollabPresenceHandlers(options);

		handlers.handleBoxSelection(message("box-selection", { userId: "u2", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }));
		expect(remoteSelectionRects.value.get("u2")).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });

		handlers.handleBoxSelection(message("box-selection", { userId: "u2", rect: null }));
		expect(remoteSelectionRects.value.has("u2")).toBe(false);
	});
});
