// File role: utility helpers for dirty-rect based redraw calculations.
import type { FlatPoint } from "./type";
import { useCommandStore } from "../store/commandStore";
import { renderPageContentFromPoints } from "../service/canvas";

/**
 * 局部区域重绘函数
 * @param dirtyRect 脏矩形区域(像素单位)
 * @param ctx 离屏或主画布上下文
 * @param canvasRef 画布 DOM 引用
 * @param transformingCmdIds 可选参数：正在执行变换的命令ID 集合
 *                            如果传入此项，重绘底层时会跳过这个ID，实现“抠图”效果
 */
const reRenderDirtyRect = (
	dirtyRect: any,
	ctx: CanvasRenderingContext2D,
	canvasRef: HTMLCanvasElement,
	transformingCmdIds?: Set<string>
) => {
	if (!ctx || !canvasRef || !dirtyRect || typeof dirtyRect.minX === "undefined") {
		return;
	}
	const dpr = window.devicePixelRatio || 1;
	const canvasW = canvasRef.width / dpr;
	const canvasH = canvasRef.height / dpr;

	// dirtyRect 是像素坐标，clip 也用像素坐标
	const { minX, minY, width, height } = dirtyRect;

	// clip 区域padding 防止 anti-aliasing (抗锯齿 导致的边缘残留，并兼容粗笔触
	const padding = 20;
	ctx.save();
	ctx.beginPath();
	// 擦除已有区域，准备重绘
	ctx.clearRect(minX - padding, minY - padding, width + padding * 2, height + padding * 2);
	ctx.rect(minX - padding, minY - padding, width + padding * 2, height + padding * 2);
	ctx.clip();

	// 算法改进：不再直接根据点位坐标过滤点，而是先找出所有与脏矩形相交的“命令
	// 然后重绘这些命令的所有点位。由于配置了 ctx.clip()，超出区域的部分会自动截断，
	// 但线段本身会因为拥有完整的点位序列而保持连续
	const points = useCommandStore().lastSortedPoints;
	const intersectingCmdIds = new Set<string>();

	points.forEach((pt: FlatPoint) => {
		const x = pt.x * canvasW;
		const y = pt.y * canvasH;
		// 如果点在脏矩形内，记录其所属的命令ID
		if (
			x >= minX - padding &&
			x <= minX + width + padding &&
			y >= minY - padding &&
			y <= minY + height + padding
		) {
			intersectingCmdIds.add(pt.cmdId);
		}
	});

	const filteredPoints = points.filter((pt: FlatPoint) => {
		// 1. 过滤已删除的点位
		if (pt.isDeleted) return false;

		// 2. 交互隔离：跳过正在变换的图形
		if (transformingCmdIds && transformingCmdIds.has(pt.cmdId)) return false;

		// 3. 包含性重绘：只要该命令与脏矩形相交，就保留其所有点
		return intersectingCmdIds.has(pt.cmdId);
	});
	// 执行重绘
	renderPageContentFromPoints(ctx, canvasW, canvasH, filteredPoints, true);
	ctx.restore();
};

export { reRenderDirtyRect };

