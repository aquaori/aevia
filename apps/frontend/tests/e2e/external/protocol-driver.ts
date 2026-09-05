import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { ExternalConfig, RoomUser } from "./types";

interface ApiResponse {
	code?: number;
	message?: string;
	data?: {
		sessionToken?: string;
		token?: string;
		userId?: string;
		expiresAt?: number | null;
		user?: {
			id?: string;
		};
	};
}

const requestJson = async (
	url: string,
	body: unknown,
	failurePrefix: string
): Promise<ApiResponse> => {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error: unknown) {
		throw new Error(`${failurePrefix}: ${error instanceof Error ? error.message : "request failed"}`, {
			cause: error,
		});
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
	} catch (error: unknown) {
		throw new Error(`frontend unreachable: ${error instanceof Error ? error.message : "request failed"}`, {
			cause: error,
		});
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
		expiresAt: data.data.expiresAt ?? null,
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
						const trustedUserId = msg?.data?.userId;
						if (typeof trustedUserId !== "string" || trustedUserId.length === 0) {
							reject(new Error("websocket init did not include a trusted user id"));
							return;
						}
						this.user.userId = trustedUserId;
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

	private sceneStrokeCommand(options: {
		opId: string;
		elementId: string;
		pageId: number;
		lamport: number;
		color: string;
		size: number;
		kind: "element.create" | "element.append";
		payload: Record<string, unknown>;
	}) {
		return {
			id: options.opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: this.user.userId,
			roomId: this.user.roomId,
			pageId: options.pageId,
			isDeleted: false,
			lamport: options.lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: 2,
			sceneOperation: {
				schemaVersion: 2,
				opId: options.opId,
				elementId: options.elementId,
				actorId: this.user.userId,
				roomId: this.user.roomId,
				pageId: options.pageId,
				lamport: options.lamport,
				historyGroupId: options.elementId,
				kind: options.kind,
				payload: options.payload,
			},
		};
	}

	private createStrokePayload(points: Array<{ x: number; y: number; p: number; lamport: number }>, color: string, size: number, isComplete: boolean) {
		return {
			descriptor: {
				elementKind: "path",
				toolId: "pen",
				recipeId: "stroke",
				style: { color, size, strokePattern: "solid" },
			},
			points,
			isComplete,
		};
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
		const pageId = options.pageId ?? 0;
		const color = options.color || "#111827";
		const size = options.size || 4;
		const command = this.sceneStrokeCommand({
			opId: commandId,
			elementId: commandId,
			pageId,
			lamport: points[0]!.lamport,
			color,
			size,
			kind: "element.create",
			payload: this.createStrokePayload(points, color, size, true),
		});

		this.ws.send(JSON.stringify({
			type: "push-cmd",
			data: { id: commandId, cmd: command, lamport: command.lamport },
		}));

		return commandId;
	}

	async sendCommittedStroke(options: {
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
		const pageId = options.pageId ?? 0;
		const color = options.color || "#111827";
		const size = options.size || 4;
		const command = this.sceneStrokeCommand({
			opId: commandId, elementId: commandId, pageId,
			lamport: points[0]!.lamport, color, size, kind: "element.create",
			payload: this.createStrokePayload(points, color, size, true),
		});

		await this.sendJsonAwait({
			type: "push-cmd",
			data: { id: commandId, cmdId: commandId, cmd: command, lamport: command.lamport },
		});

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
		const pageId = options.pageId ?? 0;
		const color = options.color || "#111827";
		const size = options.size || 4;
		const command = this.sceneStrokeCommand({
			opId: commandId, elementId: commandId, pageId,
			lamport: points[0]!.lamport, color, size, kind: "element.create",
			payload: this.createStrokePayload([points[0]!], color, size, points.length === 1),
		});

		await this.sendJsonAwait({
			type: "push-cmd",
			data: { id: commandId, cmd: command, lamport: command.lamport },
		});

		const stopPoints = points.slice(1);
		if (stopPoints.length > 0) {
			const appendId = uuidv4();
			const lastPoint = stopPoints[stopPoints.length - 1]!;
			const append = this.sceneStrokeCommand({
				opId: appendId, elementId: commandId, pageId, lamport: lastPoint.lamport,
				color, size, kind: "element.append",
				payload: { points: stopPoints, sourceStart: 1, isComplete: true },
			});
			await this.sendJsonAwait({ type: "push-cmd", data: { id: appendId, cmd: append, lamport: append.lamport } });
		}

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
