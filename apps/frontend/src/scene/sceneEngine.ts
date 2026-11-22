// File role: Canvas adapter for the canonical scene core.
import { compareRenderOrder, type AabbBox, type AffineMatrix, type RenderOrderKey } from "@collaborative-whiteboard/shared";
import { renderIRItems, renderIRItemsSteps } from "./canvasIRRenderer";
import { SceneCore } from "./sceneCore";
import type { DirtyRenderMetrics } from "./sceneTypes";
import type { RenderIRItem } from "./renderIR";

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const DIRTY_PADDING = 20;

const canvasTextMeasurer = () => {
	let context: DrawingContext | null | undefined;
	return (text: string, font: string) => {
		if (context === undefined) {
			context = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1).getContext("2d") : typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
		}
		if (!context) return Number.parseFloat(font.match(/([\d.]+)px/)?.[1] ?? "20");
		context.font = font;
		return context.measureText(text).width;
	};
};

export class SceneEngine extends SceneCore {
	constructor() { super(canvasTextMeasurer()); }

	lastAtomOrder(): RenderOrderKey | null {
		const ref = this.order.lastRef();
		return ref === undefined ? null : { ...this.atoms[ref]!.order };
	}

	// Only paint directly when every new pen atom sorts after all old atoms.
	// Otherwise existing pixels may need to cover it or a layer may need recomposition.
	renderNewPenAtomsOnTop(ctx: DrawingContext, firstRef: number, previousOrder: RenderOrderKey | null, width: number, height: number): boolean {
		const refs: number[] = [];
		for (let ref = firstRef; ref < this.atoms.length; ref += 1) refs.push(ref);
		if (refs.length === 0) return false;
		const items = Array.from(this.renderItemsForRefs(refs, new Set()));
		if (items.length !== refs.length) return false;
		let last = previousOrder;
		for (const item of items) {
			if (item.atom.toolId !== "pen" || item.eraseMasks.length > 0 || item.erasedIntervals.length > 0 ||
				(last && compareRenderOrder(last, item.atom.order) >= 0)) return false;
			last = item.atom.order;
		}
		renderIRItems(ctx, items, width, height);
		return true;
	}

	renderFull(
		ctx: DrawingContext,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set(),
		clear = true
	) {
		if (clear) this.clearContext(ctx, logicalWidth, logicalHeight);
		const refs: number[] = [];
		this.order.forEach((ref) => refs.push(ref));
		return this.renderAtomRefs(ctx, refs, logicalWidth, logicalHeight, excludedElementIds);
	}

	*renderFullSteps(ctx: DrawingContext, logicalWidth: number, logicalHeight: number, excludedElementIds: ReadonlySet<string> = new Set()): Generator<void, number> {
		this.clearContext(ctx, logicalWidth, logicalHeight);
		return yield* renderIRItemsSteps(ctx, this.fullRenderItemsInSteps(excludedElementIds), logicalWidth, logicalHeight, null, Infinity);
	}

	private *fullRenderItemsInSteps(excludedElementIds: ReadonlySet<string>): Generator<RenderIRItem | null> {
		let refs: number[] = [];
		for (const ref of this.order.refs()) {
			refs.push(ref);
			if (refs.length < 256) continue;
			yield* this.renderItemsForRefs(refs, excludedElementIds);
			refs = [];
			yield null;
		}
		yield* this.renderItemsForRefs(refs, excludedElementIds);
	}

	renderAtomRefs(
		ctx: DrawingContext,
		refs: number[],
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set(),
		deltaMatrix: AffineMatrix | null = null
	) {
		return renderIRItems(ctx, this.renderItemsForRefs(refs, excludedElementIds), logicalWidth, logicalHeight, deltaMatrix);
	}

	renderElements(
		ctx: DrawingContext,
		elementIds: ReadonlySet<string>,
		deltaMatrix: AffineMatrix | null,
		logicalWidth: number,
		logicalHeight: number
	) {
		const refs: number[] = [];
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			if (atom && elementIds.has(atom.elementId)) refs.push(ref);
		});
		return this.renderAtomRefs(ctx, refs, logicalWidth, logicalHeight, new Set(), deltaMatrix);
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
		for (const dirtyRect of dirtyRects) {
			const padding = this.maxStrokeWidth * 2;
			this.dirtyRegions.add({
				minX: dirtyRect.minX - padding, minY: dirtyRect.minY - padding,
				maxX: dirtyRect.maxX + padding, maxY: dirtyRect.maxY + padding,
				width: dirtyRect.width + padding * 2, height: dirtyRect.height + padding * 2,
			});
		}
		const regions = this.dirtyRegions.toArray().map((dirtyRect) => {
			// Clear, clip and candidate lookup must cover the same pixel-aligned area.
			// Otherwise a narrow redraw can erase parts of neighbouring strokes.
			const scaleX = ctx.canvas.width / logicalWidth;
			const scaleY = ctx.canvas.height / logicalHeight;
			const minX = Math.floor((dirtyRect.minX - DIRTY_PADDING) * scaleX) / scaleX;
			const minY = Math.floor((dirtyRect.minY - DIRTY_PADDING) * scaleY) / scaleY;
			const maxX = Math.ceil((dirtyRect.maxX + DIRTY_PADDING) * scaleX) / scaleX;
			const maxY = Math.ceil((dirtyRect.maxY + DIRTY_PADDING) * scaleY) / scaleY;
			const paintRect = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
			return { dirtyRect: paintRect, ...this.queryDirtyCandidates(paintRect, logicalWidth, logicalHeight, excludedElementIds, false) };
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
			region.candidateRefs.sort((left, right) => compareRenderOrder(this.atoms[left]!.order, this.atoms[right]!.order));
			ctx.save();
			ctx.beginPath();
			ctx.clearRect(dirtyRect.minX, dirtyRect.minY, dirtyRect.width, dirtyRect.height);
			ctx.rect(dirtyRect.minX, dirtyRect.minY, dirtyRect.width, dirtyRect.height);
			ctx.clip();
			renderedAtoms += this.renderAtomRefs(ctx, region.candidateRefs, logicalWidth, logicalHeight, excludedElementIds);
			ctx.restore();
		}
		return { mode: "dirty", gridCells, candidateChunks, candidateAtoms: uniqueCandidates.size, renderedAtoms };
	}

	private clearContext(ctx: DrawingContext, _width: number, _height: number) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
	}
}
