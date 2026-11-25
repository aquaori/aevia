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

function boxesEqual(left: AabbBox, right: AabbBox): boolean {
	return (
		left === right ||
		(left.minX === right.minX &&
			left.minY === right.minY &&
			left.maxX === right.maxX &&
			left.maxY === right.maxY &&
			left.width === right.width &&
			left.height === right.height)
	);
}

function matricesEqual(left: AffineMatrix, right: AffineMatrix): boolean {
	return (
		left === right ||
		(left[0] === right[0] &&
			left[1] === right[1] &&
			left[2] === right[2] &&
			left[3] === right[3] &&
			left[4] === right[4] &&
			left[5] === right[5])
	);
}

function stylesEqual(left: RenderIRItem["atom"]["style"], right: RenderIRItem["atom"]["style"]): boolean {
	return (
		left === right ||
		(left.color === right.color &&
			left.fillColor === right.fillColor &&
			left.size === right.size &&
			left.opacity === right.opacity &&
			left.strokePattern === right.strokePattern &&
			left.fontFamily === right.fontFamily &&
			left.fontSize === right.fontSize &&
			left.fontWeight === right.fontWeight &&
			left.textAlign === right.textAlign)
	);
}

function renderAtomsEqual(left: RenderAtom, right: RenderAtom): boolean {
	if (left === right) return true;
	if (
		left.primitive !== right.primitive ||
		left.ref !== right.ref ||
		left.generation !== right.generation ||
		left.atomId !== right.atomId ||
		left.elementId !== right.elementId ||
		left.elementRevision !== right.elementRevision ||
		left.pageId !== right.pageId ||
		left.recipeId !== right.recipeId ||
		left.toolId !== right.toolId ||
		left.order.lamport !== right.order.lamport ||
		left.order.opId !== right.order.opId ||
		left.order.sourceIndex !== right.order.sourceIndex ||
		left.order.subIndex !== right.order.subIndex ||
		!stylesEqual(left.style, right.style) ||
		!boxesEqual(left.bounds, right.bounds)
	) {
		return false;
	}
	switch (left.primitive) {
		case "dot": {
			const other = right as typeof left;
			return left.x === other.x && left.y === other.y && left.width === other.width && left.dashOffset === other.dashOffset;
		}
		case "quadratic": {
			const other = right as typeof left;
			return (
				left.fromX === other.fromX &&
				left.fromY === other.fromY &&
				left.viaX === other.viaX &&
				left.viaY === other.viaY &&
				left.toX === other.toX &&
				left.toY === other.toY &&
				left.width === other.width &&
				left.dashOffset === other.dashOffset
			);
		}
		case "shape": {
			const other = right as typeof left;
			return (
				left.shapeKind === other.shapeKind &&
				left.shapeStart?.x === other.shapeStart?.x &&
				left.shapeStart?.y === other.shapeStart?.y &&
				left.shapeEnd?.x === other.shapeEnd?.x &&
				left.shapeEnd?.y === other.shapeEnd?.y &&
				boxesEqual(left.box, other.box)
			);
		}
		case "glyph": {
			const other = right as typeof left;
			return (
				left.grapheme === other.grapheme &&
				left.x === other.x &&
				left.y === other.y &&
				left.maxWidth === other.maxWidth &&
				left.referenceWidth === other.referenceWidth
			);
		}
		case "bitmap": {
			const other = right as typeof left;
			return left.value === other.value && boxesEqual(left.box, other.box);
		}
	}
}

