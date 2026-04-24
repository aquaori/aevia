// File role: websocket transport for room collaboration, reconnection, and raw message intake.
import { ref, type Ref } from "vue";
import { toast } from "vue-sonner";
import type { Command, FlatPoint, Point, RemoteCursor } from "@collaborative-whiteboard/shared";
import { createCollabMessageDispatcher } from "./collabMessageDispatcher";
import {
	recordInitChunkParsed,
	recordInitParsed,
	recordInitReceived,
} from "../instrumentation/runtimeInstrumentation";
import { useRoomSessionEmitHook } from "./roomSessionContext";
import { commandToProtocol, statePageToProtocol } from "@collaborative-whiteboard/shared";
import type {
	InitRenderChunkMetaPayload,
	PageChangeRenderChunkMetaPayload,
} from "./collabDispatcherTypes";

interface RoomCollabTransportOptions {
	token: Ref<string>;
	userId: Ref<string>;
	roomId: Ref<string>;
	username: Ref<string>;
	roomName: Ref<string>;
	onlineCount: Ref<number>;
	totalPages: Ref<number>;
	loadedPageIds: Ref<number[]>;
	currentPageId: Ref<number>;
	currentTool: Ref<"pen" | "eraser" | "cursor">;
	reconnectFailed: Ref<boolean>;
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
}

