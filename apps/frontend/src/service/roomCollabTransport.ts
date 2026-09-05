// File role: websocket transport for room collaboration, reconnection, and raw message intake.
import { ref, type Ref } from "vue";
import { toast } from "vue-sonner";
import type { Command, EditorTool, FlatPoint, Point, RemoteCursor } from "@collaborative-whiteboard/shared";
import { createCollabMessageDispatcher } from "./collabMessageDispatcher";
import { useRoomSessionEmitHook } from "./roomSessionContext";
import { commandToProtocol, statePageToProtocol } from "@collaborative-whiteboard/shared";
import type {
	InitRenderChunkMetaPayload,
	PageChangeRenderChunkMetaPayload,
} from "./collabDispatcherTypes";
import {
	decodeRealtimeBinaryMessage,
	encodeCmdUpdateBinary,
	encodeMouseMoveBinary,
	hasRealtimeBinaryMagic,
} from "./realtimeBinary";
import { applyServerPressurePolicy, resetCollabPressurePolicy } from "./collabPressurePolicy";
import { renewRoomSession as renewRoomSessionRequest } from "./sessionApi";
import { wsBaseUrl } from "../config/endpoints";

type OutgoingPayload = Record<string, unknown> & {
	cmd?: Command;
	cmdId?: string;
	clientLoadedPageIds?: number[];
	nextPageId?: number;
	pageId?: number;
	points?: Point[];
	prevPageId?: number;
	x?: number;
	y?: number;
};

interface RoomCollabTransportOptions {
	token: Ref<string>;
	sessionExpiresAt: Ref<number | null>;
	userId: Ref<string>;
	roomId: Ref<string>;
	username: Ref<string>;
	roomName: Ref<string>;
	onlineCount: Ref<number>;
	totalPages: Ref<number>;
	loadedPageIds: Ref<number[]>;
	currentPageId: Ref<number>;
	currentTool: Ref<EditorTool>;
	reconnectFailed: Ref<boolean>;
	reconnectFailureMessage: Ref<string>;
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
	removeCommandState?: (cmdId: string) => void;
	requestSceneRefresh?: () => void;
	renderIncrementalCommand?: (
		cmd: Command,
		points: Point[],
		source?: "local" | "remote"
	) => void;
	renderSinglePointCommand?: (cmd: Command, source?: "local" | "remote") => void;
	finishIncrementalCommand?: (cmd: Command) => void;
	isOffscreenMainCanvas?: () => boolean;
	beginInitRenderStream?: (pageId?: number) => void;
	appendInitRenderChunk?: (points: FlatPoint[]) => void;
	appendInitRenderBinaryChunk?: (
		meta: InitRenderChunkMetaPayload | PageChangeRenderChunkMetaPayload,
		buffer: ArrayBuffer
	) => void;
	finishInitRenderStream?: () => void;
	setInitSceneOperations?: (commands: Command[], pageId: number) => void;
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
	setTool: (tool: EditorTool) => void;
	insertCommand: (cmd: Command) => void;
	removeCommand: (cmdId: string) => Command | null;
	replaceLoadedPageWindow: (pageIds: number[], commands: Command[]) => void;
	applyLoadedPageDelta: (input: {
		loadedPageIds: number[];
		loadPageIds: number[];
		unloadPageIds: number[];
		commands: Command[];
	}) => void;
	clearClearedCommands: (cmd: Command) => boolean;
	requestCurrentPageResync?: () => boolean;
	cancelRejectedLocalCommand?: (cmdId: string) => void;
	cancelRejectedOperation?: () => void;
	notifyRemoteTextPatch?: (elementId: string) => void;
	persistSessionAuth?: (payload: { sessionToken: string; expiresAt: number | null }) => void;
	onSessionExpired?: () => void;
}

