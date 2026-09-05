import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { Command } from "@collaborative-whiteboard/shared";
import { canvasRef } from "./canvas";
import { createLocalCommandService } from "./localCommandService";

const createCommand = (box: Command["box"]): Command => ({
	id: "cmd-1",
	type: "path",
	tool: "pen",
	color: "#000000",
	size: 4,
	points: [],
	timestamp: 0,
	userId: "user-1",
	roomId: "room-1",
	pageId: 0,
	isDeleted: false,
	lamport: 1,
	box,
});

const createService = (command: Command) => {
	const requestDirtyRender = vi.fn();
	const requestSceneRefresh = vi.fn();
	const renderCanvas = vi.fn();
	const syncCommandState = vi.fn();
	const commands = ref([command]);
	const currentCommandIndex = ref(0);
	const send = vi.fn(() => true);

	const service = createLocalCommandService({
		commands,
		currentCommandIndex,
		userId: ref("user-1"),
		roomId: ref("room-1"),
		currentPageId: ref(0),
		username: ref("user-1"),
		currentTool: ref<"pen" | "eraser" | "cursor">("pen"),
		insertCommand: (item) => commands.value.push(item),
		renderCanvas,
		requestDirtyRender,
		syncCommandState,
		isOffscreenMainCanvas: () => true,
		requestSceneRefresh,
		setTool: vi.fn(),
		send,
	});

	return { service, requestDirtyRender, requestSceneRefresh, renderCanvas, syncCommandState, send };
};

describe("local command history rendering", () => {
	beforeEach(() => setActivePinia(createPinia()));
	afterEach(() => {
		canvasRef.value = null;
	});

	it("represents legacy undo and redo as immutable scene operations", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 1000;
		canvas.height = 500;
		canvasRef.value = canvas;
		const state = createService(
			createCommand({ minX: 0.25, minY: 0.25, maxX: 0.5, maxY: 0.5, width: 0.25, height: 0.25 })
		);

		expect(state.service.undo().ok).toBe(true);
		expect(state.service.redo().ok).toBe(true);

		expect(state.requestDirtyRender).not.toHaveBeenCalled();
		expect(state.requestSceneRefresh).not.toHaveBeenCalled();
		expect(state.renderCanvas).not.toHaveBeenCalled();
		expect(state.syncCommandState).toHaveBeenCalledTimes(2);
		expect(state.syncCommandState.mock.calls[0]?.[0].sceneOperation?.kind).toBe("element.delete");
		expect(state.syncCommandState.mock.calls[1]?.[0].sceneOperation?.kind).toBe("history.toggle");
		expect(state.send.mock.calls.every(([type]) => type === "push-cmd")).toBe(true);
	});

	it("does not depend on legacy command bounds", () => {
		canvasRef.value = document.createElement("canvas");
		const state = createService(
			createCommand({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 })
		);

		expect(state.service.undo().ok).toBe(true);

		expect(state.requestDirtyRender).not.toHaveBeenCalled();
		expect(state.requestSceneRefresh).not.toHaveBeenCalled();
		expect(state.renderCanvas).not.toHaveBeenCalled();
	});

	it("rejects every legacy write path before transport", () => {
		const state = createService(
			createCommand({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 })
		);

		expect(state.service.pushCommand({ type: "path" }).ok).toBe(false);
		expect(state.send).not.toHaveBeenCalled();
	});
});
