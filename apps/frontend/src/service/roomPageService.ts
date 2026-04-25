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

interface ApplyRemotePageChangeOptions {
	deferRender?: boolean;
	requestId?: number;
}

export const createRoomPageService = (options: RoomPageServiceOptions) => {
	const emitHook = useRoomSessionEmitHook();
	let nextPageChangeRequestId = 0;
	let activePageChangeRequestId: number | null = null;
	let activePageChangeTargetId: number | null = null;

	const resetViewportState = () => {
		options.renderCanvas();
		options.setTool(options.currentTool.value);
	};

	const applyRemotePageChange = (
		index: number,
		nextTotalPages = options.totalPages.value,
		config: ApplyRemotePageChangeOptions = {}
	) => {
		const fromPageId = options.currentPageId.value;
		const switchStart = recordPageSwitchStart(fromPageId, index);
		options.totalPages.value = Math.max(1, nextTotalPages);
		options.currentPageId.value = index;
		setRuntimeSnapshot({ currentPageId: index, totalPages: options.totalPages.value });
		options.closeOverview();
		if (!config.deferRender) {
			resetViewportState();
		}
		emitHook("page:changed", { pageId: index });
		if (
			!config.deferRender &&
			typeof config.requestId === "number" &&
			activePageChangeRequestId === config.requestId
		) {
			activePageChangeRequestId = null;
		}
		recordPageSwitchEnd(fromPageId, index, performance.now() - switchStart);
	};

	const requestPageChange = (index: number) => {
		if (index < 0) return false;
		const previousPageId = options.currentPageId.value;
		const clientLoadedPageIds = [...options.loadedPageIds.value];
		const requestId = ++nextPageChangeRequestId;
		activePageChangeRequestId = requestId;
		activePageChangeTargetId = index;
		options.currentPageId.value = index;
		setRuntimeSnapshot({ currentPageId: index, totalPages: options.totalPages.value });
		options.closeOverview();
		resetViewportState();
		emitHook("page:changed", { pageId: index });
		return options.send("page-change", {
			requestId,
			pageId: index,
			prevPageId: previousPageId,
			nextPageId: index,
			clientLoadedPageIds,
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

	const requestCurrentPageResync = () => requestPageChange(options.currentPageId.value);

	const prevPage = () =>
		options.currentPageId.value <= 0 ? false : requestPageChange(options.currentPageId.value - 1);

	const nextPage = () =>
		options.currentPageId.value >= options.totalPages.value - 1
			? requestPageAdd()
			: requestPageChange(options.currentPageId.value + 1);

	const addPageAndOpenLast = () => requestPageAdd();

	const getActivePageChangeRequestId = () => activePageChangeRequestId;
	const getActivePageChangeTargetId = () => activePageChangeTargetId;

	const clearActivePageChangeRequest = (requestId?: number) => {
		if (typeof requestId === "number") {
			if (activePageChangeRequestId === requestId) {
				activePageChangeRequestId = null;
				activePageChangeTargetId = null;
			}
			return;
		}
		activePageChangeRequestId = null;
		activePageChangeTargetId = null;
	};

	return {
		goToPage,
		requestCurrentPageResync,
		applyRemotePageChange,
		getActivePageChangeRequestId,
		getActivePageChangeTargetId,
		clearActivePageChangeRequest,
		prevPage,
		nextPage,
		addPageAndOpenLast,
	};
};
