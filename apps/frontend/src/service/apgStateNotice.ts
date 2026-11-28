// File role: decide whether an `apg.state.changed` notice may invalidate local APG derived UI.
import type { ApgCatalog } from "./apgCatalog";

/** Server push payload carried on the room WebSocket JSON channel. It is a hint to re-read the
 * authoritative state, never the state itself. */
export interface ApgStateNotice {
	pluginId?: unknown;
	digest?: unknown;
	revision?: unknown;
}

export interface AcceptedApgStateNotice {
	pluginId: string;
	revision: number;
}

const isSafeRevision = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/**
 * Accept a notice only when it describes a plugin this client can currently act on and it is
 * newer than the revision this client already saw. Everything else (foreign room data, a stale
 * duplicate, a digest from a version the deployment replaced, a user-scope plugin, a plugin
 * without shared storage) is ignored. Notices are not trusted values, so a forged one can only
 * clear a preview here; it cannot write state.
 */
export const acceptApgStateNotice = (
	notice: unknown,
	catalog: ApgCatalog,
	localRevisions: Readonly<Record<string, number>> = {},
): AcceptedApgStateNotice | null => {
	if (!notice || typeof notice !== "object") return null;
	const { pluginId, digest, revision } = notice as ApgStateNotice;
	if (typeof pluginId !== "string" || pluginId.length === 0) return null;
	if (typeof digest !== "string" || digest.length === 0) return null;
	if (!isSafeRevision(revision)) return null;
	const match = catalog.plugins.some(
		(plugin) =>
			plugin.manifest.id === pluginId &&
			plugin.digest === digest &&
			plugin.manifest.scope === "system" &&
			plugin.manifest.permissions?.includes("storage.shared") === true,
	);
	if (!match) return null;
	if (revision <= (localRevisions[pluginId] ?? 0)) return null;
	return { pluginId, revision };
};
