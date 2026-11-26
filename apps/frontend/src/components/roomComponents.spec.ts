import axios from "axios";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountStore } from "../store/accountStore";
import type { PageOverviewItem } from "../service/pageOverviewService";
import AccountPanel from "./AccountPanel.vue";
import RoomConnectionOverlays from "./RoomConnectionOverlays.vue";
import RoomHeader from "./RoomHeader.vue";
import RoomInvites from "./RoomInvites.vue";
import RoomMemberList from "./RoomMemberList.vue";
import RoomPageOverview from "./RoomPageOverview.vue";
import RoomPagination from "./RoomPagination.vue";
import RoomSettings from "./RoomSettings.vue";
import RoomShortcutsDialog from "./RoomShortcutsDialog.vue";
import RoomSizePreview from "./RoomSizePreview.vue";
import RoomTextEditor from "./RoomTextEditor.vue";
import RoomToolbar from "./RoomToolbar.vue";
import RoomTransitionCurtain from "./RoomTransitionCurtain.vue";
import { roomTransition } from "../states/roomTransitionState";

vi.mock("vue-sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

describe("Room Vue components", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.clear();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
			configurable: true,
		});
	});

	afterEach(() => {
		roomTransition.abortRoomTransition();
		vi.restoreAllMocks();
	});

	it("AccountPanel opens dialog, switches mode, authenticates, updates nickname, and logs out", async () => {
		const store = useAccountStore();
		const authSpy = vi.spyOn(store, "authenticate").mockImplementation(async () => {
			store.token = "tok-a";
			store.account = { id: "u1", username: "alice", nickname: "Alice" };
		});
		const nickSpy = vi.spyOn(store, "setNickname").mockResolvedValue();
		const logoutSpy = vi.spyOn(store, "logout").mockImplementation(async () => {
			store.token = "";
			store.account = null;
		});

		const wrapper = mount(AccountPanel, {
			props: { inRoom: true },
			global: { stubs: { Teleport: true } },
		});

		await wrapper.find(".entry-account-trigger").trigger("click");
		expect(wrapper.text()).toContain("登录 Aevia");
		await wrapper.find(".entry-dialog-link").trigger("click");
		expect(wrapper.text()).toContain("创建账号");

		const inputs = wrapper.findAll("input");
		await inputs[0]!.setValue("alice");
		await inputs[1]!.setValue("password123");
		await inputs[2]!.setValue("Alice");
		await wrapper.find("form").trigger("submit");
		await flushPromises();
		expect(authSpy).toHaveBeenCalledWith("register", "alice", "password123", "Alice");
		expect(wrapper.emitted("authenticated")).toBeTruthy();

		// Now logged in
		await wrapper.find(".entry-account-trigger").trigger("click");
		await wrapper.find("input").setValue("Alice 2");
		await wrapper.find("button.entry-button.primary").trigger("click");
		await flushPromises();
		expect(nickSpy).toHaveBeenCalledWith("Alice 2");

		await wrapper.find(".entry-account-trigger").trigger("click");
		await wrapper.find(".entry-dialog-link").trigger("click");
		await flushPromises();
		expect(logoutSpy).toHaveBeenCalled();
	});

	it("RoomConnectionOverlays, RoomShortcutsDialog, and RoomSizePreview render states & emit handlers", async () => {
		const onRetry = vi.fn();
		const onBackHome = vi.fn();
		const overlay = mount(RoomConnectionOverlays, {
			props: {
				isReconnecting: true,
				reconnectCount: 2,
				maxReconnect: 5,
				reconnectFailed: true,
				reconnectFailureMessage: "Lost WS",
				onRetryReconnect: onRetry,
				onBackHome,
			},
		});
		expect(overlay.text()).toContain("第 2 / 5 次尝试");
		expect(overlay.text()).toContain("Lost WS");
		const buttons = overlay.findAll("button");
		await buttons[0]!.trigger("click");
		await buttons[1]!.trigger("click");
		expect(onBackHome).toHaveBeenCalled();
		expect(onRetry).toHaveBeenCalled();

		const onCloseShortcuts = vi.fn();
		const shortcuts = mount(RoomShortcutsDialog, {
			props: { visible: true, onClose: onCloseShortcuts },
		});
		expect(shortcuts.text()).toContain("快捷指令");
		await shortcuts.find("button").trigger("click");
		expect(onCloseShortcuts).toHaveBeenCalled();

		const sizePreview = mount(RoomSizePreview, {
			props: { visible: true, currentSize: 16, currentTool: "pen", currentColor: "#ef4444" },
		});
		expect(sizePreview.text()).toContain("16px");
	});

	it("RoomHeader, RoomPagination, RoomMemberList, and RoomPageOverview trigger actions", async () => {
		const headerFns = {
			onToggleMore: vi.fn(),
			onCopyLink: vi.fn(),
			onOpenMemberList: vi.fn(),
			onOpenRoomSettings: vi.fn(),
			onToggleShortcuts: vi.fn(),
		};
		const header = mount(RoomHeader, {
			props: {
				visible: true,
				canShare: true,
				canManageRoom: true,
				roomName: "Board 1",
				roomId: "123456",
				moreOpen: true,
				onlineCount: 3,
				hasCopied: false,
				...headerFns,
			},
		});
		expect(header.text()).toContain("Board 1");
		for (const btn of header.findAll("button")) {
			await btn.trigger("click");
		}
		expect(headerFns.onToggleMore).toHaveBeenCalled();

		const prevPage = vi.fn();
		const nextPage = vi.fn();
		const openOverview = vi.fn();
		const pagination = mount(RoomPagination, {
			props: {
				currentPageId: 1,
				totalPages: 2,
				showPageOverview: false,
				canEdit: true,
				prevPage,
				nextPage,
				openOverview,
			},
		});
		const pButtons = pagination.findAll("button");
		await pButtons[0]!.trigger("click");
		await pButtons[1]!.trigger("click");
		await pButtons[2]!.trigger("click");
		expect(prevPage).toHaveBeenCalled();
		expect(openOverview).toHaveBeenCalled();
		expect(nextPage).toHaveBeenCalled();

		const onGuestAction = vi.fn();
		const onCloseMembers = vi.fn();
		const members = mount(RoomMemberList, {
			props: {
				visible: true,
				onlineCount: 2,
				memberList: [
					["u1", "Owner"],
					["1234567890abcdef1234567890abcdef", "Guest"],
				],
				currentUserId: "u1",
				isOwner: true,
				onGuestAction,
				onClose: onCloseMembers,
			},
		});
		expect(members.text()).toContain("Guest");
		await members.findAll("button")[1]!.trigger("click");
		expect(onGuestAction).toHaveBeenCalledWith("1234567890abcdef1234567890abcdef", "viewer");

		const overviewFns = {
			onClose: vi.fn(),
			goToPage: vi.fn(),
			onAddPage: vi.fn(),
			onRetry: vi.fn(),
		};
		const overview = mount(RoomPageOverview, {
			props: {
				visible: true,
				totalPages: 2,
				currentPageId: 0,
				pages: [{ pageId: 0, revision: 1, title: "第 1 页", previewCommandCount: 3 } as unknown as PageOverviewItem],
				loading: false,
				error: "",
				canEdit: true,
				...overviewFns,
			},
		});
		await overview.findAll("button")[1]!.trigger("click");
		expect(overviewFns.goToPage).toHaveBeenCalledWith(0);
	});

	it("RoomInvites and RoomSettings load API data and perform management actions", async () => {
		const getSpy = vi.spyOn(axios, "get").mockImplementation(async (url: string) => {
			if (url.includes("/room-invites")) {
				return { data: { data: [{ id: "inv-1", expiresAt: 1800000000, createdAt: 1700000000 }] } };
			}
			if (url.includes("/generate-share-token")) {
				return { data: { data: { inviteToken: "share-tok" } } };
			}
			if (url.includes("/members")) {
				return {
					data: {
						data: [
							{ userId: "u1", username: "owner", nickname: "Owner", role: "owner", banned: false },
							{ userId: "u2", username: "mem", nickname: "Member", role: "editor", banned: false },
						],
					},
				};
			}
			if (url.includes("/settings")) {
				return {
					data: {
						data: {
							name: "Room Name",
							policy: { defaultRole: "editor", allowRoomCode: true, guestByCode: true, guestByInvite: true },
						},
					},
				};
			}
			return { data: { data: [] } };
		});
		const postSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: {} } });
		const patchSpy = vi.spyOn(axios, "patch").mockResolvedValue({ data: { data: {} } });
		const deleteSpy = vi.spyOn(axios, "delete").mockResolvedValue({ data: { data: {} } });

		const invitesWrapper = mount(RoomInvites, {
			props: { roomId: "880001", token: "tok" },
		});
		await flushPromises();
		expect(invitesWrapper.text()).toContain("撤销");
		const inviteBtns = invitesWrapper.findAll("button");
		await inviteBtns[1]!.trigger("click"); // create
		await flushPromises();
		await invitesWrapper.findAll("button")[2]?.trigger("click"); // revoke
		await flushPromises();
		expect(postSpy).toHaveBeenCalled();

		const settingsWrapper = mount(RoomSettings, {
			props: { roomId: "880001", roomName: "Old Name", role: "owner" },
			global: { stubs: { Teleport: true } },
		});
		await flushPromises();
		expect(getSpy).toHaveBeenCalled();

		await settingsWrapper.find("button.entry-button.primary").trigger("click");
		await flushPromises();
		expect(patchSpy).toHaveBeenCalled();

		// Trigger delete confirmation and confirm
		await settingsWrapper.find("button.entry-danger-link").trigger("click");
		await flushPromises();
		await settingsWrapper.find("button.entry-button.danger").trigger("click");
		await flushPromises();
		expect(deleteSpy).toHaveBeenCalled();

		// Exercise member role/kick/ban/transfer actions in RoomSettings
		const settingsActions = mount(RoomSettings, {
			props: { roomId: "880001", roomName: "Old Name", role: "owner" },
			global: { stubs: { Teleport: true } },
		});
		await flushPromises();
		const memberButtons = settingsActions.findAll(".entry-member-actions button");
		for (const btn of memberButtons) {
			await btn.trigger("click");
			await flushPromises();
		}
		if (settingsActions.find("button.entry-button.danger").exists()) {
			await settingsActions.find("button.entry-button.danger").trigger("click");
			await flushPromises();
		}
	});

	it("RoomTextEditor opens, formats, handles keydown, resize, IME, and remote patch; RoomToolbar dispatches menus & slider", async () => {
		const onChange = vi.fn();
		const onStyleChange = vi.fn();
		const onBoxChange = vi.fn(() => true);
		const editorWrapper = mount(RoomTextEditor, {
			global: { stubs: { Teleport: true } },
		});
		const vm = editorWrapper.vm as unknown as {
			open: (input: Record<string, unknown>) => Promise<string | null>;
			notifyRemotePatch: (id: string) => void;
			submit: () => void;
		};
		let remoteText = "hello";
		const promise = vm.open({
			kind: "text",
			elementId: "txt-1",
			box: { minX: 0.1, minY: 0.1, maxX: 0.4, maxY: 0.3, width: 0.3, height: 0.2 },
			initialText: "hello",
			getCanvasRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
			onChange,
			onStyleChange,
			onRemoteText: () => remoteText,
			onBoxChange,
		});
		await flushPromises();
		await editorWrapper.find('button[aria-label="增大字号"]').trigger("click");
		await editorWrapper.find('button[aria-label="粗体"]').trigger("click");
		await editorWrapper.find('button[aria-label="居中"]').trigger("click");
		expect(onStyleChange).toHaveBeenCalled();

		// Resize handle pointer drag
		const handle = editorWrapper.find(".selection-handle");
		await handle.trigger("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
		window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 130, clientY: 120 }));
		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 130, clientY: 120 }));
		expect(onBoxChange).toHaveBeenCalled();

		// Remote patch sync & IME composition
		remoteText = "hello world";
		vm.notifyRemotePatch("txt-1");
		const textarea = editorWrapper.find("textarea");
		await textarea.trigger("compositionstart");
		await textarea.trigger("compositionend");
		await textarea.setValue("updated");
		await textarea.trigger("input");
		await textarea.trigger("keydown", { key: "Enter", ctrlKey: true });
		expect(await promise).toBe("updated");

		// Escape cancels sticky note editor
		const stickyPromise = vm.open({
			kind: "sticky",
			elementId: "stk-1",
			box: { minX: 0.2, minY: 0.2, maxX: 0.4, maxY: 0.4, width: 0.2, height: 0.2 },
			getCanvasRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
		});
		await flushPromises();
		await editorWrapper.find("textarea").trigger("keydown", { key: "Escape" });
		expect(await stickyPromise).toBeNull();

		const baseToolbarProps = {
			activeMenu: "pen" as "pen" | "eraser" | "color" | "more" | null,
			currentTool: "pen" as const,
			currentColor: "#000000",
			currentSize: 5,
			currentStrokePattern: "solid" as const,
			currentSticker: "✨",
			isFullscreen: false,
			isToolbarCollapsed: false,
			toggleFullscreen: vi.fn(),
			toggleMenu: vi.fn(),
			setTool: vi.fn(),
			setColor: vi.fn(),
			setStrokePattern: vi.fn(),
			setSticker: vi.fn(),
			clearCanvas: vi.fn(),
			undo: vi.fn(),
			redo: vi.fn(),
			updateCurrentSize: vi.fn(),
			setSizePreview: vi.fn(),
			onToggleCollapsed: vi.fn(),
		};
		for (const activeMenu of ["pen", "eraser", "color", "more"] as const) {
			const toolbar = mount(RoomToolbar, { props: { ...baseToolbarProps, activeMenu } });
			for (const btn of toolbar.findAll("button")) {
				await btn.trigger("click");
			}
			const range = toolbar.find('input[type="range"]');
			if (range.exists()) {
				await range.setValue("14");
				await range.trigger("input");
				await range.trigger("change");
			}
			const track = toolbar.find(".slider-track");
			if (track.exists()) {
				vi.spyOn(track.element as HTMLElement, "getBoundingClientRect").mockReturnValue({
					left: 0,
					top: 0,
					width: 200,
					height: 40,
					right: 200,
					bottom: 40,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				});
				await track.trigger("mousedown", { clientX: 190 });
				window.dispatchEvent(new MouseEvent("mouseup"));
			}
			toolbar.unmount();
		}
		const collapsed = mount(RoomToolbar, { props: { ...baseToolbarProps, isToolbarCollapsed: true } });
		await collapsed.find("button").trigger("click");
		expect(baseToolbarProps.onToggleCollapsed).toHaveBeenCalledWith(false);
		collapsed.unmount();
	});

	it("RoomTransitionCurtain renders frosted hanging signboard with benchmark status text and backstage Easter eggs", async () => {
		const wrapper = mount(RoomTransitionCurtain);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);

		roomTransition.notifyRoomMounted({ roomId: "445566", roomName: "Studio Board" });
		await flushPromises();

		const status = wrapper.find('[role="status"]');
		expect(status.exists()).toBe(true);
		expect(status.text()).toContain("正在准备画布");
		expect(status.text()).toContain("Studio Board · #445·566");
		expect(wrapper.find(".af-egg-roller").exists()).toBe(true);
		expect(wrapper.findAll(".af-egg-knock")).toHaveLength(2);
		expect(wrapper.findAll(".af-egg-worker")).toHaveLength(2);
		expect(wrapper.findAll(".af-egg-sticky")).toHaveLength(2);

		roomTransition.notifyRoomSceneReady();
		await flushPromises();
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
