// A guest never sees the engine snapshot: it gets detached, bounded metadata. The cap
// keeps a large scene from serializing the whole Render IR across the worker boundary.
export const APG_SCENE_SNAPSHOT_LIMIT = 512;

export interface ApgSceneBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

export interface ApgSceneSnapshot {
	revision: number;
	truncated: boolean;
	items: { elementId: string; primitive: string; bounds: ApgSceneBounds }[];
}

type RenderItemLike = {
	atom?: { elementId?: unknown; primitive?: unknown; bounds?: unknown };
};

type RenderFrameLike = {
	revision?: unknown;
	items?: readonly RenderItemLike[];
};

const BOUND_KEYS: readonly (keyof ApgSceneBounds)[] = ["minX", "minY", "maxX", "maxY", "width", "height"];

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const readBounds = (value: unknown): ApgSceneBounds | null => {
	if (!value || typeof value !== "object") return null;
	const bounds = value as Partial<Record<keyof ApgSceneBounds, unknown>>;
	for (const key of BOUND_KEYS) if (!isFiniteNumber(bounds[key])) return null;
	return bounds as ApgSceneBounds;
};

// Returns null when the frame is not a usable Render IR frame. Items without the detached
// fields the guest contract promises are dropped rather than sent as half-shaped objects.
export const buildApgSceneSnapshot = (frame: RenderFrameLike | null | undefined): ApgSceneSnapshot | null => {
	if (!frame || !Array.isArray(frame.items)) return null;
	const items: ApgSceneSnapshot["items"] = [];
	for (const item of frame.items) {
		const atom = item?.atom;
		if (!atom || typeof atom.elementId !== "string" || typeof atom.primitive !== "string") continue;
		const bounds = readBounds(atom.bounds);
		if (!bounds) continue;
		items.push({ elementId: atom.elementId, primitive: atom.primitive, bounds });
		if (items.length === APG_SCENE_SNAPSHOT_LIMIT) break;
	}
	return {
		revision: isFiniteNumber(frame.revision) ? frame.revision : 0,
		truncated: frame.items.length > APG_SCENE_SNAPSHOT_LIMIT,
		items,
	};
};

// Picks the scene source for a guest read. The worker frame wins when present; without
// OffscreenCanvas the main-thread engine is authoritative, and a worker that is enabled but
// returned nothing stays an explicit failure instead of being reported as an empty scene.
export const selectApgSceneSnapshot = (
	workerFrame: RenderFrameLike | null | undefined,
	offscreenEnabled: boolean,
	fallbackFrame: RenderFrameLike | null | undefined,
): ApgSceneSnapshot | null => {
	if (workerFrame) return buildApgSceneSnapshot(workerFrame);
	if (!offscreenEnabled) return buildApgSceneSnapshot(fallbackFrame);
	return null;
};
