import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomEditorState } from "./roomEditorState";
import { createRoomInteractionState } from "./roomInteractionState";
import { createRoomSessionState } from "./roomSessionState";
import {
	CLEAR_STAGE_MS,
	createRoomTransitionController,
	FOCUS_PULL_MS,
	MIN_HANGING_MS,
	REVEAL_BADGE_MS,
	STAGE_MESSAGES,
	STEP_ROTATE_MS,
} from "./roomTransitionState";
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

describe("roomTransitionState", () => {
	afterEach(() => {
		vi.useRealTimers();
		delete (window as { __AEVIA_LAB__?: unknown }).__AEVIA_LAB__;
	});

	it("runs the full 4-act timed transition, enforces minimum hanging duration, and rotates subtitles", async () => {
		vi.useFakeTimers();
		const ctrl = createRoomTransitionController();
		let resolved = false;

		const entryPromise = ctrl
			.beginRoomEntryTransition({ roomId: "123456", roomName: "Sprint Board" }, { forceAnimation: true })
			.then(() => {
				resolved = true;
			});

		expect(ctrl.phase.value).toBe("clearing");
		expect(ctrl.isClearingStage.value).toBe(true);
		expect(ctrl.isCurtainVisible.value).toBe(false);
		expect(resolved).toBe(false);

		vi.advanceTimersByTime(CLEAR_STAGE_MS);
		await entryPromise;
		expect(resolved).toBe(true);
		expect(ctrl.phase.value).toBe("hanging");
		expect(ctrl.isCurtainVisible.value).toBe(true);
		expect(ctrl.targetRoomId.value).toBe("123456");
		expect(ctrl.targetRoomName.value).toBe("Sprint Board");

		// Room mounts and scene finishes immediately (e.g. 50ms): waits for MIN_HANGING_MS before focusing
		ctrl.notifyRoomMounted({ roomId: "123456", roomName: "Sprint Board" }, { forceAnimation: true });
		vi.advanceTimersByTime(50);
		ctrl.notifyRoomSceneReady({ forceAnimation: true });
		expect(ctrl.phase.value).toBe("hanging");

		vi.advanceTimersByTime(MIN_HANGING_MS - 50 - 1);
		expect(ctrl.phase.value).toBe("hanging");

		vi.advanceTimersByTime(1);
		expect(ctrl.phase.value).toBe("focusing");
		expect(ctrl.isFocusingOut.value).toBe(true);
		expect(ctrl.justRevealed.value).toBe(true);

		vi.advanceTimersByTime(FOCUS_PULL_MS);
		expect(ctrl.phase.value).toBe("idle");
		expect(ctrl.isCurtainVisible.value).toBe(false);

		vi.advanceTimersByTime(REVEAL_BADGE_MS);
		expect(ctrl.justRevealed.value).toBe(false);

		// Subtitles rotate cleanly across slow hangs
		ctrl.notifyRoomMounted({ roomId: "999888" }, { forceAnimation: true });
		expect(ctrl.stageStepIndex.value).toBe(0);
		vi.advanceTimersByTime(STEP_ROTATE_MS);
		expect(ctrl.stageStepIndex.value).toBe(1);
		vi.advanceTimersByTime(STEP_ROTATE_MS);
		expect(ctrl.stageStepIndex.value).toBe(2 % STAGE_MESSAGES.length);
		ctrl.handleRoomUnmounted();
		expect(ctrl.phase.value).toBe("idle");
	});

	it("skips artificial animation delays under lab mode or test fast-path while still showing ready gate on mount", async () => {
		const ctrl = createRoomTransitionController();
		(window as { __AEVIA_LAB__?: { enabled: boolean } }).__AEVIA_LAB__ = { enabled: true };

		await ctrl.beginRoomEntryTransition({ roomId: "654321" });
		expect(ctrl.phase.value).toBe("idle");

		ctrl.notifyRoomMounted({ roomId: "654321", roomName: "Lab Room" });
		expect(ctrl.phase.value).toBe("hanging");
		expect(ctrl.isCurtainVisible.value).toBe(true);

		ctrl.notifyRoomSceneReady();
		expect(ctrl.phase.value).toBe("idle");
		expect(ctrl.isCurtainVisible.value).toBe(false);
	});
});
