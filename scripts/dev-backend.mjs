import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goArgs = ["run", "./cmd/aevia-backend"];
const command = process.platform === "win32" ? "cmd.exe" : "go";
const args = process.platform === "win32" ? ["/d", "/s", "/c", "go", ...goArgs] : goArgs;

const child = spawn(command, args, {
  stdio: "inherit",
  cwd: path.join(repoRoot, "apps", "backend"),
  env: {
    ...process.env,
    PORT: process.env.GO_BACKEND_PORT || process.env.PORT || "4646",
    LOG_FORMAT: process.env.LOG_FORMAT || "console",
    DB_PATH:
      process.env.GO_BACKEND_DB_PATH ||
      process.env.DB_PATH ||
      "../../data/whiteboard-go.sqlite",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
