const config = require("../config");

class RoomService {
  constructor() {
    // Key: roomId, Value: { name: string, password: string, clients: Set<WebSocket>, commands: Command[] }
    this.rooms = new Map();
    this.initialize();
  }

  initialize() {
    // 默认测试房间
    this.rooms.set(config.DEFAULT_ROOM_ID, {
      name: config.DEFAULT_ROOM_ID,
      password: "",
      clients: new Set(),
      commands: [],
      createdAt: Date.now(),
      totalPage: 1,
    });
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  hasRoom(roomId) {
    return this.rooms.has(roomId);
  }

  createRoom(roomId, roomName, password = "") {
    if (this.hasRoom(roomId)) return false;
    this.rooms.set(roomId, {
      name: roomName || `房间${roomId}`,
      password: password,
      commands: [],
      clients: new Set(),
      createdAt: Date.now(),
      totalPage: 1,
    });
    return true;
  }

  deleteRoom(roomId) {
    return this.rooms.delete(roomId);
  }

  getAllRoomIds() {
    return Array.from(this.rooms.keys());
  }

  // 生成一个没用过的 6 位数字房号
  generateUniqueRoomId() {
    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.hasRoom(roomId));
    return roomId;
  }
}

module.exports = new RoomService();
