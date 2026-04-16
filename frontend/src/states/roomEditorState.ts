// File role: central room editor state for tools, colors, page position, and collaborator cursors.
import { computed, ref } from "vue";
import type { RemoteCursor } from "../utils/type";

export const createRoomEditorState = () => {
	const memberList = ref<[string, string][]>([]);
	const currentTool = ref<"pen" | "eraser" | "cursor">("pen");
	const currentColor = ref("#000000");
	const penSize = ref(5);
	const eraserSize = ref(15);
	const userId = ref("");
	const currentPageId = ref(0);
	const totalPages = ref(1);
	const remoteCursors = ref<Map<string, RemoteCursor>>(new Map());

	const currentSize = computed({
		get: () => (currentTool.value === "eraser" ? eraserSize.value : penSize.value),
		set: (value) => {
			if (currentTool.value === "eraser") {
				eraserSize.value = value;
				return;
			}
			penSize.value = value;
		},
	});

	return {
		memberList,
		currentTool,
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

