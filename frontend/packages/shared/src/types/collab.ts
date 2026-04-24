// File role: shared collaboration domain types intended for future reuse across frontend and backend.
export interface Point {
	x: number;
	y: number;
	p: number;
	lamport: number;
}

export interface FlatPoint extends Point {
	cmdId: string;
	pageId: number;
	userId: string;
	tool: "pen" | "eraser";
	color: string;
	size: number;
	isDeleted: boolean;
}

export interface Command {
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
	box: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	};
}

export interface RemoteCursor {
	userId: string;
	userName: string;
	x: number;
	y: number;
	pageId: number;
	color?: string;
	lastUpdate: number;
}

export interface LastWidthInfo {
	lastWidth: number;
}

export interface AabbBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

export type aabbBox = AabbBox;

export interface QueuePoint {
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
