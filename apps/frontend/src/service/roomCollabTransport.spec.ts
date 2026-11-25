import { markRaw, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomCollabTransport } from "./roomCollabTransport";

const dispatcherState = vi.hoisted(() => ({ onSnapshot: (_version: number) => {} }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const pendingMock = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./roomSessionContext", () => ({ useRoomSessionEmitHook: () => () => {} }));
vi.mock("vue-sonner", () => ({ toast: toastMock }));
vi.mock("./sessionApi", () => ({ requestWebsocketTicket: vi.fn(async () => "ticket"), renewRoomSession: vi.fn() }));
vi.mock("./pendingSceneStore", () => ({ PendingSceneStore: { open: async () => ({
	load: async () => [...pendingMock.entries()],
	put: async (id: string, value: unknown) => { pendingMock.set(id, value); },
	delete: async (id: string) => { pendingMock.delete(id); },
}) } }));
vi.mock("./collabMessageDispatcher", () => ({
	createCollabMessageDispatcher: (options: { onInitSnapshotCommitted: (version: number) => void }) => {
		dispatcherState.onSnapshot = options.onInitSnapshotCommitted;
		return { handleMessage: vi.fn(), clearInitCompletionTimer: vi.fn(), recordPageChangeLocalCommand: vi.fn(), handleInitRenderChunkBinary: vi.fn(), handlePageChangeRenderChunkBinary: vi.fn() };
	},
}));

class FakeSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static instances: FakeSocket[] = [];
	readyState = FakeSocket.OPEN;
	binaryType = "";
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	constructor(public url: string) { markRaw(this); FakeSocket.instances.push(this); }
	send(data: string) { this.sent.push(data); }
	close() { this.readyState = 3; this.onclose?.(); }
	receive(type: string, data: object) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
}

const makeTransport = (confirmInitScene: () => Promise<boolean>, recoverRenderer?: () => Promise<boolean>, applyLoadedPageDelta = vi.fn(), activePageRequest?: () => number | null) => createRoomCollabTransport({
	token: ref(`header.${btoa(JSON.stringify({ roomId: "room", roomCreatedAt: 1, userId: "user" }))}.signature`), sessionExpiresAt: ref(Date.now() + 3600000), userId: ref("user"), roomId: ref("room"),
	username: ref("user"), roomName: ref("room"), onlineCount: ref(1), totalPages: ref(1), loadedPageIds: ref([0]),
	currentPageId: ref(0), currentTool: ref("pen"), reconnectFailed: ref(false), reconnectFailureMessage: ref(""),
	commands: ref([]), currentCommandIndex: ref(-1), pendingUpdates: ref(new Map()), commandMap: new Map(),
	memberList: ref([]), remoteCursors: ref(new Map()), remoteSelectionRects: ref(new Map()),
	renderCanvas: vi.fn(), goToPage: vi.fn(), applyRemotePageChange: vi.fn(), setTool: vi.fn(),
	insertCommand: vi.fn(), removeCommand: vi.fn(() => null), replaceLoadedPageWindow: vi.fn(),
	applyLoadedPageDelta, clearClearedCommands: vi.fn(() => false), confirmInitScene, recoverRenderer, getActivePageChangeRequestId: activePageRequest,
});

describe("snapshot recovery cursor", () => {
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.instances = []; pendingMock.clear(); window.history.replaceState({}, "", "/"); vi.clearAllMocks(); });

	it("checks the worker only after the active page snapshot completes", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		const confirm = vi.fn(async () => true);
		const transport = makeTransport(confirm, undefined, vi.fn(), () => 17);
		await transport.connect();
		const connection = FakeSocket.instances[0]!;
		connection.receive("page-change-complete", { requestId: 16 });
		expect(confirm).not.toHaveBeenCalled();
		connection.receive("page-change-complete", { requestId: 17 });
		expect(confirm).toHaveBeenCalledOnce();
		transport.disconnect();
	});

	it("restores a previously unconfirmed operation and removes it after acknowledgement", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		pendingMock.set("op-old", { cmd: { id: "op-old", type: "scene-op", pageId: 1, sceneOperation: { opId: "op-old" } } });
		const transport = makeTransport(() => Promise.resolve(true));
		await transport.connect();
		const connection = FakeSocket.instances[0]!;
		connection.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		await vi.waitFor(() => expect(connection.sent.some((message) => message.includes('"op-old"'))).toBe(true));
		connection.receive("ack.accepted", { opId: "op-old" });
		await vi.waitFor(() => expect(pendingMock.has("op-old")).toBe(false));
		transport.disconnect();
	});

	it("requests pre-clear history after scene confirmation and merges it only after completion", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		window.history.replaceState({}, "", "/room?historyToast=1");
		let confirm!: (valid: boolean) => void;
		const merge = vi.fn();
		const transport = makeTransport(() => new Promise((resolve) => { confirm = resolve; }), undefined, merge);
		await transport.connect();
		const connection = FakeSocket.instances[0]!;
		connection.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		expect(connection.sent).toHaveLength(0);
		confirm(true);
		await Promise.resolve();
		const request = JSON.parse(connection.sent[0]!);
		expect(request.type).toBe("load-page-history");
		expect(transport.isPageHistoryReady(0)).toBe(false);
		connection.receive("page-history-chunk", { requestId: request.data.requestId, pageId: 0, commands: [{ id: "old", pageId: 0 }] });
		expect(merge).not.toHaveBeenCalled();
		connection.receive("page-history-complete", { requestId: request.data.requestId, pageId: 0 });
		expect(merge).toHaveBeenCalledWith(expect.objectContaining({ commands: [expect.objectContaining({ id: "old" })] }));
		expect(transport.isPageHistoryReady(0)).toBe(true);
		expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("历史已补齐（1 条）"));
		transport.disconnect();
	});

	it("resumes a history fragment after a retry at the same snapshot", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		const merge = vi.fn();
		const transport = makeTransport(() => Promise.resolve(true), undefined, merge);
		await transport.connect();
		const connection = FakeSocket.instances[0]!;
		connection.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		await Promise.resolve();
		const first = JSON.parse(connection.sent[0]!).data;
		connection.receive("page-history-meta", { requestId: first.requestId, pageId: 0, snapshotVersion: 42, resumed: false });
		connection.receive("page-history-chunk", { requestId: first.requestId, pageId: 0, cursor: "old-a", commands: [{ id: "old-a", pageId: 0 }] });
		connection.receive("page-history-failed", { requestId: first.requestId, pageId: 0 });
		vi.advanceTimersByTime(2000);
		const second = JSON.parse(connection.sent[1]!).data;
		expect(second).toMatchObject({ snapshotVersion: 42, cursor: "old-a" });
		connection.receive("page-history-meta", { requestId: second.requestId, pageId: 0, snapshotVersion: 42, resumed: true });
		connection.receive("page-history-chunk", { requestId: second.requestId, pageId: 0, cursor: "old-b", commands: [{ id: "old-b", pageId: 0 }] });
		connection.receive("page-history-complete", { requestId: second.requestId, pageId: 0 });
		expect(merge).toHaveBeenCalledWith(expect.objectContaining({ commands: [expect.objectContaining({ id: "old-a" }), expect.objectContaining({ id: "old-b" })] }));
		transport.disconnect();
	});

	it("reconnects from a full snapshot and retries unconfirmed operations after renderer recovery", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		const recover = vi.fn(async () => true);
		const transport = makeTransport(() => Promise.resolve(true), recover);
		await transport.connect();
		const first = FakeSocket.instances[0]!;
		first.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		await Promise.resolve();
		transport.send("push-cmd", { cmd: {
			id: "op-1", type: "scene-op", pageId: 0, schemaVersion: 2,
			sceneOperation: { schemaVersion: 2, opId: "op-1", elementId: "stroke", actorId: "user", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "op-1", kind: "element.delete", payload: { elementIds: ["stroke"] } },
		} });
		transport.handleRenderWorkerFailure();
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
		const second = FakeSocket.instances[1]!;
		expect(recover).toHaveBeenCalledOnce();
		expect(second.url).not.toContain("lastRoomSeq");
		second.receive("init-meta", { snapshotVersion: 43 });
		dispatcherState.onSnapshot(43);
		await Promise.resolve();
		await vi.waitFor(() => expect(second.sent.some((message) => message.includes('"op-1"'))).toBe(true));
		transport.disconnect();
	});

	it("does not reconnect after leaving during renderer recovery", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		let finish!: (result: boolean) => void;
		const transport = makeTransport(() => Promise.resolve(true), () => new Promise((resolve) => { finish = resolve; }));
		await transport.connect();
		transport.handleRenderWorkerFailure();
		transport.disconnect();
		finish(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("does not resume from a snapshot until the worker has confirmed it", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		let settle!: (valid: boolean) => void;
		const transport = makeTransport(() => new Promise<boolean>((resolve) => { settle = resolve; }));
		await transport.connect();
		const first = FakeSocket.instances[0]!;
		first.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		first.close();
		await transport.connect();
		const second = FakeSocket.instances[1]!;
		expect(second.url).not.toContain("lastRoomSeq=42");
		settle(true);
		await Promise.resolve();
		second.close();
		await transport.connect();
		expect(FakeSocket.instances[2]!.url).not.toContain("lastRoomSeq=42");
		transport.disconnect();
	});

	it("stops recovery and reports a worker failure instead of resuming from its cursor", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		const transport = makeTransport(() => Promise.resolve(true));
		await transport.connect();
		FakeSocket.instances[0]!.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		await Promise.resolve();
		transport.handleRenderWorkerFailure();
		expect(FakeSocket.instances[0]!.readyState).toBe(3);
		expect(transport.isIntentionalClose.value).toBe(true);
		await transport.connect();
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("uses the snapshot sequence after worker confirmation", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		const transport = makeTransport(() => Promise.resolve(true));
		await transport.connect();
		FakeSocket.instances[0]!.receive("init-meta", { snapshotVersion: 42 });
		dispatcherState.onSnapshot(42);
		await Promise.resolve();
		FakeSocket.instances[0]!.close();
		await transport.connect();
		expect(FakeSocket.instances[1]!.url).toContain("lastRoomSeq=42");
		transport.disconnect();
	});

	it("handles role changes, server pressure/draining, session replaced, access revoked, and member list", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		const transport = makeTransport(() => Promise.resolve(true));
		await transport.connect();
		const conn = FakeSocket.instances[0]!;

		expect(transport.send("custom-ping", { ok: true })).toBe(true);
		transport.openMemberList();
		expect(conn.sent.some((raw) => raw.includes("get-member-list"))).toBe(true);

		conn.receive("role.current", { role: "editor" });
		conn.receive("role.changed", { role: "viewer" });
		expect(toastMock.info).toHaveBeenCalled();

		conn.receive("server-pressure", { overloaded: true });
		conn.receive("server.draining", {});
		conn.receive("resync.required", { reason: "lag" });

		// session.replaced marks intentional close + reconnectFailed
		conn.receive("session.replaced", {});
		expect(transport.isIntentionalClose.value).toBe(true);
		transport.disconnect();

		// access.revoked on a fresh connection marks intentional close
		const transport2 = makeTransport(() => Promise.resolve(true));
		await transport2.connect();
		const conn2 = FakeSocket.instances[1]!;
		conn2.receive("access.revoked", {});
		expect(transport2.isIntentionalClose.value).toBe(true);
		transport2.retryReconnect();
		transport2.disconnect();
	});
});
