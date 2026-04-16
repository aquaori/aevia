// File role: page-facing command controller that wraps local command actions and user feedback.
import { toast } from "vue-sonner";
import type { Ref } from "vue";
import type { Command } from "../utils/type";
import { useRoomSessionEmitHook } from "../service/roomSessionContext";

interface LocalCommandServiceLike {
	pushCommand: (
		cmdPartial: Partial<Command>,
		type?: "normal" | "start" | "update" | "stop"
	) => { ok: boolean; error?: string; command?: Command };
	undo: () => { ok: boolean; error?: string; command?: Command };
	redo: () => { ok: boolean; command?: Command };
	clearCanvas: () => { notice?: string; command?: Command };
}

interface RoomCommandControllerOptions {
	localCommandService: LocalCommandServiceLike;
	activeMenu: Ref<"pen" | "eraser" | "color" | "more" | null>;
}

export const createRoomCommandController = (options: RoomCommandControllerOptions) => {
	const emitHook = useRoomSessionEmitHook();
	const pushCommand = (
		cmdPartial: Partial<Command>,
		type: "normal" | "start" | "update" | "stop" = "normal"
	) => {
		if (type !== "update") {
			emitHook("command:before-apply", {
				command: cmdPartial as Command,
				source: "local",
			});
		}
		const result = options.localCommandService.pushCommand(cmdPartial, type);
		if (!result.ok && result.error) {
			toast.error(result.error);
			return;
		}
		if (result.command && type !== "update") {
			emitHook("command:applied", {
				command: result.command,
				source: "local",
			});
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
		emitHook("command:before-apply", {
			command: {
				type: "clear",
			} as Command,
			source: "local",
		});
		const result = options.localCommandService.clearCanvas();
		if (result.notice) {
			toast.info(result.notice);
		}
		if (result.command) {
			emitHook("command:applied", {
				command: result.command,
				source: "local",
			});
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

