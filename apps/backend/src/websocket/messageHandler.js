const WebSocket = require("ws");
const { normalizeLoadedPageIds } = require("../shared/collabProtocol");
const config = require("../config");
const roomService = require("../services/roomService");
const {
  buildRenderChunkDictionary,
  encodeRenderChunkBinary,
} = require("./renderChunkBinary");
const {
  hasRealtimeBinaryMagic,
  encodeMouseMoveServerBinary,
  encodeCmdUpdateBinary,
  decodeRealtimeBinaryMessage,
  binaryPayloadToUtf8,
} = require("./realtimeBinary");
const Logger = require("../utils/logger");

const normalizePageIds = (pageIds) => normalizeLoadedPageIds(pageIds);

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

const sendJson = (ws, messageObj) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(messageObj));
};

const sendBinary = (ws, payload) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(payload, { binary: true });
};

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

const isValidPoint = (point) =>
  point &&
  typeof point === "object" &&
  isFiniteNumber(point.x) &&
  isFiniteNumber(point.y) &&
  isFiniteNumber(point.p) &&
  isFiniteNumber(point.lamport);

const isValidPoints = (points) => Array.isArray(points) && points.every(isValidPoint);

const isValidBox = (box) =>
  box &&
  typeof box === "object" &&
  isFiniteNumber(box.minX) &&
  isFiniteNumber(box.minY) &&
  isFiniteNumber(box.maxX) &&
  isFiniteNumber(box.maxY) &&
  isFiniteNumber(box.width) &&
  isFiniteNumber(box.height);

const isValidCommand = (cmd) =>
  cmd &&
  typeof cmd === "object" &&
  isNonEmptyString(cmd.id) &&
  (cmd.type === "path" || cmd.type === "clear") &&
  isFiniteNumber(cmd.timestamp) &&
  isNonEmptyString(cmd.userId) &&
  isNonEmptyString(cmd.roomId) &&
  Number.isInteger(cmd.pageId) &&
  cmd.pageId >= 0 &&
  typeof cmd.isDeleted === "boolean" &&
  isFiniteNumber(cmd.lamport) &&
  (cmd.points === undefined || isValidPoints(cmd.points)) &&
  (cmd.box === undefined || cmd.box === null || isValidBox(cmd.box));

const normalizeCommandIdentity = (ws, cmd) => ({
  ...cmd,
  userId: ws.userId,
  roomId: ws.roomId,
});

const withTrustedIdentity = (ws, data = {}) => ({
  ...data,
  userId: ws.userId,
  userName: ws.userName,
  username: ws.userName,
});

const rejectOperation = (ws, opType, options = {}) => {
  const {
    code = "INVALID_OPERATION",
    reason = "Operation rejected by server.",
    cmdId = null,
    pageId = null,
    requestId = null,
    shouldRefresh = true,
    shouldResync = false,
  } = options;

  Logger.warn(
    `Rejected ${opType} from ${ws.userId?.slice(0, 8) || "unknown"}: ${code}${cmdId ? ` (${cmdId})` : ""}`,
  );

  sendJson(ws, {
    type: "op-rejected",
    data: {
      opType,
      code,
      reason,
      cmdId,
      pageId,
      roomId: ws.roomId ?? null,
      requestId,
      shouldRefresh,
      shouldResync,
      serverTimestamp: Date.now(),
    },
  });
};

const broadcastBinaryToOthers = (roomId, excludeWs, payload, targetPageIds = null) => {
  const room = roomService.getRoom(roomId);
  if (!room) return;

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
      client.send(payload, { binary: true });
    }
  });
};

const waitForNextTick = () => new Promise((resolve) => setImmediate(resolve));

