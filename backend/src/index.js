const http = require("http");
const WebSocket = require("ws");
const os = require("os");
const app = require("./app");
const config = require("./config");
const roomService = require("./services/roomService");
const authService = require("./services/authService");
const handleWsMessage = require("./websocket/messageHandler");
const Logger = require("./utils/logger");

const server = http.createServer(app);

// 记录服务器进程启动的时间戳，用于核对 token 签发时间，防止重启越权
const SERVER_START_TIME = Date.now();

// 维护离线用户，记录过期时间。结构: Map<userId, expiredAt>
const offlineUsers = new Map();

// 每分钟运行一次清理，删除已经完全过期的离线记录，防止内存泄漏
setInterval(() => {
	const now = Date.now();
	for (const [userId, expiredAt] of offlineUsers.entries()) {
		if (now > expiredAt) {
			offlineUsers.delete(userId);
		}
	}
}, 60000);

const wss = new WebSocket.Server({
	noServer: true, // 禁用默认的 WebSocket 服务器绑定，以便自定义 upgrade 事件
	permessageDeflate: {
		zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
		zlibInflateOptions: { chunkSize: 10 * 1024 },
		clientNoContextTakeover: true,
		serverNoContextTakeover: true,
		serverMaxWindowBits: 10,
		concurrencyLimit: 10,
		threshold: 1024,
	},
});

// ### WebSocket 握手拦截层 ###
// 在这里进行 token 鉴定，如果在握手阶段失败，直接返回 HTTP 401 并销毁 socket，
// 防止客户端走到 ws.onopen 产生“连接成功又瞬间断开”的幽灵连接导致的无限重试。
server.on("upgrade", (request, socket, head) => {
	const url = new URL(request.url, `http://${request.headers.host}`);
	// const token = url.searchParams.get("token");

	// 限制 WebSocket 路径为 /ws，方便上线时的 Nginx 转发
	if (url.pathname !== "/ws") {
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		return socket.destroy();
	}

	// 从 headers 中获取 token
	const token = request.headers["sec-websocket-protocol"];

	if (!token) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return socket.destroy();
	}

	const decoded = authService.verifyToken(token, { ignoreExpiration: true });
	if (!decoded || !roomService.hasRoom(decoded.roomId)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return socket.destroy();
	}

	// 检查是否是由于服务器重启导致的旧 Token
	if (decoded.iat && decoded.iat * 1000 < SERVER_START_TIME) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return socket.destroy();
	}

	const room = roomService.getRoom(decoded.roomId);
	if (decoded.roomCreatedAt !== room.createdAt) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return socket.destroy();
	}

	const now = Date.now();
	const isTokenExpired = decoded.exp && decoded.exp * 1000 < now;
	const offlineExpire = offlineUsers.get(decoded.userId);

	if (offlineExpire) {
		if (now <= offlineExpire) {
			offlineUsers.delete(decoded.userId);
		} else {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return socket.destroy();
		}
	} else {
		if (isTokenExpired) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return socket.destroy();
		}
	}

	wss.handleUpgrade(request, socket, head, (ws) => {
		wss.emit("connection", ws, request, decoded);
	});
});

function getLocalIp() {
	const interfaces = os.networkInterfaces();
	for (const devName in interfaces) {
		const iface = interfaces[devName];
		for (let i = 0; i < iface.length; i++) {
			const alias = iface[i];
			if (alias.family === "IPv4" && alias.address !== "127.0.0.1" && !alias.internal) {
				return alias.address;
			}
		}
	}
	return "127.0.0.1";
}

wss.on("connection", (ws, req, decoded) => {
	// 之前握手阶段传过来的解码数据已经验证成功

	// 绑定数据到 ws... 到这里说明鉴权通过
	ws.roomId = decoded.roomId;
	ws.userId = decoded.userId;
	ws.userName = decoded.userName;
	ws.roomCreatedAt = decoded.roomCreatedAt;

	const room = roomService.getRoom(ws.roomId);
	room.clients.add(ws);

	Logger.wsEvent("joined", ws.userName, ws.userId, ws.roomId);

	// 发送初始状态
	ws.send(
		JSON.stringify({
			type: "init",
			data: {
				status: "connected",
				userId: ws.userId,
				userName: ws.userName,
				roomId: ws.roomId,
				roomName: room.name,
				onlineCount: room.clients.size,
				totalPage: room.totalPage,
				commands: room.commands,
			},
		})
	);

	// 广播在线人数
	room.clients.forEach((c) => {
		if (c.readyState === WebSocket.OPEN) {
			c.send(
				JSON.stringify({
					type: "online-count-change",
					data: {
						onlineCount: room.clients.size,
						userId: ws.userId,
						userName: ws.userName,
						type: "join",
					},
				})
			);
		}
	});

	ws.on("message", (msg) => handleWsMessage(ws, msg));

	ws.on("close", () => {
		// 断开连接时，赋予该用户 1 分钟（60000ms）的离线豁免期
		offlineUsers.set(ws.userId, Date.now() + 60000);

		room.clients.delete(ws);
		Logger.wsEvent("left", ws.userName, ws.userId, ws.roomId);

		// 如果房间内已经没有任何人，并且不是默认的保留房间，直接解散
		// if (room.clients.size === 0 && ws.roomId !== config.DEFAULT_ROOM_ID) {
		// 	Logger.info(`Empty room deleted: ${ws.roomId}`);
		// 	roomService.deleteRoom(ws.roomId);
		// 	return; // 已经解散的房间，不需要再往下广播了
		// }

		// 广播更新
		room.clients.forEach((c) => {
			if (c.readyState === WebSocket.OPEN) {
				c.send(
					JSON.stringify({
						type: "online-count-change",
						data: {
							onlineCount: room.clients.size,
							userId: ws.userId,
							userName: ws.userName,
							type: "leave",
						},
					})
				);
			}
		});
	});
});

const { setupProcessListeners } = require("./utils/errorHandler");

// 生产环境下建议开启进程异常监听
setupProcessListeners();

Logger.welcome();
server.listen(config.PORT, config.HOST, () => {
	Logger.serverInfo(config.PORT, config.HOST, getLocalIp());
});
