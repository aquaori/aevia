import { toast } from "vue-sonner";
import type { Ref } from "vue";
import type { Command } from "../utils/type";

interface LocalCommandServiceLike {
	pushCommand: (
		cmdPartial: Partial<Command>,
		type?: "normal" | "start" | "update" | "stop"
	) => { ok: boolean; error?: string };
	undo: () => { ok: boolean; error?: string };
	redo: () => void;
	clearCanvas: () => { notice?: string };
}

interface RoomCommandControllerOptions {
	localCommandService: LocalCommandServiceLike;
	activeMenu: Ref<"pen" | "eraser" | "color" | "more" | null>;
}

export const createRoomCommandController = (options: RoomCommandControllerOptions) => {
	const pushCommand = (
		cmdPartial: Partial<Command>,
		type: "normal" | "start" | "update" | "stop" = "normal"
	) => {
		const result = options.localCommandService.pushCommand(cmdPartial, type);
		if (!result.ok && result.error) {
			toast.error(result.error);
		}
	};

	const undo = () => {
		const result = options.localCommandService.undo();
		if (!result.ok && result.error) {
			toast.error(result.error);
		}
	};

	const redo = () => {
		options.localCommandService.redo();
	};

	const clearCanvas = () => {
		const result = options.localCommandService.clearCanvas();
		if (result.notice) {
			toast.info(result.notice);
		}
		options.activeMenu.value = null;
	};

	return {
		pushCommand,
		undo,
		redo,
		clearCanvas,
	};
};
