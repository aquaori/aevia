import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import { createRoomEditorState } from "./roomEditorState";
import { createRoomInteractionState } from "./roomInteractionState";
import { createRoomSessionState } from "./roomSessionState";
import { createRoomUiState } from "./roomUiState";

describe("room state factories", () => {
	it("manages editor currentSize for drawing vs eraser tools", () => {
		const state = createRoomEditorState();
		state.currentTool.value = "pen";
		state.currentSize.value = 8;
		expect(state.penSize.value).toBe(8);
		expect(state.currentSize.value).toBe(8);

		state.currentTool.value = "eraser";
		state.currentSize.value = 24;
		expect(state.eraserSize.value).toBe(24);
		expect(state.currentSize.value).toBe(24);

		state.currentTool.value = "object-eraser";
		expect(state.currentSize.value).toBe(24);
	});

	it("initializes interaction, session, and persistent UI states", async () => {
		localStorage.setItem("wb_username", "Tester");
		localStorage.setItem("wb_toolbar_collapsed", "true");

		const interaction = createRoomInteractionState();
		expect(interaction.interactionMode.value).toBe("none");
		expect(interaction.pointerHotState.currentPathPoints).toEqual([]);

		const session = createRoomSessionState("tok-1", 12345);
		expect(session.username.value).toBe("Tester");
		expect(session.showNamePrompt.value).toBe(false);
		expect(session.token.value).toBe("tok-1");
		expect(session.sessionExpiresAt.value).toBe(12345);

		const ui = createRoomUiState();
		expect(ui.isToolbarCollapsed.value).toBe(true);
		ui.isToolbarCollapsed.value = false;
		await nextTick();
		expect(localStorage.getItem("wb_toolbar_collapsed")).toBe("false");
	});
});
