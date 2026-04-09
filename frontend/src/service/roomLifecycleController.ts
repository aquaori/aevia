// File role: room lifecycle coordinator for mounting session resources and wiring page-level listeners.
import { watch, type Ref } from "vue";
import { canvasRef, uiCanvasRef } from "./canvas";
import type { EditorHookMap, WhiteboardSession } from "../utils/editorTypes";
import { useLamportStore } from "../store/lamportStore";
import { resetBenchmarkRuntime, setRuntimeSnapshot } from "./benchmarkRuntime";

interface RoomLifecycleControllerOptions {
	session: WhiteboardSession;
	commands: unknown;
	currentColor: Ref<string>;
	roomCanvasOverlay: {
		startLoop: () => void;
		stopLoop: () => void;
	};
	roomKeyboardController: {
		mount: () => void;
		unmount: () => void;
	};
	roomHeaderController: {
		syncFullscreenState: () => void;
	};
	interactionController: {
		notifyPointerLeave: (
			send: (type: string, data: unknown) => boolean,
			payload: { userId: string; userName: string }
		) => void;
	};
	send: (type: string, data: unknown) => boolean;
	userId: Ref<string>;
	username: Ref<string>;
	selectedCommandIds: Ref<Set<string>>;
}

export const createRoomLifecycleController = (options: RoomLifecycleControllerOptions) => {
	let pointerLeaveHandler: (() => void) | null = null;
	let stopSelectionWatch: (() => void) | null = null;
	let stopCommandWatch: (() => void) | null = null;

	const mount = () => {
		if (typeof window !== "undefined") {
			resetBenchmarkRuntime();
			(window as any).__benchmarkCommands = options.commands;
			(window as any).__benchmarkLamportStore = useLamportStore();
			(window as any).__benchmarkCurrentColor = options.currentColor;
			setRuntimeSnapshot({
				commandCount: Array.isArray((options.commands as any).value)
					? (options.commands as any).value.length
					: 0,
			});
		}

		if (canvasRef.value && uiCanvasRef.value) {
			options.session.mountCanvas({
				canvas: canvasRef.value,
				uiCanvas: uiCanvasRef.value,
			});
		}

		options.session.connect();
		options.roomCanvasOverlay.startLoop();
		window.addEventListener("resize", options.session.resize);
		options.roomKeyboardController.mount();

		pointerLeaveHandler = () => {
			options.interactionController.notifyPointerLeave(options.send, {
				userId: options.userId.value,
				userName: options.username.value,
			});
		};
		canvasRef.value?.addEventListener("pointerleave", pointerLeaveHandler);
		document.addEventListener("fullscreenchange", options.roomHeaderController.syncFullscreenState);

		stopSelectionWatch = watch(
			() => Array.from(options.selectedCommandIds.value),
			(ids) => {
				options.session.emitHook("selection:changed", { ids });
			},
			{ deep: true }
		);
		stopCommandWatch = watch(
			() => (options.commands as any).value?.length ?? 0,
			(commandCount) => {
				const commands = ((options.commands as any).value ?? []) as Array<{ id: string }>;
				setRuntimeSnapshot({
					commandCount,
					lastCommandDigest: commands
						.map((command) => command.id)
						.join(",")
						.substring(0, 200),
				});
			},
			{ immediate: true }
		);
	};

	const unmount = () => {
		stopCommandWatch?.();
		stopCommandWatch = null;
		stopSelectionWatch?.();
		stopSelectionWatch = null;
		if (pointerLeaveHandler) {
			canvasRef.value?.removeEventListener("pointerleave", pointerLeaveHandler);
			pointerLeaveHandler = null;
		}
		options.roomCanvasOverlay.stopLoop();
		options.session.unmount();
		window.removeEventListener("resize", options.session.resize);
		options.roomKeyboardController.unmount();
		document.removeEventListener(
			"fullscreenchange",
			options.roomHeaderController.syncFullscreenState
		);
	};

	return {
		mount,
		unmount,
	};
};

