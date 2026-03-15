import { defineStore } from "pinia";
import { ref } from "vue";

interface QueuePoint {
	x: number;
	y: number;
	p: number;
	lamport: number;
	cmdId: string;
	userId: string;
	tool: "pen" | "eraser";
	color: string;
	size: number;
	isDeleted: boolean;
	lastX: number;
	lastY: number;
	lastWidth: number;
}

export const useLamportStore = defineStore("lamport", () => {
	const lamport = ref(0);
	const pointQueue: Record<number, QueuePoint[]> = {};
	const activeLamports: number[] = [];
	const MAX_QUEUE_LAMPORT_SIZE = 3;

	const getNextLamport = () => {
		lamport.value += 1;
		return lamport.value;
	};

	const syncLamport = (remoteVal: number | string) => {
		const rv = typeof remoteVal === "string" ? parseInt(remoteVal, 10) : remoteVal;
		if (isNaN(rv)) {
			return;
		}
		lamport.value = Math.max(lamport.value, rv);
	};

	const pushToQueue = (point: QueuePoint) => {
		const newLamport = point.lamport;

		if (activeLamports.length === 0) {
			activeLamports.push(newLamport);
			pointQueue[newLamport] = [point];
		} else {
			const minLamport = activeLamports[0] as number;
			const maxLamport = activeLamports[activeLamports.length - 1] as number;
			if (newLamport > maxLamport || (newLamport >= minLamport && newLamport <= maxLamport)) {
				if (!pointQueue[newLamport]) {
					pointQueue[newLamport] = [];
					activeLamports.push(newLamport);
					activeLamports.sort((a, b) => a - b);
				}
				pointQueue[newLamport].push(point);

				// 【性能优化】不再在主线程执行 O(N^2) 的碰撞检测
				// 发送事件通知 RoomView 将脏点加入待合并队列
				window.dispatchEvent(
					new CustomEvent("point-added", {
						detail: { point },
					})
				);
			} else {
				// 处理过时的点（通常发生在网络延迟极高时）
				window.dispatchEvent(
					new CustomEvent("point-added", {
						detail: { point },
					})
				);
				return;
			}
		}

		if (activeLamports.length > MAX_QUEUE_LAMPORT_SIZE) {
			const oldestLamport = activeLamports.shift()!;
			delete pointQueue[oldestLamport];
		}
	};

	// 移除了冗余的 getGroupBoundingBox 和 compareSameLamportPoints
	// 逻辑已迁移至 Worker

	return { lamport, pointQueue, getNextLamport, syncLamport, pushToQueue };
});
