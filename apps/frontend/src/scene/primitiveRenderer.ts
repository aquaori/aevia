// File role: the single Canvas2D executor for all built-in primitive recipes.
import type { AffineMatrix, QuantizedInterval, StrokePattern } from "@collaborative-whiteboard/shared";
import { ERASE_PARAMETER_MAX, mergeQuantizedIntervals } from "./eraseGeometry";
import { matrixScale, transformPoint } from "./matrix";
import type { QuadraticAtom, RenderAtom } from "./sceneTypes";

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const dashFor = (pattern: StrokePattern | undefined, width: number) => {
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

const styleContext = (ctx: DrawingContext, atom: RenderAtom, matrix: AffineMatrix) => {
	ctx.globalCompositeOperation =
		atom.toolId === "eraser"
			? "destination-out"
			: atom.toolId === "highlighter"
				? "multiply"
				: "source-over";
	ctx.globalAlpha =
		atom.style.opacity ??
		(atom.toolId === "highlighter" ? 0.32 : atom.toolId === "pencil" ? 0.78 : 1);
	ctx.strokeStyle = atom.style.color;
	ctx.fillStyle = atom.style.fillColor ?? atom.style.color;
	ctx.lineCap = atom.toolId === "pencil" || atom.toolId === "highlighter" ? "butt" : "round";
	ctx.lineJoin = "round";
	ctx.lineWidth = ("width" in atom ? atom.width : atom.style.size) * matrixScale(matrix);
	ctx.setLineDash(dashFor(atom.style.strokePattern, ctx.lineWidth));
};

const splitQuadratic = (atom: QuadraticAtom, start: number, end: number) => {
	const point = (t: number) => {
		const inverse = 1 - t;
		return {
			x: inverse * inverse * atom.fromX + 2 * inverse * t * atom.viaX + t * t * atom.toX,
			y: inverse * inverse * atom.fromY + 2 * inverse * t * atom.viaY + t * t * atom.toY,
		};
	};
	const derivative = (t: number) => ({
		x: 2 * (1 - t) * (atom.viaX - atom.fromX) + 2 * t * (atom.toX - atom.viaX),
		y: 2 * (1 - t) * (atom.viaY - atom.fromY) + 2 * t * (atom.toY - atom.viaY),
	});
	const from = point(start);
	const to = point(end);
	const tangent = derivative(start);
	const control = {
		x: from.x + (tangent.x * (end - start)) / 2,
		y: from.y + (tangent.y * (end - start)) / 2,
	};
	return { from, control, to };
};

const visibleIntervals = (erased: QuantizedInterval[] | undefined) => {
	if (!erased || erased.length === 0) return [{ start: 0, end: 1 }];
	const merged = mergeQuantizedIntervals(erased);
	const visible: Array<{ start: number; end: number }> = [];
	let cursor = 0;
	for (const interval of merged) {
		const start = interval.start / ERASE_PARAMETER_MAX;
		const end = interval.end / ERASE_PARAMETER_MAX;
		if (start > cursor) visible.push({ start: cursor, end: start });
		cursor = Math.max(cursor, end);
	}
	if (cursor < 1) visible.push({ start: cursor, end: 1 });
	return visible.filter((interval) => interval.end - interval.start > 1 / ERASE_PARAMETER_MAX);
};

const drawQuadratic = (
	ctx: DrawingContext,
	atom: QuadraticAtom,
	matrix: AffineMatrix,
	width: number,
	offset: number,
	erased?: QuantizedInterval[]
) => {
	ctx.lineWidth = width;
	const previousLineCap = ctx.lineCap;
	if (erased && erased.length > 0) ctx.lineCap = "butt";
	for (const interval of visibleIntervals(erased)) {
		const curve = splitQuadratic(atom, interval.start, interval.end);
		const from = transformPoint(matrix, curve.from.x, curve.from.y);
		const control = transformPoint(matrix, curve.control.x, curve.control.y);
		const to = transformPoint(matrix, curve.to.x, curve.to.y);
		if (offset !== 0) {
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const length = Math.max(1e-9, Math.hypot(dx, dy));
			const ox = (-dy / length) * offset;
			const oy = (dx / length) * offset;
			from.x += ox;
			from.y += oy;
			control.x += ox;
			control.y += oy;
			to.x += ox;
			to.y += oy;
		}
		ctx.beginPath();
		ctx.moveTo(from.x, from.y);
		ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
		ctx.stroke();
	}
	ctx.lineCap = previousLineCap;
};

export const drawPrimitive = (
	ctx: DrawingContext,
	atom: RenderAtom,
	matrix: AffineMatrix,
	logicalWidth: number,
	logicalHeight: number,
	erased?: QuantizedInterval[]
) => {
	ctx.save();
	styleContext(ctx, atom, matrix);
	const pixelMatrix: AffineMatrix = [
		matrix[0],
		(matrix[1] * logicalHeight) / logicalWidth,
		(matrix[2] * logicalWidth) / logicalHeight,
		matrix[3],
		matrix[4] * logicalWidth,
		matrix[5] * logicalHeight,
	];

	if (atom.primitive === "dot") {
		if (erased?.some((interval) => interval.start === 0 && interval.end === ERASE_PARAMETER_MAX)) {
			ctx.restore();
			return;
		}
		const point = transformPoint(matrix, atom.x, atom.y);
		const radius = (atom.width * matrixScale(matrix)) / 2;
		ctx.beginPath();
		ctx.arc(point.x * logicalWidth, point.y * logicalHeight, radius, 0, Math.PI * 2);
		ctx.fill();
	} else if (atom.primitive === "quadratic") {
		const pixelAtom: QuadraticAtom = {
			...atom,
			fromX: atom.fromX * logicalWidth,
			fromY: atom.fromY * logicalHeight,
			viaX: atom.viaX * logicalWidth,
			viaY: atom.viaY * logicalHeight,
			toX: atom.toX * logicalWidth,
			toY: atom.toY * logicalHeight,
		};
		ctx.lineDashOffset = -atom.dashOffset * Math.max(logicalWidth, logicalHeight);
		if (atom.style.strokePattern === "double") {
			const lineWidth = Math.max(0.5, (atom.width * matrixScale(matrix)) / 3);
			const offset = atom.width * matrixScale(matrix) * 0.35;
			drawQuadratic(ctx, pixelAtom, pixelMatrix, lineWidth, offset, erased);
			drawQuadratic(ctx, pixelAtom, pixelMatrix, lineWidth, -offset, erased);
		} else {
			drawQuadratic(ctx, pixelAtom, pixelMatrix, atom.width * matrixScale(matrix), 0, erased);
		}
	} else if (atom.primitive === "shape") {
		if (atom.toolId === "sticky") {
			ctx.shadowColor = "rgba(71, 59, 30, 0.18)";
			ctx.shadowBlur = 14;
			ctx.shadowOffsetX = 0;
			ctx.shadowOffsetY = 7;
		}
		const box = atom.box;
		const corners = [
			transformPoint(matrix, box.minX, box.minY),
			transformPoint(matrix, box.maxX, box.minY),
			transformPoint(matrix, box.maxX, box.maxY),
			transformPoint(matrix, box.minX, box.maxY),
		].map((point) => ({ x: point.x * logicalWidth, y: point.y * logicalHeight }));
		ctx.beginPath();
		if (atom.shapeKind === "ellipse") {
			const center = transformPoint(matrix, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
			ctx.ellipse(
				center.x * logicalWidth,
				center.y * logicalHeight,
				(box.width * logicalWidth * matrixScale(matrix)) / 2,
				(box.height * logicalHeight * matrixScale(matrix)) / 2,
				Math.atan2(matrix[1], matrix[0]),
				0,
				Math.PI * 2
			);
		} else if (atom.shapeKind === "line" || atom.shapeKind === "arrow") {
			const startPoint = atom.shapeStart ? transformPoint(matrix, atom.shapeStart.x, atom.shapeStart.y) : null;
			const endPoint = atom.shapeEnd ? transformPoint(matrix, atom.shapeEnd.x, atom.shapeEnd.y) : null;
			const start = startPoint ? { x: startPoint.x * logicalWidth, y: startPoint.y * logicalHeight } : corners[0]!;
			const end = endPoint ? { x: endPoint.x * logicalWidth, y: endPoint.y * logicalHeight } : corners[2]!;
			ctx.moveTo(start.x, start.y);
			ctx.lineTo(end.x, end.y);
			if (atom.shapeKind === "arrow") {
				const angle = Math.atan2(end.y - start.y, end.x - start.x);
				const head = Math.max(8, atom.style.size * 3);
				ctx.moveTo(end.x, end.y);
				ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
				ctx.moveTo(end.x, end.y);
				ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
			}
		} else if (atom.shapeKind === "rounded-rectangle") {
			const radius = Math.min(box.width, box.height) * 0.12;
			const pixel = (x: number, y: number) => {
				const point = transformPoint(matrix, x, y);
				return { x: point.x * logicalWidth, y: point.y * logicalHeight };
			};
			const start = pixel(box.minX + radius, box.minY);
			ctx.moveTo(start.x, start.y);
			const topRightStart = pixel(box.maxX - radius, box.minY);
			const topRightCorner = pixel(box.maxX, box.minY);
			const topRightEnd = pixel(box.maxX, box.minY + radius);
			ctx.lineTo(topRightStart.x, topRightStart.y);
			ctx.quadraticCurveTo(topRightCorner.x, topRightCorner.y, topRightEnd.x, topRightEnd.y);
			const bottomRightStart = pixel(box.maxX, box.maxY - radius);
			const bottomRightCorner = pixel(box.maxX, box.maxY);
			const bottomRightEnd = pixel(box.maxX - radius, box.maxY);
			ctx.lineTo(bottomRightStart.x, bottomRightStart.y);
			ctx.quadraticCurveTo(bottomRightCorner.x, bottomRightCorner.y, bottomRightEnd.x, bottomRightEnd.y);
			const bottomLeftStart = pixel(box.minX + radius, box.maxY);
			const bottomLeftCorner = pixel(box.minX, box.maxY);
			const bottomLeftEnd = pixel(box.minX, box.maxY - radius);
			ctx.lineTo(bottomLeftStart.x, bottomLeftStart.y);
			ctx.quadraticCurveTo(bottomLeftCorner.x, bottomLeftCorner.y, bottomLeftEnd.x, bottomLeftEnd.y);
			const topLeftStart = pixel(box.minX, box.minY + radius);
			const topLeftCorner = pixel(box.minX, box.minY);
			ctx.lineTo(topLeftStart.x, topLeftStart.y);
			ctx.quadraticCurveTo(topLeftCorner.x, topLeftCorner.y, start.x, start.y);
			ctx.closePath();
		} else {
			ctx.moveTo(corners[0]!.x, corners[0]!.y);
			for (let index = 1; index < corners.length; index += 1) ctx.lineTo(corners[index]!.x, corners[index]!.y);
			ctx.closePath();
		}
		if (atom.style.fillColor) ctx.fill();
		ctx.stroke();
	} else if (atom.primitive === "glyph") {
		const point = transformPoint(matrix, atom.x, atom.y);
		ctx.fillStyle = atom.style.color;
		ctx.font = `${atom.style.fontWeight ?? 400} ${(atom.style.fontSize ?? 20) * matrixScale(matrix)}px ${atom.style.fontFamily ?? "Aevia Sans, Inter, sans-serif"}`;
		ctx.textAlign = atom.style.textAlign ?? "left";
		ctx.textBaseline = "top";
		ctx.fillText(atom.grapheme, point.x * logicalWidth, point.y * logicalHeight, atom.maxWidth * logicalWidth);
	} else if (atom.primitive === "bitmap") {
		const center = transformPoint(matrix, atom.box.minX + atom.box.width / 2, atom.box.minY + atom.box.height / 2);
		ctx.font = `${Math.max(12, atom.box.height * logicalHeight * matrixScale(matrix))}px Aevia Sans, Inter, sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(atom.value, center.x * logicalWidth, center.y * logicalHeight);
	}
	ctx.restore();
};
