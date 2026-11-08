import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, EditorTool, Point, RemoteCursor } from "@collaborative-whiteboard/shared";
import type { CollabIncomingMessage } from "./collabDispatcherTypes";

const toastMock = vi.hoisted(() => ({
	info: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("vue-sonner", () => ({ toast: toastMock }));

import { createCollabCommandHandlers } from "./collabCommandHandlers";
import { useLamportStore } from "../store/lamportStore";

const message = (type: string, data: Record<string, unknown> = {}, pushType?: string) =>
	({ type, data, pushType } as unknown as CollabIncomingMessage);

const createIncomingCommand = (overrides: Partial<Command> = {}) =>
	({
		id: "cmd-1",
		type: "path",
		tool: "pen",
		color: "#000000",
		size: 4,
		points: [],
		timestamp: 1,
		userId: "u2",
		roomId: "r1",
		pageId: 0,
		isDeleted: false,
		lamport: 1,
		box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		...overrides,
	}) as Command;

const createFixture = () => {
	const userId = ref("u1");
	const currentPageId = ref(0);
	const loadedPageIds = ref<number[]>([0]);
	const commands = ref<Command[]>([]);
	const currentCommandIndex = ref(-1);
	const getActivePageChangeRequestId = vi.fn<() => number | null>(() => null);
	const getActivePageChangeTargetId = vi.fn<() => number | null>(() => null);

	const options = {
		userId,
		roomId: ref("r1"),
		username: ref("alice"),
		roomName: ref("Room"),
		onlineCount: ref(1),
		totalPages: ref(2),
		loadedPageIds,
		currentPageId,
		currentTool: ref<EditorTool>("pen"),
		commands,
		currentCommandIndex,
		pendingUpdates: ref<Map<string, Point[]>>(new Map()),
		commandMap: new Map<string, Command>(),
		memberList: ref<[string, string][]>([]),
		remoteCursors: ref<Map<string, RemoteCursor>>(new Map()),
		remoteSelectionRects: ref<Map<string, { x: number; y: number; w: number; h: number }>>(new Map()),
		renderCanvas: vi.fn(),
		requestDirtyRender: vi.fn(),
		requestSceneRefresh: vi.fn(),
		syncCommandState: vi.fn(),
		removeCommandState: vi.fn(),
		renderIncrementalCommand: vi.fn(),
		renderSinglePointCommand: vi.fn(),
		finishIncrementalCommand: vi.fn(),
		isOffscreenMainCanvas: vi.fn(() => false),
		beginInitRenderStream: vi.fn(),
		appendInitRenderChunk: vi.fn(),
		appendInitRenderBinaryChunk: vi.fn(),
		finishInitRenderStream: vi.fn(),
		setInitSceneOperations: vi.fn(),
		syncWorkerScene: vi.fn(),
		renderSceneFromFlatPoints: vi.fn(),
		goToPage: vi.fn(),
		applyRemotePageChange: vi.fn(),
		getActivePageChangeRequestId,
		getActivePageChangeTargetId,
		clearActivePageChangeRequest: vi.fn(),
		setTool: vi.fn(),
		insertCommand: vi.fn(),
		removeCommand: vi.fn(() => null),
		replaceLoadedPageWindow: vi.fn(),
		applyLoadedPageDelta: vi.fn(),
		clearClearedCommands: vi.fn(() => false),
		requestCurrentPageResync: vi.fn(() => true),
		cancelRejectedLocalCommand: vi.fn(),
		cancelRejectedOperation: vi.fn(),
		notifyRemoteTextPatch: vi.fn(),
		onInitConnectionState: vi.fn(),
		onInitStreamInvalid: vi.fn(),
		emitHook: vi.fn(),
	};

	const handlers = createCollabCommandHandlers(options);

	return {
		handlers,
		options,
		userId,
		currentPageId,
		loadedPageIds,
		commands,
		getActivePageChangeRequestId,
		getActivePageChangeTargetId,
	};
};

const startInitStream = (fixture: ReturnType<typeof createFixture>, renderChunks = 1) => {
	fixture.handlers.handleInitMeta(
		message("init-meta", {
			pageId: 0,
			loadedPageIds: [0],
			totalPage: 1,
			maxLamport: 5,
			snapshotVersion: 1,
			chunkSummary: { totalRenderChunks: renderChunks, totalCommandChunks: 1 },
		})
	);
};

const finishInitRenderStream = (fixture: ReturnType<typeof createFixture>, lamportEnd = 6) => {
	fixture.handlers.handleInitRenderChunkBinary({
		snapshotVersion: 1,
		chunkIndex: 0,
		isLastChunk: true,
		pointCount: 0,
		commands: [],
		lamportStart: 4,
		lamportEnd,
	});
	fixture.handlers.handleInitRenderDone(
		message("init-render-done", { snapshotVersion: 1, totalChunks: 1 })
	);
};

const finishInitCommandsStream = (fixture: ReturnType<typeof createFixture>) => {
	fixture.handlers.handleInitCommandsMeta(
		message("init-commands-meta", { snapshotVersion: 1, loadedPageIds: [0], totalChunks: 1 })
	);
	fixture.handlers.handleInitCommandsChunk(
		message("init-commands-chunk", {
			snapshotVersion: 1,
			chunkIndex: 0,
			isLastChunk: true,
			commands: [createIncomingCommand()],
		})
	);
	fixture.handlers.handleInitCommandsDone(
		message("init-commands-done", { snapshotVersion: 1, totalChunks: 1 })
	);
};

describe("collab command handlers", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
		toastMock.info.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("advances init-meta -> render chunks -> commands -> complete in order", () => {
		const fixture = createFixture();

		startInitStream(fixture);
		expect(fixture.options.onInitConnectionState).toHaveBeenCalledOnce();
		expect(fixture.options.applyRemotePageChange).toHaveBeenCalledWith(0, 1, {
			deferRender: true,
		});
		expect(fixture.options.beginInitRenderStream).toHaveBeenCalledWith(0);
		expect(useLamportStore().lamport).toBe(5);

		finishInitRenderStream(fixture);
		expect(fixture.options.finishInitRenderStream).toHaveBeenCalledOnce();
		expect(useLamportStore().lamport).toBe(6);

		finishInitCommandsStream(fixture);
		expect(fixture.options.renderCanvas).not.toHaveBeenCalled();
		fixture.handlers.handleInitComplete(message("init-complete", { snapshotVersion: 1 }));
		expect(fixture.options.replaceLoadedPageWindow).toHaveBeenCalledWith(
			[0],
			expect.arrayContaining([expect.objectContaining({ id: "cmd-1" })])
		);
		expect(fixture.options.setInitSceneOperations).toHaveBeenCalled();
		expect(fixture.options.renderCanvas).toHaveBeenCalledOnce();

		fixture.handlers.handlePushCommand(
			message("push-cmd", { cmd: createIncomingCommand({ id: "cmd-after-init" }), lamport: 7 }, "normal")
		);
		expect(fixture.options.insertCommand).toHaveBeenCalledWith(
			expect.objectContaining({ id: "cmd-after-init" })
		);
		expect(fixture.options.emitHook).toHaveBeenCalledWith("command:applied", {
			command: expect.objectContaining({ id: "cmd-after-init" }),
			source: "remote",
		});
	});

	it("keeps an early init-complete pending and buffers live commands until chunks settle", () => {
		const fixture = createFixture();
		startInitStream(fixture);

		fixture.handlers.handleInitComplete(message("init-complete", { snapshotVersion: 1 }));
		const liveCommand = createIncomingCommand({ id: "live-remote" });
		fixture.handlers.handlePushCommand(
			message("push-cmd", { cmd: liveCommand, lamport: 9 }, "normal")
		);

		expect(fixture.options.emitHook).not.toHaveBeenCalled();
		expect(fixture.options.replaceLoadedPageWindow).toHaveBeenCalledTimes(1);

		finishInitRenderStream(fixture);
		finishInitCommandsStream(fixture);

		expect(fixture.options.emitHook).toHaveBeenCalledWith("command:before-apply", {
			command: expect.objectContaining({ id: "live-remote" }),
			source: "remote",
		});
		expect(fixture.options.emitHook).toHaveBeenCalledWith("command:applied", {
			command: expect.objectContaining({ id: "live-remote" }),
			source: "remote",
		});
	});

	it("does not finalize the render stream until the first chunk index arrives", () => {
		const fixture = createFixture();
		startInitStream(fixture, 2);

		fixture.handlers.handleInitRenderChunkBinary({
			snapshotVersion: 1,
			chunkIndex: 1,
			isLastChunk: true,
			pointCount: 0,
			commands: [],
			lamportEnd: 8,
		});
		fixture.handlers.handleInitRenderDone(
			message("init-render-done", { snapshotVersion: 1, totalChunks: 2 })
		);
		expect(fixture.options.finishInitRenderStream).not.toHaveBeenCalled();

		fixture.handlers.handleInitRenderChunkBinary({
			snapshotVersion: 1,
			chunkIndex: 0,
			isLastChunk: true,
			pointCount: 0,
			commands: [],
			lamportEnd: 9,
		});
		expect(fixture.options.finishInitRenderStream).toHaveBeenCalledOnce();
	});

	it("ignores render chunks from another snapshot version", () => {
		const fixture = createFixture();
		startInitStream(fixture);

		fixture.handlers.handleInitRenderChunkBinary({
			snapshotVersion: 99,
			chunkIndex: 0,
			isLastChunk: true,
			pointCount: 0,
			commands: [],
		});
		fixture.handlers.handleInitRenderDone(
			message("init-render-done", { snapshotVersion: 1, totalChunks: 1 })
		);

		expect(fixture.options.finishInitRenderStream).not.toHaveBeenCalled();
	});

	it("rejects a stream whose completion count differs from its snapshot metadata", () => {
		const fixture = createFixture();
		startInitStream(fixture);
		fixture.handlers.handleInitRenderDone(message("init-render-done", { snapshotVersion: 1, totalChunks: 0 }));
		expect(fixture.options.onInitStreamInvalid).toHaveBeenCalledOnce();
		expect(fixture.options.finishInitRenderStream).not.toHaveBeenCalled();
	});

	it("normalizes the init loaded-page window on init-meta", () => {
		const fixture = createFixture();

		fixture.handlers.handleInitMeta(
			message("init-meta", {
				pageId: 0,
				loadedPageIds: [2, "1", 2, -1],
				totalPage: 3,
				snapshotVersion: 1,
			})
		);

		// protocolPageToState clamps negatives to 0 (existing normalization), then
		// the window is deduplicated and sorted.
		expect(fixture.options.replaceLoadedPageWindow).toHaveBeenCalledWith([0, 1, 2], []);
		expect(fixture.loadedPageIds.value).toEqual([0, 1, 2]);
	});

	it("applies a page-change stream matching the active request and normalizes loaded ids", () => {
		const fixture = createFixture();
		fixture.getActivePageChangeRequestId.mockReturnValue(7);
		fixture.getActivePageChangeTargetId.mockReturnValue(3);

		fixture.handlers.handlePageChangeMeta(
			message("page-change-meta", {
				requestId: 7,
				pageId: 0,
				loadedPageIds: [3, 2],
				loadPageIds: [2],
				unloadPageIds: [0],
				totalPages: 5,
				snapshotVersion: 2,
				chunkSummary: { totalRenderChunks: 1, totalCommandChunks: 1 },
			})
		);

		expect(fixture.options.applyRemotePageChange).toHaveBeenCalledWith(3, 5, {
			deferRender: true,
			requestId: 7,
		});
		expect(fixture.options.beginInitRenderStream).toHaveBeenCalledWith(3);

		fixture.handlers.handlePageChangeRenderChunkBinary({
			requestId: 7,
			snapshotVersion: 2,
			chunkIndex: 0,
			isLastChunk: true,
			pointCount: 0,
			commands: [],
			lamportEnd: 6,
		});
		fixture.handlers.handlePageChangeRenderDone(
			message("page-change-render-done", { requestId: 7, snapshotVersion: 2, totalChunks: 1 })
		);
		expect(fixture.options.finishInitRenderStream).toHaveBeenCalledOnce();

		fixture.handlers.handlePageChangeCommandsMeta(
			message("page-change-commands-meta", {
				requestId: 7,
				snapshotVersion: 2,
				loadedPageIds: [3, 2],
				loadPageIds: [2],
				unloadPageIds: [0],
				totalChunks: 1,
			})
		);
		fixture.handlers.handlePageChangeCommandsChunk(
			message("page-change-commands-chunk", {
				requestId: 7,
				snapshotVersion: 2,
				chunkIndex: 0,
				isLastChunk: true,
				commands: [createIncomingCommand()],
			})
		);
		fixture.handlers.handlePageChangeCommandsDone(
			message("page-change-commands-done", { requestId: 7, snapshotVersion: 2, totalChunks: 1 })
		);

		expect(fixture.options.applyLoadedPageDelta).toHaveBeenCalledWith({
			loadedPageIds: [2, 3],
			loadPageIds: [2],
			unloadPageIds: [0],
			commands: [expect.objectContaining({ id: "cmd-1" })],
		});
		expect(fixture.loadedPageIds.value).toEqual([2, 3]);
		expect(fixture.options.clearActivePageChangeRequest).not.toHaveBeenCalled();

		fixture.handlers.handlePageChangeComplete(
			message("page-change-complete", { requestId: 7, snapshotVersion: 2 })
		);
		expect(fixture.options.clearActivePageChangeRequest).toHaveBeenCalledWith(7);
	});

	it("ignores page-change frames for a stale or missing request id", () => {
		const fixture = createFixture();
		fixture.getActivePageChangeRequestId.mockReturnValue(7);

		fixture.handlers.handlePageChangeMeta(
			message("page-change-meta", { requestId: 8, pageId: 0, snapshotVersion: 2 })
		);
		expect(fixture.options.applyRemotePageChange).not.toHaveBeenCalled();

		fixture.handlers.handlePageChangeMeta(
			message("page-change-meta", { requestId: "not-a-number", pageId: 0, snapshotVersion: 2 })
		);
		expect(fixture.options.applyRemotePageChange).not.toHaveBeenCalled();

		fixture.handlers.handlePageChangeMeta(
			message("page-change-meta", { requestId: 7, pageId: 0, snapshotVersion: 2 })
		);
		fixture.handlers.handlePageChangeRenderChunkBinary({
			requestId: 8,
			snapshotVersion: 2,
			chunkIndex: 0,
			isLastChunk: true,
			pointCount: 0,
			commands: [],
		});
		fixture.handlers.handlePageChangeRenderDone(
			message("page-change-render-done", { requestId: 8, snapshotVersion: 2, totalChunks: 1 })
		);
		expect(fixture.options.finishInitRenderStream).not.toHaveBeenCalled();
	});

	it("handles delta replay meta/complete and tolerates a complete without meta", () => {
		const fixture = createFixture();

		fixture.handlers.handleDeltaReplayMeta(message("delta-replay-meta"));
		expect(fixture.options.onInitConnectionState).toHaveBeenCalledOnce();

		fixture.handlers.handleDeltaReplayComplete(message("delta-replay-complete"));
		expect(fixture.options.requestSceneRefresh).toHaveBeenCalledOnce();

		expect(() =>
			fixture.handlers.handleDeltaReplayComplete(message("delta-replay-complete"))
		).not.toThrow();
		expect(fixture.options.requestSceneRefresh).toHaveBeenCalledTimes(2);
	});

	it("replaces an in-flight init stream when a new init-meta arrives", () => {
		const fixture = createFixture();
		startInitStream(fixture);

		fixture.handlers.handleInitMeta(
			message("init-meta", { pageId: 1, loadedPageIds: [1], totalPage: 2, snapshotVersion: 2 })
		);

		expect(fixture.options.applyRemotePageChange).toHaveBeenCalledTimes(2);
		expect(fixture.options.beginInitRenderStream).toHaveBeenLastCalledWith(1);
	});
});
