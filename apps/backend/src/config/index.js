require("dotenv").config();
const path = require("path");

const jwtSecret = process.env.JWT_SECRET || "";
if (process.env.NODE_ENV === "production" && !jwtSecret.trim()) {
    throw new Error("JWT_SECRET must be configured in production.");
}

module.exports = {
    PORT: process.env.PORT || 4646,
    HOST: process.env.HOST || "0.0.0.0",
    JWT_SECRET: jwtSecret,
    DEFAULT_ROOM_ID: "123123",
    DB_PATH:
        process.env.DB_PATH ||
        path.join(process.cwd(), "data", "whiteboard.sqlite"),
    SESSION_TOKEN_TTL: process.env.SESSION_TOKEN_TTL || "30m",
    INVITE_TOKEN_TTL: process.env.INVITE_TOKEN_TTL || "1d",
    SESSION_RENEW_LEEWAY_MS: Number(process.env.SESSION_RENEW_LEEWAY_MS || 120000),
    INIT_PRELOAD_PAGE_COUNT: Number(process.env.INIT_PRELOAD_PAGE_COUNT || 2),
    PAGE_CACHE_RADIUS: Number(process.env.PAGE_CACHE_RADIUS || 1),
    INIT_COMMAND_CHUNK_SIZE: Number(process.env.INIT_COMMAND_CHUNK_SIZE || 100),
    INIT_FLAT_POINT_CHUNK_SIZE: Number(
        process.env.INIT_FLAT_POINT_CHUNK_SIZE || 2000,
    ),
    PAGE_CHANGE_DEBOUNCE_MS: Number(process.env.PAGE_CHANGE_DEBOUNCE_MS || 80),
    WS_HEARTBEAT_INTERVAL_MS: Number(process.env.WS_HEARTBEAT_INTERVAL_MS || 25000),
};
