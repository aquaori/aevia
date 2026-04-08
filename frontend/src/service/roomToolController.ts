// File role: toolbar behavior controller for tool menus, color menu, and size-preview toggles.
import type { Ref } from "vue";

type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;
type Tool = "pen" | "eraser" | "cursor";

interface RoomToolControllerOptions {
	activeMenu: Ref<ActiveMenu>;
	currentTool: Ref<Tool>;
	currentSize: Ref<number>;
	showSizePreview: Ref<boolean>;
	setTool: (tool: Tool) => void;
}

export const createRoomToolController = (options: RoomToolControllerOptions) => {
	const toggleMenu = (menu: Exclude<ActiveMenu, null>) => {
		if (menu === "pen" || menu === "eraser") {
			if (options.currentTool.value === menu) {
				options.activeMenu.value = options.activeMenu.value === menu ? null : menu;
			} else {
				options.setTool(menu);
				options.activeMenu.value = null;
			}
			return;
		}

		options.activeMenu.value = options.activeMenu.value === menu ? null : menu;
	};

	const updateCurrentSize = (size: number) => {
		options.currentSize.value = size;
	};

	const setSizePreview = (visible: boolean) => {
		options.showSizePreview.value = visible;
	};

	const openColorMenu = () => {
		options.activeMenu.value = "color";
	};

	return {
		toggleMenu,
		updateCurrentSize,
		setSizePreview,
		openColorMenu,
	};
};

