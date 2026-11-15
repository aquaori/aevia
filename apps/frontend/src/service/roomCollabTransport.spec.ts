import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomCollabTransport } from "./roomCollabTransport";

const dispatcherState = vi.hoisted(() => ({ onSnapshot: (_version: number) => {} }));
vi.mock("./roomSessionContext", () => ({ useRoomSessionEmitHook: () => () => {} }));
vi.mock("vue-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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
	constructor(public url: string) { FakeSocket.instances.push(this); }
	send(data: string) { this.sent.push(data); }
	close() { this.readyState = 3; this.onclose?.(); }
	receive(type: string, data: object) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
}

const makeTransport = (confirmInitScene: () => Promise<boolean>, recoverRenderer?: () => Promise<boolean>) => createRoomCollabTransport({
	token: ref("token"), sessionExpiresAt: ref(Date.now() + 3600000), userId: ref("user"), roomId: ref("room"),
	username: ref("user"), roomName: ref("room"), onlineCount: ref(1), totalPages: ref(1), loadedPageIds: ref([0]),
	currentPageId: ref(0), currentTool: ref("pen"), reconnectFailed: ref(false), reconnectFailureMessage: ref(""),
	commands: ref([]), currentCommandIndex: ref(-1), pendingUpdates: ref(new Map()), commandMap: new Map(),
	memberList: ref([]), remoteCursors: ref(new Map()), remoteSelectionRects: ref(new Map()),
	renderCanvas: vi.fn(), goToPage: vi.fn(), applyRemotePageChange: vi.fn(), setTool: vi.fn(),
	insertCommand: vi.fn(), removeCommand: vi.fn(() => null), replaceLoadedPageWindow: vi.fn(),
	applyLoadedPageDelta: vi.fn(), clearClearedCommands: vi.fn(() => false), confirmInitScene, recoverRenderer,
});

describe("snapshot recovery cursor", () => {
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.instances = []; });

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
		expect(second.sent.some((message) => message.includes('"op-1"'))).toBe(true);
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
});
