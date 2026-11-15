import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { Command } from "@collaborative-whiteboard/shared";
import { cloneCommandForStateSync, createRenderWorkerBridge } from "./renderWorkerBridge";
import { SceneCore } from "../scene/sceneCore";
import { diffRenderIR } from "../scene/renderIR";
import { encodeRenderIR } from "../scene/renderIRCodec";

const command = (points: Command["points"]): Command => ({
	id: "cmd-1",
	type: "path",
	tool: "pen",
	color: "#000000",
	size: 4,
	points,
	timestamp: 1,
	userId: "user-1",
	roomId: "room-1",
	pageId: 0,
	isDeleted: false,
	lamport: 1,
	box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
});

describe("cloneCommandForStateSync", () => {
	it("preserves omitted points so metadata updates do not erase worker geometry", () => {
		const cloned = cloneCommandForStateSync(command(undefined));

		expect(cloned.points).toBeUndefined();
	});

	it("deep-clones points when geometry replacement is intentional", () => {
		const source = command([{ x: 0.1, y: 0.2, p: 0.5, lamport: 1 }]);
		const cloned = cloneCommandForStateSync(source);

		expect(cloned.points).toEqual(source.points);
		expect(cloned.points).not.toBe(source.points);
	});

	it("removes Vue proxies from nested scene operations before posting to the worker", () => {
		const source = reactive({
			...command(undefined),
			id: "transform-1",
			type: "scene-op" as const,
			schemaVersion: 2 as const,
			sceneOperation: {
				schemaVersion: 2 as const,
				opId: "transform-1",
				elementId: "stroke-1",
				actorId: "user-1",
				roomId: "room-1",
				pageId: 0,
				lamport: 2,
				historyGroupId: "transform-1",
				kind: "element.transform" as const,
				payload: { targets: [{ elementId: "stroke-1", deltaMatrix: [1, 0, 0, 1, 0.1, 0.2] as const }] },
			},
		});

		const cloned = cloneCommandForStateSync(source);
		expect(() => structuredClone(cloned)).not.toThrow();
		expect(cloned.sceneOperation).not.toBe(source.sceneOperation);
	});
});

