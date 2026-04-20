// File role: shared types for collaboration transport and message dispatching.
import type { Ref } from "vue";
import type { EditorHookMap } from "../utils/editorTypes";
import type { Command, FlatPoint, Point, RemoteCursor } from "../utils/type";

export interface InitRenderChunkCommandDictionaryEntry {
	cmdIndex: number;
	cmdId: string;
	userId: string;
	tool: "pen" | "eraser";
	color: string;
	size: number;
	isDeleted: boolean;
}

export interface InitRenderChunkMetaPayload {
	snapshotVersion?: number;
	chunkIndex?: number;
	isLastChunk?: boolean;
	pointCount?: number;
	commands?: InitRenderChunkCommandDictionaryEntry[];
	lamportStart?: number;
	lamportEnd?: number;
}

export interface PageChangeRenderChunkMetaPayload {
	requestId?: number;
	snapshotVersion?: number;
	chunkIndex?: number;
	isLastChunk?: boolean;
	pointCount?: number;
	commands?: InitRenderChunkCommandDictionaryEntry[];
	lamportStart?: number;
	lamportEnd?: number;
}

export interface CollabMessageDispatcherOptions {
	userId: Ref<string>;
	roomId: Ref<string>;
	username: Ref<string>;
	roomName: Ref<string>;
	onlineCount: Ref<number>;
	totalPages: Ref<number>;
	loadedPageIds: Ref<number[]>;
	currentPageId: Ref<number>;
	currentTool: Ref<"pen" | "eraser" | "cursor">;
	commands: Ref<Command[]>;
	currentCommandIndex: Ref<number>;
	pendingUpdates: Ref<Map<string, Point[]>>;
	commandMap: Map<string, Command>;
	memberList: Ref<[string, string][]>;
	remoteCursors: Ref<Map<string, RemoteCursor>>;
	remoteSelectionRects: Ref<Map<string, { x: number; y: number; w: number; h: number }>>;
	renderCanvas: () => void;
	requestDirtyRender?: (rect: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
		candidateCommandIds?: string[];
	}) => void;
	syncCommandState?: (command: Command) => void;
	requestSceneRefresh?: () => void;
	renderIncrementalCommand?: (
		cmd: Command,
		points: Point[],
		source?: "local" | "remote"
	) => void;
	renderSinglePointCommand?: (cmd: Command, source?: "local" | "remote") => void;
	beginInitRenderStream?: (pageId?: number) => void;
	appendInitRenderChunk?: (points: FlatPoint[]) => void;
	appendInitRenderBinaryChunk?: (
		meta: InitRenderChunkMetaPayload | PageChangeRenderChunkMetaPayload,
		buffer: ArrayBuffer
	) => void;
	finishInitRenderStream?: () => void;
	syncWorkerScene?: (commands: Command[], pageId: number, transformingCmdIds?: string[]) => void;
	renderSceneFromFlatPoints?: (points: FlatPoint[], pageId: number) => void;
	goToPage: (page: number) => void;
	applyRemotePageChange: (
		page: number,
		totalPages?: number,
		config?: { deferRender?: boolean; requestId?: number }
	) => void;
	getActivePageChangeRequestId?: () => number | null;
	getActivePageChangeTargetId?: () => number | null;
	clearActivePageChangeRequest?: (requestId?: number) => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	insertCommand: (cmd: Command) => void;
	replaceLoadedPageWindow: (pageIds: number[], commands: Command[]) => void;
	applyLoadedPageDelta: (input: {
		loadedPageIds: number[];
		loadPageIds: number[];
		unloadPageIds: number[];
		commands: Command[];
	}) => void;
	clearClearedCommands: (cmd: Command) => boolean;
	onInitConnectionState: () => void;
	emitHook?: <K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => void;
}

export interface CollabIncomingMessage {
	type: string;
	data: any;
	pushType?: string;
}

