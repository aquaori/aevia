const crypto = require("crypto");

const HASH_PREFIX = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;

class PasswordService {
  isHashedPassword(value) {
    return typeof value === "string" && value.startsWith(`${HASH_PREFIX}$`);
  }

  hashPassword(password) {
    if (!password) return "";
    const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
    const derivedKey = crypto.scryptSync(password, salt, KEY_BYTES).toString("hex");
    return `${HASH_PREFIX}$${salt}$${derivedKey}`;
  }

  verifyPassword(password, storedPassword) {
    if (!storedPassword) {
      return password === "" || password === undefined || password === null;
    }

    if (!this.isHashedPassword(storedPassword)) {
      return storedPassword === (password || "");
    }

    const [, salt, expectedHash] = storedPassword.split("$");
    if (!salt || !expectedHash) return false;

    const derivedKey = crypto.scryptSync(password || "", salt, KEY_BYTES);
    const expectedBuffer = Buffer.from(expectedHash, "hex");
    if (derivedKey.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(derivedKey, expectedBuffer);
  }
}

module.exports = new PasswordService();