const sendPageChangeStream = async (ws, stream, requestId, generation) => {
  if (!stream || ws.readyState !== WebSocket.OPEN) return;

  const isCancelled = () =>
    ws.readyState !== WebSocket.OPEN ||
    !ws.pageChangeStreamState ||
    ws.pageChangeStreamState.generation !== generation;

  sendJson(ws, {
    type: "page-change-meta",
    data: {
      requestId,
      snapshotVersion: stream.snapshotVersion,
      ...stream.meta,
    },
  });

  sendJson(ws, {
    type: "page-change-render-meta",
    data: {
      requestId,
      snapshotVersion: stream.snapshotVersion,
      pageId: stream.meta.pageId,
      mode: stream.meta.mode,
      totalChunks: stream.meta.chunkSummary.totalRenderChunks,
      flatPointChunkSize: stream.meta.chunkSummary.flatPointChunkSize,
      totalFlatPoints: stream.meta.chunkSummary.totalFlatPoints,
    },
  });

  for (const chunk of stream.renderChunks) {
    if (isCancelled()) return;

    const flatPoints = chunk.flatPointChunk.items;
    const { commandMap, commands } = buildRenderChunkDictionary(flatPoints);

    sendJson(ws, {
      type: "page-change-render-chunk-meta",
      data: {
        requestId,
        snapshotVersion: stream.snapshotVersion,
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
        stream.snapshotVersion,
        chunk.chunkIndex,
      ),
    );

    await waitForNextTick();
  }

  if (isCancelled()) return;

  sendJson(ws, {
    type: "page-change-render-done",
    data: {
      requestId,
      snapshotVersion: stream.snapshotVersion,
      totalChunks: stream.renderChunks.length,
    },
  });

  sendJson(ws, {
    type: "page-change-commands-meta",
    data: {
      requestId,
      snapshotVersion: stream.snapshotVersion,
      mode: stream.meta.mode,
      loadedPageIds: stream.meta.loadedPageIds,
      loadPageIds: stream.meta.loadPageIds,
      unloadPageIds: stream.meta.unloadPageIds,
      totalChunks: stream.meta.chunkSummary.totalCommandChunks,
      commandChunkSize: stream.meta.chunkSummary.commandChunkSize,
      totalCommands: stream.meta.chunkSummary.totalCommands,
    },
  });

  for (const chunk of stream.commandChunks) {
    if (isCancelled()) return;

    sendJson(ws, {
      type: "page-change-commands-chunk",
      data: {
        requestId,
        snapshotVersion: stream.snapshotVersion,
        chunkIndex: chunk.chunkIndex,
        isLastChunk: chunk.isLastChunk,
        commands: chunk.commandChunk.items,
      },
    });

    await waitForNextTick();
  }

  if (isCancelled()) return;

  sendJson(ws, {
    type: "page-change-commands-done",
    data: {
      requestId,
      snapshotVersion: stream.snapshotVersion,
      totalChunks: stream.meta.chunkSummary.totalCommandChunks,
    },
  });

  sendJson(ws, {
    type: "page-change-complete",
    data: {
      requestId,
      snapshotVersion: stream.snapshotVersion,
      mode: stream.meta.mode,
    },
  });
};

const handlers = {
  "push-cmd": (ws, data) => {
    Logger.cmd("push-cmd", data?.cmdId || data?.id);
    if (!roomService.hasRoom(ws.roomId)) {
      rejectOperation(ws, "push-cmd", {
        code: "ROOM_NOT_FOUND",
        reason: "Room does not exist.",
      });
      return;
    }

    const normalizedCommand = normalizeCommandIdentity(ws, data?.cmd);
    if (!normalizedCommand || !isValidCommand(normalizedCommand)) {
      rejectOperation(ws, "push-cmd", {
        code: "INVALID_COMMAND_FORMAT",
        reason: "Command payload is malformed.",
        cmdId: data?.cmd?.id ?? data?.id ?? null,
      });
      return;
    }

    const targetPageId = Number.isInteger(normalizedCommand.pageId) ? normalizedCommand.pageId : ws.pageId;
    let accepted = false;

    if (normalizedCommand.type === "clear") {
      accepted = roomService.clearCommands(ws.roomId, normalizedCommand.pageId);
    } else {
      accepted = roomService.saveCommand(ws.roomId, normalizedCommand);
    }

    if (!accepted) {
      rejectOperation(ws, "push-cmd", {
        code: "COMMAND_REJECTED",
        reason: "Server rejected the command.",
        cmdId: normalizedCommand.id,
        pageId: targetPageId,
      });
      return;
    }

    broadcastToOthers(
      ws.roomId,
      ws,
      { type: "push-cmd", pushType: "normal", data: { ...data, cmd: normalizedCommand } },
      [targetPageId],
    );
  },

  "cmd-start": (ws, data) => {
    Logger.cmd("cmd-start", data?.cmdId || data?.id);
    if (!roomService.hasRoom(ws.roomId)) {
      rejectOperation(ws, "cmd-start", {
        code: "ROOM_NOT_FOUND",
        reason: "Room does not exist.",
      });
      return;
    }

    const normalizedCommand = normalizeCommandIdentity(ws, data?.cmd);
    if (!normalizedCommand || !isValidCommand(normalizedCommand)) {
      rejectOperation(ws, "cmd-start", {
        code: "INVALID_COMMAND_FORMAT",
        reason: "Command payload is malformed.",
        cmdId: data?.cmd?.id ?? data?.id ?? null,
      });
      return;
    }

    if (roomService.hasCommand(ws.roomId, normalizedCommand.id)) {
      rejectOperation(ws, "cmd-start", {
        code: "DUPLICATE_COMMAND",
        reason: "Command already exists.",
        cmdId: normalizedCommand.id,
        pageId: normalizedCommand.pageId,
      });
      return;
    }

    if (roomService.saveCommand(ws.roomId, normalizedCommand)) {
      const targetPageId = Number.isInteger(normalizedCommand?.pageId) ? normalizedCommand.pageId : ws.pageId;
      broadcastToOthers(
        ws.roomId,
        ws,
        { type: "push-cmd", pushType: "start", data: { ...data, cmd: normalizedCommand } },
        [targetPageId],
      );
      return;
    }

    rejectOperation(ws, "cmd-start", {
      code: "COMMAND_REJECTED",
      reason: "Server failed to persist the command.",
      cmdId: normalizedCommand.id,
      pageId: normalizedCommand.pageId,
    });
  },

  "cmd-update": (ws, data) => {
    Logger.cmd("cmd-update", data?.cmdId);
    if (!isNonEmptyString(data?.cmdId) || !isValidPoints(data?.points)) {
      rejectOperation(ws, "cmd-update", {
        code: "INVALID_UPDATE_FORMAT",
        reason: "Update payload is malformed.",
        cmdId: data?.cmdId ?? null,
      });
      return;
    }

    if (!roomService.hasCommand(ws.roomId, data.cmdId)) {
      rejectOperation(ws, "cmd-update", {
        code: "COMMAND_NOT_FOUND",
        reason: "Target command does not exist.",
        cmdId: data.cmdId,
      });
      return;
    }

    if (roomService.mergeCommandPoints(ws.roomId, data.cmdId, data.points)) {
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      const normalizedData = {
        cmdId: data.cmdId,
        points: data.points,
      };
      if (data.__binary === true) {
        broadcastBinaryToOthers(
          ws.roomId,
          ws,
          encodeCmdUpdateBinary(normalizedData),
          [targetPageId],
        );
        return;
      }
      broadcastToOthers(
        ws.roomId,
        ws,
        { type: "push-cmd", pushType: "update", data: normalizedData },
        [targetPageId],
      );
      return;
    }

    rejectOperation(ws, "cmd-update", {
      code: "COMMAND_REJECTED",
      reason: "Server failed to apply the update.",
      cmdId: data.cmdId,
    });
  },

  "cmd-stop": (ws, data) => {
    if (
      !isNonEmptyString(data?.cmdId) ||
      !isValidPoints(data?.points) ||
      (data?.cmd?.box !== undefined && data?.cmd?.box !== null && !isValidBox(data.cmd.box))
    ) {
      rejectOperation(ws, "cmd-stop", {
        code: "INVALID_STOP_FORMAT",
        reason: "Stop payload is malformed.",
        cmdId: data?.cmdId ?? null,
      });
      return;
    }

    if (!roomService.hasCommand(ws.roomId, data.cmdId)) {
      rejectOperation(ws, "cmd-stop", {
        code: "COMMAND_NOT_FOUND",
        reason: "Target command does not exist.",
        cmdId: data.cmdId,
      });
      return;
    }

    if (roomService.mergeCommandPointsAndBox(ws.roomId, data.cmdId, data.points, data.cmd?.box)) {
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "push-cmd", pushType: "stop", data }, [targetPageId]);
      return;
    }

    rejectOperation(ws, "cmd-stop", {
      code: "COMMAND_REJECTED",
      reason: "Server failed to finalize the command.",
      cmdId: data.cmdId,
    });
  },

  "undo-cmd": (ws, data) => {
    if (!isNonEmptyString(data?.cmdId)) {
      rejectOperation(ws, "undo-cmd", {
        code: "INVALID_UNDO_FORMAT",
        reason: "Undo payload is malformed.",
      });
      return;
    }

    if (!roomService.hasCommand(ws.roomId, data.cmdId)) {
      rejectOperation(ws, "undo-cmd", {
        code: "COMMAND_NOT_FOUND",
        reason: "Target command does not exist.",
        cmdId: data.cmdId,
      });
      return;
    }

    if (roomService.setCommandDeleted(ws.roomId, data.cmdId, true)) {
      Logger.wsEvent("undo", ws.userName, ws.userId, ws.roomId, data.cmdId);
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "undo-cmd", data }, [targetPageId]);
      return;
    }

    rejectOperation(ws, "undo-cmd", {
      code: "COMMAND_REJECTED",
      reason: "Server failed to undo the command.",
      cmdId: data.cmdId,
    });
  },

  "redo-cmd": (ws, data) => {
    if (!isNonEmptyString(data?.cmdId)) {
      rejectOperation(ws, "redo-cmd", {
        code: "INVALID_REDO_FORMAT",
        reason: "Redo payload is malformed.",
      });
      return;
    }

    if (!roomService.hasCommand(ws.roomId, data.cmdId)) {
      rejectOperation(ws, "redo-cmd", {
        code: "COMMAND_NOT_FOUND",
        reason: "Target command does not exist.",
        cmdId: data.cmdId,
      });
      return;
    }

    if (roomService.setCommandDeleted(ws.roomId, data.cmdId, false)) {
      Logger.wsEvent("redo", ws.userName, ws.userId, ws.roomId, data.cmdId);
      const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
      broadcastToOthers(ws.roomId, ws, { type: "redo-cmd", data }, [targetPageId]);
      return;
    }

    rejectOperation(ws, "redo-cmd", {
      code: "COMMAND_REJECTED",
      reason: "Server failed to redo the command.",
      cmdId: data.cmdId,
    });
  },

  "delete-cmd": (ws, data) => {
    if (!isNonEmptyString(data?.cmdId)) {
      rejectOperation(ws, "delete-cmd", {
        code: "INVALID_DELETE_FORMAT",
        reason: "Delete payload is malformed.",
      });
      return;
    }

    const targetPageId = roomService.getCommandPageId(ws.roomId, data.cmdId) ?? ws.pageId;
    if (!roomService.hasCommand(ws.roomId, data.cmdId)) {
      rejectOperation(ws, "delete-cmd", {
        code: "COMMAND_NOT_FOUND",
        reason: "Target command does not exist.",
        cmdId: data.cmdId,
        pageId: targetPageId,
        shouldResync: false,
      });
      return;
    }

    if (roomService.deleteCommand(ws.roomId, data.cmdId)) {
      broadcastToOthers(ws.roomId, ws, { type: "delete-cmd", data }, [targetPageId]);
      return;
    }

    rejectOperation(ws, "delete-cmd", {
      code: "COMMAND_REJECTED",
      reason: "Server failed to delete the command.",
      cmdId: data.cmdId,
      pageId: targetPageId,
      shouldResync: false,
    });
  },

  mouseMove: (ws, data) => {
    const normalizedData = {
      userId: ws.userId,
      userName: ws.userName,
      x: data?.x,
      y: data?.y,
      pageId: data?.pageId ?? ws.pageId,
    };
    if (data?.__binary === true) {
      broadcastBinaryToOthers(
        ws.roomId,
        ws,
        encodeMouseMoveServerBinary({
          userId: ws.userId,
          userName: ws.userName,
          pageId: normalizedData.pageId,
          x: normalizedData.x,
          y: normalizedData.y,
        }),
        [ws.pageId],
      );
      return;
    }
    broadcastToOthers(ws.roomId, ws, { type: "mouseMove", data: normalizedData }, [ws.pageId]);
  },

  mouseLeave: (ws, data) => {
    broadcastToOthers(ws.roomId, ws, { type: "mouseLeave", data: withTrustedIdentity(ws, data) }, [ws.pageId]);
  },

  "cmd-batch-move": (ws, data) => {
    if (
      !Array.isArray(data?.cmdIds) ||
      data.cmdIds.some((cmdId) => !isNonEmptyString(cmdId)) ||
      !isFiniteNumber(data?.dx) ||
      !isFiniteNumber(data?.dy)
    ) {
      rejectOperation(ws, "cmd-batch-move", {
        code: "INVALID_BATCH_MOVE_FORMAT",
        reason: "Batch move payload is malformed.",
      });
      return;
    }

    const missingCmdId = data.cmdIds.find((cmdId) => !roomService.hasCommand(ws.roomId, cmdId));
    if (missingCmdId) {
      rejectOperation(ws, "cmd-batch-move", {
        code: "COMMAND_NOT_FOUND",
        reason: "At least one target command does not exist.",
        cmdId: missingCmdId,
      });
      return;
    }

    const targetPageIds = roomService.moveCommands(
      ws.roomId,
      data.cmdIds,
      data.dx,
      data.dy,
    );
    broadcastToOthers(
      ws.roomId,
      ws,
      { type: "cmd-batch-move", data: withTrustedIdentity(ws, data) },
      targetPageIds.length > 0 ? targetPageIds : [ws.pageId],
    );
  },

  "cmd-batch-update": (ws, data) => {
    if (
      !Array.isArray(data?.updates) ||
      data.updates.some(
        (update) => !isNonEmptyString(update?.cmdId) || !isValidPoints(update?.points),
      )
    ) {
      rejectOperation(ws, "cmd-batch-update", {
        code: "INVALID_BATCH_UPDATE_FORMAT",
        reason: "Batch update payload is malformed.",
      });
      return;
    }

    const missingUpdate = data.updates.find((update) => !roomService.hasCommand(ws.roomId, update.cmdId));
    if (missingUpdate) {
      rejectOperation(ws, "cmd-batch-update", {
        code: "COMMAND_NOT_FOUND",
        reason: "At least one target command does not exist.",
        cmdId: missingUpdate.cmdId,
      });
      return;
    }

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
      { type: "cmd-batch-update", data: withTrustedIdentity(ws, data) },
      targetPageIds.length > 0 ? targetPageIds : [ws.pageId],
    );
  },

  "cmd-batch-stop": (ws, data) => {
    if (
      !Array.isArray(data?.updates) ||
      data.updates.some(
        (update) =>
          !isNonEmptyString(update?.cmdId) ||
          !isValidPoints(update?.points) ||
          (update?.boxes !== undefined && update?.boxes !== null && !isValidBox(update.boxes)),
      )
    ) {
      rejectOperation(ws, "cmd-batch-stop", {
        code: "INVALID_BATCH_STOP_FORMAT",
        reason: "Batch stop payload is malformed.",
      });
      return;
    }

    const missingUpdate = data.updates.find((update) => !roomService.hasCommand(ws.roomId, update.cmdId));
    if (missingUpdate) {
      rejectOperation(ws, "cmd-batch-stop", {
        code: "COMMAND_NOT_FOUND",
        reason: "At least one target command does not exist.",
        cmdId: missingUpdate.cmdId,
      });
      return;
    }

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
      { type: "cmd-batch-stop", data: withTrustedIdentity(ws, data) },
      targetPageIds.length > 0 ? targetPageIds : [ws.pageId],
    );
  },

  "box-selection": (ws, data) => {
    broadcastToOthers(ws.roomId, ws, { type: "box-selection", data: withTrustedIdentity(ws, data) }, [ws.pageId]);
  },

  "cmd-page-add": (ws, data) => {
    roomService.incrementTotalPage(ws.roomId);
    const room = roomService.getRoom(ws.roomId);
    const totalPages = room?.totalPage ?? data?.totalPages ?? 1;
    broadcastToOthers(ws.roomId, ws, {
      type: "cmd-page-add",
      data: {
        ...withTrustedIdentity(ws, data),
        totalPages,
      },
    });
  },

  "page-change": (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (!ws.pageChangeStreamState) {
      ws.pageChangeStreamState = {
        generation: 0,
        requestId: 0,
        timer: null,
      };
    }

    const requestId = Number.isInteger(data?.requestId)
      ? data.requestId
      : ws.pageChangeStreamState.requestId + 1;

    ws.pageChangeStreamState.requestId = requestId;
    ws.pageChangeStreamState.generation += 1;
    const generation = ws.pageChangeStreamState.generation;

    if (ws.pageChangeStreamState.timer) {
      clearTimeout(ws.pageChangeStreamState.timer);
    }

    ws.pageChangeStreamState.timer = setTimeout(() => {
      if (
        ws.readyState !== WebSocket.OPEN ||
        !ws.pageChangeStreamState ||
        ws.pageChangeStreamState.generation !== generation
      ) {
        return;
      }

      const stream = roomService.buildPageChangeStream(ws.roomId, {
        prevPageId: data?.prevPageId,
        nextPageId: data?.nextPageId,
        pageId: data?.pageId,
        clientLoadedPageIds: data?.clientLoadedPageIds,
      });

      if (!stream) return;

      ws.pageId = stream.meta.pageId;
      ws.pageChangeStreamState.timer = null;
      void sendPageChangeStream(ws, stream, requestId, generation);
    }, config.PAGE_CHANGE_DEBOUNCE_MS);
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

module.exports = (ws, message, isBinary = false) => {
  try {
    if (isBinary) {
      const parsedBinaryMessage = decodeRealtimeBinaryMessage(message);
      const handler = handlers[parsedBinaryMessage.type];
      if (handler) {
        handler(ws, parsedBinaryMessage.data);
        return;
      }
      rejectOperation(ws, parsedBinaryMessage.type, {
        code: "UNSUPPORTED_BINARY_MESSAGE_TYPE",
        reason: "Binary message type is not supported by the server.",
        shouldResync: false,
        shouldRefresh: false,
      });
      return;
    }

    if (hasRealtimeBinaryMagic(message)) {
      const parsedBinaryMessage = decodeRealtimeBinaryMessage(message);
      const handler = handlers[parsedBinaryMessage.type];
      if (handler) {
        handler(ws, parsedBinaryMessage.data);
        return;
      }
      rejectOperation(ws, parsedBinaryMessage.type, {
        code: "UNSUPPORTED_BINARY_MESSAGE_TYPE",
        reason: "Binary message type is not supported by the server.",
        shouldResync: false,
        shouldRefresh: false,
      });
      return;
    }

    const rawMessage =
      typeof message === "string"
        ? message
        : binaryPayloadToUtf8(message);
    if (typeof rawMessage !== "string") {
      throw new Error("WebSocket message payload type is not supported.");
    }

    const parsedMsg = JSON.parse(rawMessage);

    if (!parsedMsg.type || !parsedMsg.data) {
      Logger.warn(`Received malformed message from ${ws.userId.slice(0, 8)}`);
      rejectOperation(ws, parsedMsg?.type || "unknown", {
        code: "INVALID_MESSAGE_FORMAT",
        reason: "Message must include both type and data.",
        shouldResync: false,
        shouldRefresh: false,
      });
      return;
    }

    const handler = handlers[parsedMsg.type];
    if (handler) {
      handler(ws, parsedMsg.data);
    } else {
      Logger.warn(`No handler found for message type: ${parsedMsg.type}`);
      rejectOperation(ws, parsedMsg.type, {
        code: "UNSUPPORTED_MESSAGE_TYPE",
        reason: "Message type is not supported by the server.",
        shouldResync: false,
        shouldRefresh: false,
      });
    }
  } catch (e) {
    Logger.error("WebSocket Message Parse Error:", e.message);
    rejectOperation(ws, "unknown", {
      code: "INVALID_JSON",
      reason: "WebSocket message is not valid JSON.",
      shouldResync: false,
      shouldRefresh: false,
    });
  }
};
