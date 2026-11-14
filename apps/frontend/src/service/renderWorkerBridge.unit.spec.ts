import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { Command } from "@collaborative-whiteboard/shared";
import { cloneCommandForStateSync, createRenderWorkerBridge } from "./renderWorkerBridge";

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
			worker!.onmessage?.({ data: { type: "scene-operation-rendered", opId: "lab-only" } });
			await pending;
			expect(settled).toBe(true);
		} finally {
			bridge.dispose();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
