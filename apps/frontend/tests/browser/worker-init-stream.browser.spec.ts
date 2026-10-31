import { afterEach, describe, expect, it } from "vitest";

const WIDTH = 320;
const HEIGHT = 240;
const INIT_RENDER_CHUNK_MAGIC = 0x49524348;
const INIT_RENDER_CHUNK_VERSION = 1;
const INIT_RENDER_CHUNK_RECORD_SIZE = 22;
const INIT_RENDER_CHUNK_HEADER_SIZE = 20;

interface BinaryPoint {
	x: number;
	y: number;
	p: number;
	lamport: number;
	cmdIndex: number;
}

const commandDictionary = [
	{
		cmdIndex: 0,
		cmdId: "cmd-1",
		sourceStart: 0,
		userId: "u2",
		tool: "pen",
		color: "#111827",
		size: 24,
		isDeleted: false,
	},
];

const buildChunk = (points: BinaryPoint[], options: { magic?: number; snapshotVersion?: number; chunkIndex?: number } = {}) => {
	const buffer = new ArrayBuffer(INIT_RENDER_CHUNK_HEADER_SIZE + points.length * INIT_RENDER_CHUNK_RECORD_SIZE);
	const view = new DataView(buffer);
	view.setUint32(0, options.magic ?? INIT_RENDER_CHUNK_MAGIC, false);
	view.setUint16(4, INIT_RENDER_CHUNK_VERSION, false);
	view.setUint16(6, INIT_RENDER_CHUNK_RECORD_SIZE, false);
	view.setUint32(8, options.snapshotVersion ?? 1, false);
	view.setUint32(12, options.chunkIndex ?? 0, false);
	view.setUint32(16, points.length, false);
	let offset = INIT_RENDER_CHUNK_HEADER_SIZE;
	for (const point of points) {
		view.setFloat32(offset, point.x, false);
		offset += 4;
		view.setFloat32(offset, point.y, false);
		offset += 4;
		view.setFloat32(offset, point.p, false);
		offset += 4;
		view.setFloat64(offset, point.lamport, false);
		offset += 8;
		view.setUint16(offset, point.cmdIndex, false);
		offset += 2;
	}
	return buffer;
};

const request = <T>(
	worker: Worker,
	payload: Record<string, unknown>,
	predicate: (data: Record<string, unknown>) => boolean,
	label: string,
	transfer: Transferable[] = []
) =>
	new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			worker.removeEventListener("message", onMessage);
			reject(new Error(`timed out waiting for ${label}`));
		}, 2000);
		const onMessage = (event: MessageEvent) => {
			const data = event.data as Record<string, unknown>;
			if (!predicate(data)) return;
			window.clearTimeout(timer);
			worker.removeEventListener("message", onMessage);
			resolve(data as T);
		};
		worker.addEventListener("message", onMessage);
		worker.postMessage(payload, transfer);
	});

const waitForFrames = () =>
	new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});

const countPaintedPixels = async (canvas: HTMLCanvasElement) => {
	const bitmap = await createImageBitmap(canvas);
	const probe = document.createElement("canvas");
	probe.width = WIDTH;
	probe.height = HEIGHT;
	const context = probe.getContext("2d");
	if (!context) throw new Error("Canvas2D is unavailable");
	context.drawImage(bitmap, 0, 0);
	bitmap.close();
	const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
	let painted = 0;
	for (let index = 3; index < pixels.length; index += 4) {
		if (pixels[index]! > 0) painted += 1;
	}
	return painted;
};

const flatPointsFromScene = (worker: Worker) =>
	request<{ points: Array<{ cmdId: string; x: number; y: number }> }>(
		worker,
		{ type: "flat-points-from-scene", data: { pageId: 0, transformingCmdIds: [] } },
		(data) => data.type === "flat-points-result",
		"flat-points-result"
	);

const commandPoints = (worker: Worker, requestId: string) =>
	request<{ commands: Array<{ cmdId: string; points: Array<{ x: number; y: number }> }> }>(
		worker,
		{ type: "get-command-points", data: { requestId, cmdIds: ["cmd-1"] } },
		(data) => data.type === "command-points-result" && data.requestId === requestId,
		"command-points-result"
	);

describe("canvas worker init render stream", () => {
	let worker: Worker | null = null;

	afterEach(() => {
		worker?.terminate();
		worker = null;
	});

	it("only starts painting after the first valid init render chunk and settles init", async () => {
		const canvas = document.createElement("canvas");
		canvas.width = WIDTH;
		canvas.height = HEIGHT;
		document.body.appendChild(canvas);

		const offscreen = canvas.transferControlToOffscreen();
		worker = new Worker(new URL("../../src/workers/canvasWorker.ts", import.meta.url), {
			type: "module",
		});

		worker.postMessage(
			{ type: "init-canvas", data: { canvas: offscreen, width: WIDTH, height: HEIGHT, dpr: 1 } },
			[offscreen]
		);
		worker.postMessage({ type: "begin-init-stream", data: { pageId: 0 } });

		// A chunk with a corrupted magic must be rejected without touching the scene.
		worker.postMessage(
			{
				type: "append-init-binary-chunk",
				data: {
					snapshotVersion: 1,
					chunkIndex: 0,
					isLastChunk: true,
					pointCount: 1,
					commands: commandDictionary,
					lamportStart: 1,
					lamportEnd: 1,
					buffer: buildChunk([{ x: 0.5, y: 0.5, p: 0.5, lamport: 1, cmdIndex: 0 }], { magic: 0xdeadbeef }),
				},
			},
			[]
		);
		const beforeChunk = await flatPointsFromScene(worker);
		expect(beforeChunk.points).toEqual([]);
		await waitForFrames();
		expect(await countPaintedPixels(canvas)).toBe(0);

		// The first valid chunk clears/initialises the canvas and paints the stroke.
		worker.postMessage(
			{
				type: "append-init-binary-chunk",
				data: {
					snapshotVersion: 1,
					chunkIndex: 0,
					isLastChunk: true,
					pointCount: 3,
					commands: commandDictionary,
					lamportStart: 1,
					lamportEnd: 3,
					buffer: buildChunk([
						{ x: 0.2, y: 0.3, p: 0.5, lamport: 1, cmdIndex: 0 },
						{ x: 0.5, y: 0.5, p: 0.6, lamport: 2, cmdIndex: 0 },
						{ x: 0.8, y: 0.7, p: 0.7, lamport: 3, cmdIndex: 0 },
					]),
				},
			},
			[]
		);
		const afterChunk = await flatPointsFromScene(worker);
		expect(afterChunk.points).toHaveLength(3);
		await waitForFrames();
		expect(await countPaintedPixels(canvas)).toBeGreaterThan(0);

		// init completion settles the scene: the worker keeps the ingested points.
		worker.postMessage({ type: "finish-init-stream" });
		const settled = await commandPoints(worker, "init-settled");
		expect(settled.commands[0]?.cmdId).toBe("cmd-1");
		expect(settled.commands[0]?.points).toHaveLength(3);

		const afterFinish = await flatPointsFromScene(worker);
		expect(afterFinish.points).toHaveLength(3);
	});
});
