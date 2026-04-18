const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("../config");

const ensureDirectory = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

class SqliteService {
  constructor() {
    ensureDirectory(config.DB_PATH);
    this.db = new DatabaseSync(config.DB_PATH);
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        password TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        total_page INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        cmd_id TEXT NOT NULL,
        page_id INTEGER,
        type TEXT,
        payload TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(room_id, cmd_id),
        FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_commands_room_id_id
      ON commands(room_id, id);

      CREATE INDEX IF NOT EXISTS idx_commands_room_id_cmd_id
      ON commands(room_id, cmd_id);
    `);
  }
}

module.exports = new SqliteService();
