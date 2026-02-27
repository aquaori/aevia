const roomService = require("../services/roomService");
const authService = require("../services/authService");
const { v4: uuidv4 } = require("uuid");

const createRoom = (req, res) => {
  const { roomId, roomName, password } = req.body;
  if (!roomId) {
    return res.status(400).json({ code: 400, msg: "Room ID is required" });
  }
  
  const success = roomService.createRoom(roomId, roomName, password);
  if (!success) {
    return res.status(400).json({ code: 400, msg: "Room already exists" });
  }

  console.log(`Room created: ${roomId} (${roomName || "房间" + roomId})`);
  res.status(200).json({ code: 200, msg: "success" });
};

const checkRoom = (req, res) => {
  const roomId = req.query.roomId;
  if (!roomId) {
    return res.status(400).json({ code: 400, msg: "Room ID is required" });
  }
  
  res.status(200).json({
    code: 200,
    msg: "success",
    data: { status: roomService.hasRoom(roomId) },
  });
};

const generateRoomId = (req, res) => {
  const roomId = roomService.generateUniqueRoomId();
  res.status(200).json({ code: 200, msg: "success", data: { roomId } });
};

const joinRoom = (req, res) => {
  const { roomId, userName, password } = req.body;
  const roomIdStr = String(roomId);

  if (!roomId || roomIdStr.length === 0) {
    return res.status(400).json({ code: 400, msg: "Room ID is required" });
  }
  if (!userName) {
    return res.status(400).json({ code: 400, msg: "User Name is required" });
  }

  const room = roomService.getRoom(roomIdStr);
  if (!room) {
    return res.status(400).json({ code: 400, msg: "Room does not exist" });
  }

  if (room.password && room.password !== password) {
    return res.status(400).json({ code: 400, msg: "Password incorrect" });
  }

  const userId = uuidv4();
  const token = authService.generateToken({
    userId,
    userName,
    roomId: roomIdStr,
    roomName: room.name,
    roomCreatedAt: room.createdAt,
  });

  res.status(200).json({ code: 200, msg: "success", data: { token } });
};

const generateShareToken = (req, res) => {
    // 接收前端传来的房间id
    const roomId = req.query.roomId;
    if (!roomId) {
        return res
            .status(400)
            .json({ code: 400, msg: "Room ID is required", data: [] });
    }
    if (!roomService.hasRoom(roomId)) {
        return res.status(400).json({
            code: 400,
            msg: "Room does not exist",
            data: [],
        });
    }
    // 生成一个长期有效的 token 凭证返回给客户端，用于 WebSocket 连接时使用
    const roomName = roomService.getRoom(roomId).name;
    const password = roomService.getRoom(roomId).password || "";
    const token = authService.generateToken({ roomId, roomName }, "1d"); // 1 天有效期
    res.status(200).json({
        code: 200,
        msg: "success",
        data: {
            token,
            password: password || "",
        },
    });
};

module.exports = {
  createRoom,
  checkRoom,
  generateRoomId,
  joinRoom,
  generateShareToken,
};
