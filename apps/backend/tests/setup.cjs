const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "vitest-secret";
process.env.DB_PATH =
	process.env.DB_PATH || path.join(os.tmpdir(), `whiteboard-vitest-${process.pid}.sqlite`);

for (const suffix of ["", "-wal", "-shm"]) {
	try {
		fs.rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
	} catch {
		// SQLite may not have created every sidecar file yet.
	}
}
