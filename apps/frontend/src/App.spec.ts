import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App.vue";
import { roomTransition } from "./states/roomTransitionState";

describe("App.vue", () => {
	afterEach(() => {
		roomTransition.abortRoomTransition();
	});

	it("renders RouterView, RoomTransitionCurtain, and Toaster", async () => {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{ path: "/", component: { template: "<div>HomeStub</div>" } }],
		});
		router.push("/");
		await router.isReady();

		const wrapper = mount(App, {
			global: { plugins: [router] },
		});
		expect(wrapper.text()).toContain("HomeStub");

		roomTransition.notifyRoomMounted({ roomId: "123456" });
		await flushPromises();
		expect(wrapper.find('[role="status"]').text()).toContain("正在准备画布");
		wrapper.unmount();
	});
});
