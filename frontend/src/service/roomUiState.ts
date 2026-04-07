import { ref, watch } from "vue";

export const createRoomUiState = () => {
	const activeMenu = ref<"pen" | "eraser" | "color" | "more" | null>(null);
	const showShortcuts = ref(false);
	const isFullscreen = ref(false);
	const hasCopied = ref(false);
	const showEraserCursor = ref(false);
	const showSizePreview = ref(false);
	const showPageOverview = ref(false);
	const showMemberList = ref(false);
	const isToolbarCollapsed = ref(localStorage.getItem("wb_toolbar_collapsed") === "true");

	watch(isToolbarCollapsed, (val) => {
		localStorage.setItem("wb_toolbar_collapsed", val.toString());
	});

	return {
		activeMenu,
		showShortcuts,
		isFullscreen,
		hasCopied,
		showEraserCursor,
		showSizePreview,
		showPageOverview,
		showMemberList,
		isToolbarCollapsed,
	};
};
