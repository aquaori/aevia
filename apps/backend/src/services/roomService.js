const config = require("../config");
const { protocolPageToState } = require("../shared/collabProtocol");
const sqliteService = require("./sqliteService");

class RoomService {
  constructor() {
    this.db = sqliteService.db;
    this.clientRooms = new Map();
    this.roomFlatQueues = new Map();
    this.prepareStatements();
    this.initialize();
  }

  prepareStatements() {
    this.getRoomStmt = this.db.prepare(`
      SELECT room_id, name, password, created_at, total_page
      FROM rooms
      WHERE room_id = ?
    `);
    this.hasRoomStmt = this.db.prepare(`
      SELECT 1
      FROM rooms
      WHERE room_id = ?
      LIMIT 1
    `);
    this.createRoomStmt = this.db.prepare(`
      INSERT INTO rooms (room_id, name, password, created_at, total_page)
      VALUES (?, ?, ?, ?, 1)
    `);
    this.deleteRoomStmt = this.db.prepare(`
      DELETE FROM rooms
      WHERE room_id = ?
    `);
    this.listRoomIdsStmt = this.db.prepare(`
      SELECT room_id
      FROM rooms
      ORDER BY created_at ASC, room_id ASC
    `);
    this.listCommandsStmt = this.db.prepare(`
      SELECT payload
      FROM commands
      WHERE room_id = ?
      ORDER BY id ASC
    `);
    this.getCommandStmt = this.db.prepare(`
      SELECT payload
      FROM commands
      WHERE room_id = ? AND cmd_id = ?
      LIMIT 1
    `);
    this.upsertCommandStmt = this.db.prepare(`
      INSERT INTO commands (room_id, cmd_id, page_id, type, payload, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, cmd_id) DO UPDATE SET
        page_id = excluded.page_id,
        type = excluded.type,
        payload = excluded.payload,
        is_deleted = excluded.is_deleted,
        updated_at = excluded.updated_at
    `);
    this.updateCommandStmt = this.db.prepare(`
      UPDATE commands
      SET page_id = ?, type = ?, payload = ?, is_deleted = ?, updated_at = ?
      WHERE room_id = ? AND cmd_id = ?
    `);
    this.deleteCommandsForPageStmt = this.db.prepare(`
      DELETE FROM commands
      WHERE room_id = ? AND page_id = ?
    `);
    this.deleteCommandStmt = this.db.prepare(`
      DELETE FROM commands
      WHERE room_id = ? AND cmd_id = ?
    `);
    this.deleteAllCommandsStmt = this.db.prepare(`
      DELETE FROM commands
      WHERE room_id = ?
    `);
    this.incrementTotalPageStmt = this.db.prepare(`
      UPDATE rooms
      SET total_page = total_page + 1
      WHERE room_id = ?
    `);
  }

  initialize() {
    const defaultRoom = this.getRoom(config.DEFAULT_ROOM_ID);
    if (!defaultRoom) {
      this.createRoom(config.DEFAULT_ROOM_ID, config.DEFAULT_ROOM_ID, "");
    }
  }

  normalizeRoom(row) {
    if (!row) return null;
    return {
      roomId: row.room_id,
      name: row.name,
      password: row.password,
      createdAt: row.created_at,
      totalPage: row.total_page,
      clients: this.getRoomClients(row.room_id),
    };
  }

  getRoomClients(roomId) {
    if (!this.clientRooms.has(roomId)) {
      this.clientRooms.set(roomId, new Set());
    }
    return this.clientRooms.get(roomId);
  }

  getRoom(roomId) {
    return this.normalizeRoom(this.getRoomStmt.get(roomId));
  }

  hasRoom(roomId) {
    return Boolean(this.hasRoomStmt.get(roomId));
  }