describe("worker acknowledgement isolation", () => {
	it("reconstructs versioned render frames from worker full and delta messages", async () => {
		let worker: { onmessage?: (event: { data: unknown }) => void; sent: { type: string; data?: { requestId?: string; epoch?: number; baseRevision?: number | null } }[] };
		vi.stubGlobal("Worker", class {
			onmessage?: (event: { data: unknown }) => void;
			sent: { type: string; data?: { requestId?: string; epoch?: number; baseRevision?: number | null } }[] = [];
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			constructor() { worker = this; }
			postMessage(message: { type: string; data?: { requestId?: string; epoch?: number; baseRevision?: number | null } }) { this.sent.push(message); }
			terminate() {}
		});
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			const core = new SceneCore();
			const initial = core.getRenderIR();
			const first = bridge.requestRenderIR();
			let request = worker!.sent.at(-1)!.data!;
			worker!.onmessage?.({ data: { type: "render-ir", requestId: request.requestId, epoch: request.epoch, buffer: encodeRenderIR(initial).buffer } });
			expect(await first).toEqual(initial);
			core.applyOperation({ schemaVersion: 2, opId: "a", elementId: "a", actorId: "u", roomId: "r", pageId: 0, lamport: 1, historyGroupId: "a", kind: "element.create", payload: { descriptor: { elementKind: "shape", toolId: "rectangle", recipeId: "shape", shapeKind: "rectangle", style: { color: "#000", size: 1 }, box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 } } } });
			const next = core.getRenderIR();
			const second = bridge.requestRenderIR();
			request = worker!.sent.at(-1)!.data!;
			expect(request.baseRevision).toBe(initial.revision);
			worker!.onmessage?.({ data: { type: "render-ir", requestId: request.requestId, epoch: request.epoch, buffer: encodeRenderIR(diffRenderIR(initial, next)).buffer } });
			expect(await second).toEqual(next);
		} finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("reports dispatch, scene and presentation watermarks independently", async () => {
		let worker: { onmessage?: (event: { data: unknown }) => void; sent: { type: string; data?: { requestId?: string; epoch?: number } }[] };
		vi.stubGlobal("Worker", class {
			onmessage?: (event: { data: unknown }) => void;
			sent: { type: string; data?: { requestId?: string; epoch?: number } }[] = [];
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			constructor() { worker = this; }
			postMessage(message: { type: string; data?: { requestId?: string; epoch?: number } }) { this.sent.push(message); }
			terminate() {}
		});
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			bridge.syncCommandState(command([]));
			bridge.syncCommandState(command([]));
			const pending = bridge.requestRenderWatermarks();
			const request = worker!.sent.at(-1)!.data!;
			worker!.onmessage?.({ data: { type: "render-watermarks", requestId: request.requestId, epoch: request.epoch, processedDispatchSeq: 1, sceneRevision: 5, presentedRevision: 3 } });
			expect(await pending).toEqual({ epoch: 0, submittedDispatchSeq: 2, processedDispatchSeq: 1, sceneRevision: 5, presentedRevision: 3 });
		} finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("reports that the main-thread renderer is needed when worker creation fails", () => {
		vi.stubGlobal("Worker", class { constructor() { throw new Error("worker unavailable"); } });
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try { expect(bridge.init()).toBe(false); }
		finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("allows main-thread fallback when canvas transfer is unavailable", () => {
		vi.stubGlobal("Worker", class { postMessage() {} terminate() {} });
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			const canvas = { transferControlToOffscreen: () => { throw new Error("transfer unavailable"); } } as unknown as HTMLCanvasElement;
			expect(bridge.bindMainCanvas(canvas, { width: 100, height: 100, dpr: 1 })).toBe(false);
			expect(bridge.isOffscreenEnabled()).toBe(false);
		} finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("discards old page replies when a new snapshot begins", async () => {
		let worker: { onmessage?: (event: { data: unknown }) => void; sent: { type: string; data?: { requestId?: string } }[] };
		vi.stubGlobal("Worker", class {
			onmessage?: (event: { data: unknown }) => void;
			sent: { type: string; data?: { requestId?: string } }[] = [];
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			constructor() { worker = this; }
			postMessage(message: { type: string; data?: { requestId?: string } }) { this.sent.push(message); }
			terminate() {}
		});
		const onMainPoints = vi.fn();
		const bridge = createRenderWorkerBridge({ onMainPoints });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			const pending = bridge.requestSceneHit(10, 20);
			const requestId = worker!.sent.at(-1)!.data!.requestId;
			bridge.beginInitRenderStream(1);
			expect(await pending).toEqual({ elementId: null, bounds: null });
			worker!.onmessage?.({ data: { type: "scene-hit-result", requestId, elementId: "old", bounds: null } });
			worker!.onmessage?.({ data: { type: "flat-points-result", requestId: "old", points: [{ x: 0 }] } });
			let painted = false;
			const paint = bridge.waitForSceneOperationRender("op-1").then(() => { painted = true; });
			worker!.onmessage?.({ data: { type: "scene-operation-rendered", opId: "op-1", epoch: 0 } });
			await Promise.resolve();
			expect(painted).toBe(false);
			worker!.onmessage?.({ data: { type: "scene-operation-rendered", opId: "op-1", epoch: 1 } });
			await paint;
			expect(onMainPoints).not.toHaveBeenCalled();
		} finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("settles pending queries when the worker is disposed", async () => {
		vi.stubGlobal("Worker", class { postMessage() {} terminate() {} });
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			const hit = bridge.requestSceneHit(10, 20);
			bridge.dispose();
			expect(await hit).toEqual({ elementId: null, bounds: null });
		} finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("forwards queued stroke data when animation frames do not run", async () => {
		const messages: string[] = [];
		vi.stubGlobal("requestAnimationFrame", () => 1);
		vi.stubGlobal("Worker", class {
			postMessage(message: { type: string }) { messages.push(message.type); }
			terminate() {}
		});
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			const point = { x: 0.1, y: 0.2, p: 0.5, lamport: 1 };
			bridge.renderIncrementalCommand(command([point]), [point], 0);
			await Promise.resolve();
			expect(messages).toContain("render-increment-batch");
		} finally { bridge.dispose(); vi.unstubAllGlobals(); }
	});

	it("waits for the worker to confirm snapshot processing", async () => {
		let instance: { onmessage?: (event: { data: unknown }) => void; sent: { type: string; data?: { requestId: string } }[] };
		vi.stubGlobal("Worker", class {
			onmessage?: (event: { data: unknown }) => void;
			sent: { type: string; data?: { requestId: string } }[] = [];
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			constructor() { instance = this; }
			postMessage(message: { type: string; data?: { requestId: string } }) { this.sent.push(message); }
			terminate() {}
		});
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			const confirmation = bridge.confirmInitScene();
			const requestId = instance!.sent.at(-1)!.data!.requestId;
			instance!.onmessage?.({ data: { type: "init-scene-barrier-result", requestId, valid: false } });
			expect(await confirmation).toBe(false);
		} finally {
			bridge.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("flushes queued stroke pixels before sending an undo operation", () => {
		const messages: string[] = [];
		vi.stubGlobal("requestAnimationFrame", () => 1);
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.stubGlobal("Worker", class {
			onmessage?: (event: { data: unknown }) => void;
			postMessage(message: { type: string }) { messages.push(message.type); }
			terminate() {}
		});
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			const point = { x: 0.1, y: 0.2, p: 0.5, lamport: 1 };
			bridge.renderIncrementalCommand(command([point]), [point], 0);
			bridge.syncCommandState({
				...command([]), type: "scene-op", schemaVersion: 2,
				sceneOperation: {
					schemaVersion: 2, opId: "undo-1", elementId: "cmd-1", actorId: "user-1",
					roomId: "room-1", pageId: 0, lamport: 2, historyGroupId: "undo-1",
					kind: "history.toggle", payload: { targetHistoryGroupId: "cmd-1", enabled: false },
				},
			});
			expect(messages.slice(-2)).toEqual(["render-increment-batch", "update-command-state"]);
		} finally {
			bridge.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("keeps lab acknowledgements out of business render completion state", async () => {
		vi.useFakeTimers();
		let worker: { onmessage?: (event: { data: unknown }) => void };
		vi.stubGlobal("Worker", class {
			onmessage?: (event: { data: unknown }) => void;
			// The test needs the constructed worker to deliver simulated messages.
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			constructor() { worker = this; }
			postMessage() {}
			terminate() {}
		});
		const bridge = createRenderWorkerBridge({ onMainPoints: () => {} });
		try {
			bridge.init();
			bridge.bindMainCanvas({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, { width: 100, height: 100, dpr: 1 });
			worker!.onmessage?.({ data: { type: "lab:operation-rendered", opId: "lab-only" } });
			let settled = false;
			const pending = bridge.waitForSceneOperationRender("lab-only", 50).then(() => { settled = true; });
			await Promise.resolve();
			expect(settled).toBe(false);
			worker!.onmessage?.({ data: { type: "scene-operation-rendered", opId: "lab-only", epoch: 0 } });
			await pending;
			expect(settled).toBe(true);
		} finally {
			bridge.dispose();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
