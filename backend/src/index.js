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
const SERVER_START_TIME = Date.now();
const offlineUsers = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [userId, expiredAt] of offlineUsers.entries()) {
    if (now > expiredAt) {
      offlineUsers.delete(userId);
    }
  }
}, 60000);

const wss = new WebSocket.Server({
  noServer: true,
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

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }

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
  } else if (isTokenExpired) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, decoded);
  });
});

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i += 1) {
      const alias = iface[i];
      if (alias.family === "IPv4" && alias.address !== "127.0.0.1" && !alias.internal) {
        return alias.address;
      }
    }
  }
  return "127.0.0.1";
}

wss.on("connection", (ws, req, decoded) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const initialPageId = Number.parseInt(requestUrl.searchParams.get("pageId"), 10);

  ws.roomId = decoded.roomId;
  ws.userId = decoded.userId;
  ws.userName = decoded.userName;
  ws.roomCreatedAt = decoded.roomCreatedAt;
  ws.pageId = Number.isInteger(initialPageId) ? initialPageId : 0;

  const room = roomService.addClient(ws.roomId, ws);
  const initPayload = roomService.getInitPayload(ws.roomId, ws.pageId);

  Logger.wsEvent("joined", ws.userName, ws.userId, ws.roomId);

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
        totalPage: initPayload.totalPage,
        pageId: initPayload.pageId,
        loadedPageIds: initPayload.loadedPageIds,
        commands: initPayload.commands,
      },
    }),
  );

  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "online-count-change",
          data: {
            onlineCount: room.clients.size,
            userId: ws.userId,
            userName: ws.userName,
            type: "join",
          },
        }),
      );
    }
  });

  ws.on("message", (msg) => handleWsMessage(ws, msg));

  ws.on("close", () => {
    offlineUsers.set(ws.userId, Date.now() + 60000);

    roomService.removeClient(ws.roomId, ws);
    Logger.wsEvent("left", ws.userName, ws.userId, ws.roomId);

    room.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "online-count-change",
            data: {
              onlineCount: room.clients.size,
              userId: ws.userId,
              userName: ws.userName,
              type: "leave",
            },
          }),
        );
      }
    });
  });
});

const { setupProcessListeners } = require("./utils/errorHandler");

setupProcessListeners();

Logger.welcome();
server.listen(config.PORT, config.HOST, () => {
  Logger.serverInfo(config.PORT, config.HOST, getLocalIp());
});
