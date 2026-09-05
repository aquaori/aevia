// File role: central room editor state for tools, colors, page position, and collaborator cursors.
import { computed, ref } from "vue";
import type { EditorTool, RemoteCursor, StrokePattern } from "@collaborative-whiteboard/shared";

export const createRoomEditorState = () => {
	const memberList = ref<[string, string][]>([]);
	const currentTool = ref<EditorTool>("pen");
	const currentStrokePattern = ref<StrokePattern>("solid");
	const currentSticker = ref("✨");
	const currentColor = ref("#000000");
	const penSize = ref(5);
	const eraserSize = ref(15);
	const userId = ref("");
	const currentPageId = ref(0);
	const totalPages = ref(1);
	const remoteCursors = ref<Map<string, RemoteCursor>>(new Map());

	const currentSize = computed({
		get: () => (currentTool.value === "eraser" || currentTool.value === "object-eraser" ? eraserSize.value : penSize.value),
		set: (value) => {
			if (currentTool.value === "eraser" || currentTool.value === "object-eraser") {
				eraserSize.value = value;
				return;
			}
			penSize.value = value;
		},
	});

	return {
		memberList,
		currentTool,
		currentStrokePattern,
		currentSticker,
		currentColor,
		penSize,
		eraserSize,
		currentSize,
		userId,
		currentPageId,
		totalPages,
		remoteCursors,
	};
};

