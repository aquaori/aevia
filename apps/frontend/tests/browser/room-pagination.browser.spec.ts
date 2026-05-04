import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import RoomPagination from "../../src/components/RoomPagination.vue";

describe("RoomPagination browser behavior", () => {
	it("emits page navigation actions through provided handlers", async () => {
		const prevPage = vi.fn();
		const nextPage = vi.fn();
		const openOverview = vi.fn();
		const wrapper = mount(RoomPagination, {
			props: {
				currentPageId: 1,
				totalPages: 3,
				showPageOverview: false,
				prevPage,
				nextPage,
				openOverview,
			},
			attachTo: document.body,
		});

		await wrapper.get('button[title="上一页"]').trigger("click");
		await wrapper.get('button[title="下一页"]').trigger("click");
		await wrapper.get('button[title="页面概览"]').trigger("click");

		expect(prevPage).toHaveBeenCalledTimes(1);
		expect(nextPage).toHaveBeenCalledTimes(1);
		expect(openOverview).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});
