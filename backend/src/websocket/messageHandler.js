const WebSocket = require("ws");
const roomService = require("../services/roomService");
const Logger = require("../utils/logger");

/**
 * 广播消息给房间内的其他客户端
 */
const broadcastToOthers = (roomId, excludeWs, messageObj) => {
    const room = roomService.getRoom(roomId);
    if (!room) return;

    const payload = JSON.stringify(messageObj);
    room.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
};

const handlers = {
    "push-cmd": (ws, data) => {
        Logger.cmd("push-cmd", data.cmdId || data.id);
        const room = roomService.getRoom(ws.roomId);
        if (room) {
            room.commands.push(data.cmd);
            if (data.cmd.type === "clear") {
                // 同步清理命令队列中属于本页的命令（类似 GC 机制，只回收当前页的废弃命令）
                const targetPageId = data.cmd.pageId;
                if (targetPageId !== undefined) {
                    // 剔除属于当前页面的所有命令，保留其他页面的命令
                    room.commands = room.commands.filter(cmd => cmd.pageId !== targetPageId);
                } else {
                    // 兼容旧版本：如果没有 pageId，清空所有命令
                    room.commands = [];
                }
            }
            broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "normal", data });
        }
    },

    "cmd-start": (ws, data) => {
        Logger.cmd("cmd-start", data.cmdId || data.id);
        const room = roomService.getRoom(ws.roomId);
        if (room) {
            room.commands.push(data.cmd);
            broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "start", data });
        }
    },

    "cmd-update": (ws, data) => {
        // Logger.cmd 内部会自动过滤 cmd-update
        Logger.cmd("cmd-update", data.cmdId);
        const room = roomService.getRoom(ws.roomId);
        if (!room) return;

        const cmd = room.commands.find((c) => c && c.id === data.cmdId);
        if (cmd) {
            if (Array.isArray(cmd.points) && Array.isArray(data.points)) {
                cmd.points = [...cmd.points, ...data.points];
            } else {
                cmd.points = { ...cmd.points, ...data.points };
            }
            broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "update", data });
        }
    },

    "cmd-stop": (ws, data) => {
        const room = roomService.getRoom(ws.roomId);
        if (!room) return;

        const cmd = room.commands.find((c) => c && c.id === data.cmdId);
        if (cmd) {
            if (Array.isArray(cmd.points) && Array.isArray(data.points)) {
                cmd.points = [...cmd.points, ...data.points];
            } else {
                cmd.points = { ...cmd.points, ...data.points };
            }
            if (data.cmd.box && Object.keys(data.cmd.box).length > 0) {
                cmd.box = data.cmd.box;
            };
        }
        broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "stop", data });
    },

    "undo-cmd": (ws, data) => {
        const room = roomService.getRoom(ws.roomId);
        const cmd = room?.commands.find((c) => c && c.id === data.cmdId);
        if (cmd) {
            cmd.isDeleted = true;
            Logger.wsEvent("undo", ws.userName, ws.userId, ws.roomId, data.cmdId);
            broadcastToOthers(ws.roomId, ws, { type: "undo-cmd", data });
        }
    },

    "redo-cmd": (ws, data) => {
        const room = roomService.getRoom(ws.roomId);
        const cmd = room?.commands.find((c) => c && c.id === data.cmdId);
        if (cmd) {
            cmd.isDeleted = false;
            Logger.wsEvent("redo", ws.userName, ws.userId, ws.roomId, data.cmdId);
            broadcastToOthers(ws.roomId, ws, { type: "redo-cmd", data });
        }
    },

    "mouseMove": (ws, data) => {
        broadcastToOthers(ws.roomId, ws, { type: "mouseMove", data });
    },

    "mouseLeave": (ws, data) => {
        broadcastToOthers(ws.roomId, ws, { type: "mouseLeave", data });
    },

    "cmd-batch-move": (ws, data) => {
        broadcastToOthers(ws.roomId, ws, { type: "cmd-batch-move", data });
    },

    "cmd-batch-update": (ws, data) => {
        const room = roomService.getRoom(ws.roomId);
        data.updates.forEach((update) => {
            const cmd = room.commands?.find((cmd) => cmd && cmd.id === update.cmdId);
            if (cmd) {
                cmd.points = update.points;
            }
        });
        broadcastToOthers(ws.roomId, ws, { type: "cmd-batch-update", data });
    },

    "cmd-batch-stop": (ws, data) => {
        const room = roomService.getRoom(ws.roomId);
        data.updates.forEach((update) => {
            const cmd = room.commands?.find((cmd) => cmd && cmd.id === update.cmdId);
            if (cmd) {
                cmd.points = update.points;
                cmd.box = update.boxes;
            }
        });
        broadcastToOthers(ws.roomId, ws, { type: "cmd-batch-stop", data });
    },

    "box-selection": (ws, data) => {
        broadcastToOthers(ws.roomId, ws, { type: "box-selection", data });
    },

    "cmd-page-add": (ws, data) => {
        const room = roomService.getRoom(ws.roomId);
        if (room) {
            room.totalPage++;
        }
        broadcastToOthers(ws.roomId, ws, { type: "cmd-page-add", data });
    },

    "get-member-list": (ws, data) => {
        const room = roomService.getRoom(data.roomId);
        if (room) {
            if (ws.readyState === WebSocket.OPEN) {
                const userNameList = [...room.clients].map(ws => [ws.userId, ws.userName]);
                ws.send(
                    JSON.stringify({
                        type: "get-member-list",
                        data: {
                            memberList: userNameList,
                        },
                    }),
                );
            }
        }
    }
};

module.exports = (ws, message) => {
    try {
        const parsedMsg = JSON.parse(message);
        
        // 防御性校验：必须包含 type 和 data
        if (!parsedMsg.type || !parsedMsg.data) {
            Logger.warn(`Received malformed message from ${ws.userId.slice(0, 8)}`);
            return;
        }

        const handler = handlers[parsedMsg.type];
        if (handler) {
            handler(ws, parsedMsg.data);
        } else {
            Logger.warn(`No handler found for message type: ${parsedMsg.type}`);
        }
    } catch (e) {
        Logger.error("WebSocket Message Parse Error:", e.message);
    }
};
