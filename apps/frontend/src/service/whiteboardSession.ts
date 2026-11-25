// File role: session host that exposes the room editor lifecycle, render requests, hooks, and plugins.
import { readonly, ref, type ComputedRef, type Ref } from "vue";
import { canvasRef, ctx, uiCanvasRef, uiCtx } from "./canvas";
import { createEventBus } from "../utils/editorEventBus";
import type {
	EditorHookMap,
	ConsistencyWatermarks,
	EditorPlugin,
	SelectionState,
	SessionLifecyclePhase,
	WhiteboardSession,
	WhiteboardSessionState,
} from "../utils/editorTypes";
import type { RemoteCursor } from "../utils/type";
import type { EditorTool } from "@collaborative-whiteboard/shared";
import type { RenderIRFrame } from "../scene/renderIR";

export const VALID_LIFECYCLE_TRANSITIONS: Readonly<Record<SessionLifecyclePhase, readonly SessionLifecyclePhase[]>> = {
	idle: ["mounting", "connecting", "destroying"],
	mounting: ["ready", "destroying"],
	ready: ["mounting", "connecting", "disconnecting", "destroying"],
	connecting: ["ready", "connected", "disconnecting", "destroying"],
	connected: ["connecting", "disconnecting", "destroying"],
	disconnecting: ["ready", "connecting", "destroying"],
	destroying: ["disconnecting", "destroying", "destroyed"],
	destroyed: [],
};

export function canTransitionLifecyclePhase(
	from: SessionLifecyclePhase,
	to: SessionLifecyclePhase,
): boolean {
	return from === to || VALID_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function areConsistencyWatermarksMonotonic(
	previous: ConsistencyWatermarks,
	next: ConsistencyWatermarks,
): boolean {
	if (next.roomSeq < previous.roomSeq) return false;
	if (!next.render) {
		return !previous.render;
	}
	if (next.render.processedDispatchSeq > next.render.submittedDispatchSeq) return false;
	if (
		next.render.presentedRevision !== null &&
		next.render.presentedRevision > next.render.sceneRevision
	) {
		return false;
	}
	if (!previous.render) return true;
	if (next.render.epoch < previous.render.epoch) return false;
	if (next.render.epoch > previous.render.epoch) return true;
	if (next.render.submittedDispatchSeq < previous.render.submittedDispatchSeq) return false;
	if (next.render.processedDispatchSeq < previous.render.processedDispatchSeq) return false;
	if (next.render.sceneRevision < previous.render.sceneRevision) return false;
	if (previous.render.presentedRevision !== null) {
		if (
			next.render.presentedRevision === null ||
			next.render.presentedRevision < previous.render.presentedRevision
		) {
			return false;
		}
	}
	return true;
}

interface CreateWhiteboardSessionOptions {
	getConsistencyWatermarks?: () => Promise<ConsistencyWatermarks>;
	getRenderIR?: () => Promise<RenderIRFrame | null>;
	state: WhiteboardSessionState;
	canUndo: ComputedRef<boolean>;
	canRedo: ComputedRef<boolean>;
	initialize?: () => boolean | void;
	dispose?: () => void;
	connect: () => void;
	disconnect: () => void;
	setTool: (tool: EditorTool) => void;
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
		currentTool: readonly(options.state.currentTool) as Ref<EditorTool>,
		currentColor: readonly(options.state.currentColor) as Ref<string>,
		currentPageId: readonly(options.state.currentPageId) as Ref<number>,
		totalPages: readonly(options.state.totalPages) as Ref<number>,
		onlineCount: readonly(options.state.onlineCount) as Ref<number>,
		isReconnecting: readonly(options.state.isReconnecting) as Ref<boolean>,
		remoteCursors: readonly(options.state.remoteCursors) as Ref<Map<string, RemoteCursor>>,
		selection: readonly(options.state.selection) as Ref<SelectionState | null>,
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
		if (options.initialize?.() === false && !ctx.value) {
			ctx.value = input.canvas.getContext("2d");
		}
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

	const setTool = (tool: EditorTool) => {
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
		getConsistencyWatermarks: () => options.getConsistencyWatermarks?.() ?? Promise.resolve({ roomSeq: 0, render: null }),
		getRenderIR: () => options.getRenderIR?.() ?? Promise.resolve(null),
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

