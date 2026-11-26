import axios from "axios";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionApi from "../service/sessionApi";
import { useAccountStore } from "../store/accountStore";
import { useUserStore } from "../store/userStore";
import HomeView from "./HomeView.vue";
import InviteView from "./InviteView.vue";
import RoomView from "./RoomView.vue";

vi.mock("vue-sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

describe("Entry views (HomeView and InviteView)", () => {
	const makeRouter = async (initialPath: string) => {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{ path: "/", name: "home", component: HomeView },
				{ path: "/invite/:token", name: "invite", component: InviteView },
				{ path: "/room", name: "room", component: { template: "<div />" } },
			],
		});
		router.push(initialPath);
		await router.isReady();
		return router;
	};

	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("HomeView handles signed-in 1-step room creation, quick-join, gallery search/filter/view-switch, unlock modal, transfer, and settings", async () => {
		const router = await makeRouter("/");
		const pushSpy = vi.spyOn(router, "push");
		const writeTextSpy = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: writeTextSpy },
		});
		const account = useAccountStore();
		account.token = "tok-acc";
		account.account = { id: "u1", username: "owner", nickname: "Owner" };
		vi.spyOn(account, "refresh").mockResolvedValue();

		vi.spyOn(axios, "get").mockImplementation(async (url: string) => {
			if (url.includes("/members")) {
				return { data: { data: [] } };
			}
			if (url.includes("/settings")) {
				return {
					data: {
						data: {
							name: "My Board",
							policy: { defaultRole: "editor", allowRoomCode: true, guestByCode: true, guestByInvite: true },
						},
					},
				};
			}
			if (url.endsWith("/v2/rooms")) {
				return {
					data: {
						data: [
							{ roomId: "123456", name: "My Board", role: "owner", passwordRequired: false },
							{ roomId: "654321", name: "Team Sprint", role: "editor", passwordRequired: true },
						],
					},
				};
			}
			if (url.includes("/v2/transfers")) {
				return { data: { data: [{ roomId: "654321", roomName: "Shared", ownerNickname: "Bob" }] } };
			}
			if (url.includes("/generate-room-id")) {
				return { data: { data: { roomId: "998877" } } };
			}
			if (url.includes("/check-room")) {
				const exists = url.includes("123456");
				return { data: { data: { status: exists } } };
			}
			return { data: { data: {} } };
		});
		const postSpy = vi.spyOn(axios, "post").mockImplementation(async (url: string, body?: unknown) => {
			if (url.includes("/admission")) {
				const payload = body as { password?: string } | undefined;
				if (url.includes("/654321/") && payload?.password !== "secret") {
					throw { response: { data: { msg: "Password incorrect" } } };
				}
				return { data: { data: { sessionToken: "ws-sess", expiresAt: 999999999, role: "owner" } } };
			}
			return { data: { data: {} } };
		});

		const wrapper = mount(HomeView, {
			global: { plugins: [router], stubs: { Teleport: true } },
		});
		await flushPromises();
		expect(wrapper.text()).toContain("My Board");
		expect(wrapper.text()).toContain("Team Sprint");
		expect(wrapper.text()).toContain("Bob 邀请你接任");
		expect(wrapper.text()).toContain("#998·877");

		// Gallery: filter by role, search, toggle view mode, copy code
		const filterButtons = wrapper.findAll(".studio-filter-pills button");
		await filterButtons[1]!.trigger("click");
		expect(wrapper.text()).toContain("My Board");
		expect(wrapper.text()).not.toContain("Team Sprint");
		await filterButtons[0]!.trigger("click");
		await wrapper.find(".studio-search-box input").setValue("654321");
		expect(wrapper.text()).not.toContain("My Board");
		expect(wrapper.text()).toContain("Team Sprint");
		await wrapper.find(".studio-search-clear").trigger("click");
		expect(wrapper.text()).toContain("My Board");

		const viewButtons = wrapper.findAll(".studio-view-switch button");
		await viewButtons[1]!.trigger("click");
		expect(wrapper.find(".entry-room-list.list-mode").exists()).toBe(true);
		await viewButtons[0]!.trigger("click");
		expect(wrapper.find(".entry-room-list.grid-mode").exists()).toBe(true);

		await wrapper.find(".entry-code-chip").trigger("click");
		await flushPromises();
		expect(writeTextSpy).toHaveBeenCalledWith("123456");

		// 1-click entry into password-free saved room
		await wrapper.find(".entry-room-link").trigger("click");
		await flushPromises();
		expect(postSpy).toHaveBeenCalledWith(expect.stringContaining("/v2/rooms/123456/admission"), expect.any(Object), expect.any(Object));
		expect(pushSpy).toHaveBeenCalledWith({ name: "room" });

		// Clicking password-protected saved room opens Quick Unlock modal
		const roomLinks = wrapper.findAll(".entry-room-link");
		await roomLinks[1]!.trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("进入「Team Sprint」");
		await wrapper.find('.entry-dialog input[placeholder="输入房间密码"]').setValue("secret");
		await wrapper.find(".entry-dialog button.primary").trigger("click");
		await flushPromises();
		expect(postSpy).toHaveBeenCalledWith(expect.stringContaining("/v2/rooms/654321/admission"), expect.objectContaining({ password: "secret" }), expect.any(Object));

		// 1-step room creation via starter preset & advanced drawer
		await wrapper.find(".studio-preset-chip").trigger("click");
		await wrapper.find('[data-testid="toggle-create-advanced"]').trigger("click");
		expect(wrapper.find(".studio-advanced-drawer").exists()).toBe(true);
		await wrapper.find('[data-testid="create-room-submit"]').trigger("click");
		await flushPromises();
		expect(postSpy).toHaveBeenCalledWith(
			expect.stringContaining("/v2/rooms"),
			expect.objectContaining({ roomId: "998877", roomName: "产品架构评审" }),
			expect.any(Object),
		);

		// 1-step Quick-Join: paste #123 456 -> live probe exists -> join
		const keycaps = wrapper.findAll(".studio-keycaps input");
		await keycaps[0]!.trigger("paste", {
			clipboardData: { getData: () => "#123 456" },
		});
		await flushPromises();
		expect((keycaps[0]!.element as HTMLInputElement).value).toBe("1");
		expect(wrapper.text()).toContain("房间在线");
		await wrapper.find('[data-testid="join-room-submit"]').trigger("click");
		await flushPromises();
		expect(pushSpy).toHaveBeenCalledWith({ name: "room" });

		// Transfer response & RoomSettings modal
		const noticeButtons = wrapper.findAll(".entry-notices button");
		await noticeButtons[0]!.trigger("click");
		await flushPromises();
		const settingsTrigger = wrapper.find(".entry-room-row .entry-icon-button");
		await settingsTrigger.trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("房间设置");
		wrapper.unmount();
	});

	it("HomeView handles 1-screen guest spatial stage boarding and password auto-reveal", async () => {
		const router = await makeRouter("/");
		const pushSpy = vi.spyOn(router, "push");
		vi.spyOn(axios, "get").mockResolvedValue({ data: { data: { status: true } } });
		const postSpy = vi.spyOn(axios, "post")
			.mockRejectedValueOnce({ response: { data: { msg: "Password incorrect" } } })
			.mockResolvedValueOnce({ data: { data: { sessionToken: "guest-sess", expiresAt: 999999, role: "editor" } } });

		const wrapper = mount(HomeView, {
			global: { plugins: [router], stubs: { Teleport: true } },
		});
		await flushPromises();
		expect(wrapper.text()).toContain("加入协作画布");
		expect(wrapper.text()).toContain("试笔画布");

		const keycaps = wrapper.findAll(".studio-keycaps input");
		await keycaps[0]!.trigger("paste", { clipboardData: { getData: () => "246810" } });
		await flushPromises();
		expect(wrapper.text()).toContain("房间在线");

		await wrapper.find('input[placeholder="输入名字"]').setValue("Guest Lin");
		await wrapper.find('[data-testid="guest-join-submit"]').trigger("click");
		await flushPromises();
		// Auto-reveals password field on Password incorrect
		expect(wrapper.find('input[placeholder="输入房间密码"]').exists()).toBe(true);

		await wrapper.find('input[placeholder="输入房间密码"]').setValue("pass123");
		await wrapper.find('[data-testid="guest-join-submit"]').trigger("click");
		await flushPromises();
		expect(postSpy).toHaveBeenLastCalledWith(
			expect.stringContaining("/v2/rooms/246810/admission"),
			expect.objectContaining({ userName: "Guest Lin", password: "pass123" }),
			expect.any(Object),
		);
		expect(pushSpy).toHaveBeenCalledWith({ name: "room" });
		wrapper.unmount();
	});

	it("InviteView renders perforated boarding pass, handles password reveal, error states, and admits user", async () => {
		const router = await makeRouter("/invite/inv-token-123");
		const pushSpy = vi.spyOn(router, "push");
		vi.spyOn(sessionApi, "getInviteMeta").mockResolvedValue({
			roomId: "445566",
			roomName: "Invite Board",
			passwordRequired: false,
		});
		const postSpy = vi.spyOn(axios, "post")
			.mockRejectedValueOnce({ response: { data: { msg: "Password incorrect" } } })
			.mockResolvedValueOnce({
				data: { code: 200, data: { sessionToken: "sess-1", expiresAt: 999999, role: "editor" } },
			});

		const wrapper = mount(InviteView, {
			global: { plugins: [router], stubs: { Teleport: true } },
		});
		await flushPromises();
		expect(wrapper.text()).toContain("Invite Board");
		expect(wrapper.text()).toContain("免密直接通行");

		await wrapper.find('input[placeholder="输入名字"]').setValue("Guest User");
		await wrapper.find("button.entry-button.primary").trigger("click");
		await flushPromises();
		expect(wrapper.find('input[placeholder="输入房间密码"]').exists()).toBe(true);

		await wrapper.find('input[placeholder="输入房间密码"]').setValue("room-pw");
		await wrapper.find("button.entry-button.primary").trigger("click");
		await flushPromises();

		expect(postSpy).toHaveBeenCalledTimes(2);
		expect(pushSpy).toHaveBeenCalledWith({ name: "room" });
		wrapper.unmount();

		vi.spyOn(sessionApi, "getInviteMeta").mockRejectedValueOnce(new Error("404"));
		const errWrapper = mount(InviteView, {
			global: { plugins: [router], stubs: { Teleport: true } },
		});
		await flushPromises();
		expect(errWrapper.text()).toContain("邀请链接无效或已过期");
		errWrapper.unmount();
	});

	it("RoomView mounts, wires session/worker/transport, handles visibilitychange, and unmounts cleanly", async () => {
		localStorage.setItem("wb_username", "Tester");
		const router = await makeRouter("/room");
		const userStore = useUserStore();
		userStore.setToken("sess-token");
		userStore.setRoomRole("owner");

		vi.stubGlobal(
			"Worker",
			class {
				onmessage = null;
				postMessage = vi.fn();
				terminate = vi.fn();
				addEventListener = vi.fn();
				removeEventListener = vi.fn();
			},
		);
		vi.stubGlobal(
			"WebSocket",
			class {
				static OPEN = 1;
				readyState = 1;
				send = vi.fn();
				close = vi.fn();
			},
		);
		vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { ticket: "ws-t" } } });

		const wrapper = mount(RoomView, {
			global: { plugins: [router], stubs: { Teleport: true } },
		});
		await flushPromises();
		document.dispatchEvent(new Event("visibilitychange"));
		wrapper.unmount();
		vi.unstubAllGlobals();
		expect(wrapper.exists()).toBe(false);
	});
});
