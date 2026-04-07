import { defineStore } from "pinia";
import { ref, markRaw, type Ref } from "vue";
import { toast } from "vue-sonner";
import type { Command, RemoteCursor } from "../utils/type";
import { useLamportStore } from "./lamportStore";
import { useCommandStore } from "./commandStore";

export interface WSContext {
	userId: Ref<string>;
	roomId: Ref<string>;
	username: Ref<string>;
	roomName: Ref<string>;
	onlineCount: Ref<number>;
	totalPages: Ref<number>;
	currentPageId: Ref<number>;
	currentTool: Ref<string>;
	token: Ref<string>;
	renderCanvas: () => void;
	goToPage: (page: number) => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
}

export const useWebsocketStore = defineStore("websocket", () => {
	const socket = ref<WebSocket | null>(null);
	const isIntentionalClose = ref(false);
	const isReconnecting = ref(false);
	const reconnectCount = ref(0);
	const MAX_RECONNECT = 5;
	const RECONNECT_INTERVAL = 1000;
	const reconnectFailed = ref(false);
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const showMemberList = ref(false);
	const memberList = ref<[string, string][]>([]);
	const remoteCursors = ref<Map<string, RemoteCursor>>(new Map());
	const remoteSelectionRects = ref<Map<string, { x: number; y: number; w: number; h: number }>>(
		new Map()
	);

	let context: WSContext | null = null;

	const initContext = (ctx: WSContext) => {
		context = ctx;
	};

	const getCursorColor = (userId: string) => {
		const colors = [
			"#FF3B30",
			"#FF9500",
			"#FFCC00",
			"#4CD964",
			"#5AC8FA",
			"#007AFF",
			"#5856D6",
			"#FF2D55",
			"#AF52DE",
			"#FF46A3",
		];
		let hash = 0;
		for (let i = 0; i < userId.length; i++) {
			hash = userId.charCodeAt(i) + ((hash << 5) - hash);
		}
		return colors[Math.abs(hash) % colors.length] || "#000000";
	};

	const openMemberList = (roomId: string) => {
		showMemberList.value = true;
		if (socket.value?.readyState === WebSocket.OPEN) {
			socket.value.send(
				JSON.stringify({
					type: "get-member-list",
					data: { roomId },
				})
			);
		}
	};

	const doReconnect = () => {
		if (isIntentionalClose.value) return;
		if (reconnectCount.value >= MAX_RECONNECT) {
			isReconnecting.value = false;
			reconnectFailed.value = true;
			return;
		}

		isReconnecting.value = true;
		reconnectCount.value++;

		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => connectWebSocket(), RECONNECT_INTERVAL);
	};

	const retryReconnect = () => {
		reconnectFailed.value = false;
		isReconnecting.value = false;
		reconnectCount.value = 0;
		doReconnect();
	};

	const disconnect = () => {
		isIntentionalClose.value = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (socket.value) {
			socket.value.close();
			socket.value = null;
		}
	};

	const connectWebSocket = () => {
		if (!context) {
			console.error("WSContext not initialized");
			return;
		}

		try {
			if (socket.value) {
				socket.value.onclose = null;
				socket.value.onerror = null;
				socket.value.onmessage = null;
				socket.value.close();
			}

			const wsUrl = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:4646";
			const tokenStr = Array.isArray(context.token.value)
				? (context.token.value[0] ?? "")
				: context.token.value || "";
			socket.value = new WebSocket(wsUrl, [tokenStr]);

			socket.value.onopen = () => {
				console.log("Connected to WebSocket server");
			};

			socket.value.onmessage = (event) => {
				if (!context) return;

				try {
					const commandStore = useCommandStore();
					const lamportStore = useLamportStore();
					const msg = JSON.parse(event.data);

					if (msg.type === "init") {
						if (isReconnecting.value) {
							toast.success("重连成功");
							isReconnecting.value = false;
							reconnectCount.value = 0;
							if (reconnectTimer) clearTimeout(reconnectTimer);
						} else {
							toast.success("已加入房间");
						}

						const initData = msg.data;
						context.userId.value = initData.userId;
						context.roomId.value = initData.roomId;
						context.username.value = initData.userName;
						context.roomName.value = initData.roomName;
						context.onlineCount.value = initData.onlineCount;
						context.totalPages.value = initData.totalPage || 1;

						if (initData.commands.length > 0) {
							const lastCommand = initData.commands[initData.commands.length - 1];
							const lastPoint = lastCommand.points?.[lastCommand.points.length - 1];
							if (lastPoint) {
								lamportStore.lamport = Math.max(lamportStore.lamport, lastPoint.lamport);
							}
						}

						initData.commands.forEach((cmd: Command) => {
							commandStore.insertCommand(cmd);
						});
						context.renderCanvas();
						return;
					}

					if (msg.type === "online-count-change") {
						context.onlineCount.value = msg.data.onlineCount;
						if (msg.data.userId !== context.userId.value) {
							const action = msg.data.type === "join" ? "加入了" : "离开了";
							toast.info(`${msg.data.userName}${action}房间`);
						}

						const { userId: changedUserId, userName: changedUserName, type } = msg.data;
						if (type === "join") {
							const exists = memberList.value.some((m) => m[0] === changedUserId);
							if (!exists) {
								memberList.value.push([changedUserId, changedUserName]);
							}
						} else if (type === "leave") {
							memberList.value = memberList.value.filter((m) => m[0] !== changedUserId);
						}
						return;
					}

					if (msg.type === "push-cmd") {
						const cmd = msg.data.cmd;
						const pushType = msg.pushType;

						if (pushType === "normal" || pushType === "start") {
							if (cmd.userId === context.userId.value) {
								commandStore.currentCommandIndex = commandStore.commands.length - 1;
							}

							if (msg.data.lamport) {
								lamportStore.syncLamport(msg.data.lamport);
							}

							if (pushType === "normal") {
								commandStore.insertCommand(cmd);
								if (cmd.type === "clear") {
									commandStore.clearClearedCommands(cmd);
									commandStore.currentCommandIndex = 0;
								}
								context.renderCanvas();
								return;
							}

							if (commandStore.pendingUpdates.has(cmd.id)) {
								const points = commandStore.pendingUpdates.get(cmd.id) || [];
								cmd.points = markRaw([...(cmd.points || []), ...points]);
								commandStore.pendingUpdates.delete(cmd.id);
							}

							commandStore.insertCommand(cmd);
							if (cmd.pageId === context.currentPageId.value) {
								context.renderCanvas();
							}
							return;
						}

						if (pushType === "update") {
							if (msg.data.lamport) {
								lamportStore.syncLamport(msg.data.lamport);
							}

							const cmdId = msg.data.cmdId;
							const points = msg.data.points ?? [];
							if (!points.length) return;

							const localCmd = commandStore.commandMap.get(cmdId);
							if (localCmd) {
								localCmd.points = markRaw([...(localCmd.points || []), ...points]);
							} else {
								commandStore.pendingUpdates.set(cmdId, points);
								return;
							}

							if (localCmd.pageId === context.currentPageId.value) {
								context.renderCanvas();
							}
							return;
						}

						if (pushType === "stop") {
							if (msg.data.lamport) {
								lamportStore.syncLamport(msg.data.lamport);
							}

							const cmdId = msg.data.cmdId;
							const stopPoints = msg.data.points ?? msg.data.cmd?.points ?? [];
							const localCmd = commandStore.commandMap.get(cmdId);

							if (localCmd) {
								if (stopPoints.length > 0) {
									localCmd.points = markRaw([...(localCmd.points || []), ...stopPoints]);
								}
								if (msg.data.box) {
									localCmd.box = msg.data.box;
								}
								if (localCmd.pageId === context.currentPageId.value) {
									context.renderCanvas();
								}
							} else if (msg.data.cmd) {
								const fallbackCmd = msg.data.cmd as Command;
								if (stopPoints.length > 0) {
									fallbackCmd.points = stopPoints;
								}
								commandStore.insertCommand(fallbackCmd);
								if (fallbackCmd.pageId === context.currentPageId.value) {
									context.renderCanvas();
								}
							}

							lamportStore.lamport = Math.max(lamportStore.lamport, msg.data.lamport);
							return;
						}
					}

					if (msg.type === "cmd-batch-move") {
						const { userId: msgUserId, cmdIds, dx, dy } = msg.data;
						if (msgUserId === context.userId.value) return;

						let hasUpdates = false;
						cmdIds.forEach((id: string) => {
							const cmd = commandStore.commands.find((c: Command) => c.id === id);
							if (!cmd?.points) return;
							cmd.points.forEach((p) => {
								p.x += dx;
								p.y += dy;
							});
							hasUpdates = true;
						});
						if (hasUpdates) context.renderCanvas();
						return;
					}

					if (msg.type === "cmd-batch-update" || msg.type === "cmd-batch-stop") {
						const { userId: msgUserId, updates } = msg.data;
						if (msgUserId === context.userId.value) return;

						let hasUpdates = false;
						updates.forEach((update: any) => {
							const cmd = commandStore.commands.find((c: Command) => c.id === update.cmdId);
							if (!cmd) return;
							cmd.points = update.points;
							hasUpdates = true;
						});
						if (hasUpdates) context.renderCanvas();
						return;
					}

					if (msg.type === "cmd-page-add") {
						const { totalPages: newTotalPages } = msg.data;
						if (newTotalPages > context.totalPages.value) {
							toast.info(`${msg.data.username} 新建了第 ${msg.data.totalPages} 页`, {
								action: {
									label: "前往查看",
									onClick: () => context?.goToPage(msg.data.totalPages - 1),
								},
							});
							context.totalPages.value = newTotalPages;
						}
						return;
					}

					if (msg.type === "mouseMove") {
						const { userId, userName, x, y, pageId } = msg.data;
						remoteCursors.value.set(userId, {
							userId,
							userName,
							x,
							y,
							pageId: pageId ?? 0,
							color: getCursorColor(userId),
							lastUpdate: Date.now(),
						});
						return;
					}

					if (msg.type === "get-member-list") {
						memberList.value = msg.data.memberList || [];
						return;
					}

					if (msg.type === "mouseLeave") {
						const { userId } = msg.data;
						remoteCursors.value.delete(userId);
						remoteSelectionRects.value.delete(userId);
						return;
					}

					if (msg.type === "box-selection") {
						const { userId, rect } = msg.data;
						if (rect) {
							remoteSelectionRects.value.set(userId, rect);
						} else {
							remoteSelectionRects.value.delete(userId);
						}
						return;
					}

					if (msg.type === "undo-cmd") {
						const cmd = commandStore.commands.find((c: Command) => c.id === msg.data.cmdId);
						if (cmd) {
							cmd.isDeleted = true;
							context.renderCanvas();
							context.setTool(context.currentTool.value as any);
						}
						return;
					}

					if (msg.type === "redo-cmd") {
						const cmd = commandStore.commands.find((c: Command) => c.id === msg.data.cmdId);
						if (cmd) {
							cmd.isDeleted = false;
							context.renderCanvas();
							context.setTool(context.currentTool.value as any);
						}
					}
				} catch (error) {
					console.error("[WebSocket Message Error]", error, event.data);
				}
			};

			socket.value.onclose = () => {
				console.log("WebSocket connection closed");
				if (isIntentionalClose.value) return;
				if (!reconnectFailed.value) {
					setTimeout(() => doReconnect(), 100);
				}
			};

			socket.value.onerror = (error) => {
				console.error("WebSocket error:", error);
			};
		} catch (error) {
			console.error("Failed to connect to WebSocket:", error);
			toast.error("WebSocket 连接失败");
			if (!isIntentionalClose.value && !reconnectFailed.value) {
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
		reconnectFailed,
		showMemberList,
		memberList,
		remoteCursors,
		remoteSelectionRects,
		initContext,
		connectWebSocket,
		doReconnect,
		retryReconnect,
		disconnect,
		openMemberList,
	};
});
