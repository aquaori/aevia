// File role: room-level session state such as room identity, auth token, naming prompt, and reconnect flags.
import { ref } from "vue";

export const createRoomSessionState = (initialToken = "") => {
	const username = ref(localStorage.getItem("wb_username") || "");
	const roomId = ref("");
	const roomName = ref("");
	const token = ref(initialToken);
	const showNamePrompt = ref(!username.value);
	const newName = ref("");
	const onlineCount = ref(0);
	const reconnectFailed = ref(false);

	return {
		username,
		roomId,
		roomName,
		token,
		showNamePrompt,
		newName,
		onlineCount,
		reconnectFailed,
	};
};

