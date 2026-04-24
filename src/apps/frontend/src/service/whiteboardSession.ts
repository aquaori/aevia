// File role: session host that exposes the room editor lifecycle, render requests, hooks, and plugins.
import { readonly, ref, type ComputedRef, type Ref } from "vue";
import { canvasRef, ctx, uiCanvasRef, uiCtx } from "./canvas";
import { createEventBus } from "../utils/editorEventBus";
import type {
	EditorHookMap,
	EditorPlugin,
	SessionLifecyclePhase,
	WhiteboardSession,
	WhiteboardSessionState,
} from "../utils/editorTypes";

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
	const lifecycle = ref<SessionLifecyclePhase>("idle");
	const pluginCleanups = new Map<string, () => void>();
	const hostState = {
		currentTool: readonly(options.state.currentTool) as Ref<"pen" | "eraser" | "cursor">,
		currentColor: readonly(options.state.currentColor) as Ref<string>,
		currentPageId: readonly(options.state.currentPageId) as Ref<number>,
		totalPages: readonly(options.state.totalPages) as Ref<number>,
		onlineCount: readonly(options.state.onlineCount) as Ref<number>,
		isReconnecting: readonly(options.state.isReconnecting) as Ref<boolean>,
		remoteCursors: readonly(options.state.remoteCursors) as Ref<Map<string, any>>,
		selection: readonly(options.state.selection) as Ref<any>,
	};

	const setLifecycle = (phase: SessionLifecyclePhase) => {
		const previousPhase = lifecycle.value;
		if (previousPhase === phase) return;
		lifecycle.value = phase;
		events.emit("session:lifecycle", { phase, previousPhase });
	};

	const emit = <K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => {
		if (event === "collab:connected") {
			setLifecycle("connected");
		}
		events.emit(event, payload);
	};

	const hasPlugin = (name: string) => pluginCleanups.has(name);

	const use = (plugin: EditorPlugin) => {
		if (pluginCleanups.has(plugin.name)) {
			return () => {
				/* plugin already registered */
			};
		}

		const teardown = plugin.setup?.({
			state: hostState,
			canUndo: options.canUndo,
			canRedo: options.canRedo,
			lifecycle,
			events,
			hooks: events,
			emitHook: emit,
			use,
			hasPlugin,
			listPlugins: () => Array.from(pluginCleanups.keys()),
		});
		const cleanup =
			typeof teardown === "function"
				? teardown
				: typeof teardown?.dispose === "function"
					? () => teardown.dispose?.()
					: () => {
						/* no-op */
					};
		pluginCleanups.set(plugin.name, cleanup);

		return () => {
			const registeredCleanup = pluginCleanups.get(plugin.name);
			if (!registeredCleanup) return;
			registeredCleanup();
			pluginCleanups.delete(plugin.name);
		};
	};

	const mountCanvas = (input: { canvas: HTMLCanvasElement; uiCanvas: HTMLCanvasElement }) => {
		setLifecycle("mounting");
		emit("session:before-init", undefined);
		canvasRef.value = input.canvas;
		uiCanvasRef.value = input.uiCanvas;
		ctx.value =
			typeof input.canvas.transferControlToOffscreen === "function"
				? null
				: input.canvas.getContext("2d");
		uiCtx.value = input.uiCanvas.getContext("2d");
		options.initialize?.();
		options.resize?.();
		setLifecycle("ready");
		emit("session:ready", undefined);
	};

	const disconnect = (targetPhase: SessionLifecyclePhase = "ready") => {
		setLifecycle("disconnecting");
		options.disconnect();
		setLifecycle(targetPhase);
	};

	const unmount = () => {
		setLifecycle("destroying");
		emit("session:before-destroy", undefined);
		disconnect("destroying");
		pluginCleanups.forEach((cleanup) => cleanup());
		pluginCleanups.clear();
		options.dispose?.();
		canvasRef.value = null;
		uiCanvasRef.value = null;
		ctx.value = null;
		uiCtx.value = null;
		setLifecycle("destroyed");
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

	const connect = () => {
		setLifecycle("connecting");
		options.connect();
	};

	return {
		state: hostState,
		canUndo: options.canUndo,
		canRedo: options.canRedo,
		lifecycle,
		events,
		hooks: events,
		emitHook: emit,
		use,
		hasPlugin,
		listPlugins: () => Array.from(pluginCleanups.keys()),
		mountCanvas,
		unmount,
		connect,
		disconnect,
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

