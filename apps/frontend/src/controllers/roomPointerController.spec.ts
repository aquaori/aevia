import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX, type AffineMatrix, type Command, type EditorTool, type EraseTarget, type Point, type StrokePattern, type aabbBox } from "@collaborative-whiteboard/shared";
import type { HandleType, InteractionMode, ProductPreviewState, TransformAnimState } from "../states/roomInteractionState";
import { canvasRef, ctx } from "../service/canvas";
import { createInteractionController } from "./interactionController";
import { createRoomPointerController } from "./roomPointerController";

const makeMockPointerEvent = (type: string, x: number, y: number, pointerId = 1) =>
	({
		type,
		clientX: x,
		clientY: y,
		pressure: 0.5,
		pointerType: "mouse",
		pointerId,
		timeStamp: performance.now(),
		getCoalescedEvents: () => [],
		target: {
			setPointerCapture: vi.fn(),
			hasPointerCapture: vi.fn(() => true),
			releasePointerCapture: vi.fn(),
		},
	}) as unknown as PointerEvent;

describe("createRoomPointerController", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(performance.now());
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const canvas = document.createElement("canvas");
		canvas.width = 1000;
		canvas.height = 800;
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 1000,
			height: 800,
			right: 1000,
			bottom: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		canvasRef.value = canvas;
		ctx.value = {
			save: vi.fn(),
			restore: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			quadraticCurveTo: vi.fn(),
			arc: vi.fn(),
			fill: vi.fn(),
			stroke: vi.fn(),
			globalCompositeOperation: "source-over",
			strokeStyle: "#000",
			fillStyle: "#000",
			lineWidth: 1,
		} as unknown as CanvasRenderingContext2D;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		canvasRef.value = null;
		ctx.value = null;
	});

	const makeController = () => {
		const commands = ref<Command[]>([]);
		const commandMap = new Map<string, Command>();
		const pushCommand = vi.fn((cmd: Partial<Command>) => {
			const full = { id: cmd.id || "id-1", ...cmd } as Command;
			commands.value.push(full);
			commandMap.set(full.id, full);
			return { ok: true, command: full };
		});
		const opts = {
			currentTool: ref<EditorTool>("pen"),
			currentColor: ref("#111111"),
			currentSize: ref(4),
			currentStrokePattern: ref<StrokePattern>("solid"),
			currentSticker: ref("✨"),
			currentPageId: ref(0),
			roomId: ref("880001"),
			userId: ref("u1"),
			username: ref("Alice"),
			isDrawing: ref(false),
			activePointerId: ref<number | null>(null),
			currentDrawingId: ref<string | null>(null),
			cursorX: ref(0),
			cursorY: ref(0),
			interactionMode: ref<InteractionMode>("none"),
			activeTransformHandle: ref<HandleType>(null),
			dragStartPos: ref<{ x: number; y: number } | null>(null),
			selectionRect: ref<{ x: number; y: number; w: number; h: number } | null>(null),
			selectedCommandIds: ref(new Set<string>()),
			transformingCmdIds: ref(new Set<string>()),
			initialCmdsState: ref(new Map<string, Point[]>()),
			previewTransform: ref<AffineMatrix | null>(null),
			initialGroupBox: ref<aabbBox | null>(null),
			selectedSceneBounds: ref<aabbBox | null>(null),
			productPreview: ref<ProductPreviewState | null>(null),
			canvasCursor: ref("default"),
			transformAnim: ref<TransformAnimState | null>(null),
			activeMenu: ref<"pen" | "eraser" | "color" | "more" | null>(null),
			commands,
			commandMap,
			lastXRef: ref(0),
			lastYRef: ref(0),
			lastWidthRef: ref(0),
			pointerHotState: { currentPathPoints: [], pendingPoints: [], lastSentPos: { x: 0, y: 0 } },
			interactionController: createInteractionController(),
			canvasRuntime: { eraseDirtyRect: vi.fn() },
			renderIncrementalCommand: vi.fn(),
			renderSinglePointCommand: vi.fn(),
			finishIncrementalCommand: vi.fn(),
			isOffscreenMainCanvas: () => true,
			syncCommandState: vi.fn(),
			waitForSceneOperationRender: vi.fn().mockResolvedValue(undefined),
			send: vi.fn(() => true),
			pushCommand,
			renderCanvas: vi.fn(),
			hydrateCommandPoints: vi.fn().mockResolvedValue(undefined),
			computeEraseTargets: vi.fn().mockResolvedValue([]),
			hitTestScene: vi.fn().mockResolvedValue({ elementId: null, bounds: null }),
			querySceneElements: vi.fn().mockResolvedValue({ elementIds: [], bounds: null }),
			requestTextInput: vi.fn().mockResolvedValue("Hello Aevia"),
			getCommandBoundingBox: (c: Command) => c.box ?? null,
			getGroupBoundingBox: () => ({ minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 }),
			onToolStateUpdated: vi.fn(),
		};
		const controller = createRoomPointerController(opts);
		return { controller, opts, pushCommand };
	};

	it("draws freehand strokes, updates tool/color, and supports cancelLocalDrawing", async () => {
		const { controller, opts, pushCommand } = makeController();
		controller.setColor("#ff0000");
		controller.setTool("pen");
		expect(opts.onToolStateUpdated).toHaveBeenCalled();

		await controller.startDrawing(makeMockPointerEvent("pointerdown", 100, 100));
		controller.draw(makeMockPointerEvent("pointermove", 200, 200));
		await controller.stopDrawing(makeMockPointerEvent("pointerup", 250, 250));
		expect(pushCommand).toHaveBeenCalled();
		expect(opts.isDrawing.value).toBe(false);

		// Start again and cancel mid-stroke
		await controller.startDrawing(makeMockPointerEvent("pointerdown", 150, 150));
		controller.cancelLocalDrawing();
		expect(opts.isDrawing.value).toBe(false);
		expect(opts.currentDrawingId.value).toBeNull();
	});

	it("handles shape tool, text tool creation & editing, and cursor box-select + drag", async () => {
		const { controller, opts, pushCommand } = makeController();

		// Rectangle creation
		controller.setTool("rectangle");
		await controller.startDrawing(makeMockPointerEvent("pointerdown", 100, 100));
		controller.draw(makeMockPointerEvent("pointermove", 300, 300));
		await controller.stopDrawing(makeMockPointerEvent("pointerup", 300, 300));
		expect(pushCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "scene-op" }));

		// Text tool creation
		controller.setTool("text");
		await controller.startDrawing(makeMockPointerEvent("pointerdown", 400, 400));
		await controller.stopDrawing(makeMockPointerEvent("pointerup", 400, 400));
		expect(opts.requestTextInput).toHaveBeenCalled();

		// Cursor box selection
		controller.setTool("cursor");
		await controller.startDrawing(makeMockPointerEvent("pointerdown", 50, 50));
		controller.draw(makeMockPointerEvent("pointermove", 350, 350));
		await controller.stopDrawing(makeMockPointerEvent("pointerup", 350, 350));
		expect(opts.querySceneElements).toHaveBeenCalled();

		// Finalize drop resets transform state
		opts.transformingCmdIds.value.add("id-1");
		opts.previewTransform.value = IDENTITY_MATRIX;
		controller.finalizeDrop();
		expect(opts.transformingCmdIds.value.size).toBe(0);
	});

	it("erases targets with eraser/object-eraser, drags selected elements, and commits element.transform", async () => {
		const { controller, opts, pushCommand } = makeController();
		opts.computeEraseTargets.mockResolvedValue([{ elementId: "p1", segmentStart: 0, segmentEnd: 1 } as unknown as EraseTarget]);

		// Eraser flow
		controller.setTool("eraser");
		await controller.startDrawing(makeMockPointerEvent("pointerdown", 100, 100));
		controller.draw(makeMockPointerEvent("pointermove", 220, 220));
		await controller.stopDrawing(makeMockPointerEvent("pointerup", 250, 250));
		expect(opts.computeEraseTargets).toHaveBeenCalled();

		// Pre-select an element with scene bounds and drag to commit element.transform
		const cmd: Command = {
			id: "el-drag",
			type: "scene-op",
			pageId: 0,
			userId: "u1",
			lamport: 2,
			isDeleted: false,
			box: { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 },
		};
		opts.commands.value.push(cmd);
		opts.commandMap.set(cmd.id, cmd);
		opts.selectedCommandIds.value = new Set([cmd.id]);
		opts.selectedSceneBounds.value = { minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.3, width: 0.2, height: 0.2 };
		opts.hitTestScene.mockResolvedValue({ elementId: cmd.id, bounds: cmd.box! });

		controller.setTool("cursor");
		await controller.startDrawing(makeMockPointerEvent("pointerdown", 200, 160));
		controller.draw(makeMockPointerEvent("pointermove", 320, 260));
		await controller.stopDrawing(makeMockPointerEvent("pointerup", 320, 260));
		expect(pushCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "scene-op",
				sceneOperation: expect.objectContaining({ kind: "element.transform" }),
			}),
		);

		// editSelectedText opens editor on hit text command
		const txtCmd: Command = {
			id: "txt-edit",
			type: "scene-op",
			pageId: 0,
			userId: "u1",
			lamport: 3,
			isDeleted: false,
			box: { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.4, width: 0.3, height: 0.2 },
			sceneOperation: {
				schemaVersion: 2,
				opId: "txt-edit",
				elementId: "txt-edit",
				actorId: "u1",
				roomId: "880001",
				historyGroupId: "hg-t",
				pageId: 0,
				lamport: 3,
				kind: "element.create",
				payload: {
					descriptor: {
						elementKind: "text",
						recipeId: "text",
						toolId: "text",
						style: { color: "#000", size: 2 },
						box: { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.4, width: 0.3, height: 0.2 },
						text: "Original",
					},
				},
			},
		};
		opts.commands.value.push(txtCmd);
		opts.commandMap.set(txtCmd.id, txtCmd);
		opts.hitTestScene.mockResolvedValue({ elementId: txtCmd.id, bounds: txtCmd.box! });
		await controller.editSelectedText(makeMockPointerEvent("dblclick", 250, 250));
		expect(opts.requestTextInput).toHaveBeenCalled();
	});
});
