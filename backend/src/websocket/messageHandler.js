const WebSocket = require("ws");
const config = require("../config");
const roomService = require("../services/roomService");
const Logger = require("../utils/logger");

const normalizePageIds = (pageIds) =>
  [...new Set(pageIds.filter((pageId) => Number.isInteger(pageId) && pageId >= 0))];

const clientHasAnyPage = (client, targetPageIds, radius = config.PAGE_CACHE_RADIUS) => {
  if (!Number.isInteger(client.pageId)) {
    return true;
  }

  return targetPageIds.some((pageId) => Math.abs(client.pageId - pageId) <= radius);
};

const broadcastToOthers = (roomId, excludeWs, messageObj, targetPageIds = null) => {
  const room = roomService.getRoom(roomId);
  if (!room) return;

  const payload = JSON.stringify(messageObj);
  const normalizedTargetPageIds = targetPageIds === null ? null : normalizePageIds(targetPageIds);

  room.clients.forEach((client) => {
    if (client === excludeWs || client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (
      normalizedTargetPageIds &&
      normalizedTargetPageIds.length > 0 &&
      !clientHasAnyPage(client, normalizedTargetPageIds)
    ) {
      return;
    }

    if (
      normalizedTargetPageIds &&
      normalizedTargetPageIds.length === 0 &&
      client !== excludeWs
    ) {
      return;
    }

    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
};

const handlers = {
  "push-cmd": (ws, data) => {
    Logger.cmd("push-cmd", data.cmdId || data.id);
    if (!roomService.hasRoom(ws.roomId) || !data.cmd) return;
    const targetPageId = Number.isInteger(data.cmd.pageId) ? data.cmd.pageId : ws.pageId;

    if (data.cmd.type === "clear") {
      roomService.clearCommands(ws.roomId, data.cmd.pageId);
    } else {
      roomService.saveCommand(ws.roomId, data.cmd);
    }

    broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "normal", data }, [targetPageId]);
  },

  "cmd-start": (ws, data) => {
    Logger.cmd("cmd-start", data.cmdId || data.id);
    if (roomService.saveCommand(ws.roomId, data.cmd)) {
      const targetPageId = Number.isInteger(data.cmd?.pageId) ? data.cmd.pageId : ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "start", data }, [targetPageId]);
    }
  },

  "cmd-update": (ws, data) => {
    Logger.cmd("cmd-update", data.cmdId);
    if (roomService.mergeCommandPoints(ws.roomId, data.cmdId, data.points)) {
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "update", data }, [targetPageId]);
    }
  },

  "cmd-stop": (ws, data) => {
    if (roomService.mergeCommandPointsAndBox(ws.roomId, data.cmdId, data.points, data.cmd?.box)) {
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "stop", data }, [targetPageId]);
    }
  },

  "undo-cmd": (ws, data) => {
    if (roomService.setCommandDeleted(ws.roomId, data.cmdId, true)) {
      Logger.wsEvent("undo", ws.userName, ws.userId, ws.roomId, data.cmdId);
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "undo-cmd", data }, [targetPageId]);
    }
  },

  "redo-cmd": (ws, data) => {
    if (roomService.setCommandDeleted(ws.roomId, data.cmdId, false)) {
      Logger.wsEvent("redo", ws.userName, ws.userId, ws.roomId, data.cmdId);
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "redo-cmd", data }, [targetPageId]);
    }
  },

  mouseMove: (ws, data) => {
    broadcastToOthers(ws.roomId, ws, { type: "mouseMove", data }, [ws.pageId]);
  },

  mouseLeave: (ws, data) => {
    broadcastToOthers(ws.roomId, ws, { type: "mouseLeave", data }, [ws.pageId]);
  },

  "cmd-batch-move": (ws, data) => {
    broadcastToOthers(ws.roomId, ws, { type: "cmd-batch-move", data }, [ws.pageId]);
  },

  "cmd-batch-update": (ws, data) => {
    const targetPageIds = [];
    data.updates.forEach((update) => {
      roomService.replaceCommandPoints(ws.roomId, update.cmdId, update.points);
      const targetPageId = roomService.getCommandPageId(ws.roomId, update.cmdId);
      if (Number.isInteger(targetPageId)) {
        targetPageIds.push(targetPageId);
      }
    });
    broadcastToOthers(
      ws.roomId,
      ws,
      { type: "cmd-batch-update", data },
      targetPageIds.length > 0 ? targetPageIds : [ws.pageId],
    );
  },

  "cmd-batch-stop": (ws, data) => {
    const targetPageIds = [];
    data.updates.forEach((update) => {
      roomService.replaceCommandPointsAndBox(ws.roomId, update.cmdId, update.points, update.boxes);
      const targetPageId = roomService.getCommandPageId(ws.roomId, update.cmdId);
      if (Number.isInteger(targetPageId)) {
        targetPageIds.push(targetPageId);
      }
    });
    broadcastToOthers(
      ws.roomId,
      ws,
      { type: "cmd-batch-stop", data },
      targetPageIds.length > 0 ? targetPageIds : [ws.pageId],
    );
  },

  "box-selection": (ws, data) => {
    broadcastToOthers(ws.roomId, ws, { type: "box-selection", data }, [ws.pageId]);
  },

  "cmd-page-add": (ws, data) => {
    roomService.incrementTotalPage(ws.roomId);
    broadcastToOthers(ws.roomId, ws, { type: "cmd-page-add", data });
  },

  "page-change": (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const hasDeltaCursor =
      Number.isInteger(data?.prevPageId) && Number.isInteger(data?.nextPageId);

    const pagePayload = hasDeltaCursor
      ? roomService.getPageChangePayload(ws.roomId, data.prevPageId, data.nextPageId)
      : roomService.getPageWindowPayload(ws.roomId, data.pageId);

    if (!pagePayload) return;

    ws.pageId = pagePayload.pageId;
    ws.send(
      JSON.stringify({
        type: "page-change",
        data: {
          mode: hasDeltaCursor ? "delta" : "full",
          ...pagePayload,
        },
      }),
    );
  },

  "get-member-list": (ws, data) => {
    const room = roomService.getRoom(data.roomId);
    if (!room || ws.readyState !== WebSocket.OPEN) return;

    const userNameList = [...room.clients].map((clientWs) => [clientWs.userId, clientWs.userName]);
    ws.send(
      JSON.stringify({
        type: "get-member-list",
        data: {
          memberList: userNameList,
        },
      }),
    );
  },
};

module.exports = (ws, message) => {
  try {
    const parsedMsg = JSON.parse(message);

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
