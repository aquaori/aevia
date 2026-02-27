require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const os = require("os");

const app = express();
app.use(cors()); // 启用 CORS
app.use(express.json()); // 解析 JSON 请求体
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    permessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3,
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024,
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024, // 只有超过 1KB 的消息才压缩
    },
});
const JWT_SECRET =
    process.env.JWT_SECRET || "JWT_4cac0f79-4ba3-4ae6-a498-84e54ecde8aa";

// 使用 Map 存储本地房间连接信息
// Key: roomId, Value: { name: string, clients: Set<WebSocket>, commands: Command[] }
const rooms = new Map();

// 为了方便测试，服务器会在启动后默认创建一个房间：123123
rooms.set("123123", { name: "123123", clients: new Set(), commands: [] });

// --- 2. WebSocket 连接处理 ---

wss.on("connection", async (ws, req) => {
    // 从 URL 中解析 token, 例如 ws://localhost:3000?token=123456&pageId=1
    const urlString = req.url.startsWith("http")
        ? req.url
        : `http://localhost${req.url}`;
    const urlParams = new URL(urlString).searchParams;

    // 如果没有提供 token，则为非法请求，拒绝连接
    if (!urlParams.has("token")) {
        ws.send(
            JSON.stringify({
                type: "init",
                data: { status: "Token is required", userId: null },
            }),
        );
        ws.close(4001, "Token is required");
        return;
    }

    const token = urlParams.get("token");
    // 验证 token
    let decoded = null;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        ws.send(
            JSON.stringify({
                type: "init",
                data: { status: "Invalid token", userId: null },
            }),
        );
        ws.close(4001, "Invalid token");
        return;
    }
    const roomId = decoded.roomId;
    // 如果房间不存在，拒绝连接
    if (!rooms.has(roomId)) {
        ws.send(
            JSON.stringify({
                type: "init",
                data: { status: "Room not found", userId: null },
            }),
        );
        ws.close(4001, "Room not found");
        return;
    }

    // 初始化页面，默认为 1
    const initialPageId = parseInt(urlParams.get("pageId")) || 1;

    // 使用 UUID 生成唯一的 userId
    // 如果 URL 中携带了 token 或 userId (重连场景)，也可以优先使用
    const userId = decoded.userId || uuidv4();

    // 将连接添加到房间管理
    if (!rooms.has(roomId)) {
        // 理论上前面已经校验过，这里是一个防御性处理
        ws.send(
            JSON.stringify({
                type: "init",
                data: { status: "Room not found", userId: null },
            }),
        );
        return ws.close(4001, "Room not found");
    }
    rooms.get(roomId).clients.add(ws);

    // 将元数据绑定到 ws 对象上，方便后续使用
    ws.roomId = roomId;
    ws.userId = userId;
    // 记录用户当前所在的 pageId
    ws.pageId = initialPageId;
    const onlineCount = rooms.get(roomId).clients.size;
    const commands = rooms.get(roomId).commands;
    ws.send(
        JSON.stringify({
            type: "init",
            data: {
                status: "connected",
                userId: userId,
                roomId: roomId,
                roomName: decoded.roomName,
                userName: decoded.userName,
                onlineCount: onlineCount,
                commands: rooms.get(roomId).commands,
            },
        }),
    );
    Logger.wsEvent("joined", decoded.userName, userId, roomId, `page: ${initialPageId}`);

    // 向其它用户广播当前在线人数变化
    rooms.get(roomId).clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(
                JSON.stringify({
                    type: "online-count-change",
                    data: {
                        onlineCount: rooms.get(roomId).clients.size,
                    },
                }),
            );
        }
    });

    // 4. 处理客户端消息
    ws.on("message", async (message) => {
        try {
            // 假设前端发送的数据格式为 JSON 字符串
            // 且格式符合 Command 接口
            const parsedMsg = JSON.parse(message);
            if (
                parsedMsg.type === "push-cmd" ||
                parsedMsg.type === "cmd-start" ||
                parsedMsg.type === "cmd-update"
            ) {
                const cmdId = parsedMsg.data.cmdId || parsedMsg.data.id || "unknown";
                Logger.cmd(parsedMsg.type, cmdId);
                const room = rooms.get(roomId);
                if ((!parsedMsg.data.userId) in room.clients) {
                    console.log(
                        "User not found in room:",
                        parsedMsg.data.userId,
                    );
                    return;
                }
                if (
                    parsedMsg.type == "cmd-update" &&
                    room.commands?.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    )
                ) {
                    const originalPoints = room.commands.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    ).points;
                    // Ensure both originalPoints and parsedMsg.data.points are arrays
                    let updatedPoints;
                    if (
                        Array.isArray(originalPoints) &&
                        Array.isArray(parsedMsg.data.points)
                    ) {
                        updatedPoints = [
                            ...originalPoints,
                            ...parsedMsg.data.points,
                        ];
                    } else {
                        updatedPoints = {
                            ...originalPoints,
                            ...parsedMsg.data.points,
                        };
                    }
                    room.commands.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    ).points = updatedPoints;
                } else {
                    room.commands.push(parsedMsg.data.cmd);
                }

                // 广播给房间内其它客户端
                const pushType =
                    parsedMsg.type == "cmd-start"
                        ? "start"
                        : parsedMsg.type == "cmd-update"
                          ? "update"
                          : "normal";
                if (room.clients.size !== 1) {
                    room.clients.forEach((client) => {
                        if (
                            client !== ws &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "push-cmd",
                                    pushType: pushType ?? "normal",
                                    data: parsedMsg.data,
                                }),
                            );
                        }
                    });
                }
            } else if (parsedMsg.type == "cmd-stop") {
                // 处理 cmd-stop 消息
                const room = rooms.get(roomId);
                if (
                    room.commands?.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    )
                ) {
                    // 广播给房间内其它客户端
                    if (room.clients.size !== 1) {
                        room.clients.forEach((client) => {
                            if (
                                client !== ws &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "push-cmd",
                                        pushType: "stop",
                                        data: parsedMsg.data,
                                    }),
                                );
                            }
                        });
                    }
                }
            } else if (parsedMsg.type === "mouseMove") {
                const room = rooms.get(roomId);
                if (room.clients.size !== 1) {
                    room.clients.forEach((client) => {
                        if (
                            client !== ws &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "mouseMove",
                                    data: parsedMsg.data,
                                }),
                            );
                        }
                    });
                }
            } else if (parsedMsg.type === "mouseLeave") {
                const room = rooms.get(roomId);
                if (room.clients.size !== 1) {
                    room.clients.forEach((client) => {
                        if (
                            client !== ws &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "mouseLeave",
                                    data: parsedMsg.data,
                                }),
                            );
                        }
                    });
                }
            } else if (parsedMsg.type === "undo-cmd") {
                const room = rooms.get(roomId);
                if (
                    room.commands?.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    )
                ) {
                    room.commands.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    ).isDeleted = true;
                    Logger.wsEvent("undo", decoded.userName, userId, roomId, parsedMsg.data.cmdId);
                    // 广播给房间内其它客户端
                    if (room.clients.size !== 1) {
                        room.clients.forEach((client) => {
                            if (
                                client !== ws &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "undo-cmd",
                                        data: parsedMsg.data,
                                    }),
                                );
                            }
                        });
                    }
                }
            } else if (parsedMsg.type === "redo-cmd") {
                const room = rooms.get(roomId);
                if (
                    room.commands?.find(
                        (cmd) => cmd && cmd.id === parsedMsg.data.cmdId,
                    )
                ) {
                    Logger.wsEvent("redo", decoded.userName, userId, roomId, parsedMsg.data.cmdId);
                    // 广播给房间内其它客户端
                    if (room.clients.size !== 1) {
                        room.clients.forEach((client) => {
                            if (
                                client !== ws &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "redo-cmd",
                                        data: parsedMsg.data,
                                    }),
                                );
                            }
                        });
                    }
                }
            } else if (parsedMsg.type === "cmd-batch-move") {
                const room = rooms.get(roomId);
                if (room.clients.size !== 1) {
                    room.clients.forEach((client) => {
                        if (
                            client !== ws &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "cmd-batch-move",
                                    data: parsedMsg.data,
                                }),
                            );
                        }
                    });
                }
            } else if (parsedMsg.type === "cmd-batch-update") {
                const room = rooms.get(roomId);
                const data = parsedMsg.data;
                data.updates.forEach((update) => {
                    const cmd = room.commands?.find(
                        (cmd) => cmd && cmd.id === update.cmdId,
                    );
                    if (cmd) {
                        cmd.points = update.points;
                    }
                });
                // 广播给房间内其它客户端
                if (room.clients.size !== 1) {
                    room.clients.forEach((client) => {
                        if (
                            client !== ws &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "cmd-batch-update",
                                    data: parsedMsg.data,
                                }),
                            );
                        }
                    });
                }
            } else if (parsedMsg.type === "box-selecting") {
                // 广播给房间内其它客户端
                if (rooms.clients.size !== 1) {
                    rooms.clients.forEach((client) => {
                        if (
                            client !== ws &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "box-selecting",
                                    data: parsedMsg.data,
                                }),
                            );
                        }
                    });
                }
            }
        } catch (e) {
            console.error("Error processing message from client:", e);
        }
    });

    // 连接关闭处理
    ws.on("close", () => {
        const room = rooms.get(roomId);
        if (room && room.clients) {
            room.clients.delete(ws);
            if (room.clients.size === 0 && roomId != "123123") {
                rooms.delete(roomId); // 房间没人了，清理 Map
            }
        }
        Logger.wsEvent("left", decoded.userName, userId, roomId);
        const clients = room.clients;
        if (clients.size !== 0) {
            clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(
                        JSON.stringify({
                            type: "online-count-change",
                            data: {
                                onlineCount: rooms.get(roomId).clients.size,
                            },
                        }),
                    );
                }
            });
        } else if (roomId != "123123") {
            rooms.delete(roomId); // 房间没人了，清理 Map
            Logger.info(`Room ${roomId} deleted due to no clients`);
        }
    });

    ws.on("error", (err) => {
        console.error(`Client ${userId} error:`, err);
    });
});

