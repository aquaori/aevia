// import { ref, markRaw } from "vue";
// import { toast } from "vue-sonner";
// import type { Command } from "../utils/type";
// import { useLamportStore } from "../store/lamportStore";
// import { useCommandStore } from "../store/commandStore";
// import { canvasRef, ctx } from "../service/canvas";

// const socket = ref<WebSocket | null>(null);
// const isIntentionalClose = ref(false);
// const isReconnecting = ref(false);
// const reconnectCount = ref(0);
// const MAX_RECONNECT = 5;
// const RECONNECT_INTERVAL = 1000;
// const reconnectFailed = ref(false);
// let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// const showMemberList = ref(false);
// const memberList = ref<[string, string][]>([]); // [userId, userName]

// const openMemberList = () => {
// 	showMemberList.value = true;
// 	activeMenu.value = null; // 关闭当前的下拉菜单
// 	if (socket.value && socket.value.readyState === WebSocket.OPEN) {
// 		socket.value.send(
// 			JSON.stringify({
// 				type: "get-member-list",
// 				data: { roomId: roomId.value },
// 			})
// 		);
// 	}
// };

// const doReconnect = () => {
// 	if (isIntentionalClose.value) return;
// 	if (reconnectCount.value >= MAX_RECONNECT) {
// 		isReconnecting.value = false;
// 		reconnectFailed.value = true;
// 		return;
// 	}

// 	isReconnecting.value = true;
// 	reconnectCount.value++;

// 	if (reconnectTimer) clearTimeout(reconnectTimer);

// 	reconnectTimer = setTimeout(() => {
// 		connectWebSocket();
// 	}, RECONNECT_INTERVAL);
// };

// const retryReconnect = () => {
// 	reconnectFailed.value = false;
// 	isReconnecting.value = false;
// 	reconnectCount.value = 0;
// 	doReconnect();
// };

// function connectWebSocket(
// 	token: string,
// 	roomId: string,
// 	username: string,
// 	roomName: string,
// 	onlineCount: number,
// 	totalPages: number,
// 	commands: Command[],
// 	userId: string
// ) {
// 	try {
// 		// 清理旧的 socket 实例，防止多次触发 onclose
// 		if (socket.value) {
// 			socket.value.onclose = null;
// 			socket.value.onerror = null;
// 			socket.value.onmessage = null;
// 			socket.value.close();
// 		}
// 		console.log(import.meta.env.VITE_WS_URL);
// 		const wsUrl = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:4646";
// 		console.log("Connecting to WebSocket server");
// 		let tokenStr = Array.isArray(token) ? token[0] : token;
// 		if (tokenStr == undefined) tokenStr = "";
// 		socket.value = new WebSocket(wsUrl, [tokenStr]);

// 		socket.value.onopen = () => {
// 			console.log("Connected to WebSocket server");
// 		};

// 		socket.value.onmessage = (event) => {
// 			try {
// 				// 判断是不是合法json数据
// 				if (JSON.parse(event.data)) {
// 					const msg = JSON.parse(event.data);
// 					// ...下面都是msg的处理分支...
// 					if (msg.type === "init") {
// 						if (isReconnecting.value) {
// 							toast.success("重新连接成功！");
// 							isReconnecting.value = false;
// 							reconnectCount.value = 0;
// 							if (reconnectTimer) clearTimeout(reconnectTimer);
// 						} else {
// 							toast.success("已连接到服务器");
// 						}
// 						const initData = msg.data;
// 						// 更新userId、username和roomname
// 						userId = initData.userId;
// 						roomId = initData.roomId;
// 						username = initData.userName;
// 						roomName = initData.roomName;
// 						onlineCount = initData.onlineCount;
// 						totalPages = initData.totalPage || 1; // 同步初始化时的总页数
// 						if (initData.commands.length > 0) {
// 							const lastCommand = initData.commands[initData.commands.length - 1];
// 							const lastPoint =
// 								lastCommand.points && Object.keys(lastCommand.points).length > 0
// 									? lastCommand.points[Object.keys(lastCommand.points).length - 1]
// 									: null;
// 							if (lastPoint) {
// 								const maxLamport = lastPoint.lamport;
// 								useLamportStore().lamport = Math.max(
// 									useLamportStore().lamport,
// 									maxLamport
// 								);
// 							}
// 						}
// 						console.log("initData:", initData);
// 						initData.commands.forEach((cmd: Command) => {
// 							useCommandStore().insertCommand(cmd);
// 						});
// 						renderCanvas();
// 					} else if (msg.type == "online-count-change") {
// 						onlineCount = msg.data.onlineCount;
// 						if (msg.data.userId != userId) {
// 							const action = msg.data.type == "join" ? "加入" : "离开";
// 							toast.info(`${msg.data.userName} ${action}了房间`);
// 						}

