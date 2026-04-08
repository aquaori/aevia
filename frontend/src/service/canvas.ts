// File role: shared canvas refs plus low-level drawing helpers used by render paths.
import { ref } from "vue";
import type { FlatPoint } from "../utils/type";
import type { Command, Point } from "../utils/type";
import { useLamportStore } from "../store/lamportStore";
import type { LastWidthInfo } from "../utils/type";

// Canvas DOM元素引用
const canvasRef = ref<HTMLCanvasElement | null>(null);
const uiCanvasRef = ref<HTMLCanvasElement | null>(null); // UICanvas

// Canvas 2D 渲染上下文
const ctx = ref<CanvasRenderingContext2D | null>(null);
const uiCtx = ref<CanvasRenderingContext2D | null>(null); // UIContext

// 记录所有没画完的点的上一点的lastWidth信息
const lastWidths: Record<string, LastWidthInfo> = {};

const renderIncrementPoint = (
	cmd: Command,
	points: Point[],
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	skipQueue: boolean = false
) => {
	if (cmd.type !== "path" || !points || points.length === 0) {
		return;
	}
	const color = cmd.tool === "eraser" ? "#ffffff" : cmd.color || "#000000";
	const op = cmd.tool === "eraser" ? "destination-out" : "source-over";
	const baseSize = cmd.size || 3;

	ctx.globalCompositeOperation = op;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;

	const startIndex = (cmd.points?.length || 0) - points.length;

	// 起始点context
	let lastX: number, lastY: number, lastWidth: number;

	if (startIndex > 0) {
		const prevPoint = cmd.points![startIndex - 1];
		if (prevPoint === undefined) return;
		lastX = prevPoint.x * width;
		lastY = prevPoint.y * height;
		if (cmd.id && lastWidths[cmd.id]?.lastWidth !== undefined) {
			lastWidth = lastWidths[cmd.id]!.lastWidth;
		} else {
			lastWidth = baseSize * (prevPoint.p * 2);
			if (cmd.tool === "eraser") lastWidth = baseSize;
		}
	} else {
		// startIndex === 0，表示从第一个点开始
		const p0 = points[0];
		if (!p0) return;
		lastX = p0.x * width;
		lastY = p0.y * height;
		lastWidth = baseSize * (p0.p * 2);
		if (cmd.tool === "eraser") lastWidth = baseSize;
	}

	// 移除未使用的 dpr 声明

	// 渲染新增的点
	for (let i = 0; i < points.length; i++) {
		// 如果是该命令的起点，且没有其它点与之相连，我们可以先画一个圆点作为落点
		if (startIndex === 0 && i === 0) {
			const pt = points[i];
			if (!pt) continue;
			const x = pt.x * width;
			const y = pt.y * height;
			let w = baseSize * (pt.p * 2);
			if (cmd.tool === "eraser") w = baseSize;

			ctx.beginPath();
			ctx.arc(x, y, w / 2, 0, Math.PI * 2);
			ctx.fill();
			continue;
		}

		const pt = points[i];
		if (!pt) continue;
		const x = pt.x * width;
		const y = pt.y * height;

		const dist = Math.hypot(x - lastX, y - lastY);
		const velocityFactor = Math.max(0.4, 1 - dist / 120);
		let targetWidth = baseSize;

		if (cmd.tool === "pen") {
			targetWidth = baseSize * (pt.p * 2) * velocityFactor;
			if (width < 500) {
				targetWidth *= Math.max(0.2, width / 1000);
			}
		} else {
			targetWidth = baseSize;
		}

		const clamp = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);
		const newWidth = clamp(lastWidth * 0.7 + targetWidth * 0.3, 1, baseSize + 2);

		if (cmd.tool === "eraser") {
			// 压入队列（脏区域重绘时跳过，避免 render→queue→collision→render 死循环）
			if (!skipQueue) {
				useLamportStore().pushToQueue({
					x: x,
					y: y,
					p: pt.p,
					lamport: pt.lamport,
					lastX: lastX,
					lastY: lastY,
					cmdId: cmd.id,
					userId: cmd.userId,
					tool: cmd.tool,
					color: cmd.color || "",
					size: baseSize || 0,
					isDeleted: cmd.isDeleted,
					lastWidth: lastWidth,
				});
			}
			ctx.beginPath();
			ctx.moveTo(lastX, lastY);
			ctx.lineTo(x, y);
			ctx.lineWidth = baseSize;
			ctx.stroke();
		} else {
			const midX = (lastX + x) / 2;
			const midY = (lastY + y) / 2;

			// 压入队列（脏区域重绘时跳过，避免死循环）
			if (!skipQueue) {
				useLamportStore().pushToQueue({
					x: x,
					y: y,
					p: pt.p,
					lamport: pt.lamport,
					lastX: lastX,
					lastY: lastY,
					cmdId: cmd.id,
					userId: cmd.userId,
					tool: cmd.tool ?? "pen",
					color: cmd.color || "",
					size: newWidth || 0,
					isDeleted: cmd.isDeleted,
					lastWidth: lastWidth,
				});
			}
			ctx.beginPath();
			ctx.moveTo(lastX, lastY);
			ctx.quadraticCurveTo(midX, midY, x, y);
			ctx.lineWidth = newWidth;
			ctx.stroke();
		}

		lastX = x;
		lastY = y;
		lastWidth = newWidth;

		if (cmd?.id) {
			lastWidths[cmd.id] = { lastWidth: newWidth };
		}
	}

};

