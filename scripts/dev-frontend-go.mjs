import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendPort = process.env.GO_BACKEND_PORT || process.env.PORT || "4646";

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

const env = {
  ...process.env,
  BROWSERSLIST_IGNORE_OLD_DATA: process.env.BROWSERSLIST_IGNORE_OLD_DATA || "1",
  VITE_API_URL: apiUrl,
  VITE_WS_URL: wsUrl,
};

console.log(`[dev:frontend:go] frontend API=${apiUrl}`);
console.log(`[dev:frontend:go] frontend WS=${wsUrl}`);

const npmArgs = ["run", "dev", "--workspace", "@collaborative-whiteboard/frontend"];
const command = process.platform === "win32" ? "cmd.exe" : "npm";
const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs;

const child = spawn(command, args, {
  stdio: "inherit",
  env,
  cwd: repoRoot,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
