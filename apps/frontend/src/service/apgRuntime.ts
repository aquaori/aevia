import { isUserPaletteEnabled, type ApgCatalog, type ApgCatalogPlugin } from "./apgCatalog";
import type { ApgInvocation } from "./apgSandbox";

/** A file the user asked the plugin to save. `text` is inert data, never markup. */
export interface ApgDownloadFile { name: string; mime: string; text: string }
type Effect =
  | { kind: "ui.preview"; value: string }
  | { kind: "ui.download"; value: ApgDownloadFile }
  | { kind: "scene.write" | "storage.shared"; value: unknown };

const APG_DOWNLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const APG_DOWNLOAD_MIMES = new Set(["application/json", "text/plain", "text/csv"]);

function parseApgDownload(value: unknown): ApgDownloadFile {
  if (!value || typeof value !== "object") throw new Error("APG invalid download");
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("name") || !keys.includes("mime") || !keys.includes("text")) throw new Error("APG invalid download");
  const file = value as Partial<ApgDownloadFile>;
  if (typeof file.name !== "string" || !APG_DOWNLOAD_NAME.test(file.name)) throw new Error("APG invalid download name");
  if (typeof file.mime !== "string" || !APG_DOWNLOAD_MIMES.has(file.mime)) throw new Error("APG invalid download type");
  if (typeof file.text !== "string") throw new Error("APG invalid download body");
  return { name: file.name, mime: file.mime, text: file.text };
}
export interface ApgSharedState { revision: number; value: unknown }
type Connection = { invoke: (invocation: ApgInvocation, program?: string) => Promise<string>; dispose: () => void };
export interface ApgHost {
  /** Capture a host-owned context identifier; results from a previous page/session are rejected. */
  contextKey(): string;
  canEdit(): boolean;
  readScene(): Promise<unknown>;
  mutate(pluginId: string, request: unknown): void;
  preview(pluginId: string, text: string): void;
  /** Save a user-requested export. The host writes it; the plugin never touches the filesystem. */
  download(pluginId: string, file: ApgDownloadFile): void;
  readSharedState?(plugin: ApgCatalogPlugin): Promise<ApgSharedState>;
  writeSharedState?(plugin: ApgCatalogPlugin, revision: number, value: unknown): Promise<void>;
  readResource?(plugin: ApgCatalogPlugin, path: string): Promise<unknown>;
  cleanup?(pluginId: string): void;
}
export function createApgWorker(): Connection {
  const worker = new Worker(new URL("./apgSandbox.worker.ts", import.meta.url), { type: "module" });
  let next = 0;
  let closed = false;
  let pending: { id: number; timer: ReturnType<typeof setTimeout>; resolve: (value: string) => void; reject: (reason: Error) => void } | undefined;
  const dispose = () => {
    if (closed) return;
    closed = true;
    worker.terminate();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("APG worker disposed"));
      pending = undefined;
    }
  };
  worker.onmessage = (event: MessageEvent) => {
    if (!pending || event.data?.id !== pending.id) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    if (typeof event.data.output !== "string" || event.data.output.length > 65536) {
      current.reject(new Error("APG invalid RPC response"));
      dispose();
    } else current.resolve(event.data.output);
  };
  worker.onerror = dispose;
  worker.onmessageerror = dispose;
  return {
    invoke(invocation, program) {
      if (closed || pending) return Promise.reject(new Error("APG worker unavailable"));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(dispose, program === undefined ? 1500 : 5000);
        pending = { id, timer, resolve, reject };
        try { worker.postMessage({ id, invocation, program }); } catch { dispose(); }
      });
    },
    dispose,
  };
}

export function authorizeApgEffects(plugin: ApgCatalogPlugin, raw: string, canEdit: boolean): Effect[] {
  if (raw.length > 65536) throw new Error("APG result too large");
  const effects: unknown = JSON.parse(raw);
  if (!Array.isArray(effects) || effects.length > 16) throw new Error("APG invalid effects");
  const permissions = new Set(plugin.manifest.permissions ?? []);
  let mutations = 0;
  return effects.map((effect): Effect => {
    if (!effect || typeof effect !== "object" || Object.keys(effect).length !== 2 || !Object.prototype.hasOwnProperty.call(effect, "kind") || !Object.prototype.hasOwnProperty.call(effect, "value")) throw new Error("APG invalid effect");
    if (effect.kind === "ui.preview" && permissions.has("ui.preview") && typeof effect.value === "string" && effect.value.length <= 4096) return effect;
    if (effect.kind === "ui.download" && permissions.has("ui.download")) return { kind: "ui.download", value: parseApgDownload(effect.value) };
    if (effect.kind === "scene.write" && permissions.has("scene.write") && plugin.manifest.scope === "system" && canEdit && ++mutations === 1) return effect;
    if (effect.kind === "storage.shared" && permissions.has("storage.shared") && plugin.manifest.scope === "system" && canEdit && ++mutations === 1 && new TextEncoder().encode(JSON.stringify(effect.value)).length <= 16384) return effect;
    throw new Error("APG capability denied");
  });
}

