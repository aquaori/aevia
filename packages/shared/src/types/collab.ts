// File role: shared collaboration domain types intended for future reuse across frontend and backend.
import type { SceneOperationEnvelopeV2, StrokePattern } from "./scene";
export interface Point {
	x: number;
	y: number;
	p: number;
	lamport: number;
}

export interface FlatPoint extends Point {
	cmdId: string;
	orderOpId?: string;
	pageId: number;
	userId: string;
	tool: "pen" | "pencil" | "highlighter" | "eraser";
	color: string;
	size: number;
	isDeleted: boolean;
	pointIndex?: number;
	strokePattern?: "solid" | "dashed" | "dotted" | "dash-dot" | "double";
}

export interface Command {
	id: string;
	type: "path" | "clear" | "scene-op";
	tool?: "pen" | "pencil" | "highlighter" | "eraser";
	color?: string;
	size?: number;
	points?: Point[];
	strokePattern?: StrokePattern;
	schemaVersion?: 1 | 2;
	sceneOperation?: SceneOperationEnvelopeV2;
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
	tool: "pen" | "pencil" | "highlighter" | "eraser";
	color: string;
	size: number;
	strokePattern?: StrokePattern;
	isDeleted: boolean;
	lastX: number;
	lastY: number;
	lastWidth: number;
}
