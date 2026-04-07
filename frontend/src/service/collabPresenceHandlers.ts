import { toast } from "vue-sonner";
import type { CollabIncomingMessage, CollabMessageDispatcherOptions } from "./collabDispatcherTypes";

export const createCollabPresenceHandlers = (options: CollabMessageDispatcherOptions) => {
	const cursorColors = [
		"#ef4444",
		"#f97316",
		"#f59e0b",
		"#84cc16",
		"#10b981",
		"#06b6d4",
		"#3b82f6",
		"#6366f1",
		"#8b5cf6",
		"#d946ef",
		"#f43f5e",
	] as const;

	const getCursorColor = (value: string): string => {
		if (!value) return cursorColors[0] ?? "#ef4444";
		let hash = 0;
		for (let index = 0; index < value.length; index++) {
			hash = value.charCodeAt(index) + ((hash << 5) - hash);
		}
		const colorIndex = Math.abs(hash) % cursorColors.length;
		return cursorColors[colorIndex] ?? cursorColors[0] ?? "#ef4444";
	};

	const handleOnlineCountChange = (msg: CollabIncomingMessage) => {
		options.onlineCount.value = msg.data.onlineCount;
		if (msg.data.userId !== options.userId.value) {
			const action = msg.data.type === "join" ? "加入了房间" : "离开了房间";
			toast.info(`${msg.data.userName} ${action}`);
		}

		const { userId: changedUserId, userName: changedUserName, type } = msg.data;
		if (type === "join") {
			const exists = options.memberList.value.some((member) => member[0] === changedUserId);
			if (!exists) {
				options.memberList.value.push([changedUserId, changedUserName]);
			}
			return;
		}

		if (type === "leave") {
			options.memberList.value = options.memberList.value.filter(
				(member) => member[0] !== changedUserId
			);
		}
	};

	const handleMouseMove = (msg: CollabIncomingMessage) => {
		const { userId, userName, x, y, pageId } = msg.data;
		options.remoteCursors.value.set(userId, {
			userId,
			userName,
			x,
			y,
			pageId: pageId ?? 0,
			color: getCursorColor(userId),
			lastUpdate: Date.now(),
		});
	};

	const handleMemberList = (msg: CollabIncomingMessage) => {
		options.memberList.value = msg.data.memberList || [];
	};

	const handleMouseLeave = (msg: CollabIncomingMessage) => {
		const { userId } = msg.data;
		options.remoteCursors.value.delete(userId);
		options.remoteSelectionRects.value.delete(userId);
	};

	const handleBoxSelection = (msg: CollabIncomingMessage) => {
		const { userId, rect } = msg.data;
		if (rect) {
			options.remoteSelectionRects.value.set(userId, rect);
			return;
		}
		options.remoteSelectionRects.value.delete(userId);
	};

	return {
		handleOnlineCountChange,
		handleMouseMove,
		handleMemberList,
		handleMouseLeave,
		handleBoxSelection,
	};
};
