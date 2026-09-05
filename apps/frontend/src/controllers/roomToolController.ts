// File role: toolbar behavior controller for tool menus, color menu, and size-preview toggles.
import type { Ref } from "vue";
import type { EditorTool, StrokePattern } from "@collaborative-whiteboard/shared";

type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;
type Tool = EditorTool;

interface RoomToolControllerOptions {
	activeMenu: Ref<ActiveMenu>;
	headerMenuOpen: Ref<boolean>;
	currentTool: Ref<Tool>;
	currentSize: Ref<number>;
	currentStrokePattern: Ref<StrokePattern>;
	currentSticker: Ref<string>;
	showSizePreview: Ref<boolean>;
	setTool: (tool: Tool) => void;
}

export const createRoomToolController = (options: RoomToolControllerOptions) => {
	const toggleMenu = (menu: Exclude<ActiveMenu, null>) => {
		options.headerMenuOpen.value = false;
		if (menu === "pen" || menu === "eraser") {
			const currentMatches = menu === "pen"
				? ["pen", "pencil", "highlighter"].includes(options.currentTool.value)
				: ["eraser", "object-eraser"].includes(options.currentTool.value);
			if (currentMatches) {
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
		options.headerMenuOpen.value = false;
		options.activeMenu.value = "color";
	};

	const setStrokePattern = (pattern: StrokePattern) => {
		options.currentStrokePattern.value = pattern;
	};

	const setSticker = (sticker: string) => {
		options.currentSticker.value = sticker;
		options.setTool("sticker");
	};

	return {
		toggleMenu,
		updateCurrentSize,
		setSizePreview,
		openColorMenu,
		setStrokePattern,
		setSticker,
	};
};

