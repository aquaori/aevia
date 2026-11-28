import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OFFICIAL_APG_IDS = ["brushes", "note-template", "palette", "scene-export", "scene-inspector", "shape-template", "shared-counter"] as const;

export function provisionApgFixture(root: string, dir: string, env: NodeJS.ProcessEnv) {
  mkdirSync(dir, { recursive: true });
  const binary = path.join(dir, process.platform === "win32" ? "apg.exe" : "apg");
  const backend = path.join(root, "apps", "backend");
  const trust = path.join(dir, "trust.json");
  const apgEnv = { ...env, APG_DIR: dir, APG_TRUST_STORE: trust, APG_TRUST_POLICY: "require-signed" };
  const invoke = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: backend, env: apgEnv, encoding: "utf8", timeout: 90000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("APG fixture failed: " + args.join(" ") + ": " + (result.error?.message ?? result.stderr));
    return result.stdout.trim();
  };
  invoke("go", ["build", "-o", binary, "./cmd/apg"]);
  const key = path.join(dir, "test-private.key");
  const publicKey = invoke(binary, ["keygen", key]);
  writeFileSync(trust, JSON.stringify({ version: 1, keys: { lab: publicKey } }), { mode: 0o600 });
  for (const name of OFFICIAL_APG_IDS) {
    const output = path.join(dir, "packages", name + ".apg");
    const signed = path.join(dir, "packages", name + ".signed.apg");
    invoke(binary, ["pack", path.join(root, "plugins", "official", name, "manifest.json"), output]);
    invoke(binary, ["sign", output, signed, "lab", key]);
    invoke(binary, ["verify", signed]);
    invoke(binary, ["install", signed]);
    invoke(binary, ["enable", "aevia." + name]);
  }
  return { binary, env: apgEnv };
}
