const express = require("express");
const cors = require("cors");
const roomController = require("./controllers/roomController");
const { requireSessionAuth } = require("./middleware/sessionAuth");

const { globalErrorHandler, notFoundHandler } = require("./utils/errorHandler");

const app = express();

app.use(cors());
app.use(express.json());

// HTTP 路由映射
app.post("/create-room", roomController.createRoom);
app.get("/check-room", roomController.checkRoom);
app.get("/generate-room-id", roomController.generateRoomId);
app.post("/join-room", roomController.joinRoom);
app.get("/get-token-info", roomController.getInviteMeta);
app.get("/generate-share-token", requireSessionAuth, roomController.generateShareToken);
app.get("/get-page-review", requireSessionAuth, roomController.getPageReview);
app.post("/renew-room-session", requireSessionAuth, roomController.renewRoomSession);

// 404 处理
app.use(notFoundHandler);

// 全局错误捕获器
app.use(globalErrorHandler);

module.exports = app;