// --- 3. 启动服务器 ---
const Logger = require("./utils/logger");
const PORT = 4646;
const HOST = "0.0.0.0";
const localIp = getLocalIp();

Logger.welcome();
server.listen(PORT, HOST, () => {
    Logger.serverInfo(PORT, HOST, localIp);
});

// 创建房间
app.post("/create-room", (req, res) => {
    // 接收前端传来的房间id和名称
    const { roomId, roomName, password } = req.body;
    if (!roomId) {
        return res
            .status(400)
            .json({ code: 400, msg: "Room ID is required", data: [] });
    }
    if (rooms.has(roomId)) {
        return res
            .status(400)
            .json({ code: 400, msg: "Room already exists", data: [] });
    }
    // 使用新结构存储房间信息
    rooms.set(roomId, {
        name: roomName || "房间" + roomId,
        password: password || "",
        commands: [],
        clients: new Set(),
    });
    Logger.success(`Room created: ${roomId} (${roomName || "房间" + roomId})`);
    res.status(200).json({ code: 200, msg: "success", data: [] });
});

// 检查房间是否存在
app.get("/check-room", (req, res) => {
    // 接收前端传来的房间id
    const roomId = req.query.roomId;
    if (!roomId) {
        return res
            .status(400)
            .json({ code: 400, msg: "Room ID is required", data: [] });
    }
    if (rooms.has(roomId)) {
        return res
            .status(200)
            .json({ code: 200, msg: "success", data: { status: true } });
    }
    res.status(200).json({
        code: 200,
        msg: "success",
        data: { status: false },
    });
});

