// File role: shared editor host, hook, selection, and session type definitions.
import type { ComputedRef, Ref } from "vue";
import type { Command, RemoteCursor } from "./type";
import type { TypedEventBus } from "./editorEventBus";

export interface SelectionState {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type SessionLifecyclePhase =
	| "idle"
	| "mounting"
	| "ready"
	| "connecting"
	| "connected"
	| "disconnecting"
	| "destroying"
	| "destroyed";

export interface WhiteboardSessionState {
	currentTool: Ref<"pen" | "eraser" | "cursor">;
	currentColor: Ref<string>;
	currentPageId: Ref<number>;
	totalPages: Ref<number>;
	onlineCount: Ref<number>;
	isReconnecting: Ref<boolean>;
	remoteCursors: Ref<Map<string, RemoteCursor>>;
	selection: Ref<SelectionState | null>;
}

export interface EditorHookMap {
	"session:lifecycle": {
		phase: SessionLifecyclePhase;
		previousPhase: SessionLifecyclePhase;
	};
	"session:before-init": void;
	"session:ready": void;
	"session:before-destroy": void;
	"tool:changed": { tool: "pen" | "eraser" | "cursor" };
	"command:before-apply": { command: Command; source: "local" | "remote" };
	"command:applied": { command: Command; source: "local" | "remote" };
	"page:changed": { pageId: number };
	"selection:changed": { ids: string[] };
	"collab:connected": void;
	"collab:message": { type: string; payload: unknown };
	"render:before": { reason: "full" | "incremental" | "overlay" };
	"render:after": { reason: "full" | "incremental" | "overlay" };
	"benchmark:init-received": { payloadBytes: number; commandCount: number };
	"benchmark:init-parsed": { payloadBytes: number; commandCount: number; durationMs?: number };
	"benchmark:commands-hydrated": { commandCount: number; durationMs: number };
	"benchmark:render-start": {
		reason: "full" | "incremental" | "overlay" | "dirty" | "local-input" | "remote-input";
		points?: number;
	};
	"benchmark:render-end": {
		reason: "full" | "incremental" | "overlay" | "dirty" | "local-input" | "remote-input";
		points?: number;
		durationMs: number;
	};
	"benchmark:incremental-render-start": { commandId?: string; points: number; source: "local" | "remote" };
	"benchmark:incremental-render-end": {
		commandId?: string;
		points: number;
		source: "local" | "remote";
		durationMs: number;
	};
	"benchmark:dirty-redraw-start": { rect: { minX: number; minY: number; width: number; height: number } };
	"benchmark:dirty-redraw-end": {
		rect: { minX: number; minY: number; width: number; height: number };
		durationMs: number;
		pointCount: number;
	};
	"benchmark:undo-start": { source: "local" | "remote" };
	"benchmark:undo-end": { source: "local" | "remote"; durationMs: number };
	"benchmark:redo-start": { source: "local" | "remote" };
	"benchmark:redo-end": { source: "local" | "remote"; durationMs: number };
	"benchmark:page-switch-start": { fromPageId: number; toPageId: number };
	"benchmark:page-switch-end": { fromPageId: number; toPageId: number; durationMs: number };
	"benchmark:remote-command-received": {
		commandId: string;
		pushType: "normal" | "start" | "update" | "stop";
		points: number;
	};
}

export interface EditorPlugin {
	name: string;
	setup?: (host: EditorHost) => void | (() => void) | { dispose?: () => void };
}

export interface EditorHost {
	state: Readonly<WhiteboardSessionState>;
	canUndo: ComputedRef<boolean>;
	canRedo: ComputedRef<boolean>;
	lifecycle: Ref<SessionLifecyclePhase>;
	events: TypedEventBus<EditorHookMap>;
	hooks: TypedEventBus<EditorHookMap>;
	emitHook<K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]): void;
	use(plugin: EditorPlugin): () => void;
	hasPlugin(name: string): boolean;
	listPlugins(): string[];
}

export interface WhiteboardSession extends EditorHost {
	mountCanvas(input: { canvas: HTMLCanvasElement; uiCanvas: HTMLCanvasElement }): void;
	unmount(): void;
	connect(): void;
	disconnect(): void;
	setTool(tool: "pen" | "eraser" | "cursor"): void;
	undo(): void;
	redo(): void;
	goToPage(page: number): void;
	resize(): void;
	requestDirtyRender(rect: unknown): void;
	requestRender(reason?: "full" | "incremental" | "overlay"): void;
	requestOverlayRender(): void;
}

