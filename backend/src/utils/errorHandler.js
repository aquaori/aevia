const Logger = require("./logger");

/**
 * Express 全局错误处理中间件
 */
const globalErrorHandler = (err, req, res, next) => {
    const status = err.status || 500;
    const message = err.message || "Internal Server Error";

    Logger.error(`[HTTP] ${req.method} ${req.url} - ${status}: ${message}`);
    if (status === 500) {
        console.error(err.stack);
    }

    res.status(status).json({
        code: status,
        msg: message,
        data: process.env.NODE_ENV === "development" ? err.stack : [],
    });
};

/**
 * 404 处理中间件
 */
const notFoundHandler = (req, res, next) => {
    const err = new Error("Resource Not Found");
    err.status = 404;
    next(err);
};

/**
 * 进程异常监听
 */
const setupProcessListeners = () => {
    process.on("uncaughtException", (err) => {
        Logger.error("CRITICAL: Uncaught Exception detected!");
        console.error(err);
        // 在生产环境下，通常建议记录日志后优雅退出，由守护进程重启
        // process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
        Logger.error("CRITICAL: Unhandled Rejection at Promise");
        console.error(reason);
    });
};

module.exports = {
    globalErrorHandler,
    notFoundHandler,
    setupProcessListeners,
};
