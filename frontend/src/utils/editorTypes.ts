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
}

export interface EditorHost {
	state: Readonly<WhiteboardSessionState>;
	canUndo: ComputedRef<boolean>;
	canRedo: ComputedRef<boolean>;
	events: TypedEventBus<EditorHookMap>;
	hooks: TypedEventBus<EditorHookMap>;
	emitHook<K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]): void;
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

