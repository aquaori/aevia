// File role: header actions such as naming, share-link copying, and fullscreen control.
import { toast } from "vue-sonner";
import type { Ref } from "vue";
import { generateShareInvite } from "../service/sessionApi";

interface RoomHeaderControllerOptions {
	roomId: Ref<string>;
	roomName: Ref<string>;
	username: Ref<string>;
	token: Ref<string>;
	newName: Ref<string>;
	showNamePrompt: Ref<boolean>;
	hasCopied: Ref<boolean>;
	isFullscreen: Ref<boolean>;
}

export const createRoomHeaderController = (options: RoomHeaderControllerOptions) => {
	const saveName = () => {
		if (!options.newName.value) return;
		options.username.value = options.newName.value;
		localStorage.setItem("wb_username", options.newName.value);
		options.showNamePrompt.value = false;
	};

	const copyLink = async () => {
		try {
			const response = await generateShareInvite(options.roomId.value, options.token.value);
			const url = `${window.location.origin}/invite/${response.inviteToken || response.token}`;
			const copyStr = `${options.username.value} 邀请你加入协同画板房间: ${options.roomName.value} ( ID: ${options.roomId.value} )，点击链接加入：${url}${response.passwordRequired ? "，该房间加入时需要输入密码" : ""}`;
			await navigator.clipboard.writeText(copyStr);
			options.hasCopied.value = true;
			toast.success("复制成功");
			window.setTimeout(() => {
				options.hasCopied.value = false;
			}, 2000);
		} catch (error: any) {
			console.error("Copy failed", error);
			toast.error(
				error?.response?.data?.msg
					? `生成分享链接失败: ${error.response.data.msg}`
					: "复制失败"
			);
		}
	};

	const toggleFullscreen = async () => {
		if (!document.fullscreenElement) {
			await document.documentElement.requestFullscreen();
			options.isFullscreen.value = true;
			return;
		}
		await document.exitFullscreen();
		options.isFullscreen.value = false;
	};

	const syncFullscreenState = () => {
		options.isFullscreen.value = !!document.fullscreenElement;
	};

	return {
		saveName,
		copyLink,
		toggleFullscreen,
		syncFullscreenState,
	};
};