export function createApgRuntime(host: ApgHost, connect: () => Connection = createApgWorker) {
  type Entry = { plugin: ApgCatalogPlugin; connection?: Connection; busy: boolean };
  const entries = new Map<string, Entry>();
  let disposed = false;
  const eligible = (plugin: ApgCatalogPlugin) => plugin.manifest.scope === "system" || isUserPaletteEnabled(plugin.manifest.id);
  const disposeEntry = (entry: Entry) => {
    host.cleanup?.(entry.plugin.manifest.id);
    const conn = entry.connection;
    entry.connection = undefined;
    if (!conn) return;
    if (entry.busy) conn.dispose();
    else void conn.invoke({ phase: "deactivate" }).catch(() => {}).finally(conn.dispose);
  };
  const reconcile = (catalog: ApgCatalog) => {
    if (disposed) return;
    const active = new Map(catalog.plugins.filter(p => p.enabled && p.program && eligible(p)).map(p => [p.manifest.id, p]));
    for (const [id, entry] of entries) {
      const plugin = active.get(id);
      if (!plugin || JSON.stringify(plugin) !== JSON.stringify(entry.plugin)) {
        entries.delete(id);
        disposeEntry(entry);
      }
    }
    for (const [id, plugin] of active) if (!entries.has(id)) entries.set(id, { plugin, busy: false });
  };
  const run = async (pluginId: string, commandId: string) => {
    const entry = entries.get(pluginId);
    if (disposed || !entry || !eligible(entry.plugin) || entry.busy || !entry.plugin.manifest.contributes.commands?.some(c => c.id === commandId)) throw new Error("APG command unavailable");
    const context = host.contextKey();
    const contribution = entry.plugin.manifest.contributes.commands!.find(c => c.id === commandId)!;
    const stillActive = () => !disposed && entries.get(pluginId) === entry && eligible(entry.plugin) && host.contextKey() === context;
    entry.busy = true;
    try {
      if (!entry.connection) {
        if ([...entries.values()].filter(e => e.connection).length >= 8) throw new Error("APG active worker limit");
        entry.connection = connect();
        const activation = await entry.connection.invoke({ phase: "activate" }, entry.plugin.program);
        if (activation !== "[]" || !stillActive()) throw new Error("APG invalid activation or revoked context");
      }
      const scene = entry.plugin.manifest.permissions?.includes("scene.read") ? await host.readScene() : undefined;
      const sharedState = entry.plugin.manifest.permissions?.includes("storage.shared") ? await host.readSharedState?.(entry.plugin) : undefined;
      const resource = contribution.resource && entry.plugin.manifest.scope === "system" ? await host.readResource?.(entry.plugin, contribution.resource) : undefined;
      if (contribution.resource && resource === undefined) throw new Error("APG resource unavailable");
      if (!stillActive()) throw new Error("APG context revoked");
      const result = await entry.connection.invoke({ phase: "command", command: commandId, input: { scene, sharedState, resource } });
      if (!stillActive()) throw new Error("APG context revoked");
      const effects = authorizeApgEffects(entry.plugin, result, host.canEdit());
      // Validate all capabilities first. Single mutation avoids pretending a multi-op transaction is atomic.
      for (const effect of effects) if (effect.kind === "scene.write") host.mutate(pluginId, effect.value);
      for (const effect of effects) if (effect.kind === "storage.shared") {
        if (!sharedState || !host.writeSharedState) throw new Error("APG shared state unavailable");
        await host.writeSharedState(entry.plugin, sharedState.revision, effect.value);
      }
      if (!stillActive()) throw new Error("APG context revoked");
      for (const effect of effects) if (effect.kind === "ui.download") host.download(pluginId, effect.value);
      for (const effect of effects) if (effect.kind === "ui.preview") host.preview(pluginId, effect.value);
    } catch (error) {
      host.cleanup?.(pluginId);
      entry.connection?.dispose();
      entry.connection = undefined;
      throw error;
    } finally { entry.busy = false; }
  };
  return { reconcile, run, dispose() {
    disposed = true;
    for (const entry of entries.values()) disposeEntry(entry);
    entries.clear();
  } };
}
