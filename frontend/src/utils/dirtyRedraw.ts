import type { FlatPoint } from "./type";
import { useCommandStore } from "../store/commandStore";
import { renderPageContentFromPoints } from "../service/canvas";
import { useWorkerStore } from "../store/workerStore";

let dirtyPointBuffer: any[] = [];
let dirtyBufferTimer: number | null = null;

/**
 * 局部区域重绘函数
 * @param dirtyRect 脏矩形区域 (像素单位)
 * @param ctx 离屏或主画布上下文
 * @param canvasRef 画布 DOM 引用
 * @param transformingCmdIds 可选参数：正在执行变换的命令 ID 集合。
 *                            如果传入此项，重绘底层时会跳过这些 ID，实现“抠图”效果。
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

	// clip 区域加 padding 防止 anti-aliasing (抗锯齿) 导致的边缘残留，并兼容粗笔触
	const padding = 20;
	ctx.save();
	ctx.beginPath();
	// 擦除已有区域，准备重填
	ctx.clearRect(minX - padding, minY - padding, width + padding * 2, height + padding * 2);
	ctx.rect(minX - padding, minY - padding, width + padding * 2, height + padding * 2);
	ctx.clip();

	// 算法改进：不再直接根据点位坐标过滤点，而是先找出所有与脏矩形相交的“命令”
	// 然后重绘这些命令的所有点位。由于配置了 ctx.clip()，超出区域的部分会自动截断，
	// 但线段本身会因为拥有完整的点位序列而保持连续。
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

		// 3. 包含性重绘：只要该命令与脏矩形相交，就保留其所有点位
		return intersectingCmdIds.has(pt.cmdId);
	});
	// 执行重绘
	renderPageContentFromPoints(ctx, canvasW, canvasH, filteredPoints, true);
	ctx.restore();
};

const bufferDirtyPoint = (point: any) => {
	dirtyPointBuffer.push(point);
	if (!dirtyBufferTimer) {
		dirtyBufferTimer = setTimeout(() => {
			processDirtyBuffer();
			dirtyBufferTimer = null;
		}, 16); // 缩短至 16ms (1帧) 以降低交互延迟
	}
};

const processDirtyBuffer = () => {
	if (dirtyPointBuffer.length === 0 || !useWorkerStore().canvasWorker) return;

	// 计算每个点的包围盒
	const rects = dirtyPointBuffer.map((pt) => {
		const maxThickness = Math.max(pt.size, pt.lastWidth || pt.size);
		const padding = maxThickness / 2;
		const minX = Math.min(pt.lastX || pt.x, pt.x);
		const maxX = Math.max(pt.lastX || pt.x, pt.x);
		const minY = Math.min(pt.lastY || pt.y, pt.y);
		const maxY = Math.max(pt.lastY || pt.y, pt.y);

		return {
			minX: minX - padding,
			minY: minY - padding,
			maxX: maxX + padding,
			maxY: maxY + padding,
		};
	});

	// 发送给 Worker 进行 DSU 合并
	useWorkerStore().canvasWorker?.postMessage({
		type: "merge-dirty-rects",
		data: { rects },
	});

	dirtyPointBuffer = [];
};

export { reRenderDirtyRect, bufferDirtyPoint };
