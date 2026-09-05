// File role: controls modal and panel visibility for shortcuts, members, overview, and menus.
import type { Ref } from "vue";

type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;

interface RoomPanelControllerOptions {
	activeMenu: Ref<ActiveMenu>;
	headerMenuOpen: Ref<boolean>;
	showShortcuts: Ref<boolean>;
	showPageOverview: Ref<boolean>;
	showMemberList: Ref<boolean>;
	openMemberListTransport: () => void;
}

export const createRoomPanelController = (options: RoomPanelControllerOptions) => {
	const openMemberList = () => {
		options.showMemberList.value = true;
		options.activeMenu.value = null;
		options.headerMenuOpen.value = false;
		options.openMemberListTransport();
	};

	const closeMemberList = () => {
		options.showMemberList.value = false;
	};

	const toggleShortcuts = () => {
		options.showShortcuts.value = !options.showShortcuts.value;
		options.activeMenu.value = null;
		options.headerMenuOpen.value = false;
	};

	const closeShortcuts = () => {
		options.showShortcuts.value = false;
	};

	const openOverview = () => {
		options.showPageOverview.value = true;
	};

	const closeOverview = () => {
		options.showPageOverview.value = false;
	};

	const toggleMoreMenu = () => {
		options.headerMenuOpen.value = !options.headerMenuOpen.value;
		if (options.headerMenuOpen.value) options.activeMenu.value = null;
	};

	return {
		openMemberList,
		closeMemberList,
		toggleShortcuts,
		closeShortcuts,
		openOverview,
		closeOverview,
		toggleMoreMenu,
	};
};