// 						// v8级别的优雅处理：直接操作本地的 memberList 数组，而不去发一次额外的 WS 请求
// 						const {
// 							userId: changedUserId,
// 							userName: changedUserName,
// 							type: type,
// 						} = msg.data;
// 						if (type && changedUserId && changedUserName) {
// 							if (type == "join") {
// 								// 防止重复添加
// 								const exists = memberList.value.some((m) => m[0] === changedUserId);
// 								if (!exists) {
// 									memberList.value.push([changedUserId, changedUserName]);
// 								}
// 							} else if (type == "leave") {
// 								memberList = memberList.value.filter((m) => m[0] !== changedUserId);
// 							}
// 						}
// 					} else if (msg.type == "push-cmd") {
// 						const cmd = msg.data.cmd;
// 						const pushType = msg.pushType; // update、normal、start
// 						console.log("Received command message:", pushType);
// 						if (pushType == "normal" || pushType == "start") {
// 							// 逻辑修复：无论本地是否在绘图(isDrawing)，都必须处理远端命令
// 							// 否则本地绘图时，远端的所有操作都会被丢弃，导致同步中断
// 							if (cmd.userId === userId) {
// 								useCommandStore().setCurrentCommandIndex(commands.length - 1);
// 							}
// 							if (pushType == "normal") {
// 								useCommandStore().insertCommand(cmd);
// 								if (msg.data.lamport) {
// 									useLamportStore().syncLamport(msg.data.lamport);
// 								}
// 								if (cmd.type == "clear") {
// 									useCommandStore().clearClearedCommands(cmd, msg.data.username);
// 									useCommandStore().setCurrentCommandIndex(0);
// 								}
// 								renderCanvas();
// 							} else if (pushType == "start") {
// 								if (msg.data.lamport) {
// 									useLamportStore().syncLamport(msg.data.lamport);
// 								}
// 								// 处理待处理的更新点
// 								if (useCommandStore().pendingUpdates.has(cmd.id)) {
// 									const points =
// 										useCommandStore().pendingUpdates.get(cmd.id) || [];
// 									cmd.points = markRaw([...(cmd.points || []), ...points]);
// 									useCommandStore().pendingUpdates.delete(cmd.id);
// 								}
// 								useCommandStore().insertCommand(cmd);
// 								if (cmd.pageId != currentPageId.value) {
// 									return;
// 								}
// 								if (canvasRef.value && ctx.value) {
// 									const dpr = window.devicePixelRatio || 1;
// 									const logicalWidth = canvasRef.value.width / dpr;
// 									const logicalHeight = canvasRef.value.height / dpr;
// 									const points = cmd.points ?? {};
// 									renderIncrementPoint(
// 										cmd,
// 										points,
// 										ctx.value,
// 										logicalWidth,
// 										logicalHeight
// 									);
// 								}
// 							}
// 						} else if (pushType == "update") {
// 							if (msg.data.lamport) {
// 								useLamportStore().syncLamport(msg.data.lamport);
// 							}
// 							// 更新当前绘制命令
// 							// const cmd: Command = msg.data.cmd;
// 							const cmdId = msg.data.cmdId;
// 							const points = msg.data.points ?? [];
// 							if (points.length == 0) {
// 								return;
// 							}
// 							// 找到本地命令数组中对应的命令并更新其points属性
// 							const localCmd = useCommandStore().commandMap.get(cmdId);
// 							if (localCmd) {
// 								// 更新本地命令的points属性，并使用 markRaw 保持原始性
// 								localCmd.points = markRaw([...(localCmd.points || []), ...points]);
// 							} else {
// 								// 如果找不到本地命令，说明可能是新命令，添加到待处理的更新点中
// 								useCommandStore().pendingUpdates.set(cmdId, points);
// 								return;
// 							}
// 							if (localCmd.pageId != currentPageId.value) {
// 								return;
// 							}
// 							if (canvasRef.value && ctx.value) {
// 								const dpr = window.devicePixelRatio || 1;
// 								const logicalWidth = canvasRef.value.width / dpr;
// 								const logicalHeight = canvasRef.value.height / dpr;
// 								// 使用增量渲染函数，只渲染新增的点
// 								renderIncrementPoint(
// 									localCmd,
// 									points,
// 									ctx.value,
// 									logicalWidth,
// 									logicalHeight
// 								);
// 							} else {
// 								renderCanvas();
// 							}
// 						} else if (pushType == "stop") {
// 							if (msg.data.lamport) {
// 								useLamportStore().syncLamport(msg.data.lamport);
// 							}
// 							// 记录当前命令的lastWidth信息
// 							const cmdId = msg.data.cmdId;
// 							if (lastWidths[cmdId]) {
// 								delete lastWidths[cmdId];
// 							}
// 							// 关键修复：将 stop 消息中携带的剩余 points 合并到本地命令中
// 							const stopPoints = msg.data.points ?? msg.data.cmd?.points ?? [];
// 							const localCmd = useCommandStore().commandMap.get(cmdId);

