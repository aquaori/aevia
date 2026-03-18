interface Point {
	x: number; // 归一化坐标 (0-1)
	y: number; // 归一化坐标 (0-1)
	p: number; // 压力 (0-1)
	lamport: number; // Lamport时钟
}

// 展开后的点集
interface FlatPoint extends Point {
	cmdId: string;
	userId: string;
	tool: "pen" | "eraser";
	color: string;
	size: number;
	isDeleted: boolean;
}

interface Command {
	id: string; // 命令唯一ID
	type: "path" | "clear"; // 命令类型
	tool?: "pen" | "eraser"; // 工具类型
	color?: string; // 颜色值 (如：#ff0000)
	size?: number; // 基础线宽
	points?: Point[]; // 路径点数组 (如：[{x:0.5,y:0.5,p:0.5},...]，x、y均为归一化坐标，p为压感)
	timestamp: number; // 时间戳
	userId: string; // 用户归属
	roomId: string; // 房间归属
	pageId: number; // 页面归属
	isDeleted: boolean; // 软删除标记
	lamport: number; // Lamport时钟
	box: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	}; // 包围盒
}

interface RemoteCursor {
	userId: string;
	userName: string;
	x: number; // 0-1
	y: number; // 0-1
	pageId: number; // 解决多页面光标穿透乱飞的幽灵隔离问题
	color?: string; // 光标颜色
	lastUpdate: number; // 最后更新时间，用于超时清除
}

interface LastWidthInfo {
	lastWidth: number;
}

interface aabbBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

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

export type { Point, FlatPoint, Command, RemoteCursor, LastWidthInfo, aabbBox, QueuePoint };
