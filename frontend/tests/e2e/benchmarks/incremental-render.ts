import { v4 as uuidv4 } from "uuid";
import type { Browser } from "playwright";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage } from "./suite-helpers";
import { createRoom, joinRoom, WebSocketInjector } from "./utils";

export interface IncrementalRenderReport {
	incrementalRenderMs: number;
	refreshRenderMs: number;
	remoteVisiblePaintMs: number;
	refreshVisiblePaintMs: number;
	dirtyAreaPx: number;
	dirtyAreaRatio: number;
	pointsPerUpdate: number;
	renderCostPerPoint: number;
}

const waitForFunctionWithSnapshot = async <T>(
	page: import("playwright").Page,
	label: string,
	fn: (payload: T) => boolean,
	payload: T,
	timeout: number
) => {
	try {
		await page.waitForFunction(fn, payload, { timeout });
	} catch (error: any) {
		const snapshot = await page.evaluate(() => {
			const runtime = (window as any).__benchmarkRuntime || {};
			return {
				lastIncrementalRender: runtime.lastIncrementalRender || null,
				lastDirtyRedraw: runtime.lastDirtyRedraw || null,
				lastFullRender: runtime.lastFullRender || null,
				remoteCommands: runtime.remoteCommands || {},
				lastEvents: [...(runtime.events || [])].slice(-12),
			};
		});
		throw new Error(
			`${label}: ${error?.message || "waitForFunction failed"}\n${JSON.stringify(snapshot)}`
		);
	}
};

interface StrokeCommandPayload {
	id: string;
	type: "path";
	points: Array<{ x: number; y: number; p: number }>;
	tool: "pen";
	color: string;
	size: number;
	timestamp: number;
	userId: string;
	roomId: string;
	pageId: number;
	isDeleted: boolean;
	lamport: number;
	box: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
}

const createStrokePoints = (count: number) => {
	const points = [];
	let x = 0.18;
	let y = 0.24;
	for (let index = 0; index < count; index += 1) {
		x += 0.008;
		y += (index % 2 === 0 ? 0.004 : -0.003);
		points.push({
			x: Number(x.toFixed(5)),
			y: Number(y.toFixed(5)),
			p: Number((0.3 + (index % 5) * 0.08).toFixed(5)),
		});
	}
	return points;
};

const createStrokeCommand = (params: {
	id: string;
	points: Array<{ x: number; y: number; p: number }>;
	color: string;
	size: number;
	userId: string;
	roomId: string;
	lamport: number;
}): StrokeCommandPayload => ({
	id: params.id,
	type: "path",
	points: [...params.points],
	tool: "pen",
	color: params.color,
	size: params.size,
	timestamp: Date.now(),
	userId: params.userId,
	roomId: params.roomId,
	pageId: 0,
	isDeleted: false,
	lamport: params.lamport,
	box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
});

const sendStroke = async (injector: WebSocketInjector, params: {
	commandId: string;
	allPoints: Array<{ x: number; y: number; p: number }>;
	color: string;
	size: number;
	userId: string;
	roomId: string;
	startLamport: number;
	updateEvery?: number;
	frameDelayMs?: number;
}) => {
	// @ts-ignore benchmark helper intentionally reaches raw websocket for protocol-accurate injection.
	const ws = injector.ws as WebSocket | null;
	if (!ws) throw new Error("incremental injector websocket unavailable");

	const updateEvery = Math.max(1, params.updateEvery ?? 2);
	const frameDelayMs = Math.max(0, params.frameDelayMs ?? 8);
	let lamport = params.startLamport;
	const startPoint = params.allPoints[0];
	if (!startPoint) throw new Error("stroke requires at least one point");

	ws.send(
		JSON.stringify({
			type: "cmd-start",
			data: {
				id: params.commandId,
				lamport,
				cmd: createStrokeCommand({
					id: params.commandId,
					points: [startPoint],
					color: params.color,
					size: params.size,
					userId: params.userId,
					roomId: params.roomId,
					lamport,
				}),
			},
		})
	);

	const accumulated = [startPoint];
	for (let index = 1; index < params.allPoints.length; index += 1) {
		const point = params.allPoints[index]!;
		accumulated.push(point);
		lamport += 1;
		if (index % updateEvery === 0 && index < params.allPoints.length - 1) {
			ws.send(
				JSON.stringify({
					type: "cmd-update",
					data: {
						cmdId: params.commandId,
						cmd: createStrokeCommand({
							id: params.commandId,
							points: [...accumulated],
							color: params.color,
							size: params.size,
							userId: params.userId,
							roomId: params.roomId,
							lamport,
						}),
						lamport,
						points: [point],
					},
				})
			);
			if (frameDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, frameDelayMs));
			}
		}
	}

	lamport += 1;
	ws.send(
		JSON.stringify({
			type: "cmd-stop",
			data: {
				cmdId: params.commandId,
				cmd: createStrokeCommand({
					id: params.commandId,
					points: [...accumulated],
					color: params.color,
					size: params.size,
					userId: params.userId,
					roomId: params.roomId,
					lamport,
				}),
				lamport,
				points: [...accumulated],
				box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			},
		})
	);

	return {
		finalLamport: lamport,
		pointsSent: accumulated.length,
	};
};

