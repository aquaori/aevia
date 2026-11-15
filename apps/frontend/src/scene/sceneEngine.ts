// File role: Canvas adapter for the canonical scene core.
import type { AabbBox, AffineMatrix } from "@collaborative-whiteboard/shared";
import { renderIRItems } from "./canvasIRRenderer";
import { SceneCore } from "./sceneCore";
import type { DirtyRenderMetrics } from "./sceneTypes";

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

	private clearContext(ctx: DrawingContext, _width: number, _height: number) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
	}
}
