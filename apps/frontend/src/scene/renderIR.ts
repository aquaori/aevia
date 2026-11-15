// File role: versioned, renderer-independent snapshots of visible scene atoms.
import type { AffineMatrix, EraseMask } from "@collaborative-whiteboard/shared";
import type { RenderAtom } from "./sceneTypes";

export interface RenderIRItem {
	id: string;
	atom: RenderAtom;
	matrix: AffineMatrix;
	erasedIntervals: Array<{ start: number; end: number }>;
	eraseMasks: EraseMask[];
}

export interface RenderIRFrame {
	version: 1;
	revision: number;
	items: RenderIRItem[];
}

export interface RenderIRDelta {
	version: 1;
	baseRevision: number;
	revision: number;
	removed: string[];
	upserted: RenderIRItem[];
	order: string[];
}

export function diffRenderIR(previous: RenderIRFrame, next: RenderIRFrame): RenderIRDelta {
	const oldItems = new Map(previous.items.map((item) => [item.id, item]));
	const nextIds = new Set(next.items.map((item) => item.id));
	return {
		version: 1,
		baseRevision: previous.revision,
		revision: next.revision,
		removed: previous.items.filter((item) => !nextIds.has(item.id)).map((item) => item.id),
		upserted: next.items.filter((item) => JSON.stringify(oldItems.get(item.id)) !== JSON.stringify(item)).map((item) => structuredClone(item)),
		order: next.items.map((item) => item.id),
	};
}

export function applyRenderIRDelta(frame: RenderIRFrame, delta: RenderIRDelta): RenderIRFrame {
	if (frame.version !== 1 || delta.version !== 1 || frame.revision !== delta.baseRevision) throw new Error("Render IR revision mismatch");
	const items = new Map(frame.items.map((item) => [item.id, structuredClone(item)]));
	for (const id of delta.removed) items.delete(id);
	for (const item of delta.upserted) items.set(item.id, structuredClone(item));
	const ordered = delta.order.map((id) => {
		const item = items.get(id);
		if (!item) throw new Error("Render IR delta references a missing atom");
		return item;
	});
	if (ordered.length !== items.size || new Set(delta.order).size !== items.size) throw new Error("Render IR delta has an invalid order");
	return { version: 1, revision: delta.revision, items: ordered };
}
