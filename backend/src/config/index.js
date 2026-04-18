require("dotenv").config();
const path = require("path");

module.exports = {
    PORT: process.env.PORT || 4646,
    HOST: process.env.HOST || "0.0.0.0",
    JWT_SECRET: process.env.JWT_SECRET || "JWT_SECRET",
    DEFAULT_ROOM_ID: "123123",
    DB_PATH:
        process.env.DB_PATH ||
        path.join(process.cwd(), "data", "whiteboard.sqlite"),
    INIT_PRELOAD_PAGE_COUNT: Number(process.env.INIT_PRELOAD_PAGE_COUNT || 2),
    PAGE_CACHE_RADIUS: Number(process.env.PAGE_CACHE_RADIUS || 1),
};
