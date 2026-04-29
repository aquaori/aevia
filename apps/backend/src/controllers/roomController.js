const roomService = require("../services/roomService");
const { authService } = require("../services/authService");
const passwordService = require("../services/passwordService");
const { v4: uuidv4 } = require("uuid");

const buildSessionResponse = (token, expiresAt) => ({
  sessionToken: token,
  token,
  expiresAt,
});

const createRoom = (req, res) => {
  const { roomId, roomName, password } = req.body;
  if (!roomId) {
    return res.status(400).json({ code: 400, msg: "Room ID is required" });
  }
  
  const success = roomService.createRoom(
    roomId,
    roomName,
    passwordService.hashPassword(password || "")
  );
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

  const normalizedPassword = password || "";
  if (!passwordService.verifyPassword(normalizedPassword, room.password)) {
    return res.status(400).json({ code: 400, msg: "Password incorrect" });
  }

  if (room.password && !passwordService.isHashedPassword(room.password)) {
    roomService.updateRoomPassword(room.roomId, passwordService.hashPassword(normalizedPassword));
  }

  const userId = uuidv4();
  const token = authService.generateSessionToken({
    userId,
    userName,
    roomId: roomIdStr,
    roomName: room.name,
    roomCreatedAt: room.createdAt,
  });
  const expiresAt = authService.getTokenExpiresAt(authService.verifySessionToken(token));

  res.status(200).json({ code: 200, msg: "success", data: buildSessionResponse(token, expiresAt) });
};

const generateShareToken = (req, res) => {
    const roomId = req.query.roomId;
    const authRoomId = req.auth?.roomId;
    if (roomId && authRoomId && roomId !== authRoomId) {
        return res.status(403).json({ code: 403, msg: "Token room does not match request room" });
    }

    const resolvedRoomId = authRoomId || roomId;
    if (!resolvedRoomId) {
        return res.status(400).json({ code: 400, msg: "Room ID is required", data: [] });
    }

    const room = roomService.getRoom(resolvedRoomId);
    if (!room) {
        return res.status(400).json({
            code: 400,
            msg: "Room does not exist",
            data: [],
        });
    }

    const inviteToken = authService.generateInviteToken({
        roomId: room.roomId,
        roomName: room.name,
        roomCreatedAt: room.createdAt,
        passwordRequired: Boolean(room.password),
    });
    res.status(200).json({
        code: 200,
        msg: "success",
        data: {
            inviteToken,
            token: inviteToken,
            passwordRequired: Boolean(room.password),
        },
    });
};

const getInviteMeta = (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).json({ code: 400, msg: "Token required" });
  }

  const decoded = authService.verifyInviteToken(token);
  if (!decoded) {
    return res.status(400).json({ code: 400, msg: "Invalid invite token" });
  }

  const room = roomService.getRoom(decoded.roomId);
  if (!room || decoded.roomCreatedAt !== room.createdAt) {
    return res.status(400).json({ code: 400, msg: "Room does not exist" });
  }

  res.status(200).json({
    code: 200,
    msg: "success",
    data: {
      roomId: room.roomId,
      roomName: room.name,
      roomCreatedAt: room.createdAt,
      passwordRequired: Boolean(room.password),
    },
  });
};

const getPageReview = (req, res) => {
  const roomId = req.query.roomId || req.auth?.roomId;
  if (!roomId) {
    return res.status(400).json({ code: 400, msg: "Room ID is required" });
  }
  if (req.auth?.roomId && roomId !== req.auth.roomId) {
    return res.status(403).json({ code: 403, msg: "Token room does not match request room" });
  }

  const pageReview = roomService.getPageReview(roomId);
  if (!pageReview) {
    return res.status(400).json({ code: 400, msg: "Room does not exist" });
  }

  res.status(200).json({
    code: 200,
    msg: "success",
    data: pageReview,
  });
};

const renewRoomSession = (req, res) => {
  const room = roomService.getRoom(req.auth.roomId);
  if (!room || room.createdAt !== req.auth.roomCreatedAt) {
    return res.status(401).json({ code: 401, msg: "Room session is no longer valid" });
  }

  const token = authService.generateSessionToken({
    userId: req.auth.userId,
    userName: req.auth.userName,
    roomId: room.roomId,
    roomName: room.name,
    roomCreatedAt: room.createdAt,
  });
  const expiresAt = authService.getTokenExpiresAt(authService.verifySessionToken(token));

  res.status(200).json({
    code: 200,
    msg: "success",
    data: buildSessionResponse(token, expiresAt),
  });
};

module.exports = {
  createRoom,
  checkRoom,
  generateRoomId,
  joinRoom,
  generateShareToken,
  getInviteMeta,
  getPageReview,
  renewRoomSession,
};