const renderPageContentFromPoints = (
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	points: FlatPoint[],
	isDirtyRender: boolean = false,
	startTime?: number
) => {
	const _renderStart = startTime || performance.now();
	if (!points) return;

	// 记录每个命令的最后状态，用于绘制线段
	const lastPointsMap: Record<string, { x: number; y: number; width: number }> = {};

	points.forEach((pt) => {
		if (pt.isDeleted) return;

		const color = pt.tool === "eraser" ? "#ffffff" : pt.color || "#000000";
		const op = pt.tool === "eraser" ? "destination-out" : "source-over";
		const baseSize = pt.size || 3;

		ctx.globalCompositeOperation = op;
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		const x = pt.x * width;
		const y = pt.y * height;
		const prev = lastPointsMap[pt.cmdId];

		if (!prev) {
			// 起始点逻辑：计算初始宽度并绘制圆点
			const initialWidth = pt.tool === "eraser" ? baseSize : baseSize * (pt.p * 2);
			ctx.beginPath();
			ctx.arc(x, y, initialWidth / 2, 0, Math.PI * 2);
			ctx.fill();
			lastPointsMap[pt.cmdId] = { x, y, width: initialWidth };
		} else {
			// 后续点逻辑：恢复速度感应和宽度平滑系数
			const dist = Math.hypot(x - prev.x, y - prev.y);
			const velocityFactor = Math.max(0.4, 1 - dist / 120);
			let targetWidth = baseSize;

			if (pt.tool === "pen") {
				targetWidth = baseSize * (pt.p * 2) * velocityFactor;
				// 移动端小屏幕适配
				if (width < 500) {
					targetWidth *= Math.max(0.2, width / 1000);
				}
			}

			// 关键：宽度平滑算法
			const clamp = (num: number, min: number, max: number) =>
				Math.min(Math.max(num, min), max);
			const newWidth = clamp(prev.width * 0.7 + targetWidth * 0.3, 1, baseSize + 2);

			const midX = (prev.x + x) / 2;
			const midY = (prev.y + y) / 2;

			ctx.beginPath();
			ctx.moveTo(prev.x, prev.y);
			ctx.quadraticCurveTo(midX, midY, x, y);
			ctx.lineWidth = newWidth;
			ctx.stroke();

			lastPointsMap[pt.cmdId] = { x, y, width: newWidth };
		}
	});

	const _renderEnd = performance.now();
	const logPrefix = isDirtyRender ? "[局部重绘完成]" : "[全量渲染完成]";
	console.log(
		`${logPrefix} 点数=${points.length} 耗时=${(_renderEnd - _renderStart).toFixed(2)}ms`
	);
};

const renderWithPoints = (sortedPoints: FlatPoint[]) => {
	if (!canvasRef.value || !ctx.value) return;
	const _renderStart = performance.now();

	const dpr = window.devicePixelRatio || 1;
	const physicalWidth = canvasRef.value.width;
	const physicalHeight = canvasRef.value.height;
	const logicalWidth = physicalWidth / dpr;
	const logicalHeight = physicalHeight / dpr;

	ctx.value.save();
	ctx.value.setTransform(1, 0, 0, 1, 0, 0);
	ctx.value.clearRect(0, 0, physicalWidth, physicalHeight);
	ctx.value.restore();

	renderPageContentFromPoints(
		ctx.value,
		logicalWidth,
		logicalHeight,
		sortedPoints,
		false,
		_renderStart
	);
};

export {
	canvasRef,
	uiCanvasRef,
	ctx,
	uiCtx,
	lastWidths,
	renderPageContentFromPoints,
	renderWithPoints,
	renderIncrementPoint,
};