  createRoom(roomId, roomName, password = "") {
    if (this.hasRoom(roomId)) return false;

    this.createRoomStmt.run(
      roomId,
      roomName || `房间${roomId}`,
      password,
      Date.now(),
    );
    this.getRoomClients(roomId);
    this.roomFlatQueues.set(roomId, {
      version: 0,
      points: [],
    });
    return true;
  }

  deleteRoom(roomId) {
    const result = this.deleteRoomStmt.run(roomId);
    this.clientRooms.delete(roomId);
    this.roomFlatQueues.delete(roomId);
    return result.changes > 0;
  }

  getAllRoomIds() {
    return this.listRoomIdsStmt.all().map((row) => row.room_id);
  }

  generateUniqueRoomId() {
    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.hasRoom(roomId));
    return roomId;
  }

  addClient(roomId, ws) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    room.clients.add(ws);
    return room;
  }

  removeClient(roomId, ws) {
    const clients = this.clientRooms.get(roomId);
    if (!clients) return;
    clients.delete(ws);
  }

  getRoomCommands(roomId) {
    if (!this.hasRoom(roomId)) return null;

    return this.listCommandsStmt.all(roomId).map((row) => JSON.parse(row.payload));
  }

  createFlatPoint(cmd, point, pointIndex) {
    if (!point || typeof point !== "object") {
      return null;
    }

    return {
      x: point.x,
      y: point.y,
      p: point.p,
      lamport: Number.isFinite(point.lamport)
        ? point.lamport
        : (typeof cmd.createdAt === "number" ? cmd.createdAt : 0),
      cmdId: cmd.id,
      pageId: cmd.pageId ?? null,
      userId: cmd.userId ?? null,
      tool: cmd.tool ?? "pen",
      color: cmd.color ?? "#000000",
      size: cmd.size ?? 3,
      isDeleted: Boolean(cmd.isDeleted),
      pointIndex,
    };
  }

  flattenCommandPoints(cmd) {
    if (!cmd || !cmd.id || !Array.isArray(cmd.points)) {
      return [];
    }

    if (!Number.isInteger(cmd.pageId) || cmd.pageId < 0) {
      return [];
    }

    return cmd.points
      .map((point, pointIndex) => this.createFlatPoint(cmd, point, pointIndex))
      .filter(Boolean);
  }

  compareFlatPoints(a, b) {
    if (a.lamport !== b.lamport) {
      return a.lamport - b.lamport;
    }

    if (a.cmdId !== b.cmdId) {
      return a.cmdId < b.cmdId ? -1 : 1;
    }

    return a.pointIndex - b.pointIndex;
  }

  stripInternalFlatPointFields(point) {
    const { pointIndex, ...flatPoint } = point;
    return flatPoint;
  }

  getRoomFlatQueue(roomId) {
    if (!this.hasRoom(roomId)) return null;

    if (!this.roomFlatQueues.has(roomId)) {
      const points = this.getRoomCommands(roomId)
        .flatMap((cmd) => this.flattenCommandPoints(cmd))
        .sort((a, b) => this.compareFlatPoints(a, b));

      this.roomFlatQueues.set(roomId, {
        version: 1,
        points,
      });
    }

    return this.roomFlatQueues.get(roomId);
  }

  getRoomFlatQueueVersion(roomId) {
    return this.getRoomFlatQueue(roomId)?.version ?? 0;
  }

  touchRoomFlatQueueVersion(roomId) {
    const queue = this.getRoomFlatQueue(roomId);
    if (!queue) return;
    queue.version += 1;
  }

  syncCommandFlatPoints(roomId, cmd) {
    const queue = this.getRoomFlatQueue(roomId);
    if (!queue || !cmd?.id) return;

    queue.points = queue.points.filter((point) => point.cmdId !== cmd.id);
    queue.points.push(...this.flattenCommandPoints(cmd));
    queue.points.sort((a, b) => this.compareFlatPoints(a, b));
    this.touchRoomFlatQueueVersion(roomId);
  }

  removeCommandFlatPoints(roomId, cmdId) {
    const queue = this.getRoomFlatQueue(roomId);
    if (!queue || !cmdId) return;

    const prevLength = queue.points.length;
    queue.points = queue.points.filter((point) => point.cmdId !== cmdId);
    if (queue.points.length !== prevLength) {
      this.touchRoomFlatQueueVersion(roomId);
    }
  }

  clearFlatPointsByPage(roomId, pageId) {
    const queue = this.getRoomFlatQueue(roomId);
    if (!queue) return;

    const prevLength = queue.points.length;
    queue.points = queue.points.filter((point) => point.pageId !== pageId);
    if (queue.points.length !== prevLength) {
      this.touchRoomFlatQueueVersion(roomId);
    }
  }

  clearRoomFlatPoints(roomId) {
    const queue = this.getRoomFlatQueue(roomId);
    if (!queue) return;

    if (queue.points.length > 0) {
      queue.points = [];
      this.touchRoomFlatQueueVersion(roomId);
    }
  }

  getRoomFlatPointsByPageIds(roomId, pageIds) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const normalizedPageIds = this.sanitizePageIds(pageIds, room.totalPage);
    if (normalizedPageIds.length === 0) {
      return [];
    }

    const pageIdSet = new Set(normalizedPageIds);
    const queue = this.getRoomFlatQueue(roomId);
    if (!queue) return [];

    return queue.points
      .filter((point) => pageIdSet.has(point.pageId))
      .map((point) => this.stripInternalFlatPointFields(point));
  }

  createChunks(items, chunkSize, buildMeta = null) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const normalizedChunkSize = Math.max(1, Number.parseInt(chunkSize, 10) || 1);
    const chunks = [];

    for (let start = 0; start < items.length; start += normalizedChunkSize) {
      const end = Math.min(start + normalizedChunkSize, items.length);
      const chunkItems = items.slice(start, end);
      const chunk = {
        chunkIndex: chunks.length,
        start,
        end: end - 1,
        count: chunkItems.length,
        items: chunkItems,
      };

      if (typeof buildMeta === "function") {
        Object.assign(chunk, buildMeta(chunkItems, start, end - 1, chunks.length) ?? {});
      }

      chunks.push(chunk);
    }

    return chunks;
  }

  chunkCommands(commands, chunkSize = config.INIT_COMMAND_CHUNK_SIZE) {
    return this.createChunks(
      commands,
      chunkSize,
      (chunkItems, start, end, chunkIndex) => ({
        commandIds: chunkItems.map((command) => command.id),
        chunkType: "commands",
        chunkIndex,
        startCommandIndex: start,
        endCommandIndex: end,
      }),
    );
  }

  chunkFlatPoints(flatPoints, chunkSize = config.INIT_FLAT_POINT_CHUNK_SIZE) {
    return this.createChunks(
      flatPoints,
      chunkSize,
      (chunkItems, start, end, chunkIndex) => ({
        cmdIds: [...new Set(chunkItems.map((point) => point.cmdId))],
        pageIds: [...new Set(chunkItems.map((point) => point.pageId))],
        lamportStart: chunkItems[0]?.lamport ?? null,
        lamportEnd: chunkItems[chunkItems.length - 1]?.lamport ?? null,
        chunkType: "flatPoints",
        chunkIndex,
        startPointIndex: start,
        endPointIndex: end,
      }),
    );
  }

  createChunkedPayload(commands, flatPoints) {
    const commandChunks = this.chunkCommands(commands);
    const flatPointChunks = this.chunkFlatPoints(flatPoints);

    return {
      commands,
      flatPoints,
      commandChunks,
      flatPointChunks,
      chunkSummary: {
        commandChunkSize: config.INIT_COMMAND_CHUNK_SIZE,
        flatPointChunkSize: config.INIT_FLAT_POINT_CHUNK_SIZE,
        totalCommands: commands.length,
        totalFlatPoints: flatPoints.length,
        totalCommandChunks: commandChunks.length,
        totalFlatPointChunks: flatPointChunks.length,
      },
    };
  }

  createEmptyChunk(chunkType, chunkIndex) {
    return {
      chunkType,
      chunkIndex,
      count: 0,
      items: [],
    };
  }

  pairChunkStreams(commandChunks, flatPointChunks) {
    const totalChunks = Math.max(commandChunks.length, flatPointChunks.length);

    return Array.from({ length: totalChunks }, (_, chunkIndex) => ({
      chunkIndex,
      isLastChunk: chunkIndex === totalChunks - 1,
      commandChunk:
        commandChunks[chunkIndex] ?? this.createEmptyChunk("commands", chunkIndex),
      flatPointChunk:
        flatPointChunks[chunkIndex] ?? this.createEmptyChunk("flatPoints", chunkIndex),
    }));
  }

  buildInitStream(roomId, payload) {
    if (!payload) return null;

    const snapshotVersion = this.getRoomFlatQueueVersion(roomId);
    const renderChunks = (payload.flatPointChunks ?? []).map((flatPointChunk, chunkIndex, chunks) => ({
      chunkIndex,
      isLastChunk: chunkIndex === chunks.length - 1,
      flatPointChunk,
    }));
    const commandChunks = (payload.commandChunks ?? []).map((commandChunk, chunkIndex, chunks) => ({
      chunkIndex,
      isLastChunk: chunkIndex === chunks.length - 1,
      commandChunk,
    }));

    return {
      snapshotVersion,
      meta: {
        totalPage: payload.totalPage,
        pageId: payload.pageId,
        loadedPageIds: payload.loadedPageIds,
        chunkSummary: {
          ...(payload.chunkSummary ?? {}),
          totalRenderChunks: renderChunks.length,
          totalCommandChunks: commandChunks.length,
        },
      },
      renderChunks,
      commandChunks,
    };
  }

  buildPagedStream(roomId, payload, metaOverrides = {}) {
    if (!payload) return null;

    const snapshotVersion = this.getRoomFlatQueueVersion(roomId);
    const renderChunks = (payload.flatPointChunks ?? []).map((flatPointChunk, chunkIndex, chunks) => ({
      chunkIndex,
      isLastChunk: chunkIndex === chunks.length - 1,
      flatPointChunk,
    }));
    const commandChunks = (payload.commandChunks ?? []).map((commandChunk, chunkIndex, chunks) => ({
      chunkIndex,
      isLastChunk: chunkIndex === chunks.length - 1,
      commandChunk,
    }));

    return {
      snapshotVersion,
      meta: {
        totalPage: payload.totalPage,
        pageId: payload.pageId,
        loadedPageIds: payload.loadedPageIds,
        loadPageIds: payload.loadPageIds ?? [],
        unloadPageIds: payload.unloadPageIds ?? [],
        previousPageId: payload.previousPageId,
        chunkSummary: {
          ...(payload.chunkSummary ?? {}),
          totalRenderChunks: renderChunks.length,
          totalCommandChunks: commandChunks.length,
        },
        ...metaOverrides,
      },
      renderChunks,
      commandChunks,
    };
  }

  normalizePageId(pageId, totalPage) {
    const numericPageId = protocolPageToState(pageId);

    if (!Number.isInteger(totalPage) || totalPage < 1) {
      return numericPageId;
    }

    return Math.min(numericPageId, totalPage - 1);
  }

  sanitizePageIds(pageIds, totalPage) {
    const uniquePageIds = new Set();

    pageIds.forEach((pageId) => {
      const normalizedPageId = this.normalizePageId(pageId, totalPage);
      if (normalizedPageId >= 0 && normalizedPageId < totalPage) {
        uniquePageIds.add(normalizedPageId);
      }
    });

    return [...uniquePageIds].sort((a, b) => a - b);
  }

  getInitPageIds(roomId, pageId, preloadCount = config.INIT_PRELOAD_PAGE_COUNT) {
    const room = this.getRoom(roomId);
    if (!room) return [];

    const startPageId = this.normalizePageId(pageId, room.totalPage);
    const pageIds = [];
    for (let i = 0; i < preloadCount; i += 1) {
      const candidatePageId = startPageId + i;
      if (candidatePageId >= room.totalPage) break;
      pageIds.push(candidatePageId);
    }

    return this.sanitizePageIds(pageIds, room.totalPage);
  }

  getAdjacentPageIds(roomId, pageId, radius = config.PAGE_CACHE_RADIUS) {
    const room = this.getRoom(roomId);
    if (!room) return [];

    const currentPageId = this.normalizePageId(pageId, room.totalPage);
    const pageIds = [];

    for (
      let candidatePageId = currentPageId - radius;
      candidatePageId <= currentPageId + radius;
      candidatePageId += 1
    ) {
      pageIds.push(candidatePageId);
    }

    return this.sanitizePageIds(pageIds, room.totalPage);
  }

  getRoomCommandsByPageIds(roomId, pageIds) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const normalizedPageIds = this.sanitizePageIds(pageIds, room.totalPage);
    if (normalizedPageIds.length === 0) {
      return [];
    }

    const placeholders = normalizedPageIds.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT payload
      FROM commands
      WHERE room_id = ?
        AND (page_id IS NULL OR page_id IN (${placeholders}))
      ORDER BY id ASC
    `);

    return stmt.all(roomId, ...normalizedPageIds).map((row) => JSON.parse(row.payload));
  }

  getInitPayload(roomId, pageId = 0) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const currentPageId = this.normalizePageId(pageId, room.totalPage);
    const loadedPageIds = this.getInitPageIds(roomId, currentPageId);
    const commands = this.getRoomCommandsByPageIds(roomId, loadedPageIds);
    const flatPoints = this.getRoomFlatPointsByPageIds(roomId, [currentPageId]);

    return {
      pageId: currentPageId,
      loadedPageIds,
      totalPage: room.totalPage,
      ...this.createChunkedPayload(commands, flatPoints),
    };
  }

  getPageWindowPayload(roomId, pageId, radius = config.PAGE_CACHE_RADIUS) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const currentPageId = this.normalizePageId(pageId, room.totalPage);
    const loadedPageIds = this.getAdjacentPageIds(roomId, currentPageId, radius);
    const commands = this.getRoomCommandsByPageIds(roomId, loadedPageIds);
    const flatPoints = this.getRoomFlatPointsByPageIds(roomId, [currentPageId]);

    return {
      pageId: currentPageId,
      loadedPageIds,
      totalPage: room.totalPage,
      ...this.createChunkedPayload(commands, flatPoints),
    };
  }

  getPageChangePayload(roomId, prevPageId, nextPageId, radius = config.PAGE_CACHE_RADIUS) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const previousPageId = this.normalizePageId(prevPageId, room.totalPage);
    const currentPageId = this.normalizePageId(nextPageId, room.totalPage);
    const previousLoadedPageIds = this.getAdjacentPageIds(roomId, previousPageId, radius);
    const loadedPageIds = this.getAdjacentPageIds(roomId, currentPageId, radius);
    const unloadPageIds = previousLoadedPageIds.filter((pageId) => !loadedPageIds.includes(pageId));
    const loadPageIds = loadedPageIds.filter((pageId) => !previousLoadedPageIds.includes(pageId));
    const commands = this.getRoomCommandsByPageIds(roomId, loadPageIds);
    const flatPoints = this.getRoomFlatPointsByPageIds(roomId, [currentPageId]);

    return {
      pageId: currentPageId,
      previousPageId,
      loadedPageIds,
      loadPageIds,
      unloadPageIds,
      totalPage: room.totalPage,
      ...this.createChunkedPayload(commands, flatPoints),
    };
  }

  getPageChangeStreamPayload(
    roomId,
    {
      prevPageId,
      nextPageId,
      pageId,
      clientLoadedPageIds = [],
      radius = config.PAGE_CACHE_RADIUS,
    } = {},
  ) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const hasDeltaCursor =
      Number.isInteger(prevPageId) && Number.isInteger(nextPageId);
    const requestedPageId = hasDeltaCursor ? nextPageId : pageId;
    const currentPageId = this.normalizePageId(requestedPageId, room.totalPage);
    const previousPageId = hasDeltaCursor
      ? this.normalizePageId(prevPageId, room.totalPage)
      : null;
    const normalizedClientLoadedPageIds = this.sanitizePageIds(
      Array.isArray(clientLoadedPageIds) ? clientLoadedPageIds : [],
      room.totalPage,
    );
    const targetPageAlreadyLoaded = normalizedClientLoadedPageIds.includes(currentPageId);

    if (targetPageAlreadyLoaded) {
      const flatPoints = this.getRoomFlatPointsByPageIds(roomId, [currentPageId]);

      return {
        pageId: currentPageId,
        previousPageId,
        loadedPageIds:
          normalizedClientLoadedPageIds.length > 0
            ? normalizedClientLoadedPageIds
            : [currentPageId],
        loadPageIds: [],
        unloadPageIds: [],
        totalPage: room.totalPage,
        ...this.createChunkedPayload([], flatPoints),
        mode: "flat-only",
      };
    }

    const loadedPageIds = this.getAdjacentPageIds(roomId, currentPageId, radius);
    const unloadPageIds = normalizedClientLoadedPageIds.filter(
      (loadedPageId) => !loadedPageIds.includes(loadedPageId),
    );
    const commands = this.getRoomCommandsByPageIds(roomId, loadedPageIds);
    const flatPoints = this.getRoomFlatPointsByPageIds(roomId, [currentPageId]);

    return {
      pageId: currentPageId,
      previousPageId,
      loadedPageIds,
      loadPageIds: loadedPageIds,
      unloadPageIds,
      totalPage: room.totalPage,
      ...this.createChunkedPayload(commands, flatPoints),
      mode: "full",
    };
  }

  buildPageChangeStream(roomId, options) {
    const payload = this.getPageChangeStreamPayload(roomId, options);
    if (!payload) return null;

    return this.buildPagedStream(roomId, payload, {
      mode: payload.mode,
    });
  }

  getCommand(roomId, cmdId) {
    const row = this.getCommandStmt.get(roomId, cmdId);
    return row ? JSON.parse(row.payload) : null;
  }

  hasCommand(roomId, cmdId) {
    return Boolean(this.getCommandStmt.get(roomId, cmdId));
  }

  getCommandPageId(roomId, cmdId) {
    const cmd = this.getCommand(roomId, cmdId);
    return cmd?.pageId ?? null;
  }

  saveCommand(roomId, cmd) {
    if (!this.hasRoom(roomId) || !cmd || !cmd.id) {
      return false;
    }

    const now = Date.now();
    const createdAt = typeof cmd.createdAt === "number" ? cmd.createdAt : now;
    const isDeleted = cmd.isDeleted ? 1 : 0;

    this.upsertCommandStmt.run(
      roomId,
      cmd.id,
      cmd.pageId ?? null,
      cmd.type || null,
      JSON.stringify(cmd),
      isDeleted,
      createdAt,
      now,
    );
    this.syncCommandFlatPoints(roomId, cmd);
    return true;
  }

  clearCommands(roomId, pageId) {
    if (!this.hasRoom(roomId)) return false;

    if (pageId !== undefined && pageId !== null) {
      this.deleteCommandsForPageStmt.run(roomId, pageId);
      this.clearFlatPointsByPage(roomId, pageId);
    } else {
      this.deleteAllCommandsStmt.run(roomId);
      this.clearRoomFlatPoints(roomId);
    }
    return true;
  }

  deleteCommand(roomId, cmdId) {
    if (!this.hasRoom(roomId) || !cmdId) return false;

    const result = this.deleteCommandStmt.run(roomId, cmdId);
    if (result.changes <= 0) {
      return false;
    }

    this.removeCommandFlatPoints(roomId, cmdId);
    return true;
  }

  updateCommand(roomId, cmdId, updater) {
    const cmd = this.getCommand(roomId, cmdId);
    if (!cmd) return false;

    updater(cmd);

    this.updateCommandStmt.run(
      cmd.pageId ?? null,
      cmd.type || null,
      JSON.stringify(cmd),
      cmd.isDeleted ? 1 : 0,
      Date.now(),
      roomId,
      cmdId,
    );
    this.syncCommandFlatPoints(roomId, cmd);
    return true;
  }

  mergeCommandPoints(roomId, cmdId, points) {
    return this.updateCommand(roomId, cmdId, (cmd) => {
      if (Array.isArray(cmd.points) && Array.isArray(points)) {
        cmd.points = [...cmd.points, ...points];
      } else {
        cmd.points = { ...cmd.points, ...points };
      }
    });
  }

  mergeCommandPointsAndBox(roomId, cmdId, points, box) {
    return this.updateCommand(roomId, cmdId, (cmd) => {
      if (Array.isArray(cmd.points) && Array.isArray(points)) {
        cmd.points = [...cmd.points, ...points];
      } else {
        cmd.points = { ...cmd.points, ...points };
      }

      if (box && Object.keys(box).length > 0) {
        cmd.box = box;
      }
    });
  }

  setCommandDeleted(roomId, cmdId, isDeleted) {
    return this.updateCommand(roomId, cmdId, (cmd) => {
      cmd.isDeleted = isDeleted;
    });
  }

  replaceCommandPoints(roomId, cmdId, points) {
    return this.updateCommand(roomId, cmdId, (cmd) => {
      cmd.points = points;
    });
  }

  replaceCommandPointsAndBox(roomId, cmdId, points, box) {
    return this.updateCommand(roomId, cmdId, (cmd) => {
      cmd.points = points;
      cmd.box = box;
    });
  }

  moveCommands(roomId, cmdIds, dx, dy) {
    if (!Array.isArray(cmdIds) || cmdIds.length === 0) {
      return [];
    }

    const movedPageIds = new Set();

    cmdIds.forEach((cmdId) => {
      this.updateCommand(roomId, cmdId, (cmd) => {
        if (Array.isArray(cmd.points)) {
          cmd.points = cmd.points.map((point) => ({
            ...point,
            x: typeof point.x === "number" ? point.x + dx : point.x,
            y: typeof point.y === "number" ? point.y + dy : point.y,
          }));
        }

        if (cmd.box && typeof cmd.box === "object") {
          cmd.box = {
            ...cmd.box,
            x: typeof cmd.box.x === "number" ? cmd.box.x + dx : cmd.box.x,
            y: typeof cmd.box.y === "number" ? cmd.box.y + dy : cmd.box.y,
          };
        }

        if (Number.isInteger(cmd.pageId)) {
          movedPageIds.add(cmd.pageId);
        }
      });
    });

    return [...movedPageIds];
  }

  incrementTotalPage(roomId) {
    if (!this.hasRoom(roomId)) return false;
    this.incrementTotalPageStmt.run(roomId);
    return true;
  }

  getPageReview(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const collaboratorCountByPageId = new Map();
    room.clients.forEach((client) => {
      const pageId = this.normalizePageId(client.pageId, room.totalPage);
      collaboratorCountByPageId.set(
        pageId,
        (collaboratorCountByPageId.get(pageId) || 0) + 1,
      );
    });

    const pages = Array.from({ length: room.totalPage }, (_, pageId) => ({
      pageId,
      pageNumber: pageId + 1,
      collaboratorCount: collaboratorCountByPageId.get(pageId) || 0,
    }));

    return {
      roomId: room.roomId,
      totalPage: room.totalPage,
      pages,
    };
  }
}

module.exports = new RoomService();
