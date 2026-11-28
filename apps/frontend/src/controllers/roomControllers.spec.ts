import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasRef, uiCanvasRef } from "../service/canvas";
import { provideRoomSession } from "../service/roomSessionContext";
import * as sessionApi from "../service/sessionApi";
import type { Command, EditorTool, StrokePattern } from "@collaborative-whiteboard/shared";
import type { InteractionMode, TransformAnimState } from "../states/roomInteractionState";
import type { WhiteboardSession } from "../utils/editorTypes";
import { createRoomCommandController } from "./roomCommandController";
import { createRoomEditorController } from "./roomEditorController";
import { createRoomHeaderController } from "./roomHeaderController";
import { createRoomKeyboardController } from "./roomKeyboardController";
import { createRoomLifecycleController } from "./roomLifecycleController";
import { createRoomPanelController } from "./roomPanelController";
import { createRoomToolController } from "./roomToolController";

vi.mock("vue-sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

describe("room UI controllers", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		canvasRef.value = null;
		uiCanvasRef.value = null;
	});

	it("roomCommandController & roomEditorController emit hooks and handle pointerController fallbacks", () => {
		const emitHook = vi.fn();
		const session = { emitHook } as unknown as WhiteboardSession;

		let cmdCtrl!: ReturnType<typeof createRoomCommandController>;
		let edCtrl!: ReturnType<typeof createRoomEditorController>;
		const activeMenu = ref<"pen" | "eraser" | "color" | "more" | null>("pen");
		const pointerController = ref<{ setTool: (tool: EditorTool) => void; setColor: (color: string) => void; finalizeDrop: () => void } | null>(null);
		const currentTool = ref<EditorTool>("pen");
		const currentColor = ref("#000");
			const currentBrushOpacity = ref<number | undefined>(0.5);
		const transformingCmdIds = ref(new Set(["c1"]));
		const transformAnim = ref<TransformAnimState | null>({ phase: "dragging", progress: 1, initialBox: null });
		const selectionRect = ref<{ x: number; y: number; w: number; h: number } | null>({ x: 0, y: 0, w: 1, h: 1 });
		const interactionMode = ref<InteractionMode>("box-selecting");
		const renderCanvas = vi.fn();

		const Host = defineComponent({
			setup() {
				provideRoomSession(session);
				cmdCtrl = createRoomCommandController({
					localCommandService: {
						pushCommand: (cmd) => ({ ok: true, command: { id: "c1", ...cmd } as Command }),
						undo: () => ({ ok: false, error: "nothing to undo" }),
						redo: () => ({ ok: false, error: "nothing to redo" }),
						clearCanvas: () => ({ ok: true, notice: "cleared", command: { id: "clr", type: "clear" } as Command }),
					},
					activeMenu,
				});
				edCtrl = createRoomEditorController({
					pointerController,
					currentTool,
					currentColor,
						currentBrushOpacity,
					activeMenu,
					transformingCmdIds,
					transformAnim,
					renderCanvas,
					selectionRect,
					interactionMode,
				});
				return {};
			},
			template: "<div />",
		});
		mount(Host);

		cmdCtrl.pushCommand({ id: "c1" });
		cmdCtrl.undo();
		cmdCtrl.redo();
		cmdCtrl.clearCanvas();
		expect(activeMenu.value).toBeNull();
		expect(emitHook).toHaveBeenCalledWith("command:applied", expect.any(Object));

		// Fallback paths (no pointerController yet)
		edCtrl.setTool("pen");
			expect(currentBrushOpacity.value).toBeUndefined();
		expect(selectionRect.value).toBeNull();
		expect(interactionMode.value).toBe("none");
		edCtrl.setColor("#ff0000");
		expect(currentColor.value).toBe("#ff0000");
		edCtrl.finalizeDrop();
		expect(transformingCmdIds.value.size).toBe(0);
		expect(renderCanvas).toHaveBeenCalled();

		// Delegating paths (pointerController mounted)
		pointerController.value = { setTool: vi.fn(), setColor: vi.fn(), finalizeDrop: vi.fn() };
		edCtrl.setTool("rectangle");
		edCtrl.setColor("#00ff00");
		edCtrl.finalizeDrop();
		expect(pointerController.value.setTool).toHaveBeenCalledWith("rectangle");
		expect(pointerController.value.setColor).toHaveBeenCalledWith("#00ff00");
		expect(pointerController.value.finalizeDrop).toHaveBeenCalled();
	});

	it("roomHeaderController, roomPanelController, and roomToolController update UI states and clipboard", async () => {
		const headerOpts = {
			roomId: ref("88001"),
			roomName: ref("Design"),
			username: ref("Alice"),
			token: ref("tok"),
			newName: ref("Alice 2"),
			showNamePrompt: ref(true),
			hasCopied: ref(false),
			isFullscreen: ref(false),
		};
		const header = createRoomHeaderController(headerOpts);
		header.saveName();
		expect(headerOpts.username.value).toBe("Alice 2");
		expect(localStorage.getItem("wb_username")).toBe("Alice 2");
		expect(headerOpts.showNamePrompt.value).toBe(false);

		vi.spyOn(sessionApi, "generateShareInvite").mockResolvedValue({
			inviteToken: "inv-1",
			passwordRequired: true,
		} as unknown as Awaited<ReturnType<typeof sessionApi.generateShareInvite>>);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
			configurable: true,
		});
		await header.copyLink();
		expect(headerOpts.hasCopied.value).toBe(true);

		vi.spyOn(sessionApi, "generateShareInvite").mockRejectedValueOnce({
			response: { data: { msg: "denied" } },
		});
		await header.copyLink();

		Object.defineProperty(document.documentElement, "requestFullscreen", {
			value: vi.fn().mockResolvedValue(undefined),
			configurable: true,
		});
		Object.defineProperty(document, "exitFullscreen", {
			value: vi.fn().mockResolvedValue(undefined),
			configurable: true,
		});
		await header.toggleFullscreen();
		expect(headerOpts.isFullscreen.value).toBe(true);
		header.syncFullscreenState();

		const activeMenu = ref<"pen" | "eraser" | "color" | "more" | null>("pen");
		const headerMenuOpen = ref(false);
		const showShortcuts = ref(false);
		const showPageOverview = ref(false);
		const showMemberList = ref(false);
		const openMemberListTransport = vi.fn();
		const panel = createRoomPanelController({
			activeMenu,
			headerMenuOpen,
			showShortcuts,
			showPageOverview,
			showMemberList,
			openMemberListTransport,
		});
		panel.openMemberList();
		expect(showMemberList.value).toBe(true);
		expect(openMemberListTransport).toHaveBeenCalled();
		panel.closeMemberList();
		panel.toggleShortcuts();
		expect(showShortcuts.value).toBe(true);
		panel.closeShortcuts();
		panel.openOverview();
		expect(showPageOverview.value).toBe(true);
		panel.closeOverview();
		panel.toggleMoreMenu();
		expect(headerMenuOpen.value).toBe(true);

		const setTool = vi.fn();
		const toolOpts = {
			activeMenu,
			headerMenuOpen,
			currentTool: ref<EditorTool>("pen"),
			currentSize: ref(5),
			currentStrokePattern: ref<StrokePattern>("solid"),
			currentSticker: ref("✨"),
			showSizePreview: ref(false),
			setTool,
		};
		const toolCtrl = createRoomToolController(toolOpts);
		toolCtrl.toggleMenu("pen");
		expect(activeMenu.value).toBe("pen");
		toolCtrl.toggleMenu("eraser");
		expect(setTool).toHaveBeenCalledWith("eraser");
		toolCtrl.openColorMenu();
		expect(activeMenu.value).toBe("color");
		toolCtrl.updateCurrentSize(12);
		toolCtrl.setSizePreview(true);
		toolCtrl.setStrokePattern("dashed");
		toolCtrl.setSticker("💡");
		expect(toolOpts.currentSize.value).toBe(12);
		expect(toolOpts.currentStrokePattern.value).toBe("dashed");
		expect(setTool).toHaveBeenCalledWith("sticker");
	});

	it("roomKeyboardController & roomLifecycleController bind shortcuts and mount/unmount lifecycle", () => {
		const undo = vi.fn();
		const redo = vi.fn();
		const setTool = vi.fn();
		const openColorMenu = vi.fn();
		const toggleShortcuts = vi.fn();
		const toggleFullscreen = vi.fn();

		const kb = createRoomKeyboardController({
			canEdit: () => true,
			undo,
			redo,
			setTool,
			openColorMenu,
			toggleShortcuts,
			toggleFullscreen,
		});
		kb.mount();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
		expect(undo).toHaveBeenCalledTimes(1);
		expect(redo).toHaveBeenCalledTimes(2);
		expect(setTool).toHaveBeenCalledWith("pen");
		expect(setTool).toHaveBeenCalledWith("eraser");
		expect(openColorMenu).toHaveBeenCalled();
		expect(toggleShortcuts).toHaveBeenCalled();
		expect(toggleFullscreen).toHaveBeenCalled();
		kb.unmount();

		const fakeSession = {
			mountCanvas: vi.fn(),
			connect: vi.fn(),
			resize: vi.fn(),
			unmount: vi.fn(),
			emitHook: vi.fn(),
		} as unknown as WhiteboardSession;

		canvasRef.value = document.createElement("canvas");
		uiCanvasRef.value = document.createElement("canvas");

		const overlay = { startLoop: vi.fn(), stopLoop: vi.fn() };
		const notifyPointerLeave = vi.fn();
		let lcCtrl!: ReturnType<typeof createRoomLifecycleController>;

		const Host = defineComponent({
			setup() {
				provideRoomSession(fakeSession);
				lcCtrl = createRoomLifecycleController({
					roomCanvasOverlay: overlay,
					roomKeyboardController: { mount: vi.fn(), unmount: vi.fn() },
					roomHeaderController: { syncFullscreenState: vi.fn() },
					interactionController: { notifyPointerLeave },
					send: vi.fn(() => true),
					userId: ref("u1"),
					username: ref("Alice"),
					selectedCommandIds: ref(new Set()),
				});
				return {};
			},
			template: "<div />",
		});
		mount(Host);
		lcCtrl.mount();
		canvasRef.value.dispatchEvent(new Event("pointerleave"));
		expect(notifyPointerLeave).toHaveBeenCalled();
		lcCtrl.unmount();
		expect(fakeSession.unmount).toHaveBeenCalled();
	});
});
