// File role: draw renderer-independent scene items on a Canvas 2D context.
import type { AffineMatrix } from "@collaborative-whiteboard/shared";
import { multiplyMatrices } from "./matrix";
import { drawPrimitive } from "./primitiveRenderer";
import type { RenderIRFrame, RenderIRItem } from "./renderIR";

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function renderIRItems(ctx: DrawingContext, items: Iterable<RenderIRItem>, width: number, height: number, delta: AffineMatrix | null = null) {
	let rendered = 0;
	let layer: OffscreenCanvas | HTMLCanvasElement | null = null;
	let layerCtx: DrawingContext | null = null;
	let active: RenderIRItem | null = null;
	let highlighter = false;
	const flush = () => {
		if (!active || !layer || !layerCtx) return;
		for (const mask of active.eraseMasks) {
			const matrix = multiplyMatrices(delta ? multiplyMatrices(delta, active.matrix) : active.matrix, mask.inverseMatrix);
			layerCtx.save();
			layerCtx.globalCompositeOperation = "destination-out";
			layerCtx.transform(matrix[0], matrix[1] * height / width, matrix[2] * width / height, matrix[3], matrix[4] * width, matrix[5] * height);
			layerCtx.scale(width / mask.width, height / mask.height);
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
		if (active.eraseMasks.length > 0) ctx.shadowColor = "transparent";
		if (highlighter) { ctx.globalAlpha = active.opacity ?? 0.32; ctx.globalCompositeOperation = "multiply"; }
		ctx.drawImage(layer, 0, 0, width, height);
		ctx.restore();
		layerCtx.clearRect(0, 0, width, height);
		active = null;
	};
	for (const item of items) {
		const { atom } = item;
		const matrix = delta ? multiplyMatrices(delta, item.matrix) : item.matrix;
		if (atom.toolId !== "highlighter" && item.eraseMasks.length === 0) {
			flush();
			drawPrimitive(ctx, atom, matrix, width, height, item.erasedIntervals);
			rendered += 1;
			continue;
		}
		if (!layer) {
			layer = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height) : document.createElement("canvas");
			layer.width = ctx.canvas.width;
			layer.height = ctx.canvas.height;
			layerCtx = layer.getContext("2d") as DrawingContext | null;
			layerCtx?.scale(layer.width / width, layer.height / height);
		}
		if (!layerCtx) { drawPrimitive(ctx, atom, matrix, width, height, item.erasedIntervals); rendered += 1; continue; }
		if (active?.atom.elementId !== atom.elementId) { flush(); active = item; highlighter = atom.toolId === "highlighter"; }
		const renderedAtom = highlighter ? { ...atom, toolId: "pen" as const, style: { ...atom.style, opacity: 1 } } : atom;
		drawPrimitive(layerCtx, renderedAtom, matrix, width, height, item.erasedIntervals);
		rendered += 1;
	}
	flush();
	return rendered;
}

export function renderIRFrame(ctx: DrawingContext, frame: RenderIRFrame, width: number, height: number) {
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.restore();
	return renderIRItems(ctx, frame.items, width, height);
}
