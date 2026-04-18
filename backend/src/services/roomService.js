const config = require("../config");
const sqliteService = require("./sqliteService");

class RoomService {
  constructor() {
    this.db = sqliteService.db;
    this.clientRooms = new Map();
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
    return true;
  }

  deleteRoom(roomId) {
    const result = this.deleteRoomStmt.run(roomId);
    this.clientRooms.delete(roomId);
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

  normalizePageId(pageId, totalPage) {
    const numericPageId = Number.parseInt(pageId, 10);
    if (!Number.isInteger(numericPageId) || numericPageId < 0) {
      return 0;
    }

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

    return {
      pageId: currentPageId,
      loadedPageIds,
      totalPage: room.totalPage,
      commands: this.getRoomCommandsByPageIds(roomId, loadedPageIds),
    };
  }

  getPageWindowPayload(roomId, pageId, radius = config.PAGE_CACHE_RADIUS) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const currentPageId = this.normalizePageId(pageId, room.totalPage);
    const loadedPageIds = this.getAdjacentPageIds(roomId, currentPageId, radius);

    return {
      pageId: currentPageId,
      loadedPageIds,
      totalPage: room.totalPage,
      commands: this.getRoomCommandsByPageIds(roomId, loadedPageIds),
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

    return {
      pageId: currentPageId,
      previousPageId,
      loadedPageIds,
      loadPageIds,
      unloadPageIds,
      totalPage: room.totalPage,
      commands: this.getRoomCommandsByPageIds(roomId, loadPageIds),
    };
  }

  getCommand(roomId, cmdId) {
    const row = this.getCommandStmt.get(roomId, cmdId);
    return row ? JSON.parse(row.payload) : null;
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
    return true;
  }

  clearCommands(roomId, pageId) {
    if (!this.hasRoom(roomId)) return false;

    if (pageId !== undefined && pageId !== null) {
      this.deleteCommandsForPageStmt.run(roomId, pageId);
    } else {
      this.deleteAllCommandsStmt.run(roomId);
    }
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
