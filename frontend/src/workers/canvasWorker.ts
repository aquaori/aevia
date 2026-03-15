// canvasWorker.ts
// 该 Worker 负责处理复杂的重绘计算、CRDT 排序以及基于 DSU 的脏矩形合并

interface Point {
	x: number;
	y: number;
	p: number;
	lamport: number;
}

interface FlatPoint extends Point {
	cmdId: string;
	userId: string;
	tool: "pen" | "eraser";
	color: string;
	size: number;
	isDeleted: boolean;
}

interface Command {
	id: string;
	type: "path" | "clear";
	tool?: "pen" | "eraser";
	color?: string;
	size?: number;
	points?: Point[];
	timestamp: number;
	userId: string;
	roomId: string;
	pageId: number;
	isDeleted: boolean;
	lamport: number;
}

interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

// 并查集 (DSU) 实现，用于合并重叠的矩形
class DSU {
	parent: number[];
	constructor(n: number) {
		this.parent = Array.from({ length: n }, (_, i) => i);
	}
	find(i: number): number {
		if (this.parent[i] === i) return i;
		const p = this.parent[i];
		if (p === undefined) return i;
		return (this.parent[i] = this.find(p));
	}
	union(i: number, j: number) {
		const rootI = this.find(i);
		const rootJ = this.find(j);
		if (rootI !== rootJ) {
			this.parent[rootI] = rootJ;
		}
	}
}

function isIntersect(a: Rect, b: Rect): boolean {
	return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function mergeRects(rects: Rect[]): Rect[] {
	if (rects.length <= 1) return rects;

	const n = rects.length;
	const dsu = new DSU(n);

	// O(N^2) 基础合并逻辑，在 Worker 线程运行不会阻塞 UI
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const r1 = rects[i];
			const r2 = rects[j];
			if (r1 && r2 && isIntersect(r1, r2)) {
				dsu.union(i, j);
			}
		}
	}

	const groups = new Map<number, Rect>();
	for (let i = 0; i < n; i++) {
		const root = dsu.find(i);
		const current = rects[i];
		if (!current) continue;

		const existing = groups.get(root);
		if (!existing) {
			groups.set(root, { ...current });
		} else {
			existing.minX = Math.min(existing.minX, current.minX);
			existing.minY = Math.min(existing.minY, current.minY);
			existing.maxX = Math.max(existing.maxX, current.maxX);
			existing.maxY = Math.max(existing.maxY, current.maxY);
		}
	}

	return Array.from(groups.values());
}

self.onmessage = (e: MessageEvent) => {
	const { type, data } = e.data;

	if (type === "flat-points") {
		const { commands, pageId, transformingCmdIds, requestId } = data;
		const transformSet = new Set(transformingCmdIds as string[]);
		const points: FlatPoint[] = [];

		(commands as Command[]).forEach((cmd: Command) => {
			if (transformSet.has(cmd.id)) return;
			if (cmd.points && cmd.pageId === pageId) {
				const ptArray: Point[] = Array.isArray(cmd.points)
					? cmd.points
					: Object.values(cmd.points);
				ptArray.forEach((pt: Point) => {
					points.push({
						x: pt.x,
						y: pt.y,
						p: pt.p,
						lamport: pt.lamport,
						cmdId: cmd.id,
						userId: cmd.userId,
						tool: cmd.tool ?? "pen",
						color: cmd.color ?? "#000000",
						size: cmd.size ?? 3,
						isDeleted: cmd.isDeleted,
					});
				});
			}
		});

		points.sort((a, b) => {
			if (a.lamport !== b.lamport) return a.lamport - b.lamport;
			return a.cmdId < b.cmdId ? -1 : 1;
		});

		self.postMessage({ type: "flat-points-result", points, requestId });
	}

	if (type === "merge-dirty-rects") {
		const { rects } = data;
		const merged = mergeRects(rects);
		self.postMessage({ type: "merge-dirty-rects-result", rects: merged });
	}
};