// 							if (localCmd) {
// 								if (stopPoints.length > 0) {
// 									// 将 stop 携带的点合并到本地命令
// 									localCmd.points = [...(localCmd.points || []), ...stopPoints];
// 									// 增量渲染这些新增的点
// 									if (localCmd.pageId != currentPageId.value) {
// 										return;
// 									}
// 									if (canvasRef.value && ctx.value) {
// 										const dpr = window.devicePixelRatio || 1;
// 										const logicalWidth = canvasRef.value.width / dpr;
// 										const logicalHeight = canvasRef.value.height / dpr;
// 										renderIncrementPoint(
// 											localCmd,
// 											stopPoints,
// 											ctx.value,
// 											logicalWidth,
// 											logicalHeight
// 										);
// 									}
// 								}
// 							} else if (msg.data.cmd) {
// 								// 兜底：如果 start 包因为网络拥塞丢弃，但我们收到了 stop 包
// 								const fallbackCmd = msg.data.cmd as Command;
// 								if (stopPoints.length > 0) {
// 									fallbackCmd.points = stopPoints;
// 								}
// 								useCommandStore().insertCommand(fallbackCmd);
// 								renderCanvas();
// 							}
// 							if (
// 								localCmd &&
// 								localCmd.type === "path" &&
// 								localCmd.points &&
// 								localCmd.points.length === 1
// 							) {
// 								if (localCmd.pageId != currentPageId.value) {
// 									return;
// 								}
// 								if (canvasRef.value && ctx.value) {
// 									const dpr = window.devicePixelRatio || 1;
// 									const width = canvasRef.value.width / dpr;
// 									const height = canvasRef.value.height / dpr;

// 									const p0 = localCmd.points[0];
// 									if (!p0) {
// 										return;
// 									}
// 									const x = p0.x * width;
// 									const y = p0.y * height;
// 									const baseSize = localCmd.size || 3;
// 									let p0_width = baseSize * (p0.p * 2);
// 									if (localCmd.tool === "eraser") p0_width = baseSize;

// 									const color =
// 										localCmd.tool === "eraser"
// 											? "#ffffff"
// 											: localCmd.color || "#000000";
// 									const op =
// 										localCmd.tool === "eraser"
// 											? "destination-out"
// 											: "source-over";

// 									ctx.value.save();
// 									ctx.value.globalCompositeOperation = op;
// 									ctx.value.fillStyle = color;
// 									ctx.value.beginPath();
// 									ctx.value.arc(x, y, p0_width / 2, 0, Math.PI * 2);
// 									ctx.value.fill();
// 									ctx.value.restore();
// 								}
// 							}

// 							// 更新lamport时间戳
// 							const maxLamport = msg.data.lamport;
// 							useLamportStore().lamport = Math.max(
// 								useLamportStore().lamport,
// 								maxLamport
// 							);
// 						}
// 					} else if (msg.type == "cmd-batch-move") {
// 						// 处理批量移动
// 						const { userId: msgUserId, cmdIds, dx, dy } = msg.data;
// 						if (msgUserId === userId) return;

// 						let hasUpdates = false;

// 						cmdIds.forEach((id: string) => {
// 							const cmd = useCommandStore().commands.find(
// 								(c: Command) => c.id === id
// 							);
// 							if (cmd && cmd.points) {
// 								cmd.points.forEach((p) => {
// 									p.x += dx;
// 									p.y += dy;
// 								});
// 								hasUpdates = true;
// 							}
// 						});
// 						if (hasUpdates) renderCanvas();
// 					} else if (msg.type == "cmd-batch-update") {
// 						// 处理批量更新 (缩放结果)
// 						const { userId: msgUserId, updates } = msg.data;
// 						if (msgUserId === userId) return;

