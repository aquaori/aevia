const jwt = require("jsonwebtoken");
const config = require("../config");

const TOKEN_TYPES = {
  SESSION: "session",
  INVITE: "invite",
};

class AuthService {
  generateToken(payload, expiresIn = "1min") {
    return jwt.sign(payload, config.JWT_SECRET, { expiresIn });
  }

  generateSessionToken(payload, expiresIn = config.SESSION_TOKEN_TTL) {
    return this.generateToken({ ...payload, tokenType: TOKEN_TYPES.SESSION }, expiresIn);
  }

  generateInviteToken(payload, expiresIn = config.INVITE_TOKEN_TTL) {
    return this.generateToken({ ...payload, tokenType: TOKEN_TYPES.INVITE }, expiresIn);
  }

  verifyToken(token, options = {}) {
    try {
      return jwt.verify(token, config.JWT_SECRET, options);
    } catch (e) {
      return null;
    }
  }

  verifySessionToken(token, options = {}) {
    const decoded = this.verifyToken(token, options);
    return decoded?.tokenType === TOKEN_TYPES.SESSION ? decoded : null;
  }

  verifyInviteToken(token, options = {}) {
    const decoded = this.verifyToken(token, options);
    return decoded?.tokenType === TOKEN_TYPES.INVITE ? decoded : null;
  }

  getTokenExpiresAt(decoded) {
    if (!decoded?.exp) return null;
    return decoded.exp * 1000;
  }
}

module.exports = {
  authService: new AuthService(),
  TOKEN_TYPES,
};
