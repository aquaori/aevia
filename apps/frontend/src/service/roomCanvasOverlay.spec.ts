import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX, type Command, type EditorTool, type RemoteCursor, type StrokePattern, type aabbBox } from "@collaborative-whiteboard/shared";
import type { ProductPreviewState } from "../states/roomInteractionState";
import { uiCanvasRef, uiCtx } from "./canvas";
import { createRoomCanvasOverlay } from "./roomCanvasOverlay";

const createMockCtx = () =>
	({
		save: vi.fn(),
		restore: vi.fn(),
		beginPath: vi.fn(),
		closePath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		arc: vi.fn(),
		rect: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		clearRect: vi.fn(),
		fillRect: vi.fn(),
		strokeRect: vi.fn(),
		setLineDash: vi.fn(),
		translate: vi.fn(),
		scale: vi.fn(),
		setTransform: vi.fn(),
		fillText: vi.fn(),
		measureText: vi.fn(() => ({ width: 42 })),
		globalAlpha: 1,
		fillStyle: "#000",
		strokeStyle: "#000",
		lineWidth: 1,
		lineCap: "round",
		lineJoin: "round",
		font: "",
		textBaseline: "middle",
		shadowColor: "",
		shadowBlur: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
	}) as unknown as CanvasRenderingContext2D;

describe("createRoomCanvasOverlay", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			return window.setTimeout(() => cb(performance.now()), 16);
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
		uiCanvasRef.value = { width: 800, height: 600 } as HTMLCanvasElement;
		uiCtx.value = createMockCtx();
		Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		uiCanvasRef.value = null;
		uiCtx.value = null;
	});

	const createOptions = () => {
		const shapeCmd: Command = {
			id: "el-1",
			type: "scene-op",
			pageId: 0,
			userId: "u1",
			lamport: 1,
			isDeleted: false,
			box: { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 },
			sceneOperation: {
				schemaVersion: 2,
				opId: "el-1",
				elementId: "el-1",
				actorId: "u1",
				roomId: "r1",
				historyGroupId: "hg1",
				pageId: 0,
				lamport: 1,
				kind: "element.create",
				payload: {
					descriptor: {
						elementKind: "shape",
						recipeId: "shape",
						toolId: "rectangle",
						style: { color: "#000", size: 2 },
						start: { x: 0.1, y: 0.1 },
						end: { x: 0.3, y: 0.3 },
					},
				},
			},
		};
		return {
			interactionMode: ref<"none" | "box-selecting" | "dragging" | "resizing" | "rotating">("box-selecting"),
			selectionRect: ref<{ x: number; y: number; w: number; h: number } | null>({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
			remoteSelectionRects: ref(new Map([["remote-1", { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }]])),
			transformAnim: ref<{ progress: number; phase: "entering" | "dragging" | "exiting"; initialBox: aabbBox | null } | null>({
				progress: 0.9,
				phase: "entering",
				initialBox: { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 },
			}),
			transformingCmdIds: ref(new Set(["el-1"])),
			previewTransform: ref(IDENTITY_MATRIX),
			selectedCommandIds: ref(new Set(["el-1"])),
			selectedSceneBounds: ref<aabbBox | null>({ minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 }),
			productPreview: ref<ProductPreviewState | null>({
				tool: "rectangle",
				start: { x: 0.1, y: 0.1 },
				end: { x: 0.4, y: 0.4 },
				points: [],
			}),
			currentTool: ref<EditorTool>("rectangle"),
			currentColor: ref("#111"),
			currentSize: ref(3),
			currentStrokePattern: ref<StrokePattern>("solid"),
			currentSticker: ref("✨"),
			commands: ref([shapeCmd]),
			commandMap: new Map([["el-1", shapeCmd]]),
			currentPageId: ref(0),
			remoteCursors: ref<Map<string, RemoteCursor>>(
				new Map([
					["u2", { userId: "u2", userName: "Alice", color: "#00f", pageId: 0, x: 0.5, y: 0.5, lastUpdate: Date.now() }],
					["u3", { userId: "u3", userName: "Old", color: "#0f0", pageId: 0, x: 0.6, y: 0.6, lastUpdate: Date.now() - 20000 }],
				]),
			),
			userId: ref("u1"),
			finalizeDrop: vi.fn(),
			getGroupBoundingBox: vi.fn(() => ({ minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 })),
			requestFlatPoints: vi.fn((_payload, cb) => cb?.([])),
		};
	};

	it("renders previews, selection, transform phases, handles, remote cursors, and preview canvas", () => {
		const opts = createOptions();
		const overlay = createRoomCanvasOverlay(opts);

		// Render shape preview + selection + entering anim -> transitions to dragging
		overlay.render();
		expect(opts.transformAnim.value?.phase).toBe("dragging");
		expect(opts.remoteCursors.value.has("u3")).toBe(false);

		// Eraser & sticker preview modes + exiting animation finalizeDrop
		opts.productPreview.value = { tool: "eraser", start: { x: 0.1, y: 0.1 }, end: { x: 0.2, y: 0.2 }, points: [] };
		opts.transformAnim.value = { progress: 0.05, phase: "exiting", initialBox: null };
		overlay.render();
		expect(opts.finalizeDrop).toHaveBeenCalled();

		opts.productPreview.value = { tool: "sticker", start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 }, points: [] };
		overlay.render();

		// Watcher loop + cleanup
		overlay.startLoop();
		vi.advanceTimersByTime(32);
		overlay.stopLoop();

		// Render thumbnail preview canvas
		const thumb = document.createElement("canvas");
		vi.spyOn(thumb, "getContext").mockReturnValue(createMockCtx());
		vi.spyOn(thumb, "getBoundingClientRect").mockReturnValue({ width: 120, height: 90 } as DOMRect);
		overlay.renderPreviewCanvas(thumb, 0);
		vi.advanceTimersByTime(32);
		expect(opts.requestFlatPoints).toHaveBeenCalled();
	});

	it("keeps a lazy cursor expiry deadline across active cursor updates without clearing timers every frame", () => {
		const opts = createOptions();
		opts.interactionMode.value = "none";
		opts.selectionRect.value = null;
		opts.remoteSelectionRects.value.clear();
		opts.transformAnim.value = null;
		opts.transformingCmdIds.value.clear();
		opts.selectedCommandIds.value.clear();
		opts.productPreview.value = null;
		opts.remoteCursors.value.delete("u3");

		const setTimeoutSpy = vi.spyOn(window, "setTimeout");
		const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

		const overlay = createRoomCanvasOverlay(opts);
		const t0 = Date.now();
		opts.remoteCursors.value.set("u2", {
			userId: "u2",
			userName: "Alice",
			color: "#00f",
			pageId: 0,
			x: 0.2,
			y: 0.2,
			lastUpdate: t0,
		});
		overlay.render();
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

		for (let i = 1; i <= 10; i += 1) {
			vi.advanceTimersByTime(200);
			opts.remoteCursors.value.set("u2", {
				userId: "u2",
				userName: "Alice",
				color: "#00f",
				pageId: 0,
				x: 0.2 + i * 0.02,
				y: 0.2,
				lastUpdate: Date.now(),
			});
			overlay.render();
		}
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(0);

		// Stop moving cursor and advance past remaining expiry window -> cursor pruned after 10s idle
		vi.advanceTimersByTime(10500);
		expect(opts.remoteCursors.value.has("u2")).toBe(false);
	});
});
