// File role: room lifecycle coordinator for mounting session resources and wiring page-level listeners.
import { watch, type Ref } from "vue";
import { canvasRef, uiCanvasRef } from "../service/canvas";
import { useRoomSession } from "../service/roomSessionContext";

interface RoomLifecycleControllerOptions {
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
	const session = useRoomSession();
	let pointerLeaveHandler: (() => void) | null = null;
	let stopSelectionWatch: (() => void) | null = null;

	const mount = () => {
		if (canvasRef.value && uiCanvasRef.value) {
			session.mountCanvas({
				canvas: canvasRef.value,
				uiCanvas: uiCanvasRef.value,
			});
		}

		session.connect();
		options.roomCanvasOverlay.startLoop();
		window.addEventListener("resize", session.resize);
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
				session.emitHook("selection:changed", { ids });
			},
			{ deep: true }
		);
	};

	const unmount = () => {
		stopSelectionWatch?.();
		stopSelectionWatch = null;
		if (pointerLeaveHandler) {
			canvasRef.value?.removeEventListener("pointerleave", pointerLeaveHandler);
			pointerLeaveHandler = null;
		}
		options.roomCanvasOverlay.stopLoop();
		session.unmount();
		window.removeEventListener("resize", session.resize);
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

