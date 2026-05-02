import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { ExternalConfig, RoomUser } from "./types";

const requestJson = async (
	url: string,
	body: unknown,
	failurePrefix: string
): Promise<any> => {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error: any) {
		throw new Error(`${failurePrefix}: ${error?.message || "request failed"}`);
	}
	if (!response.ok) {
		throw new Error(`${failurePrefix}: HTTP ${response.status}`);
	}
	return response.json();
};

export const assertFrontendReachable = async (config: ExternalConfig) => {
	try {
		const response = await fetch(config.frontendUrl);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
	} catch (error: any) {
		throw new Error(`frontend unreachable: ${error?.message || "request failed"}`);
	}
};

export const createRoom = async (config: ExternalConfig, roomId = randomRoomId()) => {
	const data = await requestJson(
		`${config.apiUrl}/create-room`,
		{ roomId, roomName: `External_${roomId}`, password: "" },
		"create-room failed"
	);
	if (data?.code !== 200 && !String(data?.message || "").includes("已存在")) {
		throw new Error(`create-room rejected: ${JSON.stringify(data)}`);
	}
	return roomId;
};

export const joinRoom = async (
	config: ExternalConfig,
	roomId: string,
	userName: string
): Promise<RoomUser> => {
	const data = await requestJson(
		`${config.apiUrl}/join-room`,
		{ roomId, userName, password: "" },
		"join-room failed"
	);
	const token = data?.data?.sessionToken || data?.data?.token;
	const userId = data?.data?.userId || data?.data?.user?.id || `${userName}-${Date.now()}`;
	if (data?.code !== 200 || !token) {
		throw new Error(`join-room rejected: ${JSON.stringify(data)}`);
	}
	return {
		roomId,
		userName,
		token,
		userId,
	};
};

export const randomRoomId = () => String(Math.floor(100000 + Math.random() * 900000));

export class ProtocolClient {
	private ws: WebSocket | null = null;
	private lamport = 1;

	constructor(
		private config: ExternalConfig,
		private user: RoomUser
	) {}

	connect() {
		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(this.config.wsUrl, [this.user.token]);
			this.ws = ws;
			const timer = setTimeout(() => {
				reject(new Error("websocket init timeout"));
			}, 8000);

			ws.on("message", (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (msg?.type === "init-meta") {
						clearTimeout(timer);
						resolve();
					}
				} catch {
					// Ignore binary and non-init frames.
				}
			});
			ws.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	close() {
		this.ws?.close();
		this.ws = null;
	}

	sendRaw(type: string, data: unknown) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("protocol websocket is not connected");
		}
		this.ws.send(JSON.stringify({ type, data }));
	}

	private sendJsonAwait(payload: unknown) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("protocol websocket is not connected");
		}
		return new Promise<void>((resolve, reject) => {
			this.ws!.send(JSON.stringify(payload), (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	sendStroke(options: {
		points: Array<{ x: number; y: number; p?: number }>;
		color?: string;
		size?: number;
		pageId?: number;
		commandId?: string;
	}) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("protocol websocket is not connected");
		}

		const points = options.points.map((point) => ({
			x: point.x,
			y: point.y,
			p: point.p ?? 0.5,
			lamport: this.lamport++,
		}));
		if (points.length === 0) {
			throw new Error("stroke requires at least one point");
		}

		const commandId = options.commandId || uuidv4();
		const command = {
			id: commandId,
			type: "path",
			points: [points[0]],
			tool: "pen",
			color: options.color || "#111827",
			size: options.size || 4,
			timestamp: Date.now(),
			userId: this.user.userId,
			roomId: this.user.roomId,
			pageId: options.pageId ?? 0,
			isDeleted: false,
			lamport: points[0]!.lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};

		this.ws.send(JSON.stringify({
			type: "cmd-start",
			data: { id: commandId, cmd: command, lamport: command.lamport },
		}));

		const stopPoints = points.slice(1);
		const lastPoint = points[points.length - 1]!;
		this.ws.send(JSON.stringify({
			type: "cmd-stop",
			data: {
				cmdId: commandId,
				cmd: { ...command, points, lamport: lastPoint.lamport },
				lamport: lastPoint.lamport,
				points: stopPoints,
				box: command.box,
			},
		}));

		return commandId;
	}

	async sendStrokeAwait(options: {
		points: Array<{ x: number; y: number; p?: number }>;
		color?: string;
		size?: number;
		pageId?: number;
		commandId?: string;
	}) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("protocol websocket is not connected");
		}

		const points = options.points.map((point) => ({
			x: point.x,
			y: point.y,
			p: point.p ?? 0.5,
			lamport: this.lamport++,
		}));
		if (points.length === 0) {
			throw new Error("stroke requires at least one point");
		}

		const commandId = options.commandId || uuidv4();
		const command = {
			id: commandId,
			type: "path",
			points: [points[0]],
			tool: "pen",
			color: options.color || "#111827",
			size: options.size || 4,
			timestamp: Date.now(),
			userId: this.user.userId,
			roomId: this.user.roomId,
			pageId: options.pageId ?? 0,
			isDeleted: false,
			lamport: points[0]!.lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};

		await this.sendJsonAwait({
			type: "cmd-start",
			data: { id: commandId, cmd: command, lamport: command.lamport },
		});

		const stopPoints = points.slice(1);
		const lastPoint = points[points.length - 1]!;
		await this.sendJsonAwait({
			type: "cmd-stop",
			data: {
				cmdId: commandId,
				cmd: { ...command, points, lamport: lastPoint.lamport },
				lamport: lastPoint.lamport,
				points: stopPoints,
				box: command.box,
			},
		});

		return commandId;
	}
}

export const createLinePoints = (
	count: number,
	start = { x: 0.18, y: 0.28 },
	delta = { x: 0.004, y: 0.003 }
) =>
	Array.from({ length: count }, (_, index) => ({
		x: Number((start.x + delta.x * index).toFixed(5)),
		y: Number((start.y + delta.y * index).toFixed(5)),
		p: 0.55,
	}));

export const createDistributedStrokePoints = (
	count: number,
	strokeIndex: number,
	totalStrokes: number
) => {
	const columns = Math.max(1, Math.ceil(Math.sqrt(totalStrokes)));
	const rows = Math.max(1, Math.ceil(totalStrokes / columns));
	const column = strokeIndex % columns;
	const row = Math.floor(strokeIndex / columns);
	const xBase = 0.06 + (column / Math.max(1, columns - 1)) * 0.82;
	const yBase = 0.08 + (row / Math.max(1, rows - 1)) * 0.76;
	const xDirection = strokeIndex % 2 === 0 ? 1 : -1;
	const yDirection = Math.floor(strokeIndex / 2) % 2 === 0 ? 1 : -1;
	const xStep = (0.18 / Math.max(8, count)) * xDirection;
	const yStep = (0.1 / Math.max(8, count)) * yDirection;

	return Array.from({ length: count }, (_, index) => ({
		x: Number(Math.min(0.96, Math.max(0.04, xBase + xStep * index)).toFixed(5)),
		y: Number(Math.min(0.94, Math.max(0.06, yBase + yStep * index)).toFixed(5)),
		p: 0.55,
	}));
};

export const createRoomWithUsers = async (
	config: ExternalConfig,
	userNames: string[]
): Promise<{ roomId: string; users: RoomUser[] }> => {
	const roomId = await createRoom(config);
	const users: RoomUser[] = [];
	for (const userName of userNames) {
		users.push(await joinRoom(config, roomId, userName));
	}
	return { roomId, users };
};
