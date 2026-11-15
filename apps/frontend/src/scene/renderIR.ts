// File role: versioned, renderer-independent snapshots of visible scene atoms.
import type { AabbBox, AffineMatrix, EraseMask, SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import type { RenderAtom } from "./sceneTypes";
import { transformBounds } from "./matrix";

export interface RenderIRItem {
	id: string;
	handle: AtomHandle;
	atom: RenderAtom;
	matrix: AffineMatrix;
	erasedIntervals: Array<{ start: number; end: number }>;
	eraseMasks: EraseMask[];
	opacity?: number;
}

export interface AtomHandle {
	id: string;
	generation: number;
	epoch: string;
}

export interface RenderIRFrame {
	version: 1;
	revision: number;
	items: RenderIRItem[];
}

export interface SceneCorePort {
	applyOperation(operation: SceneOperationEnvelopeV2): unknown;
	getRenderIR(): RenderIRFrame;
}

export interface RenderIRDelta {
	version: 1;
	baseRevision: number;
	revision: number;
	removed: string[];
	upserted: RenderIRItem[];
	order: string[];
	dirtyBounds: AabbBox[];
}

export function diffRenderIR(previous: RenderIRFrame, next: RenderIRFrame): RenderIRDelta {
	const oldItems = new Map(previous.items.map((item) => [item.id, item]));
	const nextIds = new Set(next.items.map((item) => item.id));
	const removed = previous.items.filter((item) => !nextIds.has(item.id));
	const changed = next.items.filter((item) => JSON.stringify(oldItems.get(item.id)) !== JSON.stringify(item));
	const orderChanged = previous.items.map((item) => item.id).join("\0") !== next.items.map((item) => item.id).join("\0");
	const dirtyItems = orderChanged ? [...previous.items, ...next.items] : [...removed, ...changed.flatMap((item) => [oldItems.get(item.id), item].filter((value): value is RenderIRItem => !!value))];
	return {
		version: 1,
		baseRevision: previous.revision,
		revision: next.revision,
		removed: removed.map((item) => item.id),
		upserted: changed.map((item) => structuredClone(item)),
		order: next.items.map((item) => item.id),
		dirtyBounds: dirtyItems.map((item) => transformBounds(item.matrix, item.atom.bounds)),
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
