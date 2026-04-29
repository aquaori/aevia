// File role: room-level session state such as room identity, auth token, naming prompt, and reconnect flags.
import { ref } from "vue";

export const createRoomSessionState = (initialToken = "", initialSessionExpiresAt: number | null = null) => {
	const username = ref(localStorage.getItem("wb_username") || "");
	const roomId = ref("");
	const roomName = ref("");
	const token = ref(initialToken);
	const sessionExpiresAt = ref<number | null>(initialSessionExpiresAt);
	const showNamePrompt = ref(!username.value);
	const newName = ref("");
	const onlineCount = ref(0);
	const reconnectFailed = ref(false);
	const reconnectFailureMessage = ref("服务器连接超时，请返回首页或重新尝试连接。");

	return {
		username,
		roomId,
		roomName,
		token,
		sessionExpiresAt,
		showNamePrompt,
		newName,
		onlineCount,
		reconnectFailed,
		reconnectFailureMessage,
	};
};

