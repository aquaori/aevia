import type { Browser } from "playwright";
import { v4 as uuidv4 } from "uuid";
import type { BenchmarkRunSample } from "./core-types";
import { bootstrapRoomPage, createContextAndPage, readBenchmarkRuntime } from "./suite-helpers";
import { WebSocketInjector, createRoom, joinRoom } from "./utils";

export interface LatencyReport {
	inputToLocalRenderStartMs: number;
	inputToLocalRenderEndMs: number;
	remoteSendToRemoteReceiveMs: number;
	remoteSendToRemoteRenderEndMs: number;
}

export const runLatencySuite = async (
	browser: Browser,
	throttleCpu = false
): Promise<LatencyReport> => {
	const roomId = String(Math.floor(100000 + Math.random() * 900000));
	await createRoom(roomId, "LatencyRoom");

	const observer = await joinRoom(roomId, "Observer");
	if (!observer) throw new Error("observer join failed");

	const { context, page } = await createContextAndPage(browser, throttleCpu);
	await bootstrapRoomPage(page, { token: observer.token, userName: "Observer" });

	const canvas = page.locator("canvas").first();
	const box = await canvas.boundingBox();
	if (!box) throw new Error("canvas bounding box unavailable");

	await page.mouse.move(box.x + 200, box.y + 200);
	await page.mouse.down();
	await page.mouse.move(box.x + 212, box.y + 212, { steps: 3 });
	await page.mouse.up();

	await page.waitForFunction(
		() => {
			const localInput = (window as any).__benchmarkRuntime?.localInput;
			return localInput?.lastRenderEndTs > 0 && localInput?.lastRenderStartTs > 0;
		},
		undefined,
		{ timeout: 5000 }
	);

	const runtimeAfterLocal = await readBenchmarkRuntime(page);
	const localInput = runtimeAfterLocal.localInput || {};

	const remoteUser = await joinRoom(roomId, "RemoteLatencyBot");
	if (!remoteUser) throw new Error("remote join failed");
	const injector = new WebSocketInjector(roomId, "RemoteLatencyBot", remoteUser.token, remoteUser.userId);
	await injector.connect();
	const commandId = uuidv4();
	const sendPerfTs = await page.evaluate(() => performance.now());
	// @ts-ignore testing-only raw websocket access
	injector.ws?.send(
		JSON.stringify({
			type: "cmd-start",
			data: {
				id: commandId,
				lamport: 9999,
				cmd: {
					id: commandId,
					type: "path",
					points: [{ x: 0.5, y: 0.5, p: 0.5 }],
					tool: "pen",
					color: "#ff0000",
					size: 5,
					timestamp: Date.now(),
					userId: remoteUser.userId,
					roomId,
					pageId: 0,
					isDeleted: false,
					lamport: 9999,
				},
			},
		})
	);

	await page.waitForFunction(
		(id) => {
			const remote = (window as any).__benchmarkRuntime?.remoteCommands?.[id];
			return remote?.receiveTs > 0 && remote?.renderEndTs > 0;
		},
		commandId,
		{ timeout: 5000 }
	);

	const runtimeAfterRemote = await readBenchmarkRuntime(page);
	const remote = runtimeAfterRemote.remoteCommands?.[commandId];
	injector.close();
	await context.close();

	return {
		inputToLocalRenderStartMs: Math.max(
			0,
			(localInput.lastRenderStartTs || 0) - (localInput.lastStartTs || 0)
		),
		inputToLocalRenderEndMs: Math.max(
			0,
			(localInput.lastRenderEndTs || 0) - (localInput.lastStartTs || 0)
		),
		remoteSendToRemoteReceiveMs: Math.max(0, (remote?.receiveTs || 0) - sendPerfTs),
		remoteSendToRemoteRenderEndMs: Math.max(0, (remote?.renderEndTs || 0) - sendPerfTs),
	};
};

export const collectLatencySample = async (
	browser: Browser,
	throttleCpu = false
): Promise<BenchmarkRunSample> => {
	const startedAt = performance.now();
	try {
		const report = await runLatencySuite(browser, throttleCpu);
		return {
			status: "passed",
			durationMs: performance.now() - startedAt,
			metrics: report,
		};
	} catch (error: any) {
		return {
			status: "failed",
			durationMs: performance.now() - startedAt,
			metrics: {},
			error: error?.message || "latency suite failed",
		};
	}
};
