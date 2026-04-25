// File role: routes incoming collaboration messages to command and presence handlers.
import { createCollabCommandHandlers } from "./collabCommandHandlers";
import { createCollabPresenceHandlers } from "./collabPresenceHandlers";
import type {
	CollabIncomingMessage,
	CollabMessageDispatcherOptions,
	InitRenderChunkMetaPayload,
	PageChangeRenderChunkMetaPayload,
} from "./collabDispatcherTypes";

export const createCollabMessageDispatcher = (options: CollabMessageDispatcherOptions) => {
	const commandHandlers = createCollabCommandHandlers(options);
	const presenceHandlers = createCollabPresenceHandlers(options);

	const handleMessage = (msg: CollabIncomingMessage) => {
		if (msg.type === "init-meta") {
			commandHandlers.handleInitMeta(msg);
			return;
		}

		if (msg.type === "init-render-meta") {
			commandHandlers.handleInitRenderMeta(msg);
			return;
		}

		if (msg.type === "init-render-chunk-meta") {
			commandHandlers.handleInitRenderChunkMeta(msg);
			return;
		}

		if (msg.type === "init-render-done") {
			commandHandlers.handleInitRenderDone(msg);
			return;
		}

		if (msg.type === "init-commands-meta") {
			commandHandlers.handleInitCommandsMeta(msg);
			return;
		}

		if (msg.type === "init-commands-chunk") {
			commandHandlers.handleInitCommandsChunk(msg);
			return;
		}

		if (msg.type === "init-commands-done") {
			commandHandlers.handleInitCommandsDone(msg);
			return;
		}

		if (msg.type === "init-complete") {
			commandHandlers.handleInitComplete(msg);
			return;
		}

		if (msg.type === "page-change-meta") {
			commandHandlers.handlePageChangeMeta(msg);
			return;
		}

		if (msg.type === "page-change-render-meta") {
			commandHandlers.handlePageChangeRenderMeta(msg);
			return;
		}

		if (msg.type === "page-change-render-chunk-meta") {
			commandHandlers.handlePageChangeRenderChunkMeta(msg);
			return;
		}

		if (msg.type === "page-change-render-done") {
			commandHandlers.handlePageChangeRenderDone(msg);
			return;
		}

		if (msg.type === "page-change-commands-meta") {
			commandHandlers.handlePageChangeCommandsMeta(msg);
			return;
		}

		if (msg.type === "page-change-commands-chunk") {
			commandHandlers.handlePageChangeCommandsChunk(msg);
			return;
		}

		if (msg.type === "page-change-commands-done") {
			commandHandlers.handlePageChangeCommandsDone(msg);
			return;
		}

		if (msg.type === "page-change-complete") {
			commandHandlers.handlePageChangeComplete(msg);
			return;
		}

		if (msg.type === "page-change-chunk") {
			commandHandlers.handlePageChangeChunk(msg);
			return;
		}

		if (msg.type === "page-change-done") {
			commandHandlers.handlePageChangeDone(msg);
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

		if (msg.type === "op-rejected") {
			commandHandlers.handleOperationRejected(msg);
			return;
		}

		if (msg.type === "delete-cmd") {
			commandHandlers.handleDeleteCommand(msg);
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
		handleInitRenderChunkBinary: (meta: InitRenderChunkMetaPayload) => {
			commandHandlers.handleInitRenderChunkBinary(meta);
		},
		handlePageChangeRenderChunkBinary: (meta: PageChangeRenderChunkMetaPayload) => {
			commandHandlers.handlePageChangeRenderChunkBinary(meta);
		},
	};
};

