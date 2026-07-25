require("dotenv").config();
const path = require("path");

const jwtSecret = process.env.JWT_SECRET || "";
if (process.env.NODE_ENV === "production" && !jwtSecret.trim()) {
    throw new Error("JWT_SECRET must be configured in production.");
}

const readIntegerEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const rawValue = process.env[name] ?? String(fallback);
    const parsed = Number(rawValue);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(
            `${name} must be an integer between ${min} and ${max}. Received: ${rawValue}`,
        );
    }

    return parsed;
};

const readPortEnv = () => readIntegerEnv("PORT", 4646, { min: 1, max: 65535 });

module.exports = {
    PORT: readPortEnv(),
    HOST: process.env.HOST || "0.0.0.0",
    JWT_SECRET: jwtSecret,
    DEFAULT_ROOM_ID: "123123",
    DB_PATH:
        process.env.DB_PATH ||
        path.join(process.cwd(), "data", "whiteboard.sqlite"),
    SESSION_TOKEN_TTL: process.env.SESSION_TOKEN_TTL || "30m",
    INVITE_TOKEN_TTL: process.env.INVITE_TOKEN_TTL || "1d",
    SESSION_RENEW_LEEWAY_MS: readIntegerEnv("SESSION_RENEW_LEEWAY_MS", 120000, { min: 0 }),
    INIT_PRELOAD_PAGE_COUNT: readIntegerEnv("INIT_PRELOAD_PAGE_COUNT", 2, { min: 0, max: 20 }),
    PAGE_CACHE_RADIUS: readIntegerEnv("PAGE_CACHE_RADIUS", 1, { min: 0, max: 20 }),
    INIT_COMMAND_CHUNK_SIZE: readIntegerEnv("INIT_COMMAND_CHUNK_SIZE", 100, { min: 1, max: 5000 }),
    INIT_FLAT_POINT_CHUNK_SIZE: readIntegerEnv("INIT_FLAT_POINT_CHUNK_SIZE", 2000, {
        min: 1,
        max: 100000,
    }),
    PAGE_CHANGE_DEBOUNCE_MS: readIntegerEnv("PAGE_CHANGE_DEBOUNCE_MS", 80, { min: 0 }),
    WS_HEARTBEAT_INTERVAL_MS: readIntegerEnv("WS_HEARTBEAT_INTERVAL_MS", 25000, {
        min: 1000,
    }),
    WS_MAX_PAYLOAD_BYTES: readIntegerEnv("WS_MAX_PAYLOAD_BYTES", 1024 * 1024, {
        min: 1024,
        max: 16 * 1024 * 1024,
    }),
    WS_JSON_MAX_BYTES: readIntegerEnv("WS_JSON_MAX_BYTES", 512 * 1024, {
        min: 1024,
        max: 16 * 1024 * 1024,
    }),
    WS_MAX_POINTS_PER_COMMAND: readIntegerEnv("WS_MAX_POINTS_PER_COMMAND", 20000, {
        min: 1,
        max: 100000,
    }),
    WS_MAX_POINTS_PER_UPDATE: readIntegerEnv("WS_MAX_POINTS_PER_UPDATE", 2000, {
        min: 1,
        max: 65535,
    }),
    WS_MAX_BATCH_COMMANDS: readIntegerEnv("WS_MAX_BATCH_COMMANDS", 200, {
        min: 1,
        max: 5000,
    }),
};
