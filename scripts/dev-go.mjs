import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const children = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendPort = process.env.GO_BACKEND_PORT || process.env.PORT || "4647";

const detectPublicHost = () => {
  if (process.env.AEVIA_PUBLIC_HOST || process.env.PUBLIC_HOST) {
    return process.env.AEVIA_PUBLIC_HOST || process.env.PUBLIC_HOST;
  }
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  const score = (address) => {
    if (address.startsWith("192.168.")) return 0;
    if (address.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
    return 3;
  };
  return addresses.sort((a, b) => score(a) - score(b))[0] || "127.0.0.1";
};

const publicHost = detectPublicHost();
const apiUrl = process.env.VITE_API_URL || `http://${publicHost}:${backendPort}`;
const wsUrl = process.env.VITE_WS_URL || `ws://${publicHost}:${backendPort}/ws`;

const commandForPlatform = (command, args) => {
  if (process.platform !== "win32") {
    return { command, args };
  }
  return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
};

const spawnChild = (name, command, args, options = {}) => {
  const resolved = commandForPlatform(command, args);
  const child = spawn(resolved.command, resolved.args, {
    stdio: "inherit",
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
};

const shutdown = (code = 0) => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

spawnChild("go-backend", "go", ["run", "./cmd/aevia-go-backend"], {
  cwd: path.join(repoRoot, "apps", "go-backend"),
  env: {
    ...process.env,
    PORT: backendPort,
    LOG_FORMAT: process.env.LOG_FORMAT || "console",
    DB_PATH:
      process.env.GO_BACKEND_DB_PATH ||
      process.env.DB_PATH ||
      "../../data/whiteboard-go.sqlite",
  },
});

spawnChild("frontend", "npm", ["run", "dev", "--workspace", "@collaborative-whiteboard/frontend"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BROWSERSLIST_IGNORE_OLD_DATA: process.env.BROWSERSLIST_IGNORE_OLD_DATA || "1",
    VITE_API_URL: apiUrl,
    VITE_WS_URL: wsUrl,
  },
});

console.log(`[dev:go] frontend API=${apiUrl}`);
console.log(`[dev:go] frontend WS=${wsUrl}`);
