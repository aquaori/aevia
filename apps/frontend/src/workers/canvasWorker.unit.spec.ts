import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock2dContext = (canvas?: { width: number; height: number }) => ({
	canvas: canvas ?? { width: 800, height: 600 },
	save: vi.fn(),
	restore: vi.fn(),
	setTransform: vi.fn(),
	scale: vi.fn(),
	clearRect: vi.fn(),
	fillRect: vi.fn(),
	strokeRect: vi.fn(),
	beginPath: vi.fn(),
	closePath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	quadraticCurveTo: vi.fn(),
	arc: vi.fn(),
	ellipse: vi.fn(),
	rect: vi.fn(),
	clip: vi.fn(),
	fill: vi.fn(),
	stroke: vi.fn(),
	setLineDash: vi.fn(),
	translate: vi.fn(),
	transform: vi.fn(),
	drawImage: vi.fn(),
	fillText: vi.fn(),
	measureText: vi.fn(() => ({ width: 20 })),
	createPattern: vi.fn(() => ({})),
	createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
	lineCap: "round",
	lineJoin: "round",
	lineWidth: 1,
	fillStyle: "#000",
	strokeStyle: "#000",
	globalAlpha: 1,
	globalCompositeOperation: "source-over",
	lineDashOffset: 0,
	font: "",
	textAlign: "left",
	textBaseline: "top",
	shadowColor: "",
	shadowBlur: 0,
	shadowOffsetX: 0,
	shadowOffsetY: 0,
});

const buildInitBinaryChunkBuffer = (snapshotVersion: number, chunkIndex: number, pointCount: number) => {
	const buf = new ArrayBuffer(20 + pointCount * 22);
	const view = new DataView(buf);
	view.setUint32(0, 0x49524348, false);
	view.setUint16(4, 1, false);
	view.setUint16(6, 22, false);
	view.setUint32(8, snapshotVersion, false);
	view.setUint32(12, chunkIndex, false);
	view.setUint32(16, pointCount, false);
	for (let i = 0; i < pointCount; i += 1) {
		const offset = 20 + i * 22;
		view.setFloat32(offset, 0.1 + i * 0.1, false);
		view.setFloat32(offset + 4, 0.2 + i * 0.1, false);
		view.setFloat32(offset + 8, 0.5, false);
		view.setFloat64(offset + 12, i + 1, false);
		view.setUint16(offset + 20, 0, false);
	}
	return buf;
};

