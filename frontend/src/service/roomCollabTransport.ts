// File role: websocket transport for room collaboration, reconnection, and raw message intake.
import { ref, type Ref } from "vue";
import { toast } from "vue-sonner";
import type { Command, Point, RemoteCursor } from "../utils/type";
import { createCollabMessageDispatcher } from "./collabMessageDispatcher";
import { recordInitParsed, recordInitReceived } from "../instrumentation/runtimeInstrumentation";
import { useRoomSessionEmitHook } from "./roomSessionContext";
import { commandToProtocol, statePageToProtocol } from "./collabProtocol";

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
	goToPage: (page: number) => void;
	applyRemotePageChange: (page: number, totalPages?: number) => void;
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
		goToPage: options.goToPage,
		applyRemotePageChange: options.applyRemotePageChange,
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

			socket.value.onopen = () => {
				emitHook("collab:connected", undefined);
			};

			socket.value.onmessage = (event) => {
				try {
					const parseStart = performance.now();
					const payloadText = typeof event.data === "string" ? event.data : "";
					const msg = JSON.parse(event.data);
					if (msg.type === "init") {
						const payloadBytes = new TextEncoder().encode(payloadText).length;
						recordInitReceived(payloadBytes, msg.data?.commands?.length || 0);
						recordInitParsed(
							payloadBytes,
							msg.data?.commands?.length || 0,
							performance.now() - parseStart
						);
					}
					emitHook("collab:message", { type: msg.type, payload: msg.data });
					dispatcher.handleMessage(msg);
				} catch (error) {
					console.error(
						"[WebSocket Message Error]: Failed to parse or process message.",
						error,
						event.data
					);
				}
			};

			socket.value.onclose = () => {
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
