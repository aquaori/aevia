import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabIncomingMessage, CollabMessageDispatcherOptions } from "./collabDispatcherTypes";

const handlers = vi.hoisted(() => ({
	command: {
		handleInitMeta: vi.fn(),
		handleInitRenderMeta: vi.fn(),
		handleInitRenderChunkMeta: vi.fn(),
		handleInitRenderChunkBinary: vi.fn(),
		handleInitRenderDone: vi.fn(),
		handleInitCommandsMeta: vi.fn(),
		handleInitCommandsChunk: vi.fn(),
		handleInitCommandsDone: vi.fn(),
		handleInitComplete: vi.fn(),
		handleDeltaReplayMeta: vi.fn(),
		handleDeltaReplayComplete: vi.fn(),
		handlePageChangeMeta: vi.fn(),
		handlePageChangeRenderMeta: vi.fn(),
		handlePageChangeRenderChunkMeta: vi.fn(),
		handlePageChangeRenderChunkBinary: vi.fn(),
		handlePageChangeRenderDone: vi.fn(),
		handlePageChangeCommandsMeta: vi.fn(),
		handlePageChangeCommandsChunk: vi.fn(),
		handlePageChangeCommandsDone: vi.fn(),
		handlePageChangeComplete: vi.fn(),
		handlePageChangeChunk: vi.fn(),
		handlePageChangeDone: vi.fn(),
		handlePushCommand: vi.fn(),
		handleOperationRejected: vi.fn(),
		handleDeleteCommand: vi.fn(),
		handlePageAdd: vi.fn(),
		handleUndoRedo: vi.fn(),
	},
	presence: {
		handleOnlineCountChange: vi.fn(),
		handleMouseMove: vi.fn(),
		handleMemberList: vi.fn(),
		handleMouseLeave: vi.fn(),
		handleBoxSelection: vi.fn(),
	},
}));

vi.mock("./collabCommandHandlers", () => ({
	createCollabCommandHandlers: vi.fn(() => handlers.command),
}));
vi.mock("./collabPresenceHandlers", () => ({
	createCollabPresenceHandlers: vi.fn(() => handlers.presence),
}));

import { createCollabMessageDispatcher } from "./collabMessageDispatcher";

const minimalOptions = {} as unknown as CollabMessageDispatcherOptions;

const message = (type: string, data: Record<string, unknown> = {}) =>
	({ type, data } as unknown as CollabIncomingMessage);

const calledHandlerNames = () =>
	[
		...Object.entries(handlers.command),
		...Object.entries(handlers.presence),
	]
		.filter(([, handler]) => handler.mock.calls.length > 0)
		.map(([name]) => name);

const routingTable: Array<{ type: string; handler: keyof typeof handlers.command | keyof typeof handlers.presence }> = [
	{ type: "init-meta", handler: "handleInitMeta" },
	{ type: "init-render-meta", handler: "handleInitRenderMeta" },
	{ type: "init-render-chunk-meta", handler: "handleInitRenderChunkMeta" },
	{ type: "init-render-done", handler: "handleInitRenderDone" },
	{ type: "init-commands-meta", handler: "handleInitCommandsMeta" },
	{ type: "init-commands-chunk", handler: "handleInitCommandsChunk" },
	{ type: "init-commands-done", handler: "handleInitCommandsDone" },
	{ type: "init-complete", handler: "handleInitComplete" },
	{ type: "delta-replay-meta", handler: "handleDeltaReplayMeta" },
	{ type: "delta-replay-complete", handler: "handleDeltaReplayComplete" },
	{ type: "page-change-meta", handler: "handlePageChangeMeta" },
	{ type: "page-change-render-meta", handler: "handlePageChangeRenderMeta" },
	{ type: "page-change-render-chunk-meta", handler: "handlePageChangeRenderChunkMeta" },
	{ type: "page-change-render-done", handler: "handlePageChangeRenderDone" },
	{ type: "page-change-commands-meta", handler: "handlePageChangeCommandsMeta" },
	{ type: "page-change-commands-chunk", handler: "handlePageChangeCommandsChunk" },
	{ type: "page-change-commands-done", handler: "handlePageChangeCommandsDone" },
	{ type: "page-change-complete", handler: "handlePageChangeComplete" },
	{ type: "page-change-chunk", handler: "handlePageChangeChunk" },
	{ type: "page-change-done", handler: "handlePageChangeDone" },
	{ type: "push-cmd", handler: "handlePushCommand" },
	{ type: "op-rejected", handler: "handleOperationRejected" },
	{ type: "delete-cmd", handler: "handleDeleteCommand" },
	{ type: "cmd-page-add", handler: "handlePageAdd" },
	{ type: "undo-cmd", handler: "handleUndoRedo" },
	{ type: "redo-cmd", handler: "handleUndoRedo" },
	{ type: "online-count-change", handler: "handleOnlineCountChange" },
	{ type: "mouseMove", handler: "handleMouseMove" },
	{ type: "get-member-list", handler: "handleMemberList" },
	{ type: "mouseLeave", handler: "handleMouseLeave" },
	{ type: "box-selection", handler: "handleBoxSelection" },
];

