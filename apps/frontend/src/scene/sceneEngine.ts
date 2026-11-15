// File role: Canvas adapter for the canonical scene core.
import type { AabbBox, AffineMatrix } from "@collaborative-whiteboard/shared";
import { multiplyMatrices } from "./matrix";
import { drawPrimitive } from "./primitiveRenderer";
import { SceneCore } from "./sceneCore";
import type { DirtyRenderMetrics, SceneElementState } from "./sceneTypes";

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
		let rendered = 0;
		let layer: OffscreenCanvas | HTMLCanvasElement | null = null;
		let layerCtx: DrawingContext | null = null;
		let activeElement: SceneElementState | null = null;
		let highlighter = false;
		const flush = () => {
			if (!activeElement || !layer || !layerCtx) return;
			for (const mask of activeElement.eraseMasks) {
				const elementMatrix = deltaMatrix ? multiplyMatrices(deltaMatrix, activeElement.matrix) : activeElement.matrix;
				const matrix = multiplyMatrices(elementMatrix, mask.inverseMatrix);
				layerCtx.save();
				layerCtx.globalCompositeOperation = "destination-out";
				layerCtx.transform(matrix[0], matrix[1] * logicalHeight / logicalWidth, matrix[2] * logicalWidth / logicalHeight, matrix[3], matrix[4] * logicalWidth, matrix[5] * logicalHeight);
				layerCtx.scale(logicalWidth / mask.width, logicalHeight / mask.height);
				layerCtx.lineWidth = mask.size;
				layerCtx.lineCap = "round";
				layerCtx.lineJoin = "round";
				layerCtx.beginPath();
				const first = mask.points[0];
				if (!first) { layerCtx.restore(); continue; }
				layerCtx.moveTo(first.x * mask.width, first.y * mask.height);
				for (const point of mask.points) layerCtx.lineTo(point.x * mask.width, point.y * mask.height);
				layerCtx.stroke();
				layerCtx.restore();
			}
			ctx.save();
			// A drop shadow behind the composited stroke can fill small erased holes
			// while the selection is being dragged.
			if (activeElement.eraseMasks.length > 0) ctx.shadowColor = "transparent";
			if (highlighter) { ctx.globalAlpha = activeElement.descriptor.style.opacity ?? 0.32; ctx.globalCompositeOperation = "multiply"; }
			ctx.drawImage(layer, 0, 0, logicalWidth, logicalHeight);
			ctx.restore();
			layerCtx.clearRect(0, 0, logicalWidth, logicalHeight);
			activeElement = null;
		};
		for (const ref of refs) {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (!atom || !element || !this.isAtomVisible(atom, element, excludedElementIds)) continue;
			if (atom.toolId !== "highlighter" && element.eraseMasks.length === 0) {
				flush();
				if (deltaMatrix) {
					drawPrimitive(ctx, atom, multiplyMatrices(deltaMatrix, element.matrix), logicalWidth, logicalHeight, element.erasedIntervals.get(atom.atomId));
					rendered += 1;
				} else if (this.drawRef(ctx, ref, logicalWidth, logicalHeight, excludedElementIds)) rendered += 1;
				continue;
			}
			if (!layer) {
				layer = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height) : document.createElement("canvas");
				layer.width = ctx.canvas.width;
				layer.height = ctx.canvas.height;
				layerCtx = layer.getContext("2d") as DrawingContext | null;
				layerCtx?.scale(layer.width / logicalWidth, layer.height / logicalHeight);
			}
			if (!layerCtx) { if (this.drawRef(ctx, ref, logicalWidth, logicalHeight, excludedElementIds)) rendered += 1; continue; }
			if (activeElement?.id !== element.id) { flush(); activeElement = element; highlighter = atom.toolId === "highlighter"; }
			const renderedAtom = highlighter ? { ...atom, toolId: "pen" as const, style: { ...atom.style, opacity: 1 } } : atom;
			drawPrimitive(layerCtx, renderedAtom, deltaMatrix ? multiplyMatrices(deltaMatrix, element.matrix) : element.matrix, logicalWidth, logicalHeight, element.erasedIntervals.get(atom.atomId));
			rendered += 1;
		}
		flush();
		return rendered;
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

	private drawRef(ctx: DrawingContext, ref: number, width: number, height: number, excluded: ReadonlySet<string>) {
		const atom = this.atoms[ref];
		const element = atom ? this.elements.get(atom.elementId) : undefined;
		if (!atom || !this.isAtomVisible(atom, element, excluded)) return false;
		drawPrimitive(ctx, atom, element!.matrix, width, height, element!.erasedIntervals.get(atom.atomId));
		return true;
	}

	private clearContext(ctx: DrawingContext, _width: number, _height: number) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
	}
}
