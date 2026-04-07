import { readonly, type ComputedRef, type Ref } from "vue";
import { canvasRef, ctx, uiCanvasRef, uiCtx } from "./canvas";
import { createEventBus } from "../utils/editorEventBus";
import type { EditorHookMap, WhiteboardSession, WhiteboardSessionState } from "../utils/editorTypes";

interface CreateWhiteboardSessionOptions {
	state: WhiteboardSessionState;
	canUndo: ComputedRef<boolean>;
	canRedo: ComputedRef<boolean>;
	initialize?: () => void;
	dispose?: () => void;
	connect: () => void;
	disconnect: () => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	undo: () => void;
	redo: () => void;
	goToPage: (page: number) => void;
	resize?: () => void;
	requestDirtyRender?: (rect: unknown) => void;
	requestRender: () => void;
	requestOverlayRender: () => void;
}

export const createWhiteboardSession = (
	options: CreateWhiteboardSessionOptions
): WhiteboardSession => {
	const events = createEventBus<EditorHookMap>();

	const emit = <K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => {
		events.emit(event, payload);
	};

	const mountCanvas = (input: { canvas: HTMLCanvasElement; uiCanvas: HTMLCanvasElement }) => {
		emit("session:before-init", undefined);
		canvasRef.value = input.canvas;
		uiCanvasRef.value = input.uiCanvas;
		ctx.value = input.canvas.getContext("2d");
		uiCtx.value = input.uiCanvas.getContext("2d");
		options.initialize?.();
		options.resize?.();
		emit("session:ready", undefined);
	};

	const unmount = () => {
		emit("session:before-destroy", undefined);
		options.disconnect();
		options.dispose?.();
		canvasRef.value = null;
		uiCanvasRef.value = null;
		ctx.value = null;
		uiCtx.value = null;
		events.clear();
	};

	const setTool = (tool: "pen" | "eraser" | "cursor") => {
		options.setTool(tool);
		emit("tool:changed", { tool });
	};

	const goToPage = (page: number) => {
		options.goToPage(page);
		emit("page:changed", { pageId: page });
	};

	const resize = () => {
		options.resize?.();
	};

	const requestDirtyRender = (rect: unknown) => {
		options.requestDirtyRender?.(rect);
	};

	const requestRender = (reason: "full" | "incremental" | "overlay" = "full") => {
		emit("render:before", { reason });
		if (reason === "overlay") {
			options.requestOverlayRender();
		} else {
			options.requestRender();
		}
		emit("render:after", { reason });
	};

	return {
		state: {
			currentTool: readonly(options.state.currentTool) as Ref<"pen" | "eraser" | "cursor">,
			currentColor: readonly(options.state.currentColor) as Ref<string>,
			currentPageId: readonly(options.state.currentPageId) as Ref<number>,
			totalPages: readonly(options.state.totalPages) as Ref<number>,
			onlineCount: readonly(options.state.onlineCount) as Ref<number>,
			isReconnecting: readonly(options.state.isReconnecting) as Ref<boolean>,
			remoteCursors: readonly(options.state.remoteCursors) as Ref<Map<string, any>>,
			selection: readonly(options.state.selection) as Ref<any>,
		},
		canUndo: options.canUndo,
		canRedo: options.canRedo,
		events,
		mountCanvas,
		unmount,
		connect: options.connect,
		disconnect: options.disconnect,
		setTool,
		undo: options.undo,
		redo: options.redo,
		goToPage,
		resize,
		requestDirtyRender,
		requestRender,
		requestOverlayRender: () => requestRender("overlay"),
	};
};