export const runIncrementalRenderSuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<IncrementalRenderReport> => {
	const roomId = String(Math.floor(100000 + Math.random() * 900000));
	await createRoom(roomId, "IncrementalRoom");

	const observer = await joinRoom(roomId, "IncrementalObserver");
	if (!observer) throw new Error("observer join failed");

	const remoteUser = await joinRoom(roomId, "IncrementalRemote");
	if (!remoteUser) throw new Error("remote join failed");

	const injector = new WebSocketInjector(roomId, "IncrementalRemote", remoteUser.token, remoteUser.userId);
	await injector.connect();

	const { context, page } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(page, { token: observer.token, userName: "IncrementalObserver" });
	const baselineState = await page.evaluate(() => {
		const runtime = (window as any).__benchmarkRuntime || {};
		return {
			baselineSignature: String(
				runtime.lastFullRender?.canvasSignature || runtime.lastIncrementalRender?.canvasSignature || ""
			),
			baselineIncrementalTs: Number(runtime.lastIncrementalRender?.ts || 0),
		};
	});

	const commandId = uuidv4();
	const backgroundCommandId = uuidv4();
	const backgroundPoints = createStrokePoints(8).map((point, index) => ({
		...point,
		x: Number((point.x - 0.08).toFixed(5)),
		y: Number((point.y - 0.08 + index * 0.001).toFixed(5)),
	}));
	const allPoints = createStrokePoints(21);
	const updatePoints = allPoints.slice(1);

	let lamport = 990;
	const seeded = await sendStroke(injector, {
		commandId: backgroundCommandId,
		allPoints: backgroundPoints,
		color: "#2563eb",
		size: 4,
		userId: remoteUser.userId,
		roomId,
		startLamport: lamport,
		updateEvery: 2,
		frameDelayMs: 6,
	});
	lamport = seeded.finalLamport + 1;
	await page.waitForTimeout(200);

	await sendStroke(injector, {
		commandId,
		allPoints,
		color: "#ff0000",
		size: 5,
		userId: remoteUser.userId,
		roomId,
		startLamport: lamport,
		updateEvery: 3,
		frameDelayMs: 10,
	});

	await waitForFunctionWithSnapshot(
		page,
		"incremental remote render wait",
		(payload: { id: string; baselineSignature: string; baselineIncrementalTs: number }) => {
			const runtime = (window as any).__benchmarkRuntime;
			const remote = runtime?.remoteCommands?.[payload.id];
			const matchedEvent = [...(runtime?.events || [])]
				.reverse()
				.find(
					(event: any) =>
						event?.name === "incremental-render-end" &&
						event?.detail?.commandId === payload.id &&
						event?.detail?.source === "remote"
				);
			const lastIncremental = runtime?.lastIncrementalRender;
			const fallbackSignature = String(lastIncremental?.canvasSignature || "");
			return (
				remote?.renderEndTs > 0 &&
				remote?.visiblePaintTs > 0 &&
				typeof remote?.canvasSignature === "string" &&
				remote.canvasSignature.length > 0 &&
				Number(matchedEvent?.detail?.points || 0) > 0 &&
				typeof matchedEvent?.detail?.durationMs === "number"
			) || (
				lastIncremental?.ts > payload.baselineIncrementalTs &&
				lastIncremental?.visiblePaintTs > 0 &&
				fallbackSignature.length > 0 &&
				Number(lastIncremental?.points || 0) > 0 &&
				typeof lastIncremental?.durationMs === "number"
			);
		},
		{
			id: commandId,
			baselineSignature: baselineState.baselineSignature,
			baselineIncrementalTs: baselineState.baselineIncrementalTs,
		},
		8000
	);

	const beforeUndo = await page.evaluate((id: string) => {
		const runtime = (window as any).__benchmarkRuntime || {};
		const remote = runtime.remoteCommands?.[id] || {};
		const lastIncremental = runtime.lastIncrementalRender || null;
		const summary =
			[...(runtime.events || [])]
				.reverse()
				.find(
					(event: any) =>
						event?.name === "incremental-render-end" &&
						event?.detail?.commandId === id &&
						event?.detail?.source === "remote"
				)?.detail || null;
		const dirty = runtime.lastDirtyRedraw || null;
		const full = runtime.lastFullRender || null;
		return {
			renderEndTs: Number(remote.renderEndTs || 0),
			incrementalRenderMs: Number(summary?.durationMs || lastIncremental?.durationMs || 0),
			remoteVisiblePaintMs: Number(remote.visiblePaintMs || lastIncremental?.visiblePaintMs || 0),
			remoteCanvasSignature: String(remote.canvasSignature || lastIncremental?.canvasSignature || ""),
			pointsPerUpdate: Number(summary?.points || lastIncremental?.points || 0),
			dirtyCount: Number(dirty?.count || 0),
			fullRenderTs: Number(full?.ts || 0),
			dirtyVisiblePaintTs: Number(dirty?.lastVisiblePaintTs || 0),
			fullVisiblePaintTs: Number(full?.visiblePaintTs || 0),
		};
	}, commandId);

	// @ts-ignore benchmark test helper intentionally uses raw websocket access.
	injector.ws?.send(
		JSON.stringify({
			type: "undo-cmd",
			data: {
				cmdId: commandId,
			},
		})
	);

	await waitForFunctionWithSnapshot(
		page,
		"incremental refresh wait",
		(payload: { dirtyCount: number; fullRenderTs: number }) => {
			const runtime = (window as any).__benchmarkRuntime;
			const dirty = runtime?.lastDirtyRedraw;
			const full = runtime?.lastFullRender;
			return (
				(dirty?.count > payload.dirtyCount &&
					typeof dirty?.lastRect?.width === "number" &&
					dirty.lastDurationMs >= 0 &&
					dirty?.lastVisiblePaintTs > 0 &&
					typeof dirty?.lastCanvasSignature === "string" &&
					dirty.lastCanvasSignature.length > 0) ||
				(full?.ts > payload.fullRenderTs &&
					full?.durationMs > 0 &&
					full?.visiblePaintTs > 0 &&
					typeof full?.canvasSignature === "string" &&
					full.canvasSignature.length > 0)
			);
		},
		{
			dirtyCount: beforeUndo.dirtyCount,
			fullRenderTs: beforeUndo.fullRenderTs,
		},
		8000
	);

	const snapshot = await page.evaluate(() => {
		const runtime = (window as any).__benchmarkRuntime || {};
		const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
		return {
			lastDirtyRedraw: runtime.lastDirtyRedraw || null,
			lastFullRender: runtime.lastFullRender || null,
			canvasArea: canvas ? canvas.width * canvas.height : 0,
		};
	});

	injector.close();
	await context.close();

	const rect = snapshot?.lastDirtyRedraw?.lastRect;
	const usedDirtyPath =
		Number(snapshot?.lastDirtyRedraw?.count || 0) > Number(beforeUndo.dirtyCount || 0);
	const canvasArea = Number(snapshot?.canvasArea || 0);
	const dirtyAreaPxRaw = usedDirtyPath
		? rect
			? Number(rect.width) * Number(rect.height)
			: 0
		: Math.max(canvasArea, 1);
	const dirtyAreaPx = Number.isFinite(dirtyAreaPxRaw) ? dirtyAreaPxRaw : 0;
	const incrementalRenderMs = Math.max(0.01, Number(beforeUndo.incrementalRenderMs || 0.01));
	const remoteVisiblePaintMs = Math.max(0.01, Number(beforeUndo.remoteVisiblePaintMs || 0.01));
	const refreshRenderMs = usedDirtyPath
		? Math.max(0.01, Number(snapshot?.lastDirtyRedraw?.lastDurationMs || 0.01))
		: Math.max(0.01, Number(snapshot?.lastFullRender?.durationMs || 0.01));
	const refreshVisiblePaintMs = usedDirtyPath
		? Math.max(0.01, Number(snapshot?.lastDirtyRedraw?.lastVisiblePaintMs || 0.01))
		: Math.max(0.01, Number(snapshot?.lastFullRender?.visiblePaintMs || 0.01));
	const pointsPerUpdate = Number(beforeUndo.pointsPerUpdate || 0);
	if (pointsPerUpdate <= 0) {
		throw new Error("incremental render metrics missing");
	}
	return {
		incrementalRenderMs,
		refreshRenderMs,
		remoteVisiblePaintMs,
		refreshVisiblePaintMs,
		dirtyAreaPx,
		dirtyAreaRatio: canvasArea > 0 ? dirtyAreaPx / canvasArea : 0,
		pointsPerUpdate,
		renderCostPerPoint: pointsPerUpdate > 0 ? incrementalRenderMs / pointsPerUpdate : 0,
	};
};

export const collectIncrementalRenderSample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runIncrementalRenderSuite(browser, throttleCpu);
		return { status: "passed", durationMs: performance.now() - startedAt, metrics: report };
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "incremental render suite failed",
		};
	}
};
