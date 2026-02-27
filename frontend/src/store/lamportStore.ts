import { defineStore } from 'pinia'
import { ref } from 'vue'

interface QueuePoint {
    x: number;
    y: number;
    p: number;
    lamport: number;
    cmdId: string;
    userId: string;
    tool: 'pen' | 'eraser';
    color: string;
    size: number;
    isDeleted: boolean;
    lastX: number;
    lastY: number;
    lastWidth: number;
}

export const useLamportStore = defineStore('lamport', () => {
    const lamport = ref(0);
    const pointQueue: Record<number, QueuePoint[]> = {};
    const activeLamports: number[] = [];
    const MAX_QUEUE_LAMPORT_SIZE = 3;

    const getNextLamport = () => {
        lamport.value += 1;
        return lamport.value;
    }

    const syncLamport = (remoteVal: number | string) => {
        const rv = typeof remoteVal === 'string' ? parseInt(remoteVal, 10) : remoteVal;
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
                const [needRedrawing, dirtyPoints] = compareSameLamportPoints(point);

                if (needRedrawing && dirtyPoints.length > 0) {
                    const dirtyRect = getGroupBoundingBox(dirtyPoints);
                    if (dirtyRect) {
                        window.dispatchEvent(new CustomEvent('point-collision', {
                            detail: { rect: dirtyRect }
                        }));
                    }
                }

            } else {
                // 过去：重绘命令所在的包围盒内的所有命令
                const dirtyRect = getGroupBoundingBox([point]);
                if (dirtyRect) {
                    window.dispatchEvent(new CustomEvent('point-collision', {
                        detail: { rect: dirtyRect }
                    }));
                }
                return;
            }
        }

        if (activeLamports.length > MAX_QUEUE_LAMPORT_SIZE) {
            const oldestLamport = activeLamports.shift()!;
            delete pointQueue[oldestLamport];
        }
    };

    // 比较新压入队列的点与其它点有没有交集
    const compareSameLamportPoints = (newPoint: QueuePoint): [boolean, QueuePoint[]] => {
        const dirtyPoints: QueuePoint[] = [];
        let needRedrawing = false;

        const p1x = newPoint.x, p1y = newPoint.y;
        const p2x = newPoint.lastX, p2y = newPoint.lastY;
        const pad1 = (newPoint.size + newPoint.lastWidth) / 2;
        const boxAMinX = Math.min(p1x, p2x) - pad1;
        const boxAMaxX = Math.max(p1x, p2x) + pad1;
        const boxAMinY = Math.min(p1y, p2y) - pad1;
        const boxAMaxY = Math.max(p1y, p2y) + pad1;

        const keys = activeLamports;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === undefined) continue;
            const points = pointQueue[key];
            if (!points) continue;
            for (let j = 0; j < points.length; j++) {
                const point = points[j];
                if (!point || point === newPoint || point.userId === newPoint.userId || point.isDeleted) {
                    continue;
                }

                const q1x = point.x, q1y = point.y;
                const q2x = point.lastX, q2y = point.lastY;
                const pad2 = (point.size + point.lastWidth) / 2;
                const boxBMinX = Math.min(q1x, q2x) - pad2;
                const boxBMaxX = Math.max(q1x, q2x) + pad2;
                const boxBMinY = Math.min(q1y, q2y) - pad2;
                const boxBMaxY = Math.max(q1y, q2y) + pad2;

                // 检查AABB包围盒是否相交
                if (boxAMaxX < boxBMinX || boxAMinX > boxBMaxX ||
                    boxAMaxY < boxBMinY || boxAMinY > boxBMaxY) {
                    continue; // 绝不相交
                }

                needRedrawing = true;
                dirtyPoints.push(point);
            }
        }
        return [needRedrawing, dirtyPoints];
    }

    // 1. 获取单个 QueuePoint (一段有宽度的短线段) 的包围盒
    const getPointBoundingBox = (point: QueuePoint) => {
        if (!point) return null;

        // 【关键逻辑】这根线的粗细，取起点和终点里比较粗的那一个作为 padding 的基础
        // 除以 2 是因为线宽是以骨架为中心向两边扩散的
        const maxThickness = Math.max(point.size, point.lastWidth);
        const padding = maxThickness / 2;

        // 起点和终点，谁小谁做边界，谁大谁做边界
        const minX = Math.min(point.lastX, point.x);
        const maxX = Math.max(point.lastX, point.x);
        const minY = Math.min(point.lastY, point.y);
        const maxY = Math.max(point.lastY, point.y);

        return {
            minX: minX - padding,
            minY: minY - padding,
            maxX: maxX + padding,
            maxY: maxY + padding,
            width: (maxX - minX) + padding * 2,
            height: (maxY - minY) + padding * 2
        };
    };

    // 2. 获取一组脏点（比如发生连环相交的几个点）的合并包围盒
    const getGroupBoundingBox = (dirtyPoints: QueuePoint[]) => {
        if (!dirtyPoints || dirtyPoints.length === 0) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let hasValid = false;

        dirtyPoints.forEach(point => {
            if (point && !point.isDeleted) {
                // 利用上面的函数算出单根线的盒子
                const box = getPointBoundingBox(point);
                if (box) {
                    hasValid = true;
                    // 然后进行大框套小框的合并操作
                    if (box.minX < minX) minX = box.minX;
                    if (box.minY < minY) minY = box.minY;
                    if (box.maxX > maxX) maxX = box.maxX;
                    if (box.maxY > maxY) maxY = box.maxY;
                }
            }
        });

        if (!hasValid) return null;

        return {
            minX, minY, maxX, maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    };


    return { lamport, pointQueue, getNextLamport, syncLamport, pushToQueue };
});