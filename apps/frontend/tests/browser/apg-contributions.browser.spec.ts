import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import RoomToolbar from "../../src/components/RoomToolbar.vue";
import type { ApgBrushView, ApgPaletteView } from "../../src/service/apgCatalog";

const brushes: ApgBrushView[] = [
	{
		id: "soft-pencil",
		label: "Soft Pencil",
		base: "pencil",
		size: 5,
		opacity: 0.65,
		pluginId: "aevia.brushes",
		pluginName: "Aevia Drawing Presets",
	},
];

const palettes: ApgPaletteView[] = [
	{
		id: "studio",
		label: "Studio",
		colors: ["#111827", "#2563EB"],
		pluginId: "aevia.palette",
		pluginName: "Aevia Studio Palette",
		scope: "user",
		enabled: true,
		toggleable: true,
	},
];

const mountToolbar = (props: Record<string, unknown> = {}) => {
	const handlers = {
		activateApgBrush: vi.fn(),
		toggleApgPalette: vi.fn(),
		setColor: vi.fn(),
		setTool: vi.fn(),
		toggleMenu: vi.fn(),
		updateCurrentSize: vi.fn(),
		setSizePreview: vi.fn(),
		toggleFullscreen: vi.fn(),
		setStrokePattern: vi.fn(),
		setSticker: vi.fn(),
		clearCanvas: vi.fn(),
		undo: vi.fn(),
		redo: vi.fn(),
		onToggleCollapsed: vi.fn(),
	};
	const wrapper = mount(RoomToolbar, {
		props: {
			activeMenu: "pen",
			currentTool: "pen",
			currentColor: "#111827",
			currentSize: 4,
			currentStrokePattern: "solid",
			currentSticker: "",
			apgBrushes: brushes,
			apgPalettes: palettes,
			isFullscreen: false,
			isToolbarCollapsed: false,
			...handlers,
			...props,
		},
		attachTo: document.body,
	});
	return { wrapper, handlers };
};

describe("APG contribution rendering", () => {
	it("renders a contributed brush and dispatches its native style", async () => {
		const { wrapper, handlers } = mountToolbar();
		const brushButton = wrapper
			.findAll("button")
			.find((button) => button.text() === "Soft Pencil");
		expect(brushButton, "contributed brush button should render").toBeTruthy();
		expect(wrapper.text()).toContain("插件画笔");
		expect(brushButton?.attributes("title")).toBe("Aevia Drawing Presets");

		await brushButton?.trigger("click");
		expect(handlers.activateApgBrush).toHaveBeenCalledTimes(1);
		expect(handlers.activateApgBrush).toHaveBeenCalledWith(brushes[0]);
		// A contributed preset selects a native base tool; it does not add a new tool id.
		expect(handlers.setTool).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it("renders a user palette with working toggle and colour dispatch", async () => {
		const { wrapper, handlers } = mountToolbar({ activeMenu: "color" });

		expect(wrapper.text()).toContain("Studio");
		expect(wrapper.text()).toContain("Aevia Studio Palette");

		const swatches = wrapper
			.findAll("button")
			.filter((button) => button.attributes("style")?.includes("background-color"));
		const studioSwatches = swatches.filter((button) =>
			["rgb(17, 24, 39)", "rgb(37, 99, 235)"].includes(
				(button.element as HTMLElement).style.backgroundColor,
			),
		);
		expect(studioSwatches).toHaveLength(2);

		await studioSwatches[1].trigger("click");
		expect(handlers.setColor).toHaveBeenCalledWith("#2563EB");

		const toggle = wrapper
			.findAll("button")
			.find((button) => button.text() === "已启用");
		await toggle?.trigger("click");
		expect(handlers.toggleApgPalette).toHaveBeenCalledWith("aevia.palette", false);
		wrapper.unmount();
	});

	it("hides swatches for a disabled user palette but keeps the header", async () => {
		const { wrapper, handlers } = mountToolbar({
			activeMenu: "color",
			apgPalettes: [{ ...palettes[0], enabled: false }],
		});
		expect(wrapper.text()).toContain("Studio");
		expect(wrapper.text()).toContain("已停用");
		const studioSwatches = wrapper
			.findAll("button")
			.filter((button) =>
				["rgb(17, 24, 39)", "rgb(37, 99, 235)"].includes(
					(button.element as HTMLElement).style.backgroundColor,
				),
			);
		expect(studioSwatches).toHaveLength(0);
		// The disabled palette keeps its toggle, otherwise a personal palette could never be
		// turned back on without clearing browser storage.
		const toggle = wrapper.findAll("button").find((button) => button.text() === "已停用");
		await toggle?.trigger("click");
		expect(handlers.toggleApgPalette).toHaveBeenCalledWith("aevia.palette", true);
		wrapper.unmount();
	});
});
