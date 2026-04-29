const { authService } = require("../services/authService");

const extractBearerToken = (authorizationHeader) => {
    if (typeof authorizationHeader !== "string") return "";
    const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || "";
};

const requireSessionAuth = (req, res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
        return res.status(401).json({ code: 401, msg: "Session token required" });
    }

    const decoded = authService.verifySessionToken(token);
    if (!decoded) {
        return res.status(401).json({ code: 401, msg: "Invalid session token" });
    }

    req.auth = decoded;
    req.sessionToken = token;
    next();
};

module.exports = {
    requireSessionAuth,
};