export const createRoomCollabTransport = (options: RoomCollabTransportOptions) => {
	const emitHook = useRoomSessionEmitHook();
	const socket = ref<WebSocket | null>(null);
	const isIntentionalClose = ref(false);
	const isReconnecting = ref(false);
	const reconnectCount = ref(0);
	const MAX_RECONNECT = 5;
	const RECONNECT_INTERVAL = 1000;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingRenderBinaryChunk:
		| {
				kind: "init";
				meta: InitRenderChunkMetaPayload;
		  }
		| {
				kind: "page-change";
				meta: PageChangeRenderChunkMetaPayload;
		  }
		| null = null;
	const dispatcher = createCollabMessageDispatcher({
		userId: options.userId,
		roomId: options.roomId,
		username: options.username,
		roomName: options.roomName,
		onlineCount: options.onlineCount,
		totalPages: options.totalPages,
		loadedPageIds: options.loadedPageIds,
		currentPageId: options.currentPageId,
		currentTool: options.currentTool,
		commands: options.commands,
		currentCommandIndex: options.currentCommandIndex,
		pendingUpdates: options.pendingUpdates,
		commandMap: options.commandMap,
		memberList: options.memberList,
		remoteCursors: options.remoteCursors,
		remoteSelectionRects: options.remoteSelectionRects,
		renderCanvas: options.renderCanvas,
		requestDirtyRender: options.requestDirtyRender,
		syncCommandState: options.syncCommandState,
		requestSceneRefresh: options.requestSceneRefresh,
		renderIncrementalCommand: options.renderIncrementalCommand,
		renderSinglePointCommand: options.renderSinglePointCommand,
		beginInitRenderStream: options.beginInitRenderStream,
		appendInitRenderChunk: options.appendInitRenderChunk,
		appendInitRenderBinaryChunk: options.appendInitRenderBinaryChunk,
		finishInitRenderStream: options.finishInitRenderStream,
		syncWorkerScene: options.syncWorkerScene,
		renderSceneFromFlatPoints: options.renderSceneFromFlatPoints,
		goToPage: options.goToPage,
		applyRemotePageChange: options.applyRemotePageChange,
		getActivePageChangeRequestId: options.getActivePageChangeRequestId,
		getActivePageChangeTargetId: options.getActivePageChangeTargetId,
		clearActivePageChangeRequest: options.clearActivePageChangeRequest,
		setTool: options.setTool,
		insertCommand: options.insertCommand,
		replaceLoadedPageWindow: options.replaceLoadedPageWindow,
		applyLoadedPageDelta: options.applyLoadedPageDelta,
		clearClearedCommands: options.clearClearedCommands,
		emitHook,
		onInitConnectionState: () => {
			if (isReconnecting.value) {
				toast.success("重连成功");
				isReconnecting.value = false;
				reconnectCount.value = 0;
				if (reconnectTimer) clearTimeout(reconnectTimer);
			} else {
				toast.success("已加入房间");
			}
		},
	});

	const doReconnect = () => {
		if (isIntentionalClose.value) return;
		if (reconnectCount.value >= MAX_RECONNECT) {
			isReconnecting.value = false;
			options.reconnectFailed.value = true;
			return;
		}

		isReconnecting.value = true;
		reconnectCount.value += 1;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			connect();
		}, RECONNECT_INTERVAL);
	};

	const retryReconnect = () => {
		options.reconnectFailed.value = false;
		isReconnecting.value = false;
		reconnectCount.value = 0;
		doReconnect();
	};

	const openMemberList = () => {
		send("get-member-list", { roomId: options.roomId.value });
	};

	const send = (type: string, data: unknown) => {
		if (socket.value?.readyState !== WebSocket.OPEN) {
			return false;
		}

		let outgoing = data as any;
		if (outgoing && typeof outgoing === "object") {
			outgoing = { ...outgoing };
		}

		if (type === "page-change" && outgoing) {
			if (typeof outgoing.pageId === "number") {
				outgoing.pageId = statePageToProtocol(outgoing.pageId);
			}
			if (typeof outgoing.prevPageId === "number") {
				outgoing.prevPageId = statePageToProtocol(outgoing.prevPageId);
			}
			if (typeof outgoing.nextPageId === "number") {
				outgoing.nextPageId = statePageToProtocol(outgoing.nextPageId);
			}
			if (Array.isArray(outgoing.clientLoadedPageIds)) {
				outgoing.clientLoadedPageIds = outgoing.clientLoadedPageIds.map((pageId: number) =>
					statePageToProtocol(pageId)
				);
			}
		}

		if (type === "mouseMove" && outgoing && typeof outgoing.pageId === "number") {
			outgoing.pageId = statePageToProtocol(outgoing.pageId);
		}

		if ((type === "push-cmd" || type === "cmd-start" || type === "cmd-stop") && outgoing) {
			if (outgoing.cmd && typeof outgoing.cmd === "object") {
				outgoing.cmd = commandToProtocol(outgoing.cmd);
			} else if (typeof outgoing.pageId === "number") {
				outgoing = commandToProtocol(outgoing);
			}
		}

		socket.value.send(JSON.stringify({ type, data: outgoing }));
		return true;
	};

	const disconnect = () => {
		isIntentionalClose.value = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket.value?.close();
	};

	const connect = () => {
		try {
			if (socket.value) {
				socket.value.onclose = null;
				socket.value.onerror = null;
				socket.value.onmessage = null;
				socket.value.close();
			}

			const wsBaseUrl = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:4646/ws";
			const tokenStr = Array.isArray(options.token.value)
				? (options.token.value[0] ?? "")
				: options.token.value || "";
			const wsUrl = `${wsBaseUrl.replace(/\/ws$/, "")}/ws?pageId=${statePageToProtocol(options.currentPageId.value)}`;
			socket.value = new WebSocket(wsUrl, [tokenStr]);
			socket.value.binaryType = "arraybuffer";

			socket.value.onopen = () => {
				emitHook("collab:connected", undefined);
			};

			socket.value.onmessage = (event) => {
				try {
					if (typeof event.data === "string") {
						const parseStart = performance.now();
						const msg = JSON.parse(event.data);
						if (msg.type === "init-meta") {
						const commandCount = Number(
							msg.data?.chunkSummary?.totalCommands ??
								msg.data?.totalCommands ??
								msg.data?.commandCount ??
								msg.data?.commandsTotal ??
								0
						);
							recordInitReceived(0, commandCount);
							recordInitParsed(0, commandCount, performance.now() - parseStart);
						} else if (
							msg.type === "init-render-chunk-meta" ||
							msg.type === "init-commands-chunk" ||
							msg.type === "page-change-render-chunk-meta" ||
							msg.type === "page-change-commands-chunk"
						) {
							recordInitChunkParsed(0, performance.now() - parseStart);
						}

						if (msg.type === "init-render-chunk-meta") {
							pendingRenderBinaryChunk = {
								kind: "init",
								meta: (msg.data ?? {}) as InitRenderChunkMetaPayload,
							};
						} else if (msg.type === "page-change-render-chunk-meta") {
							pendingRenderBinaryChunk = {
								kind: "page-change",
								meta: (msg.data ?? {}) as PageChangeRenderChunkMetaPayload,
							};
						}

						emitHook("collab:message", { type: msg.type, payload: msg.data });
						dispatcher.handleMessage(msg);
						return;
					}

					if (event.data instanceof ArrayBuffer) {
						if (!pendingRenderBinaryChunk) {
							console.error(
								"[WebSocket Message Error]: Received render binary frame without pending meta."
							);
							return;
						}

						const pendingChunk = pendingRenderBinaryChunk;
						pendingRenderBinaryChunk = null;
						options.appendInitRenderBinaryChunk?.(pendingChunk.meta, event.data);
						if (pendingChunk.kind === "init") {
							dispatcher.handleInitRenderChunkBinary(pendingChunk.meta);
							return;
						}
						dispatcher.handlePageChangeRenderChunkBinary(pendingChunk.meta);
						return;
					}

					console.error(
						"[WebSocket Message Error]: Unsupported WebSocket payload type.",
						event.data
					);
				} catch (error) {
					console.error(
						"[WebSocket Message Error]: Failed to parse or process message.",
						error,
						event.data
					);
				}
			};

			socket.value.onclose = () => {
				pendingRenderBinaryChunk = null;
				if (isIntentionalClose.value) return;
				if (!options.reconnectFailed.value) {
					setTimeout(() => doReconnect(), 100);
				}
			};

			socket.value.onerror = (error) => {
				console.error("WebSocket error:", error);
			};
		} catch (error) {
			console.error("Failed to connect to WebSocket:", error);
			toast.error("服务器连接失败");
			if (!isIntentionalClose.value && !options.reconnectFailed.value) {
				setTimeout(() => doReconnect(), 100);
			}
		}
	};

	return {
		socket,
		isIntentionalClose,
		isReconnecting,
		reconnectCount,
		MAX_RECONNECT,
		send,
		openMemberList,
		connect,
		disconnect,
		retryReconnect,
		doReconnect,
	};
};
