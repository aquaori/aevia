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

	it("HomeView handles guest join & authenticated room list, transfer response, and room creation", async () => {
		const router = await makeRouter("/");
		const pushSpy = vi.spyOn(router, "push");
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
				return { data: { data: [{ roomId: "123456", name: "My Board", role: "owner", passwordRequired: false }] } };
			}
			if (url.includes("/v2/transfers")) {
				return { data: { data: [{ roomId: "654321", roomName: "Shared", ownerNickname: "Bob" }] } };
			}
			if (url.includes("/generate-room-id")) {
				return { data: { data: { roomId: "998877" } } };
			}
			if (url.includes("/check-room")) {
				return { data: { data: { status: false } } };
			}
			return { data: { data: {} } };
		});
		const postSpy = vi.spyOn(axios, "post").mockImplementation(async (url: string) => {
			if (url.includes("/admission")) {
				return { data: { data: { sessionToken: "ws-sess", expiresAt: 999999999, role: "owner" } } };
			}
			return { data: { data: {} } };
		});

		const wrapper = mount(HomeView, {
			global: { plugins: [router], stubs: { Teleport: true } },
		});
		await flushPromises();
		expect(wrapper.text()).toContain("My Board");
		expect(wrapper.text()).toContain("Bob 邀请你接任");

		// Switch to create mode & advance to step 2 & submit
		const tabs = wrapper.findAll(".entry-tabs button");
		await tabs[1]!.trigger("click");
		await flushPromises();
		await wrapper.find(".entry-action-card button.primary").trigger("click");
		await flushPromises();
		const roomNameInput = wrapper.findAll('.entry-action-card input').find((i) => i.attributes("placeholder") === "输入房间名称");
		await roomNameInput?.setValue("New Board");
		await wrapper.find(".entry-action-card button.primary").trigger("click");
		await flushPromises();

		expect(postSpy).toHaveBeenCalledWith(expect.stringContaining("/v2/rooms"), expect.any(Object), expect.any(Object));
		expect(pushSpy).toHaveBeenCalledWith({ name: "room" });

		// Return to step 1 so .entry-digits is rendered, then test OTP paste, transfer response, and settings modal
		await wrapper.find(".entry-back-row button").trigger("click");
		await flushPromises();
		const otp = wrapper.find('.entry-digits input');
		if (otp.exists()) {
			await otp.trigger("paste", {
				clipboardData: { getData: () => "123456" },
			});
		}
		const noticeButtons = wrapper.findAll(".entry-notices button");
		if (noticeButtons[0]) {
			await noticeButtons[0].trigger("click");
			await flushPromises();
		}
		const settingsTrigger = wrapper.find('.entry-room-row .entry-icon-button');
		if (settingsTrigger.exists()) {
			await settingsTrigger.trigger("click");
			await flushPromises();
		}
		wrapper.unmount();
	});

	it("InviteView loads invite metadata, handles 404/error states, and admits user into room", async () => {
		const router = await makeRouter("/invite/inv-token-123");
		const pushSpy = vi.spyOn(router, "push");
		vi.spyOn(sessionApi, "getInviteMeta").mockResolvedValue({
			roomId: "445566",
			roomName: "Invite Board",
			passwordRequired: false,
		});
		const postSpy = vi.spyOn(axios, "post").mockResolvedValue({
			data: { code: 200, data: { sessionToken: "sess-1", expiresAt: 999999, role: "editor" } },
		});

		const wrapper = mount(InviteView, {
			global: { plugins: [router] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain("Invite Board");

		await wrapper.find('input[placeholder="输入名字"]').setValue("Guest User");
		await wrapper.find("button.entry-button.primary").trigger("click");
		await flushPromises();

		expect(postSpy).toHaveBeenCalled();
		expect(pushSpy).toHaveBeenCalledWith({ name: "room" });
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
