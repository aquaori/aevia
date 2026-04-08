// File role: top-level editor controller for tool switching, color changes, and transform finalization.
import type { Ref } from "vue";
import type { EditorHookMap } from "../utils/editorTypes";
import type { HandleType, InteractionMode, TransformAnimState } from "./roomInteractionState";

type Tool = "pen" | "eraser" | "cursor";
type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;

interface PointerControllerLike {
	setTool: (tool: Tool) => void;
	setColor: (color: string) => void;
	finalizeDrop: () => void;
}

interface RoomEditorControllerOptions {
	pointerController: Ref<PointerControllerLike | null>;
	currentTool: Ref<Tool>;
	currentColor: Ref<string>;
	activeMenu: Ref<ActiveMenu>;
	transformingCmdIds: Ref<Set<string>>;
	transformAnim: Ref<TransformAnimState | null>;
	renderCanvas: () => void;
	selectionRect: Ref<{ x: number; y: number; w: number; h: number } | null>;
	interactionMode: Ref<InteractionMode>;
	emitHook?: <K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => void;
}

export const createRoomEditorController = (options: RoomEditorControllerOptions) => {
	const setTool = (tool: Tool) => {
		if (options.pointerController.value) {
			options.pointerController.value.setTool(tool);
			options.emitHook?.("tool:changed", { tool });
			return;
		}
		options.currentTool.value = tool;
		options.activeMenu.value = null;
		if (tool !== "cursor") {
			options.selectionRect.value = null;
			options.interactionMode.value = "none";
		}
		options.emitHook?.("tool:changed", { tool });
	};

	const setColor = (color: string) => {
		if (options.pointerController.value) {
			options.pointerController.value.setColor(color);
			return;
		}
		options.currentColor.value = color;
		options.activeMenu.value = null;
	};

	const finalizeDrop = () => {
		if (options.pointerController.value) {
			options.pointerController.value.finalizeDrop();
			return;
		}
		options.transformingCmdIds.value.clear();
		options.transformAnim.value = null;
		options.renderCanvas();
	};

	return {
		setTool,
		setColor,
		finalizeDrop,
	};
};

