import type { Ref } from "vue";

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
}

export const createRoomPageService = (options: RoomPageServiceOptions) => {
	const resetViewportState = () => {
		options.renderCanvas();
		options.setTool(options.currentTool.value);
	};

	const goToPage = (index: number) => {
		options.currentPageId.value = index;
		options.closeOverview();
		resetViewportState();
	};

	const prevPage = () => {
		if (options.currentPageId.value <= 0) return;
		options.currentPageId.value -= 1;
		resetViewportState();
	};

	const nextPage = () => {
		if (options.currentPageId.value === options.totalPages.value - 1) {
			options.totalPages.value += 1;
			options.send("cmd-page-add", {
				userId: options.userId.value,
				username: options.username.value ?? "未知用户",
				totalPages: options.totalPages.value,
			});
		}

		options.currentPageId.value += 1;
		resetViewportState();
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