// 						let hasUpdates = false;
// 						updates.forEach((update: any) => {
// 							const cmd = useCommandStore().commands.find(
// 								(c: Command) => c.id === update.cmdId
// 							);
// 							if (cmd) {
// 								cmd.points = update.points;
// 								hasUpdates = true;
// 							}
// 						});
// 						if (hasUpdates) renderCanvas();
// 					} else if (msg.type == "cmd-batch-stop") {
// 						// 处理批量更新 (缩放结果)
// 						const { userId: msgUserId, updates } = msg.data;
// 						if (msgUserId === userId) return;

// 						let hasUpdates = false;
// 						updates.forEach((update: any) => {
// 							const cmd = useCommandStore().commands.find(
// 								(c: Command) => c.id === update.cmdId
// 							);
// 							if (cmd) {
// 								cmd.points = update.points;
// 								cmd.box = update.boxes;
// 								hasUpdates = true;
// 							}
// 						});
// 						if (hasUpdates) renderCanvas();
// 					} else if (msg.type === "cmd-page-add") {
// 						// 同步页面增加
// 						const { totalPages: newTotalPages } = msg.data;
// 						if (newTotalPages > totalPages.value) {
// 							toast.info(`${msg.data.username} 新建了页面 ${msg.data.totalPages}`, {
// 								action: {
// 									label: "点击前往",
// 									onClick: () => goToPage(msg.data.totalPages - 1),
// 								},
// 							});
// 							totalPages = newTotalPages;
// 						}
// 					} else if (msg.type == "mouseMove") {
// 						// 在屏幕上更新用户鼠标位置
// 						const { userId, userName, x, y, pageId } = msg.data;
// 						remoteCursors.value.set(userId, {
// 							userId,
// 							userName,
// 							x,
// 							y,
// 							pageId: pageId ?? 0, // 兼容老版本报文
// 							color: getCursorColor(userId), // 使用动态哈希色彩分配
// 							lastUpdate: Date.now(),
// 						});
// 					} else if (msg.type === "get-member-list") {
// 						memberList.value = msg.data.memberList || [];
// 					} else if (msg.type == "mouseLeave") {
// 						const { userId } = msg.data;
// 						if (remoteCursors.value.has(userId)) {
// 							remoteCursors.value.delete(userId);
// 						}
// 						if (remoteSelectionRects.value.has(userId)) {
// 							remoteSelectionRects.value.delete(userId);
// 						}
// 					} else if (msg.type == "box-selection") {
// 						const { userId, rect } = msg.data;
// 						if (rect) {
// 							remoteSelectionRects.value.set(userId, rect);
// 						} else {
// 							remoteSelectionRects.value.delete(userId);
// 						}
// 					} else if (msg.type == "undo-cmd") {
// 						const cmdId = msg.data.cmdId;
// 						const cmd = commands.value.find((c: Command) => c.id === cmdId);
// 						if (cmd) {
// 							cmd.isDeleted = true;
// 							renderCanvas();
// 							setTool(currentTool.value);
// 						}
// 					} else if (msg.type == "redo-cmd") {
// 						const cmdId = msg.data.cmdId;
// 						const cmd = commands.value.find((c: Command) => c.id === cmdId);
// 						if (cmd) {
// 							cmd.isDeleted = false;
// 							renderCanvas();
// 							setTool(currentTool.value);
// 						}
// 					}
// 				}
// 			} catch (error) {
// 				console.error(
// 					"[WebSocket Message Error]: Failed to parse or process message.",
// 					error,
// 					event.data
// 				);
// 			}
// 		};

// 		socket.value.onclose = () => {
// 			console.log("WebSocket connection closed");
// 			if (isIntentionalClose.value) return; // 如果是主动关闭，则不进行重连

// 			// 为了防止某种极其离谱的同步触发，只在一个宏任务后发起重连
// 			if (!reconnectFailed.value) {
// 				setTimeout(() => doReconnect(), 100);
// 			}
// 		};

// 		socket.value.onerror = (error) => {
// 			console.error("WebSocket error:", error);
// 			// onerror 也会导致 onclose，所以这里不需要额外触发 doReconnect
// 		};
// 	} catch (error) {
// 		console.error("Failed to connect to WebSocket:", error);
// 		toast.error("无法连接到服务器");
// 		// 如果 new WebSocket() 同步抛出错误，onclose 不会被触发，需要手动触发重连逻辑
// 		if (!isIntentionalClose.value && !reconnectFailed.value) {
// 			setTimeout(() => doReconnect(), 100);
// 		}
// 	}
// }
