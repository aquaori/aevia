// File role: canonical scene folding, indexing, hit-testing, and rendering engine.
import {
	IDENTITY_MATRIX,
	compareRenderOrder,
	sceneOperationOrderKey,
	type AabbBox,
	type AffineMatrix,
	type Command,
	type ElementCreatePayload,
	type EraseTarget,
	type FlatPoint,
	type Point,
	type RenderOrderKey,
	type SceneElementDescriptor,
	type SceneElementStyle,
	type SceneOperationEnvelopeV2,
} from "@collaborative-whiteboard/shared";
import { cutIntervalsForStrokeAtom, mergeQuantizedIntervals } from "./eraseGeometry";
import { DirtyRegionSet } from "./dirtyRegionSet";
import { cloneMatrix, invertMatrix, matrixScale, multiplyMatrices, transformBounds, transformPoint, unionBounds } from "./matrix";
import { drawPrimitive } from "./primitiveRenderer";
import { RenderOrderIndex } from "./renderOrderIndex";
import type {
	BitmapAtom,
	DirtyRenderMetrics,
	GlyphAtom,
	RenderAtom,
	SceneElementState,
	SceneStats,
	ShapeAtom,
	TextCharacterState,
} from "./sceneTypes";
import { SpatialGridIndex } from "./spatialGridIndex";
import { splitGraphemes } from "./graphemes";
import {
	compileStrokeSample,
	finishCompiledStroke,
	type StrokeCompilerState,
} from "./strokeCompiler";

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const EMPTY_BOX: AabbBox = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
const DEFAULT_FONT_SIZE = 20;
const DIRTY_PADDING = 20;

const intersects = (left: AabbBox, right: AabbBox) =>
	!(left.maxX < right.minX || left.minX > right.maxX || left.maxY < right.minY || left.minY > right.maxY);

const pointInBox = (point: { x: number; y: number }, box: AabbBox) =>
	point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;

const distanceToSegment = (
	point: { x: number; y: number },
	from: { x: number; y: number },
	to: { x: number; y: number }
) => {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (dx === 0 && dy === 0) return Math.hypot(point.x - from.x, point.y - from.y);
	const parameter = Math.max(
		0,
		Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy))
	);
	return Math.hypot(point.x - (from.x + parameter * dx), point.y - (from.y + parameter * dy));
};

const dashPattern = (pattern: SceneElementDescriptor["style"]["strokePattern"], width: number) => {
	switch (pattern) {
		case "dashed":
			return [width * 4, width * 2.5];
		case "dotted":
			return [0.01, width * 2.2];
		case "dash-dot":
			return [width * 4, width * 2, 0.01, width * 2];
		default:
			return [];
	}
};

const isDashPainted = (pattern: SceneElementDescriptor["style"]["strokePattern"], width: number, distance: number) => {
	const dash = dashPattern(pattern, width);
	if (dash.length === 0) return true;
	const period = dash.reduce((sum, length) => sum + length, 0);
	let cursor = ((distance % period) + period) % period;
	for (let index = 0; index < dash.length; index += 1) {
		if (cursor <= dash[index]!) return index % 2 === 0;
		cursor -= dash[index]!;
	}
	return true;
};

const segmentIntersectsBox = (
	from: { x: number; y: number },
	to: { x: number; y: number },
	box: AabbBox
) => {
	if (pointInBox(from, box) || pointInBox(to, box)) return true;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	let lower = 0;
	let upper = 1;
	const clip = (p: number, q: number) => {
		if (p === 0) return q >= 0;
		const ratio = q / p;
		if (p < 0) {
			if (ratio > upper) return false;
			lower = Math.max(lower, ratio);
		} else {
			if (ratio < lower) return false;
			upper = Math.min(upper, ratio);
		}
		return true;
	};
	return clip(-dx, from.x - box.minX) && clip(dx, box.maxX - from.x) && clip(-dy, from.y - box.minY) && clip(dy, box.maxY - from.y);
};

