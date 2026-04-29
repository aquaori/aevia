const http = require("http");
const WebSocket = require("ws");
const os = require("os");
const { protocolPageToState } = require("./shared/collabProtocol");
const app = require("./app");
const config = require("./config");
const roomService = require("./services/roomService");
const { authService } = require("./services/authService");
const handleWsMessage = require("./websocket/messageHandler");
const {
    buildRenderChunkDictionary,
    encodeRenderChunkBinary,
} = require("./websocket/renderChunkBinary");
const Logger = require("./utils/logger");

const server = http.createServer(app);

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

    const decoded = authService.verifySessionToken(token);
    if (!decoded || !roomService.hasRoom(decoded.roomId)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
    }

    const room = roomService.getRoom(decoded.roomId);
    if (decoded.roomCreatedAt !== room.createdAt) {
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
            if (
                alias.family === "IPv4" &&
                alias.address !== "127.0.0.1" &&
                !alias.internal
            ) {
                return alias.address;
            }
        }
    }
    return "127.0.0.1";
}

function sendJson(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
}

function sendBinary(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(payload, { binary: true });
}

function sendInitStream(ws, room, initStream) {
    if (!initStream) return;

    const memberList = [...room.clients].map((client) => [
        client.userId,
        client.userName,
    ]);

    sendJson(ws, {
        type: "init-meta",
        data: {
            status: "connected",
            userId: ws.userId,
            userName: ws.userName,
            roomId: ws.roomId,
            roomName: room.name,
            onlineCount: room.clients.size,
            memberList,
            snapshotVersion: initStream.snapshotVersion,
            ...initStream.meta,
        },
    });

    sendJson(ws, {
        type: "init-render-meta",
        data: {
            snapshotVersion: initStream.snapshotVersion,
            pageId: initStream.meta.pageId,
            totalChunks: initStream.renderChunks.length,
            flatPointChunkSize: initStream.meta.chunkSummary.flatPointChunkSize,
            totalFlatPoints: initStream.meta.chunkSummary.totalFlatPoints,
        },
    });

    initStream.renderChunks.forEach((chunk) => {
        const flatPoints = chunk.flatPointChunk.items;
        const { commandMap, commands } = buildRenderChunkDictionary(flatPoints);

        sendJson(ws, {
            type: "init-render-chunk-meta",
            data: {
                snapshotVersion: initStream.snapshotVersion,
                chunkIndex: chunk.chunkIndex,
                isLastChunk: chunk.isLastChunk,
                pointCount: flatPoints.length,
                commands,
                lamportStart: chunk.flatPointChunk.lamportStart,
                lamportEnd: chunk.flatPointChunk.lamportEnd,
            },
        });

        sendBinary(
            ws,
            encodeRenderChunkBinary(
                flatPoints,
                commandMap,
                initStream.snapshotVersion,
                chunk.chunkIndex,
            ),
        );
    });

    sendJson(ws, {
        type: "init-render-done",
        data: {
            snapshotVersion: initStream.snapshotVersion,
            totalChunks: initStream.renderChunks.length,
        },
    });

    sendJson(ws, {
        type: "init-commands-meta",
        data: {
            snapshotVersion: initStream.snapshotVersion,
            loadedPageIds: initStream.meta.loadedPageIds,
            totalChunks: initStream.commandChunks.length,
            commandChunkSize: initStream.meta.chunkSummary.commandChunkSize,
            totalCommands: initStream.meta.chunkSummary.totalCommands,
        },
    });

    initStream.commandChunks.forEach((chunk) => {
        sendJson(ws, {
            type: "init-commands-chunk",
            data: {
                snapshotVersion: initStream.snapshotVersion,
                chunkIndex: chunk.chunkIndex,
                isLastChunk: chunk.isLastChunk,
                commands: chunk.commandChunk.items,
            },
        });
    });

    sendJson(ws, {
        type: "init-commands-done",
        data: {
            snapshotVersion: initStream.snapshotVersion,
            totalChunks: initStream.commandChunks.length,
        },
    });

    sendJson(ws, {
        type: "init-complete",
        data: {
            snapshotVersion: initStream.snapshotVersion,
        },
    });
}

wss.on("connection", (ws, req, decoded) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const initialPageId = protocolPageToState(
        requestUrl.searchParams.get("pageId"),
    );

    ws.isAlive = true;
    ws.roomId = decoded.roomId;
    ws.userId = decoded.userId;
    ws.userName = decoded.userName;
    ws.roomCreatedAt = decoded.roomCreatedAt;
    ws.pageId = initialPageId;

    const room = roomService.addClient(ws.roomId, ws);
    const initPayload = roomService.getInitPayload(ws.roomId, ws.pageId);
    const initStream = roomService.buildInitStream(ws.roomId, initPayload);

    Logger.wsEvent("joined", ws.userName, ws.userId, ws.roomId);

    sendInitStream(ws, room, initStream);

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

    ws.on("message", (msg, isBinary) => handleWsMessage(ws, msg, isBinary));
    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("close", () => {
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

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) {
            return;
        }

        if (client.isAlive === false) {
            client.terminate();
            return;
        }

        client.isAlive = false;
        client.ping();
    });
}, config.WS_HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
    clearInterval(heartbeatInterval);
});

const { setupProcessListeners } = require("./utils/errorHandler");

setupProcessListeners();

Logger.welcome();
server.listen(config.PORT, config.HOST, () => {
    Logger.serverInfo(config.PORT, config.HOST, getLocalIp());
});
