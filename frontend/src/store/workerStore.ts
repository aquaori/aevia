import { defineStore } from "pinia";
import { ref } from "vue";
import { useCommandStore } from "./commandStore";
import { renderWithPoints } from "../service/canvas";
import { bufferDirtyPoint } from "../utils/dirtyRedraw";

export const useWorkerStore = defineStore("worker", () => {
	// --- Worker 初始化 ---
	let canvasWorker = ref<Worker | null>(null);
	const initWorker = () => {
		// 使用 Vite 的 Worker 导入语法
		canvasWorker.value = new Worker(new URL("../workers/canvasWorker.ts", import.meta.url), {
			type: "module",
		});

		canvasWorker.value.onmessage = (e) => {
			const { type, points, rects, requestId } = e.data;
			if (type === "flat-points-result") {
				// 1. 如果有特定的异步回调 (如预览图)，则执行回调
				if (requestId && useCommandStore().pendingRenderCallbacks.has(requestId)) {
					const cb = useCommandStore().pendingRenderCallbacks.get(requestId);
					cb!(points);
					useCommandStore().pendingRenderCallbacks.delete(requestId);
					return;
				}

				// 2. 否则视为当前主页面的全量更新
				useCommandStore().lastSortedPoints = points;
				renderWithPoints(points);
			} else if (type === "merge-dirty-rects-result") {
				// 处理 Worker 返回的合并后的脏矩形
				rects.forEach((rect: any) => {
					window.dispatchEvent(
						new CustomEvent("point-collision", {
							detail: { rect },
						})
					);
				});
			}
		};
		// 监听点位添加事件，用于脏矩形合并（DSU 优化）
		window.addEventListener("point-added", ((e: CustomEvent) => {
			const { point } = e.detail;
			bufferDirtyPoint(point);
		}) as any);
	};

	return {
		initWorker,
		canvasWorker,
	};
});
