const jwt = require("jsonwebtoken");
const config = require("../config");

class AuthService {
  generateToken(payload, expiresIn = "1min") {
    return jwt.sign(payload, config.JWT_SECRET, { expiresIn });
  }

  verifyToken(token, options = {}) {
    try {
      return jwt.verify(token, config.JWT_SECRET, options);
    } catch (e) {
      return null;
    }
  }
}

module.exports = new AuthService();
