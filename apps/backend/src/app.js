const express = require("express");
const cors = require("cors");
const roomController = require("./controllers/roomController");
const authService = require("./services/authService");

const { globalErrorHandler, notFoundHandler } = require("./utils/errorHandler");

const app = express();

app.use(cors());
app.use(express.json());

// HTTP 路由映射
app.post("/create-room", roomController.createRoom);
app.get("/check-room", roomController.checkRoom);
app.get("/generate-room-id", roomController.generateRoomId);
app.post("/join-room", roomController.joinRoom);
app.get("/generate-share-token", roomController.generateShareToken);
app.get("/get-page-review", roomController.getPageReview);

// 提取的 Token 信息接口 (可选)
app.get("/get-token-info", (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ code: 400, msg: "Token required" });
    const decoded = authService.verifyToken(token);
    if (!decoded) return res.status(400).json({ code: 400, msg: "Invalid token" });
    res.status(200).json({ code: 200, msg: "success", data: decoded });
});

// 404 处理
app.use(notFoundHandler);

// 全局错误捕获器
app.use(globalErrorHandler);

module.exports = app;