export function renderIRItemsEqual(left: RenderIRItem, right: RenderIRItem): boolean {
	if (left === right) return true;
	if (
		left.id !== right.id ||
		left.opacity !== right.opacity ||
		left.handle.id !== right.handle.id ||
		left.handle.generation !== right.handle.generation ||
		left.handle.epoch !== right.handle.epoch ||
		left.erasedIntervals.length !== right.erasedIntervals.length ||
		left.eraseMasks.length !== right.eraseMasks.length ||
		!matricesEqual(left.matrix, right.matrix) ||
		!renderAtomsEqual(left.atom, right.atom)
	) {
		return false;
	}
	for (let i = 0; i < left.erasedIntervals.length; i += 1) {
		const a = left.erasedIntervals[i]!;
		const b = right.erasedIntervals[i]!;
		if (a.start !== b.start || a.end !== b.end) return false;
	}
	for (let i = 0; i < left.eraseMasks.length; i += 1) {
		const a = left.eraseMasks[i]!;
		const b = right.eraseMasks[i]!;
		if (
			a.size !== b.size ||
			a.width !== b.width ||
			a.height !== b.height ||
			a.points.length !== b.points.length ||
			!matricesEqual(a.inverseMatrix, b.inverseMatrix)
		) {
			return false;
		}
		for (let j = 0; j < a.points.length; j += 1) {
			const pa = a.points[j]!;
			const pb = b.points[j]!;
			if (pa.x !== pb.x || pa.y !== pb.y || pa.p !== pb.p || pa.lamport !== pb.lamport) return false;
		}
	}
	return true;
}

export function diffRenderIR(previous: RenderIRFrame, next: RenderIRFrame): RenderIRDelta {
	const oldItems = new Map<string, RenderIRItem>();
	for (const item of previous.items) oldItems.set(item.id, item);

	const nextIds = new Set<string>();
	const order: string[] = [];
	const changed: RenderIRItem[] = [];
	let orderChanged = previous.items.length !== next.items.length;

	for (let i = 0; i < next.items.length; i += 1) {
		const item = next.items[i]!;
		nextIds.add(item.id);
		order.push(item.id);
		if (!orderChanged && previous.items[i]!.id !== item.id) {
			orderChanged = true;
		}
		const prev = oldItems.get(item.id);
		if (!prev || !renderIRItemsEqual(prev, item)) {
			changed.push(item);
		}
	}

	const removed: RenderIRItem[] = [];
	for (const item of previous.items) {
		if (!nextIds.has(item.id)) removed.push(item);
	}

	const dirtyBounds: AabbBox[] = [];
	if (orderChanged) {
		for (const item of previous.items) dirtyBounds.push(transformBounds(item.matrix, item.atom.bounds));
		for (const item of next.items) dirtyBounds.push(transformBounds(item.matrix, item.atom.bounds));
	} else {
		for (const item of removed) dirtyBounds.push(transformBounds(item.matrix, item.atom.bounds));
		for (const item of changed) {
			const prev = oldItems.get(item.id);
			if (prev) dirtyBounds.push(transformBounds(prev.matrix, prev.atom.bounds));
			dirtyBounds.push(transformBounds(item.matrix, item.atom.bounds));
		}
	}

	return {
		version: 1,
		baseRevision: previous.revision,
		revision: next.revision,
		removed: removed.map((item) => item.id),
		upserted: changed.map((item) => structuredClone(item)),
		order,
		dirtyBounds,
	};
}

export function applyRenderIRDelta(frame: RenderIRFrame, delta: RenderIRDelta, cloneItems = true): RenderIRFrame {
	if (frame.version !== 1 || delta.version !== 1 || frame.revision !== delta.baseRevision) throw new Error("Render IR revision mismatch");
	const items = new Map(frame.items.map((item) => [item.id, cloneItems ? structuredClone(item) : item]));
	for (const id of delta.removed) items.delete(id);
	for (const item of delta.upserted) items.set(item.id, cloneItems ? structuredClone(item) : item);
	const ordered = delta.order.map((id) => {
		const item = items.get(id);
		if (!item) throw new Error("Render IR delta references a missing atom");
		return item;
	});
	if (ordered.length !== items.size || new Set(delta.order).size !== items.size) throw new Error("Render IR delta has an invalid order");
	return { version: 1, revision: delta.revision, items: ordered };
}
