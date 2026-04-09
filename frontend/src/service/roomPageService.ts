// File role: page navigation and page-creation orchestration for the whiteboard room.
import type { Ref } from "vue";
import type { EditorHookMap } from "../utils/editorTypes";
import { recordPageSwitchEnd, recordPageSwitchStart, setRuntimeSnapshot } from "./benchmarkRuntime";

interface RoomPageServiceOptions {
	currentPageId: Ref<number>;
	totalPages: Ref<number>;
	username: Ref<string>;
	userId: Ref<string>;
	closeOverview: () => void;
	renderCanvas: () => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	currentTool: Ref<"pen" | "eraser" | "cursor">;
	send: (type: string, data: unknown) => boolean;
	emitHook?: <K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => void;
}

export const createRoomPageService = (options: RoomPageServiceOptions) => {
	const resetViewportState = () => {
		options.renderCanvas();
		options.setTool(options.currentTool.value);
	};

	const goToPage = (index: number) => {
		const fromPageId = options.currentPageId.value;
		const switchStart = recordPageSwitchStart(fromPageId, index);
		options.currentPageId.value = index;
		setRuntimeSnapshot({ currentPageId: index, totalPages: options.totalPages.value });
		options.closeOverview();
		resetViewportState();
		options.emitHook?.("page:changed", { pageId: index });
		recordPageSwitchEnd(fromPageId, index, performance.now() - switchStart);
	};

	const prevPage = () => {
		if (options.currentPageId.value <= 0) return;
		const fromPageId = options.currentPageId.value;
		const toPageId = fromPageId - 1;
		const switchStart = recordPageSwitchStart(fromPageId, toPageId);
		options.currentPageId.value -= 1;
		setRuntimeSnapshot({
			currentPageId: options.currentPageId.value,
			totalPages: options.totalPages.value,
		});
		resetViewportState();
		options.emitHook?.("page:changed", { pageId: options.currentPageId.value });
		recordPageSwitchEnd(fromPageId, toPageId, performance.now() - switchStart);
	};

	const nextPage = () => {
		const fromPageId = options.currentPageId.value;
		if (options.currentPageId.value === options.totalPages.value - 1) {
			options.totalPages.value += 1;
			setRuntimeSnapshot({ totalPages: options.totalPages.value });
			options.send("cmd-page-add", {
				userId: options.userId.value,
				username: options.username.value ?? "未知用户",
				totalPages: options.totalPages.value,
			});
		}

		options.currentPageId.value += 1;
		const toPageId = options.currentPageId.value;
		setRuntimeSnapshot({ currentPageId: toPageId, totalPages: options.totalPages.value });
		const switchStart = recordPageSwitchStart(fromPageId, toPageId);
		resetViewportState();
		options.emitHook?.("page:changed", { pageId: options.currentPageId.value });
		recordPageSwitchEnd(fromPageId, toPageId, performance.now() - switchStart);
	};

	const addPageAndOpenLast = () => {
		nextPage();
		goToPage(options.totalPages.value - 1);
	};

	return {
		goToPage,
		prevPage,
		nextPage,
		addPageAndOpenLast,
	};
};

