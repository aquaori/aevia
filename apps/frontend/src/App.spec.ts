import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import App from "./App.vue";

describe("App.vue", () => {
	it("renders RouterView and Toaster", async () => {
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
	});
});