describe("canvasWorker", () => {
	type PostedMsg = { type?: string; valid?: boolean; requestId?: string; buffer?: unknown; rects?: unknown[]; reason?: string };
	let posted: PostedMsg[] = [];

	beforeEach(async () => {
		posted = [];
		vi.resetModules();
		vi.stubGlobal("postMessage", (msg: unknown) => {
			posted.push(msg);
		});
		vi.stubGlobal("self", globalThis);
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(performance.now());
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());

		class MockPath2D {
			moveTo = vi.fn();
			lineTo = vi.fn();
			quadraticCurveTo = vi.fn();
			arc = vi.fn();
		}
		vi.stubGlobal("Path2D", MockPath2D);

		class MockOffscreenCanvas {
			width: number;
			height: number;
			private ctx: ReturnType<typeof createMock2dContext>;
			constructor(width = 800, height = 600) {
				this.width = width;
				this.height = height;
				this.ctx = createMock2dContext(this);
			}
			getContext() {
				return this.ctx;
			}
		}
		vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);

		await import("./canvasWorker");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const dispatch = (type: string, data?: unknown) => {
		globalThis.onmessage?.(new MessageEvent("message", { data: { type, data } }));
	};

	it("handles canvas init, streaming init lifecycle, scene ops, queries, IR export, dirty renders, and dispose", () => {
		const canvas = new OffscreenCanvas(800, 600);
		dispatch("lab-configure", { enabled: true });
		dispatch("init-canvas", { canvas, width: 800, height: 600, dpr: 1 });
		dispatch("resize", { width: 1024, height: 768, dpr: 2 });

		// Init stream lifecycle + invalid/valid binary chunk + scene op finish
		dispatch("begin-init-stream", { pageId: 0 });
		dispatch("append-init-points", {
			points: [
				{ x: 0.1, y: 0.1, p: 0.5, lamport: 1, cmdId: "p-init", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: false },
				{ x: 0.2, y: 0.2, p: 0.6, lamport: 2, cmdId: "p-init", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: false },
			],
		});
		dispatch("append-init-binary-chunk", {
			snapshotVersion: 1,
			chunkIndex: 0,
			pointCount: 1,
			buffer: buildInitBinaryChunkBuffer(1, 0, 1),
			commands: [{ cmdIndex: 0, cmdId: "p-bin", userId: "u1", tool: "pen", color: "#111", size: 3, isDeleted: false }],
		});
		dispatch("set-init-scene-operations", {
			pageId: 0,
			commands: [
				{
					id: "op-rect",
					type: "scene-op",
					pageId: 0,
					userId: "u1",
					lamport: 10,
					isDeleted: false,
					box: { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.5, width: 0.3, height: 0.3 },
					sceneOperation: {
						schemaVersion: 2,
						opId: "op-rect",
						elementId: "rect-1",
						actorId: "u1",
						roomId: "r1",
						historyGroupId: "hg1",
						pageId: 0,
						lamport: 10,
						kind: "element.create",
						payload: {
							descriptor: {
								elementKind: "shape",
								recipeId: "shape",
								toolId: "rectangle",
								style: { color: "#000", size: 2 },
								start: { x: 0.2, y: 0.2 },
								end: { x: 0.5, y: 0.5 },
							},
						},
					},
				},
			],
		});
		dispatch("init-scene-barrier", { requestId: "bar-1" });
		dispatch("finish-init-stream", {});
		expect(posted.some((m) => m.type === "init-scene-barrier-result" && m.valid === true)).toBe(true);

		// Render watermarks & Render IR (full + delta)
		dispatch("get-render-watermarks", { requestId: "wm-1", epoch: 1 });
		dispatch("get-render-ir", { requestId: "ir-1", epoch: 1 });
		expect(posted.some((m) => m.type === "render-watermarks" && m.requestId === "wm-1")).toBe(true);
		expect(posted.some((m) => m.type === "render-ir" && m.requestId === "ir-1" && m.buffer !== null)).toBe(true);

		// Hit test, query, get-command-points, compute-erase-targets, flat-points-from-scene
		dispatch("scene-hit-test", { requestId: "hit-1", x: 0.35, y: 0.35 });
		dispatch("scene-query-elements", {
			requestId: "qry-1",
			rect: { minX: 0.1, minY: 0.1, maxX: 0.6, maxY: 0.6, width: 0.5, height: 0.5 },
		});
		dispatch("get-command-points", { requestId: "pts-1", cmdIds: ["p-init"] });
		dispatch("compute-erase-targets", {
			requestId: "ers-1",
			points: [{ x: 0.15, y: 0.15, p: 0.5, lamport: 11 }],
			size: 20,
			wholeObjects: false,
		});
		dispatch("flat-points-from-scene", { requestId: "fps-1", transformingCmdIds: [] });

		// Incremental batch + finish + dirty renders + merge rects + transfer batch
		dispatch("render-increment-batch", [
			{
				cmd: { id: "inc-1", type: "path", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: false },
				points: [{ x: 0.6, y: 0.6, p: 0.5, lamport: 12 }, { x: 0.7, y: 0.7, p: 0.5, lamport: 13 }],
			},
		]);
		dispatch("finish-command-stroke", { cmdId: "inc-1" });
		dispatch("render-dirty", { pageId: 0, rect: { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 }, transformingCmdIds: [] });
		dispatch("render-dirty-regions", { pageId: 0, rects: [{ minX: 0, minY: 0, maxX: 50, maxY: 50, width: 50, height: 50 }], transformingCmdIds: [] });
		dispatch("merge-dirty-rects", {
			epoch: 1,
			rects: [
				{ minX: 0, minY: 0, maxX: 20, maxY: 20, width: 20, height: 20, candidateCommandIds: ["a"] },
				{ minX: 10, minY: 10, maxX: 30, maxY: 30, width: 20, height: 20, candidateCommandIds: ["b"] },
			],
		});
		expect(posted.some((m) => m.type === "merge-dirty-rects-result" && m.rects?.length === 1)).toBe(true);

		// Legacy update + remove + rerender + transfer batch + bad binary chunk
		dispatch("update-command-state", {
			cmd: { id: "p-init", type: "path", pageId: 0, tool: "pen", color: "#000", size: 3, isDeleted: true, lamport: 20, box: { minX: 0, minY: 0, maxX: 0.2, maxY: 0.2, width: 0.2, height: 0.2 } },
		});
		dispatch("remove-command-state", { cmdId: "p-init" });
		dispatch("rerender-scene", { pageId: 0, transformingCmdIds: [] });
		const encodedBatch = new TextEncoder().encode(JSON.stringify([]));
		dispatch("scene-batch-transfer", { buffer: encodedBatch.buffer });

		dispatch("append-init-binary-chunk", {
			snapshotVersion: 1,
			chunkIndex: 0,
			pointCount: 1,
			buffer: new ArrayBuffer(4),
			commands: [],
		});
		expect(posted.some((m) => m.type === "scene-resync-required" && m.reason === "invalid-render-chunk")).toBe(true);

		// Full scene sync, render-full, live scene operations (append, transform, erase, history, clear), and background flat-points
		const penCreateCmd = {
			id: "op-pen-1",
			type: "scene-op",
			pageId: 0,
			userId: "u1",
			lamport: 21,
			isDeleted: false,
			box: { minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, width: 0.1, height: 0.1 },
			sceneOperation: {
				schemaVersion: 2,
				opId: "op-pen-1",
				elementId: "pen-1",
				actorId: "u1",
				roomId: "r1",
				historyGroupId: "hg-pen-1",
				pageId: 0,
				lamport: 21,
				kind: "element.create",
				payload: {
					descriptor: {
						elementKind: "path",
						recipeId: "stroke",
						toolId: "pen",
						style: { color: "#000", size: 3 },
						points: [{ x: 0.1, y: 0.1, p: 0.5, lamport: 21 }],
					},
					points: [{ x: 0.1, y: 0.1, p: 0.5, lamport: 21 }],
				},
			},
		};
		dispatch("render-full", { commands: [penCreateCmd], pageId: 0, transformingCmdIds: [] });
		dispatch("update-command-state", {
			dispatchSeq: 5,
			cmd: {
				...penCreateCmd,
				id: "op-pen-app",
				lamport: 22,
				sceneOperation: {
					...penCreateCmd.sceneOperation,
					opId: "op-pen-app",
					kind: "element.append",
					payload: { points: [{ x: 0.2, y: 0.2, p: 0.6, lamport: 22 }], sourceStart: 1, isComplete: true },
				},
			},
		});
		dispatch("update-command-state", {
			dispatchSeq: 6,
			epoch: 0,
			cmd: {
				...penCreateCmd,
				id: "op-pen-tr",
				lamport: 23,
				sceneOperation: {
					...penCreateCmd.sceneOperation,
					opId: "op-pen-tr",
					kind: "element.transform",
					payload: { targets: [{ elementId: "pen-1", deltaMatrix: [1, 0, 0, 1, 0.05, 0.05] }] },
				},
			},
		});
		dispatch("update-command-state", {
			dispatchSeq: 7,
			cmd: {
				...penCreateCmd,
				id: "op-pen-hist",
				lamport: 24,
				sceneOperation: {
					...penCreateCmd.sceneOperation,
					opId: "op-pen-hist",
					kind: "history.toggle",
					payload: { targetHistoryGroupId: "hg-pen-1", isDeleted: true },
				},
			},
		});
		dispatch("render-flat-points-scene", {
			pageId: 0,
			points: [{ x: 0.3, y: 0.3, p: 0.5, lamport: 30, cmdId: "fp-1", pageId: 0, userId: "u1", tool: "pen", color: "#000", size: 3, isDeleted: false }],
		});
		dispatch("flat-points", { requestId: "fp-bg-1", commands: [penCreateCmd], pageId: 0, transformingCmdIds: [] });
		dispatch("sync-scene", { commands: [penCreateCmd], pageId: 0, transformingCmdIds: [] });

		dispatch("dispose", {});
	});
});