export const createRoomCollabTransport = (options: RoomCollabTransportOptions) => {
	const emitHook = useRoomSessionEmitHook();
	const socket = ref<WebSocket | null>(null);
	const isIntentionalClose = ref(false);
	const isReconnecting = ref(false);
	const reconnectCount = ref(0);
	const MAX_RECONNECT = 5;
	const RECONNECT_BASE_DELAY_MS = 1000;
	const RECONNECT_BACKOFF_FACTOR = 2;
	const RECONNECT_MAX_DELAY_MS = 15000;
	const RECONNECT_JITTER_RATIO = 0.35;
	const RECONNECT_JITTER_MAX_MS = 2500;
	const SESSION_RENEWAL_LEEWAY_MS = 2 * 60 * 1000;
	const SESSION_RENEW_RETRY_DELAY_MS = 30 * 1000;
	const DEFAULT_RECONNECT_FAILURE_MESSAGE = "服务器连接超时，请返回首页或重新尝试连接。";
	const SESSION_EXPIRED_FAILURE_MESSAGE = "签名已过期，请返回首页重新加入房间。";
	const SERVER_DRAINING_FAILURE_MESSAGE = "服务器正在维护并保存数据，请稍后刷新或重新进入房间。";
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let sessionRenewTimer: ReturnType<typeof setTimeout> | null = null;
	let sessionRenewInFlight: Promise<boolean> | null = null;
	let isBrowserOffline = typeof navigator !== "undefined" ? !navigator.onLine : false;
	let browserConnectivityListenersBound = false;
	// Delta replay lets a reconnect resume from the last applied roomSeq instead of
	// re-downloading the whole page. On by default now that the backend implements
	// it and the client handles the replay envelopes; set
	// VITE_ENABLE_DELTA_REPLAY=0 to force full re-init (e.g. against a backend
	// that ignores lastRoomSeq).
	const enableDeltaReplay = import.meta.env.VITE_ENABLE_DELTA_REPLAY !== "0";
	let lastRoomSeq = 0;
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

	const clearReconnectTimer = () => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const clearSessionRenewTimer = () => {
		if (sessionRenewTimer) {
			clearTimeout(sessionRenewTimer);
			sessionRenewTimer = null;
		}
	};

	const hasActiveSocketConnection = () => {
		return (
			socket.value?.readyState === WebSocket.OPEN ||
			socket.value?.readyState === WebSocket.CONNECTING
		);
	};

	const updateReconnectFailureMessage = (message = DEFAULT_RECONNECT_FAILURE_MESSAGE) => {
		options.reconnectFailureMessage.value = message;
	};

	const clearReconnectState = () => {
		clearReconnectTimer();
		isReconnecting.value = false;
		reconnectCount.value = 0;
		options.reconnectFailed.value = false;
		updateReconnectFailureMessage();
	};

	const persistSessionAuth = (sessionToken: string, expiresAt: number | null) => {
		options.token.value = sessionToken;
		options.sessionExpiresAt.value = expiresAt;
		options.persistSessionAuth?.({ sessionToken, expiresAt });
	};

	const markReconnectFailed = (message = DEFAULT_RECONNECT_FAILURE_MESSAGE) => {
		clearReconnectTimer();
		clearSessionRenewTimer();
		isReconnecting.value = false;
		options.reconnectFailed.value = true;
		updateReconnectFailureMessage(message);
	};

	const getReconnectDelay = (attempt: number) => {
		const exponent = Math.max(0, attempt - 1);
		const backoffDelay = Math.min(
			RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_FACTOR ** exponent,
			RECONNECT_MAX_DELAY_MS
		);
		const jitterWindow = Math.min(
			Math.round(backoffDelay * RECONNECT_JITTER_RATIO),
			RECONNECT_JITTER_MAX_MS
		);
		const jitter = jitterWindow > 0 ? Math.floor(Math.random() * (jitterWindow + 1)) : 0;
		return backoffDelay + jitter;
	};

	const handleBrowserOnline = () => {
		isBrowserOffline = false;
		if (isIntentionalClose.value || options.reconnectFailed.value || hasActiveSocketConnection()) {
			return;
		}
		scheduleReconnect(0);
	};

	const handleBrowserOffline = () => {
		isBrowserOffline = true;
		if (isIntentionalClose.value || hasActiveSocketConnection()) return;
		isReconnecting.value = true;
		clearReconnectTimer();
	};

	const bindBrowserConnectivityListeners = () => {
		if (browserConnectivityListenersBound || typeof window === "undefined") return;
		window.addEventListener("online", handleBrowserOnline);
		window.addEventListener("offline", handleBrowserOffline);
		browserConnectivityListenersBound = true;
	};

	const unbindBrowserConnectivityListeners = () => {
		if (!browserConnectivityListenersBound || typeof window === "undefined") return;
		window.removeEventListener("online", handleBrowserOnline);
		window.removeEventListener("offline", handleBrowserOffline);
		browserConnectivityListenersBound = false;
	};

	const scheduleSessionRenewal = () => {
		clearSessionRenewTimer();
		const expiresAt = options.sessionExpiresAt.value;
		if (!expiresAt || !options.token.value) return;

		const renewDelay = Math.max(expiresAt - Date.now() - SESSION_RENEWAL_LEEWAY_MS, 0);
		sessionRenewTimer = setTimeout(() => {
			sessionRenewTimer = null;
			void renewSessionToken("background");
		}, renewDelay);
	};

	const handleSessionExpired = () => {
		if (isIntentionalClose.value && !options.token.value) {
			return;
		}

		isIntentionalClose.value = true;
		clearReconnectTimer();
		clearSessionRenewTimer();
		isReconnecting.value = false;
		reconnectCount.value = 0;
		options.reconnectFailed.value = true;
		updateReconnectFailureMessage(SESSION_EXPIRED_FAILURE_MESSAGE);
		pendingRenderBinaryChunk = null;
		if (socket.value) {
			socket.value.onclose = null;
			socket.value.onerror = null;
			socket.value.onmessage = null;
			socket.value.close();
			socket.value = null;
		}
		persistSessionAuth("", null);
		options.onSessionExpired?.();
		toast.error("签名已过期，请重新加入房间。");
	};

	const handleServerDraining = () => {
		isIntentionalClose.value = true;
		clearReconnectTimer();
		clearSessionRenewTimer();
		isReconnecting.value = false;
		reconnectCount.value = 0;
		options.reconnectFailed.value = true;
		updateReconnectFailureMessage(SERVER_DRAINING_FAILURE_MESSAGE);
		pendingRenderBinaryChunk = null;
		if (socket.value) {
			socket.value.onclose = null;
			socket.value.onerror = null;
			socket.value.onmessage = null;
			socket.value.close();
			socket.value = null;
		}
		toast.info("服务器正在维护，已暂停重连。");
	};

	/**
	 * Handles `resync.required`, which the server sends when it can no longer
	 * guarantee our view matches the room: a slow-client eviction, a render chunk
	 * it refused to encode, or the database dropping to read-only.
	 *
	 * This message previously had no handler at all, so a degraded room silently
	 * rejected every subsequent edit. Two things have to happen: discard the delta
	 * cursor (the incremental chain is broken, so any reconnect must do a full
	 * init) and re-pull the current page.
	 */
	const handleResyncRequired = (payload: unknown) => {
		const reason = String((payload as { reason?: unknown } | undefined)?.reason ?? "");
		lastRoomSeq = 0;
		if (reason === "degraded-read-only") {
			toast.error("服务器存储异常，白板暂时只读，正在重新同步。");
		} else {
			toast.info("正在与服务器重新同步…");
		}
		options.requestCurrentPageResync?.();
	};

	const renewSessionToken = async (reason: "background" | "connect" = "background") => {
		if (!options.token.value) {
			handleSessionExpired();
			return false;
		}
		if (sessionRenewInFlight) {
			return sessionRenewInFlight;
		}

		sessionRenewInFlight = (async () => {
			try {
				const payload = await renewRoomSessionRequest(options.token.value);
				const nextToken = payload.sessionToken || payload.token || "";
				if (!nextToken) {
					handleSessionExpired();
					return false;
				}
				persistSessionAuth(nextToken, payload.expiresAt ?? null);
				scheduleSessionRenewal();
				return true;
			} catch (error: unknown) {
				const status = (error as { response?: { status?: number } }).response?.status;
				if (status === 401 || status === 403) {
					handleSessionExpired();
					return false;
				}
				if (reason === "background") {
					clearSessionRenewTimer();
					sessionRenewTimer = setTimeout(() => {
						sessionRenewTimer = null;
						void renewSessionToken("background");
					}, SESSION_RENEW_RETRY_DELAY_MS);
					return false;
				}

				const expiresAt = options.sessionExpiresAt.value;
				if (expiresAt && expiresAt <= Date.now()) {
					handleSessionExpired();
					return false;
				}
				return true;
			} finally {
				sessionRenewInFlight = null;
			}
		})();

		return sessionRenewInFlight;
	};

	const ensureSessionFreshForConnection = async () => {
		const tokenValue = Array.isArray(options.token.value)
			? (options.token.value[0] ?? "")
			: options.token.value || "";
		if (!tokenValue) {
			handleSessionExpired();
			return false;
		}

		const expiresAt = options.sessionExpiresAt.value;
		if (!expiresAt) {
			return renewSessionToken("connect");
		}
		const remainingMs = expiresAt - Date.now();
		if (remainingMs <= 0) {
			handleSessionExpired();
			return false;
		}

		if (remainingMs <= SESSION_RENEWAL_LEEWAY_MS) {
			return renewSessionToken("connect");
		}

		return true;
	};

	const scheduleReconnect = (delayOverride?: number) => {
		if (isIntentionalClose.value || options.reconnectFailed.value || hasActiveSocketConnection()) {
			return;
		}
		if (reconnectCount.value >= MAX_RECONNECT) {
			markReconnectFailed();
			return;
		}

		isReconnecting.value = true;
		if (isBrowserOffline) {
			clearReconnectTimer();
			return;
		}
		if (reconnectTimer) return;

		const nextAttempt = reconnectCount.value + 1;
		const reconnectDelay =
			typeof delayOverride === "number" ? delayOverride : getReconnectDelay(nextAttempt);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			doReconnect();
		}, reconnectDelay);
	};

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
		removeCommandState: options.removeCommandState,
		requestSceneRefresh: options.requestSceneRefresh,
		renderIncrementalCommand: options.renderIncrementalCommand,
		renderSinglePointCommand: options.renderSinglePointCommand,
		finishIncrementalCommand: options.finishIncrementalCommand,
		isOffscreenMainCanvas: options.isOffscreenMainCanvas,
		beginInitRenderStream: options.beginInitRenderStream,
		appendInitRenderChunk: options.appendInitRenderChunk,
		appendInitRenderBinaryChunk: options.appendInitRenderBinaryChunk,
		finishInitRenderStream: options.finishInitRenderStream,
		setInitSceneOperations: options.setInitSceneOperations,
		syncWorkerScene: options.syncWorkerScene,
		renderSceneFromFlatPoints: options.renderSceneFromFlatPoints,
		goToPage: options.goToPage,
		applyRemotePageChange: options.applyRemotePageChange,
		getActivePageChangeRequestId: options.getActivePageChangeRequestId,
		getActivePageChangeTargetId: options.getActivePageChangeTargetId,
		clearActivePageChangeRequest: options.clearActivePageChangeRequest,
		setTool: options.setTool,
		insertCommand: options.insertCommand,
		removeCommand: options.removeCommand,
		replaceLoadedPageWindow: options.replaceLoadedPageWindow,
		applyLoadedPageDelta: options.applyLoadedPageDelta,
		clearClearedCommands: options.clearClearedCommands,
		requestCurrentPageResync: options.requestCurrentPageResync,
		cancelRejectedLocalCommand: options.cancelRejectedLocalCommand,
		cancelRejectedOperation: options.cancelRejectedOperation,
		notifyRemoteTextPatch: options.notifyRemoteTextPatch,
		emitHook,
		onInitConnectionState: () => {
			if (isReconnecting.value) {
				toast.success("重连成功");
				clearReconnectState();
			} else {
				clearReconnectState();
				toast.success("已加入房间");
			}
			scheduleSessionRenewal();
		},
	});

	const updateLastRoomSeq = (payload: unknown) => {
		const roomSeq = Number((payload as { roomSeq?: unknown } | undefined)?.roomSeq ?? NaN);
		if (Number.isFinite(roomSeq) && roomSeq > lastRoomSeq) {
			lastRoomSeq = roomSeq;
		}
	};

	const doReconnect = () => {
		if (isIntentionalClose.value || options.reconnectFailed.value || hasActiveSocketConnection()) {
			return;
		}
		if (reconnectCount.value >= MAX_RECONNECT) {
			markReconnectFailed();
			return;
		}
		if (typeof navigator !== "undefined") {
			isBrowserOffline = !navigator.onLine;
		}
		if (isBrowserOffline) {
			isReconnecting.value = true;
			return;
		}

		isReconnecting.value = true;
		reconnectCount.value += 1;
		connect();
	};

	const retryReconnect = () => {
		isIntentionalClose.value = false;
		clearReconnectState();
		if (typeof navigator !== "undefined") {
			isBrowserOffline = !navigator.onLine;
		}
		if (isBrowserOffline) {
			isReconnecting.value = true;
			return;
		}
		doReconnect();
	};

	const openMemberList = () => {
		send("get-member-list", { roomId: options.roomId.value });
	};

	const send = (type: string, data: unknown) => {
		if (socket.value?.readyState !== WebSocket.OPEN) {
			return false;
		}

		let outgoing = data as OutgoingPayload;
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

		if (type === "mouseMove" && outgoing) {
			socket.value.send(
				encodeMouseMoveBinary({
					pageId: outgoing.pageId ?? 0,
					x: outgoing.x ?? 0,
					y: outgoing.y ?? 0,
				})
			);
			return true;
		}

		if (type === "cmd-update" && outgoing) {
			socket.value.send(
				encodeCmdUpdateBinary({
					cmdId: outgoing.cmdId ?? "",
					points: Array.isArray(outgoing.points) ? outgoing.points : [],
				})
			);
			return true;
		}

		socket.value.send(JSON.stringify({ type, data: outgoing }));
		return true;
	};

	const disconnect = () => {
		isIntentionalClose.value = true;
		clearReconnectTimer();
		clearSessionRenewTimer();
		unbindBrowserConnectivityListeners();
		socket.value?.close();
	};

	const connect = async () => {
		try {
			if (isIntentionalClose.value || hasActiveSocketConnection()) return;
			bindBrowserConnectivityListeners();
			if (typeof navigator !== "undefined") {
				isBrowserOffline = !navigator.onLine;
			}
			if (isBrowserOffline) {
				scheduleReconnect();
				return;
			}
			const sessionReady = await ensureSessionFreshForConnection();
			if (!sessionReady || isIntentionalClose.value) {
				return;
			}
			clearReconnectTimer();
			if (socket.value) {
				socket.value.onclose = null;
				socket.value.onerror = null;
				socket.value.onmessage = null;
				socket.value.close();
			}

			const tokenStr = Array.isArray(options.token.value)
				? (options.token.value[0] ?? "")
				: options.token.value || "";
			const wsUrl = `${wsBaseUrl}?pageId=${statePageToProtocol(options.currentPageId.value)}${
				enableDeltaReplay && lastRoomSeq > 0 ? `&lastRoomSeq=${lastRoomSeq}` : ""
			}`;
			socket.value = new WebSocket(wsUrl, [tokenStr]);
			socket.value.binaryType = "arraybuffer";

			socket.value.onopen = () => {
				emitHook("collab:connected", undefined);
				scheduleSessionRenewal();
			};

			socket.value.onmessage = (event) => {
				try {
					if (typeof event.data === "string") {
						const msg = JSON.parse(event.data);

						if (msg.type === "init-meta" && typeof window !== "undefined") {
							(window as Window & { __aeviaInitStreamStartedAt?: number }).__aeviaInitStreamStartedAt =
								performance.now();
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
						if (msg.type === "server-pressure") {
							applyServerPressurePolicy(msg.data);
							return;
						}
						if (msg.type === "server.draining") {
							handleServerDraining();
							return;
						}
						if (msg.type === "resync.required") {
							handleResyncRequired(msg.data);
							return;
						}
						if (enableDeltaReplay) updateLastRoomSeq(msg.data);
						dispatcher.handleMessage(msg);
						return;
					}

					if (event.data instanceof ArrayBuffer) {
						if (hasRealtimeBinaryMagic(event.data)) {
							const msg = decodeRealtimeBinaryMessage(event.data);
							emitHook("collab:message", { type: msg.type, payload: msg.data });
							if (enableDeltaReplay) updateLastRoomSeq(msg.data);
							dispatcher.handleMessage(msg);
							return;
						}

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
				resetCollabPressurePolicy();
				clearSessionRenewTimer();
				socket.value = null;
				if (isIntentionalClose.value) return;
				scheduleReconnect();
			};

			socket.value.onerror = (error) => {
				console.error("WebSocket error:", error);
			};
		} catch (error) {
			console.error("Failed to connect to WebSocket:", error);
			if (!options.reconnectFailed.value) {
				toast.error("服务器连接失败");
			}
			socket.value = null;
			scheduleReconnect();
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
