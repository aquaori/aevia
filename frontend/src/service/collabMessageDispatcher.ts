// File role: routes incoming collaboration messages to command and presence handlers.
import { createCollabCommandHandlers } from "./collabCommandHandlers";
import { createCollabPresenceHandlers } from "./collabPresenceHandlers";
import type { CollabIncomingMessage, CollabMessageDispatcherOptions } from "./collabDispatcherTypes";

export const createCollabMessageDispatcher = (options: CollabMessageDispatcherOptions) => {
	const commandHandlers = createCollabCommandHandlers(options);
	const presenceHandlers = createCollabPresenceHandlers(options);

	const handleMessage = (msg: CollabIncomingMessage) => {
		if (msg.type === "init") {
			commandHandlers.handleInit(msg);
			return;
		}

		if (msg.type === "page-change") {
			commandHandlers.handlePageChange(msg);
			return;
		}

		if (msg.type === "online-count-change") {
			presenceHandlers.handleOnlineCountChange(msg);
			return;
		}

		if (msg.type === "push-cmd") {
			commandHandlers.handlePushCommand(msg);
			return;
		}

		if (msg.type === "cmd-batch-move") {
			commandHandlers.handleBatchMove(msg);
			return;
		}

		if (msg.type === "cmd-batch-update" || msg.type === "cmd-batch-stop") {
			commandHandlers.handleBatchUpdate(msg);
			return;
		}

		if (msg.type === "cmd-page-add") {
			commandHandlers.handlePageAdd(msg);
			return;
		}

		if (msg.type === "mouseMove") {
			presenceHandlers.handleMouseMove(msg);
			return;
		}

		if (msg.type === "get-member-list") {
			presenceHandlers.handleMemberList(msg);
			return;
		}

		if (msg.type === "mouseLeave") {
			presenceHandlers.handleMouseLeave(msg);
			return;
		}

		if (msg.type === "box-selection") {
			presenceHandlers.handleBoxSelection(msg);
			return;
		}

		if (msg.type === "undo-cmd" || msg.type === "redo-cmd") {
			commandHandlers.handleUndoRedo(msg);
		}
	};

	return {
		handleMessage,
	};
};

