// File role: page navigation orchestration driven by backend page-window responses.
import type { Ref } from "vue";
import {
	recordPageSwitchEnd,
	recordPageSwitchStart,
	setRuntimeSnapshot,
} from "../instrumentation/runtimeInstrumentation";
import { useRoomSessionEmitHook } from "./roomSessionContext";

interface RoomPageServiceOptions {
	currentPageId: Ref<number>;
	totalPages: Ref<number>;
	loadedPageIds: Ref<number[]>;
	username: Ref<string>;
	userId: Ref<string>;
	closeOverview: () => void;
	renderCanvas: () => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	currentTool: Ref<"pen" | "eraser" | "cursor">;
	send: (type: string, data: unknown) => boolean;
}

export const createRoomPageService = (options: RoomPageServiceOptions) => {
	const emitHook = useRoomSessionEmitHook();

	const resetViewportState = () => {
		options.renderCanvas();
		options.setTool(options.currentTool.value);
	};

	const applyRemotePageChange = (index: number, nextTotalPages = options.totalPages.value) => {
		const fromPageId = options.currentPageId.value;
		const switchStart = recordPageSwitchStart(fromPageId, index);
		options.totalPages.value = Math.max(1, nextTotalPages);
		options.currentPageId.value = index;
		setRuntimeSnapshot({ currentPageId: index, totalPages: options.totalPages.value });
		options.closeOverview();
		resetViewportState();
		emitHook("page:changed", { pageId: index });
		recordPageSwitchEnd(fromPageId, index, performance.now() - switchStart);
	};

	const requestPageChange = (index: number) => {
		if (index < 0) return false;
		return options.send("page-change", {
			prevPageId: options.currentPageId.value,
			nextPageId: index,
		});
	};

	const requestPageAdd = () => {
		const nextTotalPages = options.totalPages.value + 1;
		const created = options.send("cmd-page-add", {
			userId: options.userId.value,
			username: Array.isArray(options.username.value)
				? (options.username.value[0] ?? "")
				: options.username.value,
			totalPages: nextTotalPages,
		});
		if (!created) {
			return false;
		}

		options.totalPages.value = nextTotalPages;
		setRuntimeSnapshot({ totalPages: nextTotalPages });
		return requestPageChange(nextTotalPages - 1);
	};

	const goToPage = (index: number) => requestPageChange(index);

	const prevPage = () =>
		options.currentPageId.value <= 0 ? false : requestPageChange(options.currentPageId.value - 1);

	const nextPage = () =>
		options.currentPageId.value >= options.totalPages.value - 1
			? requestPageAdd()
			: requestPageChange(options.currentPageId.value + 1);

	const addPageAndOpenLast = () => requestPageAdd();

	return {
		goToPage,
		applyRemotePageChange,
		prevPage,
		nextPage,
		addPageAndOpenLast,
	};
};