// 随机生成一个没用过的房号
app.get("/generate-room-id", (req, res) => {
    // 房间号是 6 位数字
    let roomId;
    do {
        roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(roomId));
    res.status(200).json({ code: 200, msg: "success", data: { roomId } });
});

app.post("/join-room", (req, res) => {
    // 接收前端传来的房间id和用户id
    const { roomId, userName, password } = req.body;
    let roomIdStr = roomId;
    if (typeof roomId !== "string") {
        roomIdStr = roomId.toString();
    }
    if (!roomId || roomIdStr.length === 0) {
        return res
            .status(400)
            .json({ code: 400, msg: "Room ID is required", data: [] });
    }
    if (!userName) {
        return res
            .status(400)
            .json({ code: 400, msg: "User Name is required", data: [] });
    }
    if (!rooms.has(roomIdStr)) {
        return res.status(400).json({
            code: 400,
            msg: "Room does not exist",
            data: [],
        });
    }
    // 检查密码是否匹配
    const room = rooms.get(roomIdStr);
    if (room.password && room.password !== password) {
        return res
            .status(400)
            .json({ code: 400, msg: "Password incorrect", data: [] });
    }
    const userId = uuidv4();
    // 生成一个短期有效的 token 凭证返回给客户端，用于 WebSocket 连接时使用
    const roomName = room.name;
    const token = generateToken({
        userId,
        userName,
        roomId: roomIdStr,
        roomName,
    });
    res.status(200).json({
        code: 200,
        msg: "success",
        data: {
            token,
        },
    });
});

app.get("/generate-share-token", (req, res) => {
    // 接收前端传来的房间id
    const roomId = req.query.roomId;
    if (!roomId) {
        return res
            .status(400)
            .json({ code: 400, msg: "Room ID is required", data: [] });
    }
    if (!rooms.has(roomId)) {
        return res.status(400).json({
            code: 400,
            msg: "Room does not exist",
            data: [],
        });
    }
    // 生成一个长期有效的 token 凭证返回给客户端，用于 WebSocket 连接时使用
    const roomName = rooms.get(roomId).name;
    const password = rooms.get(roomId).password || "";
    const token = generateToken({ roomId, roomName }, "1d"); // 1 天有效期
    res.status(200).json({
        code: 200,
        msg: "success",
        data: {
            token,
            password: password || "",
        },
    });
});

app.get("/get-token-info", (req, res) => {
    // 接收前端传来的 token
    const token = req.query.token;
    if (!token) {
        return res
            .status(400)
            .json({ code: 400, msg: "Token is required", data: [] });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(400).json({
            code: 400,
            msg: "Token is invalid",
            data: [],
        });
    }
    res.status(200).json({
        code: 200,
        msg: "success",
        data: decoded,
    });
});

function verifyToken(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded;
        /*
        Example decoded:
        {
            userId: '9eb81252-fd13-4e5b-a63d-70b6ce8eab89',
            userName: '用户1',
            roomId: '111111',
            roomName: '房间111111',
            iat: 1769407810,
            exp: 1769411410
        }
        */
    } catch (e) {
        return null;
    }
}

function generateToken(info, expiresIn = "1min") {
    let token = null;
    const payload = {
        ...info,
    };
    token = jwt.sign(payload, JWT_SECRET, { expiresIn });
    return token;
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            // 过滤：IPv4、非回环地址、非内网虚拟地址
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
