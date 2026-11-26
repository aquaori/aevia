// File role: cross-route stagehand room-entry transition state machine (clearing -> hanging -> focusing -> idle).
import { computed, ref } from "vue";
import { labEnabled } from "../instrumentation/labMarks";

export type RoomTransitionPhase = "idle" | "clearing" | "hanging" | "focusing";

export interface RoomTransitionMeta {
	roomId?: string;
	roomName?: string;
}

export interface RoomTransitionOptions {
	forceAnimation?: boolean;
}

export const STAGE_MESSAGES = [
	"正在为你铺展点阵画纸与颜料…",
	"正在校准画笔、便签与协作光标…",
	"正在同步房间历史笔迹，马上就好…",
] as const;

export const CLEAR_STAGE_MS = 230;
export const MIN_HANGING_MS = 520;
export const FOCUS_PULL_MS = 300;
export const STEP_ROTATE_MS = 900;
export const REVEAL_BADGE_MS = 450;

const detectReducedMotion = (): boolean => {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	} catch {
		return false;
	}
};

export const createRoomTransitionController = () => {
	const phase = ref<RoomTransitionPhase>("idle");
	const targetRoomId = ref("");
	const targetRoomName = ref("");
	const stageStepIndex = ref(0);
	const justRevealed = ref(false);
	const isReducedMotion = ref(detectReducedMotion());

	const isClearingStage = computed(() => phase.value === "clearing");
	const isCurtainVisible = computed(() => phase.value === "hanging" || phase.value === "focusing");
	const isFocusingOut = computed(() => phase.value === "focusing");

	let hangStartedAt = 0;
	let sceneReady = false;
	let clearTimer: ReturnType<typeof setTimeout> | null = null;
	let hangMinTimer: ReturnType<typeof setTimeout> | null = null;
	let focusTimer: ReturnType<typeof setTimeout> | null = null;
	let revealTimer: ReturnType<typeof setTimeout> | null = null;
	let stepInterval: ReturnType<typeof setInterval> | null = null;
	let pendingClearResolve: (() => void) | null = null;

	const refreshReducedMotion = (): boolean => {
		const reduced = detectReducedMotion();
		isReducedMotion.value = reduced;
		return reduced;
	};

	const shouldSkipMotion = (options?: RoomTransitionOptions): boolean => {
		if (options?.forceAnimation) return false;
		return labEnabled() || refreshReducedMotion() || import.meta.env.MODE === "test";
	};

	const clearTimers = () => {
		if (clearTimer !== null) {
			clearTimeout(clearTimer);
			clearTimer = null;
		}
		if (hangMinTimer !== null) {
			clearTimeout(hangMinTimer);
			hangMinTimer = null;
		}
		if (focusTimer !== null) {
			clearTimeout(focusTimer);
			focusTimer = null;
		}
		if (revealTimer !== null) {
			clearTimeout(revealTimer);
			revealTimer = null;
		}
		if (stepInterval !== null) {
			clearInterval(stepInterval);
			stepInterval = null;
		}
		if (pendingClearResolve) {
			const resolve = pendingClearResolve;
			pendingClearResolve = null;
			resolve();
		}
	};

	const applyMeta = (meta?: RoomTransitionMeta) => {
		if (!meta) return;
		if (typeof meta.roomId === "string" && meta.roomId.trim()) {
			targetRoomId.value = meta.roomId.trim();
		}
		if (typeof meta.roomName === "string" && meta.roomName.trim()) {
			targetRoomName.value = meta.roomName.trim();
		}
	};

	const startSubtitleRotation = () => {
		if (stepInterval !== null) {
			clearInterval(stepInterval);
		}
		stageStepIndex.value = 0;
		stepInterval = setInterval(() => {
			stageStepIndex.value = (stageStepIndex.value + 1) % STAGE_MESSAGES.length;
		}, STEP_ROTATE_MS);
	};

	const enterHangingState = (rotateSubtitles: boolean) => {
		phase.value = "hanging";
		hangStartedAt = Date.now();
		if (rotateSubtitles) {
			startSubtitleRotation();
		} else {
			stageStepIndex.value = 0;
		}
	};

	const beginRoomEntryTransition = (
		meta?: RoomTransitionMeta,
		options?: RoomTransitionOptions,
	): Promise<void> => {
		clearTimers();
		sceneReady = false;
		justRevealed.value = false;
		targetRoomId.value = "";
		targetRoomName.value = "";
		applyMeta(meta);

		if (shouldSkipMotion(options)) {
			phase.value = "idle";
			return Promise.resolve();
		}

		phase.value = "clearing";
		return new Promise<void>((resolve) => {
			pendingClearResolve = resolve;
			clearTimer = setTimeout(() => {
				clearTimer = null;
				pendingClearResolve = null;
				enterHangingState(true);
				resolve();
			}, CLEAR_STAGE_MS);
		});
	};

	const notifyRoomMounted = (meta?: RoomTransitionMeta, options?: RoomTransitionOptions) => {
		applyMeta(meta);
		sceneReady = false;

		if (phase.value === "idle" || phase.value === "clearing") {
			if (clearTimer !== null) {
				clearTimeout(clearTimer);
				clearTimer = null;
			}
			if (pendingClearResolve) {
				const resolve = pendingClearResolve;
				pendingClearResolve = null;
				resolve();
			}
			enterHangingState(!shouldSkipMotion(options));
		}
	};

	const updateRoomMeta = (meta?: RoomTransitionMeta) => {
		applyMeta(meta);
	};

	const triggerFocusReveal = () => {
		if (phase.value === "idle") return;
		if (stepInterval !== null) {
			clearInterval(stepInterval);
			stepInterval = null;
		}
		phase.value = "focusing";
		justRevealed.value = true;

		if (focusTimer !== null) clearTimeout(focusTimer);
		focusTimer = setTimeout(() => {
			focusTimer = null;
			if (phase.value === "focusing") {
				phase.value = "idle";
			}
		}, FOCUS_PULL_MS);

		if (revealTimer !== null) clearTimeout(revealTimer);
		revealTimer = setTimeout(() => {
			revealTimer = null;
			justRevealed.value = false;
		}, REVEAL_BADGE_MS);
	};

	const notifyRoomSceneReady = (options?: RoomTransitionOptions) => {
		sceneReady = true;
		if (phase.value === "idle") return;

		if (shouldSkipMotion(options)) {
			clearTimers();
			phase.value = "idle";
			justRevealed.value = false;
			return;
		}

		if (phase.value === "focusing") return;

		const elapsed = Date.now() - hangStartedAt;
		const remaining = Math.max(0, MIN_HANGING_MS - elapsed);

		if (hangMinTimer !== null) clearTimeout(hangMinTimer);
		if (remaining === 0) {
			triggerFocusReveal();
			return;
		}
		hangMinTimer = setTimeout(() => {
			hangMinTimer = null;
			if (sceneReady && phase.value === "hanging") {
				triggerFocusReveal();
			}
		}, remaining);
	};

	const abortRoomTransition = () => {
		clearTimers();
		sceneReady = false;
		phase.value = "idle";
		justRevealed.value = false;
	};

	const handleRoomUnmounted = () => {
		abortRoomTransition();
	};

	return {
		phase,
		targetRoomId,
		targetRoomName,
		stageStepIndex,
		justRevealed,
		isReducedMotion,
		isClearingStage,
		isCurtainVisible,
		isFocusingOut,
		beginRoomEntryTransition,
		notifyRoomMounted,
		updateRoomMeta,
		notifyRoomSceneReady,
		abortRoomTransition,
		handleRoomUnmounted,
	};
};

export const roomTransition = createRoomTransitionController();