const polygonIntersectsBox = (points: Array<{ x: number; y: number }>, box: AabbBox) => {
	if (points.some((point) => pointInBox(point, box))) return true;
	for (let index = 0; index < points.length; index += 1) {
		if (segmentIntersectsBox(points[index]!, points[(index + 1) % points.length]!, box)) return true;
	}
	const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
	let inside = false;
	for (let left = points.length - 1, right = 0; right < points.length; left = right, right += 1) {
		const a = points[left]!;
		const b = points[right]!;
		if ((a.y > center.y) !== (b.y > center.y) && center.x < ((b.x - a.x) * (center.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
};

const commandDescriptor = (command: Command): SceneElementDescriptor => ({
	elementKind: "path",
	toolId: command.tool ?? "pen",
	recipeId: "stroke",
	style: {
		color: command.color ?? "#000000",
		size: command.size ?? 3,
		strokePattern: command.strokePattern ?? "solid",
		opacity: command.tool === "highlighter" ? 0.32 : command.tool === "pencil" ? 0.78 : 1,
	},
	box: command.box,
});

const pointOrder = (elementId: string, point: Point, sourceIndex: number): RenderOrderKey => ({
	lamport: point.lamport,
	opId: (point as FlatPoint).orderOpId ?? elementId,
	sourceIndex,
	subIndex: 0,
});

const operationTargets = (operation: SceneOperationEnvelopeV2) => {
	switch (operation.kind) {
		case "element.transform":
			return operation.payload.targets.map((target) => target.elementId);
		case "element.erase":
			return operation.payload.targets.map((target) => target.elementId);
		case "element.delete":
			return operation.payload.elementIds;
		default:
			return [operation.elementId];
	}
};

export class SceneEngine {
	private readonly atoms: RenderAtom[] = [];
	private readonly elements = new Map<string, SceneElementState>();
	private readonly compilerStates = new Map<string, StrokeCompilerState>();
	private readonly legacyElementIds = new Set<string>();
	private readonly legacyDeleted = new Map<string, boolean>();
	private readonly operations: SceneOperationEnvelopeV2[] = [];
	private readonly operationIds = new Set<string>();
	private readonly operationsByElement = new Map<string, SceneOperationEnvelopeV2[]>();
	private readonly operationsByHistoryGroup = new Map<string, SceneOperationEnvelopeV2[]>();
	private readonly revisionSeed = new Map<string, number>();
	private readonly historyEnabled = new Map<string, boolean>();
	private readonly pageClearBefore = new Map<number, RenderOrderKey>();
	private readonly spatial = new SpatialGridIndex();
	private readonly dirtyRegions = new DirtyRegionSet();
	private readonly order = new RenderOrderIndex((ref) => this.atoms[ref]!.order);
	private pageId = 0;
	private maxStrokeWidth = 1;
	private visibleAtomCount = 0;
	private dirtyFullMode = false;
	private bulkLoading = false;

	reset(pageId = this.pageId) {
		this.atoms.length = 0;
		this.elements.clear();
		this.compilerStates.clear();
		this.legacyElementIds.clear();
		this.legacyDeleted.clear();
		this.operations.length = 0;
		this.operationIds.clear();
		this.operationsByElement.clear();
		this.operationsByHistoryGroup.clear();
		this.revisionSeed.clear();
		this.historyEnabled.clear();
		this.pageClearBefore.clear();
		this.spatial.clear();
		this.order.clear();
		this.dirtyRegions.clear();
		this.pageId = pageId;
		this.maxStrokeWidth = 1;
		this.visibleAtomCount = 0;
		this.dirtyFullMode = false;
		this.bulkLoading = false;
	}

	beginBulkLoad() {
		this.bulkLoading = true;
	}

	endBulkLoad() {
		if (!this.bulkLoading) return;
		this.bulkLoading = false;
		this.spatial.clear();
		for (const atom of this.atoms) {
			const element = this.elements.get(atom.elementId);
			if (!element || atom.elementRevision !== element.revision) continue;
			this.spatial.addAtom(atom.elementId, atom.ref, transformBounds(element.matrix, atom.bounds));
		}
	}

	setPage(pageId: number) {
		this.pageId = pageId;
	}

	ingestFlatPoint(point: FlatPoint) {
		let element = this.elements.get(point.cmdId);
		if (!element) {
			element = this.createElement(
				point.cmdId,
				point.pageId,
				{
					elementKind: "path",
					toolId: point.tool,
					recipeId: "stroke",
					style: {
						color: point.color,
						size: point.size,
						strokePattern: point.strokePattern ?? "solid",
						opacity: point.tool === "highlighter" ? 0.32 : point.tool === "pencil" ? 0.78 : 1,
					},
				},
				pointOrder(point.cmdId, point, point.pointIndex ?? 0)
			);
			this.legacyElementIds.add(element.id);
		}
		element.deleted = point.isDeleted;
		this.legacyDeleted.set(element.id, point.isDeleted);
		const sourceIndex = point.pointIndex ?? element.points.length;
		return this.appendPoint(element, { x: point.x, y: point.y, p: point.p, lamport: point.lamport }, sourceIndex, pointOrder(point.cmdId, point, sourceIndex));
	}

	appendCommandPoints(command: Command, points: Point[]) {
		if (command.type !== "path" || points.length === 0) return [] as number[];
		let element = this.elements.get(command.id);
		if (!element) {
			const first = points[0]!;
			element = this.createElement(command.id, command.pageId, commandDescriptor(command), pointOrder(command.id, first, 0));
			this.legacyElementIds.add(command.id);
		}
		element.deleted = command.isDeleted;
		this.legacyDeleted.set(element.id, command.isDeleted);
		element.descriptor = commandDescriptor(command);
		const created: number[] = [];
		for (const point of points) {
			const sourceIndex = element.points.length;
			created.push(...this.appendPoint(element, point, sourceIndex, pointOrder(command.id, point, sourceIndex)));
		}
		return created;
	}

	finishElement(elementId: string) {
		const element = this.elements.get(elementId);
		if (!element || element.descriptor.recipeId !== "stroke") return [] as number[];
		const atoms = finishCompiledStroke({
			elementId,
			elementRevision: element.revision,
			pageId: element.pageId,
			descriptor: element.descriptor,
			state: this.compilerStates.get(elementId),
		});
		return atoms.map((atom) => this.storeAtom(element, atom));
	}

	finishAllOpenStrokes() {
		const refs: number[] = [];
		for (const elementId of this.compilerStates.keys()) refs.push(...this.finishElement(elementId));
		return refs;
	}

	rebuildFromCommands(commands: Command[], pageId: number) {
		this.reset(pageId);
		const points: FlatPoint[] = [];
		const sceneOperations: SceneOperationEnvelopeV2[] = [];
		for (const command of commands) {
			if (command.type === "scene-op" && command.sceneOperation) {
				sceneOperations.push(command.sceneOperation);
				continue;
			}
			if (command.type !== "path" || command.pageId !== pageId || !command.points) continue;
			command.points.forEach((point, pointIndex) => {
				points.push({
					...point,
					cmdId: command.id,
					pageId: command.pageId,
					userId: command.userId,
					tool: command.tool ?? "pen",
					color: command.color ?? "#000000",
					size: command.size ?? 3,
					isDeleted: command.isDeleted,
					pointIndex,
					strokePattern: command.strokePattern,
				});
			});
		}
		points.sort((left, right) => compareRenderOrder(pointOrder(left.cmdId, left, left.pointIndex ?? 0), pointOrder(right.cmdId, right, right.pointIndex ?? 0)));
		for (const point of points) this.ingestFlatPoint(point);
		this.finishAllOpenStrokes();
		for (const operation of sceneOperations.sort((left, right) => compareRenderOrder(sceneOperationOrderKey(left), sceneOperationOrderKey(right)))) {
			this.applyOperation(operation);
		}
	}

	applyOperation(operation: SceneOperationEnvelopeV2) {
		if (this.operationIds.has(operation.opId)) return [] as string[];
		this.operationIds.add(operation.opId);
		let insertAt = this.operations.length;
		while (insertAt > 0 && compareRenderOrder(sceneOperationOrderKey(operation), sceneOperationOrderKey(this.operations[insertAt - 1]!)) < 0) {
			insertAt -= 1;
		}
		this.operations.splice(insertAt, 0, operation);
		this.indexOperation(operation);
		const tail = insertAt === this.operations.length - 1;
		if (!tail) {
			if (operation.kind === "page.clear") {
				this.rebuildV2Elements();
			} else {
				this.rebuildElements(new Set(operationTargets(operation)));
			}
			return operationTargets(operation);
		}
		if (operation.kind === "history.toggle") {
			this.applyHistoryToggle(operation);
			return operationTargets(operation);
		}
		this.applyOperationIncremental(operation);
		return operationTargets(operation);
	}

	setLegacyCommandState(command: Command) {
		if (command.type === "scene-op" && command.sceneOperation) {
			this.applyOperation(command.sceneOperation);
			return;
		}
		const element = this.elements.get(command.id);
		if (!element || command.type !== "path") return;
		const wasVisible = this.isElementBaseVisible(element);
		element.deleted = command.isDeleted;
		this.legacyDeleted.set(element.id, command.isDeleted);
		const isVisible = this.isElementBaseVisible(element);
		if (wasVisible !== isVisible) this.visibleAtomCount += (isVisible ? 1 : -1) * element.atomRefs.length;
		element.descriptor = commandDescriptor(command);
		if (command.points && command.points.length !== element.points.length) {
			this.rebuildLegacyElement(command);
		}
	}

	removeElement(elementId: string) {
		const element = this.elements.get(elementId);
		if (element && !element.deleted) {
			if (this.isElementBaseVisible(element)) this.visibleAtomCount -= element.atomRefs.length;
			element.deleted = true;
		}
	}

	getElementPoints(elementId: string) {
		return this.elements.get(elementId)?.points.map((point) => ({ ...point })) ?? [];
	}

	hasHydratedPathRange(elementId: string, sourceEndExclusive: number) {
		const element = this.elements.get(elementId);
		return Boolean(
			element &&
			element.descriptor.elementKind === "path" &&
			element.points.length >= sourceEndExclusive
		);
	}

	exportFlatPoints(excludedElementIds: ReadonlySet<string> = new Set()) {
		const points: FlatPoint[] = [];
		for (const element of this.elements.values()) {
			if (element.pageId !== this.pageId || excludedElementIds.has(element.id) || element.descriptor.elementKind !== "path") continue;
			element.points.forEach((point, pointIndex) => {
				const transformed = transformPoint(element.matrix, point.x, point.y);
				points.push({
					...point,
					x: transformed.x,
					y: transformed.y,
					cmdId: element.id,
					pageId: element.pageId,
					userId: "",
					tool: element.descriptor.toolId as FlatPoint["tool"],
					color: element.descriptor.style.color,
					size: element.descriptor.style.size,
					isDeleted: element.deleted,
					pointIndex,
					strokePattern: element.descriptor.style.strokePattern,
				});
			});
		}
		points.sort((left, right) => compareRenderOrder(pointOrder(left.cmdId, left, left.pointIndex ?? 0), pointOrder(right.cmdId, right, right.pointIndex ?? 0)));
		return points;
	}

	renderFull(
		ctx: DrawingContext,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set(),
		clear = true
	) {
		if (clear) this.clearContext(ctx, logicalWidth, logicalHeight);
		let rendered = 0;
		this.order.forEach((ref) => {
			if (this.drawRef(ctx, ref, logicalWidth, logicalHeight, excludedElementIds)) rendered += 1;
		});
		return rendered;
	}

	renderAtomRefs(
		ctx: DrawingContext,
		refs: number[],
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set()
	) {
		let rendered = 0;
		for (const ref of refs) {
			if (this.drawRef(ctx, ref, logicalWidth, logicalHeight, excludedElementIds)) rendered += 1;
		}
		return rendered;
	}

	renderElements(
		ctx: DrawingContext,
		elementIds: ReadonlySet<string>,
		deltaMatrix: AffineMatrix | null,
		logicalWidth: number,
		logicalHeight: number
	) {
		let rendered = 0;
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (!atom || !element || !elementIds.has(atom.elementId) || !this.isAtomVisible(atom, element, new Set())) return;
			const matrix = deltaMatrix ? multiplyMatrices(deltaMatrix, element.matrix) : element.matrix;
			drawPrimitive(ctx, atom, matrix, logicalWidth, logicalHeight, element.erasedIntervals.get(atom.atomId));
			rendered += 1;
		});
		return rendered;
	}

	renderDirty(
		ctx: DrawingContext,
		dirtyRect: AabbBox,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set()
	): DirtyRenderMetrics {
		return this.renderDirtyRegions(ctx, [dirtyRect], logicalWidth, logicalHeight, excludedElementIds);
	}

	renderDirtyRegions(
		ctx: DrawingContext,
		dirtyRects: AabbBox[],
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set()
	): DirtyRenderMetrics {
		if (dirtyRects.length === 0) return { mode: "dirty", gridCells: 0, candidateChunks: 0, candidateAtoms: 0, renderedAtoms: 0 };
		this.dirtyRegions.clear();
		for (const dirtyRect of dirtyRects) this.dirtyRegions.add(dirtyRect);
		const regions = this.dirtyRegions.toArray().map((dirtyRect) => {
			return { dirtyRect, ...this.queryDirtyCandidates(dirtyRect, logicalWidth, logicalHeight, excludedElementIds) };
		});
		const uniqueCandidates = new Set<number>();
		for (const region of regions) for (const ref of region.candidateRefs) uniqueCandidates.add(ref);
		const gridCells = regions.reduce((sum, region) => sum + region.gridCells, 0);
		const candidateChunks = regions.reduce((sum, region) => sum + region.candidateChunks, 0);
		this.dirtyFullMode = this.dirtyRegions.shouldRenderFull(
			logicalWidth,
			logicalHeight,
			uniqueCandidates.size,
			this.visibleAtomCount,
			this.dirtyFullMode
		);
		if (this.dirtyFullMode) {
			const renderedAtoms = this.renderFull(ctx, logicalWidth, logicalHeight, excludedElementIds);
			return { mode: "full", gridCells, candidateChunks, candidateAtoms: uniqueCandidates.size, renderedAtoms };
		}

		let renderedAtoms = 0;
		for (const region of regions) {
			const dirtyRect = region.dirtyRect;
			ctx.save();
			ctx.beginPath();
			ctx.clearRect(dirtyRect.minX - DIRTY_PADDING, dirtyRect.minY - DIRTY_PADDING, dirtyRect.width + DIRTY_PADDING * 2, dirtyRect.height + DIRTY_PADDING * 2);
			ctx.rect(dirtyRect.minX - DIRTY_PADDING, dirtyRect.minY - DIRTY_PADDING, dirtyRect.width + DIRTY_PADDING * 2, dirtyRect.height + DIRTY_PADDING * 2);
			ctx.clip();
			renderedAtoms += this.renderAtomRefs(ctx, region.candidateRefs, logicalWidth, logicalHeight, excludedElementIds);
			ctx.restore();
		}
		return { mode: "dirty", gridCells, candidateChunks, candidateAtoms: uniqueCandidates.size, renderedAtoms };
	}

	queryDirtyCandidates(
		dirtyRect: AabbBox,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set()
	) {
		const normalized = this.pixelRectToNormalized(dirtyRect, logicalWidth, logicalHeight);
		const query = this.spatial.query(normalized);
		const candidateRefs = query.atomRefs.filter((ref) => {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			return Boolean(
				atom &&
				this.isAtomVisible(atom, element, excludedElementIds) &&
				intersects(transformBounds(element!.matrix, atom.bounds), normalized)
			);
		});
		candidateRefs.sort((left, right) => compareRenderOrder(this.atoms[left]!.order, this.atoms[right]!.order));
		return {
			candidateRefs,
			gridCells: query.gridCells,
			candidateChunks: query.chunkIds.length,
		};
	}

	hitTestTopmost(x: number, y: number, logicalWidth: number, logicalHeight: number) {
		const radius = 8;
		const bounds = this.pixelRectToNormalized(
			{ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius, width: radius * 2, height: radius * 2 },
			logicalWidth,
			logicalHeight
		);
		const refs = this.spatial.query(bounds).atomRefs;
		refs.sort((left, right) => compareRenderOrder(this.atoms[right]!.order, this.atoms[left]!.order));
		for (const ref of refs) {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (!atom || !this.isAtomVisible(atom, element, new Set()) || atom.toolId === "eraser") continue;
			if (this.hitAtom(atom, element!, x, y, logicalWidth, logicalHeight)) return atom.elementId;
		}
		return null;
	}

	queryElements(rect: AabbBox, logicalWidth: number, logicalHeight: number) {
		const normalized = {
			minX: rect.minX / Math.max(1, logicalWidth),
			minY: rect.minY / Math.max(1, logicalHeight),
			maxX: rect.maxX / Math.max(1, logicalWidth),
			maxY: rect.maxY / Math.max(1, logicalHeight),
			width: rect.width / Math.max(1, logicalWidth),
			height: rect.height / Math.max(1, logicalHeight),
		};
		const coarse = this.pixelRectToNormalized(rect, logicalWidth, logicalHeight);
		const ids = new Set<string>();
		for (const ref of this.spatial.query(coarse).atomRefs) {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (
				atom &&
				element &&
				this.isAtomVisible(atom, element, new Set()) &&
				intersects(transformBounds(element.matrix, atom.bounds), coarse) &&
				this.atomIntersectsBox(atom, element, normalized, logicalWidth, logicalHeight)
			) ids.add(atom.elementId);
		}
		return Array.from(ids);
	}

	computeEraseTargets(eraser: Point[], eraserSize: number, logicalWidth: number, logicalHeight: number, wholeObjects = false) {
		if (eraser.length === 0) return [] as EraseTarget[];
		const xs = eraser.map((point) => point.x * logicalWidth);
		const ys = eraser.map((point) => point.y * logicalHeight);
		const radius = eraserSize / 2;
		const rect = {
			minX: Math.min(...xs) - radius,
			minY: Math.min(...ys) - radius,
			maxX: Math.max(...xs) + radius,
			maxY: Math.max(...ys) + radius,
			width: Math.max(...xs) - Math.min(...xs) + radius * 2,
			height: Math.max(...ys) - Math.min(...ys) + radius * 2,
		};
		const normalized = this.pixelRectToNormalized(rect, logicalWidth, logicalHeight);
		const targets = new Map<string, EraseTarget>();
		for (const ref of this.spatial.query(normalized).atomRefs) {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (!atom || !element || !this.isAtomVisible(atom, element, new Set()) || atom.toolId === "eraser") continue;
			if (wholeObjects || atom.recipeId !== "stroke") {
				if (this.eraserTouchesAtom(atom, element, eraser, eraserSize, logicalWidth, logicalHeight)) {
					targets.set(element.id, { elementId: element.id, eraseWhole: true });
				}
				continue;
			}
			const intervals = cutIntervalsForStrokeAtom(
				atom,
				eraser,
				eraserSize,
				logicalWidth,
				logicalHeight,
				(x, y) => transformPoint(element.matrix, x, y),
				matrixScale(element.matrix)
			);
			if (intervals.length > 0) targets.set(atom.atomId, { elementId: element.id, atomId: atom.atomId, intervals });
		}
		return Array.from(targets.values()).sort((left, right) => left.elementId < right.elementId ? -1 : left.elementId > right.elementId ? 1 : (left.atomId ?? "") < (right.atomId ?? "") ? -1 : 1);
	}

	getElementBounds(elementId: string) {
		const element = this.elements.get(elementId);
		if (!element) return null;
		let bounds: AabbBox | null = null;
		for (const ref of element.atomRefs) {
			const atom = this.atoms[ref];
			if (atom?.elementRevision === element.revision) bounds = unionBounds(bounds, transformBounds(element.matrix, atom.bounds));
		}
		return bounds;
	}

	get atomCount() {
		return this.atoms.length;
	}

	getAtomBoundsSince(firstRef: number, elementIds?: ReadonlySet<string>) {
		let bounds: AabbBox | null = null;
		for (let ref = Math.max(0, firstRef); ref < this.atoms.length; ref += 1) {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (!atom || !element || atom.elementRevision !== element.revision) continue;
			if (elementIds && !elementIds.has(element.id)) continue;
			bounds = unionBounds(bounds, transformBounds(element.matrix, atom.bounds));
		}
		return bounds;
	}

	getHistoryImpact(historyGroupId: string) {
		const elementIds = new Set<string>();
		let pageWide = false;
		for (const operation of this.operationsByHistoryGroup.get(historyGroupId) ?? []) {
			if (operation.kind === "page.clear") pageWide = true;
			for (const elementId of operationTargets(operation)) elementIds.add(elementId);
		}
		return { elementIds: Array.from(elementIds), pageWide };
	}

	getVisibleAtomOrder() {
		const result: Array<{ atomId: string; elementId: string; order: RenderOrderKey }> = [];
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			if (atom && this.isAtomVisible(atom, this.elements.get(atom.elementId), new Set())) {
				result.push({ atomId: atom.atomId, elementId: atom.elementId, order: { ...atom.order } });
			}
		});
		return result;
	}

	getStats(): SceneStats {
		let visibleAtoms = 0;
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			if (atom && this.isAtomVisible(atom, this.elements.get(atom.elementId), new Set())) visibleAtoms += 1;
		});
		const spatial = this.spatial.stats();
		return {
			atoms: this.atoms.length,
			visibleAtoms,
			elements: this.elements.size,
			orderBlocks: this.order.blockCount,
			geometryChunks: spatial.chunks,
			gridReferences: spatial.gridReferences,
			largeChunks: spatial.largeChunks,
		};
	}

	sceneHash() {
		const rows: string[] = [];
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (!atom || !this.isAtomVisible(atom, element, new Set())) return;
			const geometry = { ...atom, ref: undefined, elementRevision: undefined };
			rows.push(`${JSON.stringify(geometry)}|${element!.matrix.join(",")}|${JSON.stringify(element!.erasedIntervals.get(atom.atomId) ?? [])}`);
		});
		let hash = 2166136261;
		for (const char of rows.join("\n")) {
			hash ^= char.charCodeAt(0);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	}

	private createElement(id: string, pageId: number, descriptor: SceneElementDescriptor, createOrder: RenderOrderKey) {
		const element: SceneElementState = {
			id,
			pageId,
			descriptor,
			createOrder,
			revision: this.revisionSeed.get(id) ?? 0,
			deleted: false,
			matrix: cloneMatrix(IDENTITY_MATRIX),
			points: [],
			atomRefs: [],
			erasedIntervals: new Map(),
			characters: new Map(),
		};
		this.elements.set(id, element);
		this.maxStrokeWidth = Math.max(this.maxStrokeWidth, descriptor.style.size);
		return element;
	}

	private appendPoint(element: SceneElementState, point: Point, sourceIndex: number, order: RenderOrderKey) {
		element.points.push(point);
		const result = compileStrokeSample({
			elementId: element.id,
			elementRevision: element.revision,
			pageId: element.pageId,
			descriptor: element.descriptor,
			point,
			order,
			sourceIndex,
			previousState: this.compilerStates.get(element.id),
		});
		this.compilerStates.set(element.id, result.state);
		return result.atoms.map((atom) => this.storeAtom(element, atom));
	}

	private storeAtom(element: SceneElementState, atom: Omit<RenderAtom, "ref">) {
		const ref = this.atoms.length;
		const stored = { ...atom, ref } as RenderAtom;
		this.atoms.push(stored);
		element.atomRefs.push(ref);
		this.order.insert(ref);
		if (!this.bulkLoading) {
			this.spatial.addAtom(element.id, ref, transformBounds(element.matrix, stored.bounds));
		}
		if (this.isElementBaseVisible(element)) this.visibleAtomCount += 1;
		return ref;
	}

	private indexOperation(operation: SceneOperationEnvelopeV2) {
		if (operation.kind !== "history.toggle") {
			const group = this.operationsByHistoryGroup.get(operation.historyGroupId) ?? [];
			this.insertOperationOrdered(group, operation);
			this.operationsByHistoryGroup.set(operation.historyGroupId, group);
		}
		for (const elementId of new Set(operationTargets(operation))) {
			const elementOperations = this.operationsByElement.get(elementId) ?? [];
			this.insertOperationOrdered(elementOperations, operation);
			this.operationsByElement.set(elementId, elementOperations);
		}
	}

	private insertOperationOrdered(target: SceneOperationEnvelopeV2[], operation: SceneOperationEnvelopeV2) {
		let index = target.length;
		while (index > 0 && compareRenderOrder(sceneOperationOrderKey(operation), sceneOperationOrderKey(target[index - 1]!)) < 0) index -= 1;
		target.splice(index, 0, operation);
	}

	private applyHistoryToggle(operation: Extract<SceneOperationEnvelopeV2, { kind: "history.toggle" }>) {
		this.historyEnabled.set(operation.payload.targetHistoryGroupId, operation.payload.enabled);
		const groupOperations = this.operationsByHistoryGroup.get(operation.payload.targetHistoryGroupId) ?? [];
		if (groupOperations.some((candidate) => candidate.kind === "page.clear")) {
			this.rebuildV2Elements();
			return;
		}
		const affected = new Set<string>();
		for (const candidate of groupOperations) for (const elementId of operationTargets(candidate)) affected.add(elementId);
		this.rebuildElements(affected);
	}

	private rebuildElements(elementIds: ReadonlySet<string>) {
		for (const elementId of elementIds) {
			const previous = this.elements.get(elementId);
			if (previous && this.isElementBaseVisible(previous)) this.visibleAtomCount -= previous.atomRefs.length;
			if (previous && this.legacyElementIds.has(elementId)) {
				previous.matrix = cloneMatrix(IDENTITY_MATRIX);
				previous.deleted = this.legacyDeleted.get(elementId) ?? false;
				previous.erasedIntervals.clear();
				if (this.isElementBaseVisible(previous)) this.visibleAtomCount += previous.atomRefs.length;
			} else {
				if (previous) this.revisionSeed.set(elementId, previous.revision + 1);
				this.elements.delete(elementId);
				this.compilerStates.delete(elementId);
			}
			for (const candidate of this.operationsByElement.get(elementId) ?? []) {
				if (candidate.kind === "history.toggle" || !this.isOperationEnabled(candidate)) continue;
				this.applyOperationToElement(candidate, elementId);
			}
		}
		let currentAtoms = 0;
		for (const element of this.elements.values()) currentAtoms += element.atomRefs.length;
		if (this.atoms.length - currentAtoms > 4096 && this.atoms.length > currentAtoms * 1.25) this.compactIndexes();
	}

	private applyOperationToElement(operation: SceneOperationEnvelopeV2, elementId: string) {
		switch (operation.kind) {
			case "element.create":
				if (operation.elementId === elementId) this.applyCreate(elementId, operation.pageId, operation.payload, sceneOperationOrderKey(operation));
				break;
			case "element.append": {
				if (operation.elementId !== elementId) break;
				const element = this.elements.get(elementId);
				if (!element) break;
				this.appendOperationPoints(element, operation);
				if (operation.payload.isComplete) this.finishElement(elementId);
				break;
			}
			case "element.transform": {
				const target = operation.payload.targets.find((candidate) => candidate.elementId === elementId);
				if (target) this.applyElementMatrix(elementId, target.deltaMatrix);
				break;
			}
			case "element.style":
				if (operation.elementId === elementId) this.applyElementStyle(elementId, operation.payload.style);
				break;
			case "element.erase": {
				for (const target of operation.payload.targets) if (target.elementId === elementId) this.applyEraseTarget(target);
				break;
			}
			case "element.delete":
				if (operation.payload.elementIds.includes(elementId)) {
					const element = this.elements.get(elementId);
					if (element && !element.deleted) {
						if (this.isElementBaseVisible(element)) this.visibleAtomCount -= element.atomRefs.length;
						element.deleted = true;
					}
				}
				break;
			case "text.patch":
				if (operation.elementId === elementId) this.applyTextPatches(operation);
				break;
			case "page.clear":
			case "history.toggle":
				break;
		}
	}

	private applyOperationIncremental(operation: SceneOperationEnvelopeV2) {
		if (!this.isOperationEnabled(operation)) return;
		switch (operation.kind) {
			case "element.create":
				this.applyCreate(operation.elementId, operation.pageId, operation.payload, sceneOperationOrderKey(operation));
				break;
			case "element.append": {
				const element = this.elements.get(operation.elementId);
				if (!element) break;
				this.appendOperationPoints(element, operation);
				if (operation.payload.isComplete) this.finishElement(operation.elementId);
				break;
			}
			case "element.transform":
				for (const target of operation.payload.targets) this.applyElementMatrix(target.elementId, target.deltaMatrix);
				break;
			case "element.style":
				this.applyElementStyle(operation.elementId, operation.payload.style);
				break;
			case "element.erase":
				for (const target of operation.payload.targets) this.applyEraseTarget(target);
				break;
			case "element.delete":
				for (const elementId of operation.payload.elementIds) {
					const element = this.elements.get(elementId);
					if (element && !element.deleted) {
						if (this.isElementBaseVisible(element)) this.visibleAtomCount -= element.atomRefs.length;
						element.deleted = true;
					}
				}
				break;
			case "text.patch":
				this.applyTextPatches(operation);
				break;
			case "history.toggle":
				this.historyEnabled.set(operation.payload.targetHistoryGroupId, operation.payload.enabled);
				break;
			case "page.clear":
				this.applyPageClear(operation.pageId, operation.payload.before);
				break;
		}
	}

	private applyCreate(elementId: string, pageId: number, payload: ElementCreatePayload, order: RenderOrderKey) {
		const hydrated = this.elements.get(elementId);
		if (
			hydrated &&
			payload.descriptor.elementKind === "path" &&
			this.legacyElementIds.has(elementId)
		) {
			this.legacyElementIds.delete(elementId);
			this.legacyDeleted.delete(elementId);
			hydrated.pageId = pageId;
			hydrated.descriptor = payload.descriptor;
			hydrated.createOrder = order;
			hydrated.deleted = false;
			this.maxStrokeWidth = Math.max(this.maxStrokeWidth, payload.descriptor.style.size);
			for (const ref of hydrated.atomRefs) {
				const atom = this.atoms[ref];
				if (!atom || atom.elementRevision !== hydrated.revision) continue;
				atom.toolId = payload.descriptor.toolId;
				atom.style = payload.descriptor.style;
			}
			return;
		}
		if (hydrated) return;
		const element = this.createElement(elementId, pageId, payload.descriptor, order);
		if (payload.descriptor.elementKind === "path") {
			payload.points?.forEach((point, sourceIndex) => this.appendPoint(element, point, sourceIndex, { ...order, lamport: point.lamport, sourceIndex }));
			if (payload.isComplete) this.finishElement(elementId);
			return;
		}
		if (payload.descriptor.elementKind === "shape") {
			this.storeShapeAtom(element, order);
			return;
		}
		if (payload.descriptor.elementKind === "sticker") {
			this.storeBitmapAtom(element, order);
			return;
		}
		if (payload.descriptor.elementKind === "text" || payload.descriptor.elementKind === "sticky") {
			splitGraphemes(payload.descriptor.text ?? "").forEach((grapheme, sourceIndex) => {
				const charId = `${elementId}:initial:${sourceIndex}`;
				element.characters.set(charId, { charId, afterId: sourceIndex === 0 ? null : `${elementId}:initial:${sourceIndex - 1}`, grapheme, deleted: false, order: { ...order, sourceIndex } });
			});
			this.rebuildTextAtoms(element);
		}
	}

	private appendOperationPoints(
		element: SceneElementState,
		operation: Extract<SceneOperationEnvelopeV2, { kind: "element.append" }>
	) {
		operation.payload.points.forEach((point, index) => {
			const sourceIndex = operation.payload.sourceStart + index;
			if (sourceIndex < element.points.length) return;
			this.appendPoint(element, point, sourceIndex, {
				...sceneOperationOrderKey(operation, sourceIndex),
				lamport: point.lamport,
			});
		});
	}

	private storeShapeAtom(element: SceneElementState, order: RenderOrderKey) {
		const box = element.descriptor.box ?? EMPTY_BOX;
		const atom: Omit<ShapeAtom, "ref"> = {
			atomId: `${element.id}:shape:0`, elementId: element.id, elementRevision: element.revision, pageId: element.pageId,
			order, recipeId: "shape", primitive: "shape", toolId: element.descriptor.toolId, style: element.descriptor.style,
			bounds: { ...box }, box: { ...box }, shapeKind: element.descriptor.shapeKind ?? "rectangle",
			shapeStart: element.descriptor.shapeStart,
			shapeEnd: element.descriptor.shapeEnd,
		};
		this.storeAtom(element, atom);
	}

	private storeBitmapAtom(element: SceneElementState, order: RenderOrderKey) {
		const box = element.descriptor.box ?? EMPTY_BOX;
		const atom: Omit<BitmapAtom, "ref"> = {
			atomId: `${element.id}:bitmap:0`, elementId: element.id, elementRevision: element.revision, pageId: element.pageId,
			order, recipeId: "bitmap", primitive: "bitmap", toolId: element.descriptor.toolId, style: element.descriptor.style,
			bounds: { ...box }, box: { ...box }, value: element.descriptor.sticker ?? "✨",
		};
		this.storeAtom(element, atom);
	}

	private applyTextPatches(operation: Extract<SceneOperationEnvelopeV2, { kind: "text.patch" }>) {
		const element = this.elements.get(operation.elementId);
		if (!element) return;
		operation.payload.patches.forEach((patch, index) => {
			if (patch.type === "insert") {
				element.characters.set(patch.charId, { charId: patch.charId, afterId: patch.afterId, grapheme: patch.grapheme, deleted: false, order: sceneOperationOrderKey(operation, index) });
			} else {
				const character = element.characters.get(patch.charId);
				if (character) character.deleted = true;
			}
		});
		this.rebuildTextAtoms(element);
	}

	private rebuildTextAtoms(element: SceneElementState) {
		if (this.isElementBaseVisible(element)) this.visibleAtomCount -= element.atomRefs.length;
		element.revision += 1;
		element.atomRefs = [];
		const box = element.descriptor.box ?? { minX: 0.1, minY: 0.1, maxX: 0.5, maxY: 0.3, width: 0.4, height: 0.2 };
		if (element.descriptor.elementKind === "sticky") {
			const fillColor = element.descriptor.style.fillColor ?? "#fff7cc";
			const background: Omit<ShapeAtom, "ref"> = {
				atomId: `${element.id}:sticky-background`, elementId: element.id, elementRevision: element.revision, pageId: element.pageId,
				order: { ...element.createOrder, subIndex: -1 }, recipeId: "shape", primitive: "shape", toolId: "sticky",
				style: { ...element.descriptor.style, color: "#e7d58a", fillColor },
				bounds: { ...box }, box: { ...box }, shapeKind: "rounded-rectangle",
			};
			this.storeAtom(element, background);
		}
		const characters = this.orderedCharacters(element.characters).filter((character) => !character.deleted);
		const fontSize = element.descriptor.style.fontSize ?? DEFAULT_FONT_SIZE;
		const advance = Math.max(0.008, fontSize / 1200);
		const lineHeight = advance * 1.5;
		const padding = advance * (element.descriptor.elementKind === "sticky" ? 0.85 : 0.4);
		const maxPerLine = Math.max(1, Math.floor((box.width - padding * 2) / advance));
		const lines: TextCharacterState[][] = [[]];
		for (const character of characters) {
			if (character.grapheme === "\n") {
				lines.push([]);
				continue;
			}
			let line = lines[lines.length - 1]!;
			if (line.length >= maxPerLine) {
				line = [];
				lines.push(line);
			}
			line.push(character);
		}
		lines.forEach((line, lineIndex) => {
			const lineWidth = line.length * advance;
			let x = box.minX + padding;
			if (element.descriptor.style.textAlign === "center") x = box.minX + (box.width - lineWidth) / 2;
			if (element.descriptor.style.textAlign === "right") x = box.maxX - padding - lineWidth;
			const y = box.minY + padding + lineIndex * lineHeight;
			for (const character of line) {
				const bounds = { minX: x, minY: y, maxX: x + advance, maxY: y + lineHeight, width: advance, height: lineHeight };
				const atom: Omit<GlyphAtom, "ref"> = {
					atomId: `${element.id}:glyph:${character.charId}`, elementId: element.id, elementRevision: element.revision, pageId: element.pageId,
					order: character.order, recipeId: "glyph", primitive: "glyph", toolId: element.descriptor.toolId, style: element.descriptor.style,
					bounds, grapheme: character.grapheme, x, y, maxWidth: advance * 1.5,
				};
				this.storeAtom(element, atom);
				x += advance;
			}
		});
		this.maybeCompactIndexes();
	}

	private orderedCharacters(characters: Map<string, TextCharacterState>) {
		const children = new Map<string | null, TextCharacterState[]>();
		for (const character of characters.values()) {
			const bucket = children.get(character.afterId) ?? [];
			bucket.push(character);
			children.set(character.afterId, bucket);
		}
		for (const bucket of children.values()) bucket.sort((left, right) => compareRenderOrder(left.order, right.order));
		const ordered: TextCharacterState[] = [];
		const stack = [...(children.get(null) ?? [])].reverse();
		while (stack.length > 0) {
			const character = stack.pop()!;
			ordered.push(character);
			const nested = children.get(character.charId) ?? [];
			for (let index = nested.length - 1; index >= 0; index -= 1) stack.push(nested[index]!);
		}
		return ordered;
	}

	private maybeCompactIndexes() {
		if (this.bulkLoading) return;
		let currentAtoms = 0;
		for (const element of this.elements.values()) currentAtoms += element.atomRefs.length;
		if (this.atoms.length - currentAtoms > 4096 && this.atoms.length > currentAtoms * 1.25) this.compactIndexes();
	}

	private applyElementMatrix(elementId: string, delta: AffineMatrix) {
		const element = this.elements.get(elementId);
		if (!element || delta.some((value) => !Number.isFinite(value))) return;
		element.matrix = multiplyMatrices(delta, element.matrix);
		this.spatial.reindexElement(elementId, (ref) => transformBounds(element.matrix, this.atoms[ref]!.bounds));
	}

	private applyElementStyle(elementId: string, style: Partial<SceneElementStyle>) {
		const element = this.elements.get(elementId);
		if (!element) return;
		element.descriptor = {
			...element.descriptor,
			style: { ...element.descriptor.style, ...style },
		};
		if (element.descriptor.elementKind === "text" || element.descriptor.elementKind === "sticky") {
			this.rebuildTextAtoms(element);
			return;
		}
		for (const ref of element.atomRefs) {
			const atom = this.atoms[ref];
			if (atom?.elementRevision === element.revision) atom.style = element.descriptor.style;
		}
	}

	private applyEraseTarget(target: EraseTarget) {
		const element = this.elements.get(target.elementId);
		if (!element) return;
		if (target.eraseWhole) {
			if (!element.deleted) {
				if (this.isElementBaseVisible(element)) this.visibleAtomCount -= element.atomRefs.length;
				element.deleted = true;
			}
			return;
		}
		if (!target.atomId || !target.intervals) return;
		const current = element.erasedIntervals.get(target.atomId) ?? [];
		element.erasedIntervals.set(target.atomId, mergeQuantizedIntervals([...current, ...target.intervals]));
	}

	private applyPageClear(pageId: number, before: RenderOrderKey) {
		const current = this.pageClearBefore.get(pageId);
		if (current && compareRenderOrder(current, before) >= 0) return;
		for (const element of this.elements.values()) {
			if (element.pageId !== pageId || element.deleted) continue;
			const wasVisible = !current || compareRenderOrder(element.createOrder, current) > 0;
			const isVisible = compareRenderOrder(element.createOrder, before) > 0;
			if (wasVisible && !isVisible) this.visibleAtomCount -= element.atomRefs.length;
		}
		this.pageClearBefore.set(pageId, before);
	}

	private rebuildV2Elements() {
		for (const [elementId] of this.elements) {
			if (!this.legacyElementIds.has(elementId)) {
				this.elements.delete(elementId);
				this.compilerStates.delete(elementId);
				continue;
			}
			const element = this.elements.get(elementId)!;
			element.matrix = cloneMatrix(IDENTITY_MATRIX);
			element.deleted = this.legacyDeleted.get(elementId) ?? false;
			element.erasedIntervals.clear();
		}
		this.historyEnabled.clear();
		this.pageClearBefore.clear();
		for (const operation of this.operations) {
			if (operation.kind === "history.toggle") this.historyEnabled.set(operation.payload.targetHistoryGroupId, operation.payload.enabled);
		}
		for (const operation of this.operations) {
			if (operation.kind !== "history.toggle") this.applyOperationIncremental(operation);
		}
		this.compactIndexes();
	}

	private rebuildLegacyElement(command: Command) {
		const previous = this.elements.get(command.id);
		if (previous) previous.revision += 1;
		this.elements.delete(command.id);
		this.compilerStates.delete(command.id);
		const points = command.points ?? [];
		if (points.length === 0) return;
		const element = this.createElement(command.id, command.pageId, commandDescriptor(command), pointOrder(command.id, points[0]!, 0));
		this.legacyElementIds.add(command.id);
		this.legacyDeleted.set(command.id, command.isDeleted);
		element.deleted = command.isDeleted;
		points.forEach((point, sourceIndex) => this.appendPoint(element, point, sourceIndex, pointOrder(command.id, point, sourceIndex)));
		this.finishElement(command.id);
	}

	private compactIndexes() {
		const activeAtoms: RenderAtom[] = [];
		for (const element of this.elements.values()) {
			const nextRefs: number[] = [];
			for (const oldRef of element.atomRefs) {
				const atom = this.atoms[oldRef];
				if (!atom || atom.elementRevision !== element.revision) continue;
				const ref = activeAtoms.length;
				activeAtoms.push({ ...atom, ref });
				nextRefs.push(ref);
			}
			element.atomRefs = nextRefs;
		}
		this.atoms.length = 0;
		this.atoms.push(...activeAtoms);
		this.order.clear();
		this.spatial.clear();
		this.visibleAtomCount = 0;
		for (const atom of this.atoms) {
			const element = this.elements.get(atom.elementId)!;
			this.order.insert(atom.ref);
			this.spatial.addAtom(atom.elementId, atom.ref, transformBounds(element.matrix, atom.bounds));
			if (this.isElementBaseVisible(element)) this.visibleAtomCount += 1;
		}
	}

	private isElementBaseVisible(element: SceneElementState) {
		if (element.pageId !== this.pageId || element.deleted) return false;
		const clearBefore = this.pageClearBefore.get(element.pageId);
		return !clearBefore || compareRenderOrder(element.createOrder, clearBefore) > 0;
	}

	private isOperationEnabled(operation: SceneOperationEnvelopeV2) {
		return this.historyEnabled.get(operation.historyGroupId) !== false;
	}

	private isAtomVisible(atom: RenderAtom, element: SceneElementState | undefined, excluded: ReadonlySet<string>) {
		if (!element || element.pageId !== this.pageId || element.deleted || excluded.has(element.id) || atom.elementRevision !== element.revision) return false;
		const clearBefore = this.pageClearBefore.get(element.pageId);
		if (clearBefore && compareRenderOrder(element.createOrder, clearBefore) <= 0) return false;
		if (
			atom.primitive === "dot" &&
			element.points.length > 1 &&
			(atom.toolId === "pencil" || atom.toolId === "highlighter")
		) return false;
		return true;
	}

	private drawRef(ctx: DrawingContext, ref: number, width: number, height: number, excluded: ReadonlySet<string>) {
		const atom = this.atoms[ref];
		const element = atom ? this.elements.get(atom.elementId) : undefined;
		if (!atom || !this.isAtomVisible(atom, element, excluded)) return false;
		drawPrimitive(ctx, atom, element!.matrix, width, height, element!.erasedIntervals.get(atom.atomId));
		return true;
	}

	private pixelRectToNormalized(rect: AabbBox, width: number, height: number) {
		const padding = DIRTY_PADDING + this.maxStrokeWidth * 2;
		const minX = Math.max(0, (rect.minX - padding) / Math.max(1, width));
		const minY = Math.max(0, (rect.minY - padding) / Math.max(1, height));
		const maxX = Math.min(1, (rect.maxX + padding) / Math.max(1, width));
		const maxY = Math.min(1, (rect.maxY + padding) / Math.max(1, height));
		return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
	}

	private eraserTouchesAtom(
		atom: RenderAtom,
		element: SceneElementState,
		eraser: Point[],
		eraserSize: number,
		width: number,
		height: number
	) {
		const radius = Math.max(0.5, eraserSize / 2);
		const pixelPoints = eraser.map((point) => ({ x: point.x * width, y: point.y * height }));
		for (let index = 0; index < pixelPoints.length; index += 1) {
			const from = pixelPoints[Math.max(0, index - 1)]!;
			const to = pixelPoints[index]!;
			const distance = Math.hypot(to.x - from.x, to.y - from.y);
			const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.6)));
			for (let step = 0; step <= steps; step += 1) {
				const ratio = step / steps;
				const x = from.x + (to.x - from.x) * ratio;
				const y = from.y + (to.y - from.y) * ratio;
				if (this.hitAtom(atom, element, x, y, width, height, radius)) return true;
			}
		}
		return false;
	}

	private hitAtom(
		atom: RenderAtom,
		element: SceneElementState,
		x: number,
		y: number,
		width: number,
		height: number,
		tolerance = 6
	) {
		const inverse = invertMatrix(element.matrix);
		if (!inverse) return false;
		const local = transformPoint(inverse, x / width, y / height);
		if (atom.primitive === "dot") {
			const erased = element.erasedIntervals.get(atom.atomId);
			if (erased?.some((interval) => interval.start <= 0 && interval.end >= 0xffff)) return false;
			return Math.hypot((local.x - atom.x) * width, (local.y - atom.y) * height) <= atom.width / 2 + tolerance;
		}
		if (atom.primitive === "quadratic") {
			let traversed = atom.dashOffset * Math.max(width, height);
			let previous = { x: atom.fromX * width, y: atom.fromY * height };
			const erased = mergeQuantizedIntervals(element.erasedIntervals.get(atom.atomId) ?? []);
			for (let step = 0; step <= 16; step += 1) {
				const t = step / 16;
				const inverseT = 1 - t;
				const qx = inverseT * inverseT * atom.fromX + 2 * inverseT * t * atom.viaX + t * t * atom.toX;
				const qy = inverseT * inverseT * atom.fromY + 2 * inverseT * t * atom.viaY + t * t * atom.toY;
				const current = { x: qx * width, y: qy * height };
				if (step > 0) traversed += Math.hypot(current.x - previous.x, current.y - previous.y);
				previous = current;
				const quantized = Math.round(t * 0xffff);
				if (erased.some((interval) => quantized >= interval.start && quantized <= interval.end)) continue;
				if (!isDashPainted(atom.style.strokePattern, atom.width, traversed)) continue;
				if (Math.hypot((local.x - qx) * width, (local.y - qy) * height) <= atom.width / 2 + tolerance) return true;
			}
			return false;
		}
		if (atom.primitive === "shape") {
			const localPixel = { x: local.x * width, y: local.y * height };
			const scale = Math.max(1e-6, matrixScale(element.matrix));
			const shapeTolerance = atom.style.size / 2 + tolerance / scale;
			if (atom.shapeKind === "line" || atom.shapeKind === "arrow") {
				const from = atom.shapeStart ?? { x: atom.box.minX, y: atom.box.minY };
				const to = atom.shapeEnd ?? { x: atom.box.maxX, y: atom.box.maxY };
				const fromPixel = { x: from.x * width, y: from.y * height };
				const toPixel = { x: to.x * width, y: to.y * height };
				if (distanceToSegment(localPixel, fromPixel, toPixel) > shapeTolerance) return false;
				const dx = toPixel.x - fromPixel.x;
				const dy = toPixel.y - fromPixel.y;
				const lengthSquared = dx * dx + dy * dy;
				const parameter = lengthSquared === 0
					? 0
					: Math.max(0, Math.min(1, ((localPixel.x - fromPixel.x) * dx + (localPixel.y - fromPixel.y) * dy) / lengthSquared));
				return isDashPainted(atom.style.strokePattern, atom.style.size, Math.sqrt(lengthSquared) * parameter);
			}
			if (atom.shapeKind === "ellipse") {
			const rx = Math.max(1e-9, atom.box.width / 2);
			const ry = Math.max(1e-9, atom.box.height / 2);
			const cx = atom.box.minX + rx;
			const cy = atom.box.minY + ry;
			const normalizedRadius = Math.sqrt(((local.x - cx) / rx) ** 2 + ((local.y - cy) / ry) ** 2);
			if (atom.style.fillColor) return normalizedRadius <= 1;
			return Math.abs(normalizedRadius - 1) * Math.min(rx * width, ry * height) <= shapeTolerance;
			}
			const inside = pointInBox(local, atom.box);
			const edgeDistance = Math.min(
				Math.abs(local.x - atom.box.minX) * width,
				Math.abs(local.x - atom.box.maxX) * width,
				Math.abs(local.y - atom.box.minY) * height,
				Math.abs(local.y - atom.box.maxY) * height
			);
			if (inside) return atom.style.fillColor ? true : edgeDistance <= shapeTolerance;
			return local.x >= atom.box.minX - shapeTolerance / width &&
				local.x <= atom.box.maxX + shapeTolerance / width &&
				local.y >= atom.box.minY - shapeTolerance / height &&
				local.y <= atom.box.maxY + shapeTolerance / height &&
				edgeDistance <= shapeTolerance;
		}
		return local.x >= atom.bounds.minX - tolerance / width &&
			local.x <= atom.bounds.maxX + tolerance / width &&
			local.y >= atom.bounds.minY - tolerance / height &&
			local.y <= atom.bounds.maxY + tolerance / height;
	}

	private atomIntersectsBox(atom: RenderAtom, element: SceneElementState, box: AabbBox, width: number, height: number) {
		const matrix = element.matrix;
		if (atom.primitive === "dot") {
			const center = transformPoint(matrix, atom.x, atom.y);
			const paddingX = (atom.width * matrixScale(matrix)) / Math.max(1, width) / 2;
			const paddingY = (atom.width * matrixScale(matrix)) / Math.max(1, height) / 2;
			return pointInBox(center, {
				minX: box.minX - paddingX, minY: box.minY - paddingY,
				maxX: box.maxX + paddingX, maxY: box.maxY + paddingY,
				width: box.width + paddingX * 2, height: box.height + paddingY * 2,
			});
		}
		if (atom.primitive === "quadratic") {
			let previous = transformPoint(matrix, atom.fromX, atom.fromY);
			for (let step = 1; step <= 20; step += 1) {
				const t = step / 20;
				const inverse = 1 - t;
				const current = transformPoint(
					matrix,
					inverse * inverse * atom.fromX + 2 * inverse * t * atom.viaX + t * t * atom.toX,
					inverse * inverse * atom.fromY + 2 * inverse * t * atom.viaY + t * t * atom.toY
				);
				if (segmentIntersectsBox(previous, current, box)) return true;
				previous = current;
			}
			return false;
		}
		if (atom.primitive === "shape" && (atom.shapeKind === "line" || atom.shapeKind === "arrow")) {
			const from = atom.shapeStart ?? { x: atom.box.minX, y: atom.box.minY };
			const to = atom.shapeEnd ?? { x: atom.box.maxX, y: atom.box.maxY };
			return segmentIntersectsBox(transformPoint(matrix, from.x, from.y), transformPoint(matrix, to.x, to.y), box);
		}
		if (atom.primitive === "shape" && atom.shapeKind === "ellipse") {
			const points = Array.from({ length: 24 }, (_, index) => {
				const angle = (index / 24) * Math.PI * 2;
				return transformPoint(
					matrix,
					atom.box.minX + atom.box.width / 2 + Math.cos(angle) * atom.box.width / 2,
					atom.box.minY + atom.box.height / 2 + Math.sin(angle) * atom.box.height / 2
				);
			});
			if (atom.style.fillColor) return polygonIntersectsBox(points, box);
			return points.some((point, index) => segmentIntersectsBox(point, points[(index + 1) % points.length]!, box));
		}
		if (atom.primitive === "shape" && !atom.style.fillColor) {
			const bounds = atom.box;
			const corners = [
				transformPoint(matrix, bounds.minX, bounds.minY),
				transformPoint(matrix, bounds.maxX, bounds.minY),
				transformPoint(matrix, bounds.maxX, bounds.maxY),
				transformPoint(matrix, bounds.minX, bounds.maxY),
			];
			return corners.some((point, index) => segmentIntersectsBox(point, corners[(index + 1) % corners.length]!, box));
		}
		const bounds = "box" in atom ? atom.box : atom.bounds;
		return polygonIntersectsBox([
			transformPoint(matrix, bounds.minX, bounds.minY),
			transformPoint(matrix, bounds.maxX, bounds.minY),
			transformPoint(matrix, bounds.maxX, bounds.maxY),
			transformPoint(matrix, bounds.minX, bounds.maxY),
		], box);
	}

	private clearContext(ctx: DrawingContext, _width: number, _height: number) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
	}
}
