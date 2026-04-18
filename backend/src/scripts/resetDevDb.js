const fs = require("fs");
const config = require("../config");

const dbFiles = [
  config.DB_PATH,
  `${config.DB_PATH}-wal`,
  `${config.DB_PATH}-shm`,
];

dbFiles.forEach((filePath) => {
  if (fs.existsSync(filePath)) {
    try {
      fs.rmSync(filePath, { force: true });
      console.log(`[predev] removed ${filePath}`);
    } catch (error) {
      console.error(`[predev] failed to remove ${filePath}: ${error.code || error.message}`);
      console.error("[predev] close any running backend process that is still using the SQLite files, then retry.");
      process.exitCode = 1;
    }
  }
});