describe("collab message dispatcher", () => {
	beforeEach(() => {
		for (const handler of [...Object.values(handlers.command), ...Object.values(handlers.presence)]) {
			handler.mockReset();
		}
	});

	it("routes every known message type to exactly one handler", () => {
		const dispatcher = createCollabMessageDispatcher(minimalOptions);

		for (const { type, handler } of routingTable) {
			const allHandlers = [...Object.entries(handlers.command), ...Object.entries(handlers.presence)];
			for (const [, candidate] of allHandlers) candidate.mockClear();
			const msg = message(type);
			dispatcher.handleMessage(msg);

			const called = allHandlers.filter(([, candidate]) => candidate.mock.calls.length > 0);
			expect(called.map(([name]) => name), type).toEqual([handler]);
			expect(called[0]?.[1].mock.calls[0]?.[0], type).toBe(msg);
		}
	});

	it("forwards binary chunk metadata to the dedicated command handlers", () => {
		const dispatcher = createCollabMessageDispatcher(minimalOptions);
		const initMeta = { snapshotVersion: 1, chunkIndex: 0, pointCount: 2 };
		const pageChangeMeta = { requestId: 9, snapshotVersion: 2, chunkIndex: 1 };

		dispatcher.handleInitRenderChunkBinary(initMeta);
		dispatcher.handlePageChangeRenderChunkBinary(pageChangeMeta);

		expect(handlers.command.handleInitRenderChunkBinary).toHaveBeenCalledWith(initMeta);
		expect(handlers.command.handlePageChangeRenderChunkBinary).toHaveBeenCalledWith(pageChangeMeta);
	});

	it("silently ignores unknown types, including transport-level control messages", () => {
		const dispatcher = createCollabMessageDispatcher(minimalOptions);

		expect(() => {
			dispatcher.handleMessage(message("server-pressure"));
			dispatcher.handleMessage(message("server.draining"));
			dispatcher.handleMessage(message("resync.required"));
			dispatcher.handleMessage(message("totally-unknown"));
			dispatcher.handleMessage({ type: "no-data" } as unknown as CollabIncomingMessage);
		}).not.toThrow();

		expect(calledHandlerNames()).toEqual([]);
	});

	it("propagates handler exceptions without corrupting later routing", () => {
		const dispatcher = createCollabMessageDispatcher(minimalOptions);
		handlers.command.handleInitMeta.mockImplementationOnce(() => {
			throw new Error("handler exploded");
		});

		expect(() => dispatcher.handleMessage(message("init-meta"))).toThrow("handler exploded");
		expect(handlers.command.handleInitRenderMeta).not.toHaveBeenCalled();

		const next = message("init-render-meta");
		dispatcher.handleMessage(next);
		expect(handlers.command.handleInitRenderMeta).toHaveBeenCalledWith(next);
	});
});
