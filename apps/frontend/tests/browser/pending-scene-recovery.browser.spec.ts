import { afterEach, expect, it, vi } from "vitest";
import { markRaw, ref } from "vue";
import { createRoomCollabTransport } from "../../src/service/roomCollabTransport";
import { PendingSceneStore } from "../../src/service/pendingSceneStore";

const dispatcher = vi.hoisted(() => ({ onSnapshot: (_version: number) => {} }));
vi.mock("../../src/service/roomSessionContext", () => ({ useRoomSessionEmitHook: () => () => {} }));
vi.mock("../../src/service/sessionApi", () => ({ requestWebsocketTicket: async () => "ticket", renewRoomSession: async () => ({}) }));
vi.mock("../../src/service/collabMessageDispatcher", () => ({
	createCollabMessageDispatcher: (options: { onInitSnapshotCommitted: (version: number) => void }) => {
		dispatcher.onSnapshot = options.onInitSnapshotCommitted;
		return { handleMessage: () => {}, clearInitCompletionTimer: () => {}, recordPageChangeLocalCommand: () => {}, handleInitRenderChunkBinary: () => {}, handlePageChangeRenderChunkBinary: () => {} };
	},
}));

class TestSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static instances: TestSocket[] = [];
	readyState = TestSocket.OPEN;
	binaryType = "";
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	constructor() { markRaw(this); TestSocket.instances.push(this); }
	send(data: string) { this.sent.push(data); }
	close() { this.readyState = 3; this.onclose?.(); }
	receive(type: string, data: object) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
}

afterEach(() => { vi.unstubAllGlobals(); TestSocket.instances = []; });

it("restores an unconfirmed operation from IndexedDB after reopening and removes it on acknowledgement", async () => {
	vi.stubGlobal("WebSocket", TestSocket);
	const roomId = `test-${crypto.randomUUID()}`;
	const actorId = "writer";
	const token = `header.${btoa(JSON.stringify({ roomId, roomCreatedAt: 123, userId: actorId }))}.signature`;
	const create = () => createRoomCollabTransport({
		token: ref(token), sessionExpiresAt: ref(Date.now() + 3600000), userId: ref(actorId), roomId: ref(roomId),
		username: ref("writer"), roomName: ref("room"), onlineCount: ref(1), totalPages: ref(1), loadedPageIds: ref([0]),
		currentPageId: ref(0), currentTool: ref("pen"), reconnectFailed: ref(false), reconnectFailureMessage: ref(""),
		commands: ref([]), currentCommandIndex: ref(-1), pendingUpdates: ref(new Map()), commandMap: new Map(),
		memberList: ref([]), remoteCursors: ref(new Map()), remoteSelectionRects: ref(new Map()),
		renderCanvas: () => {}, goToPage: () => {}, applyRemotePageChange: () => {}, setTool: () => {},
		insertCommand: () => {}, removeCommand: () => null, replaceLoadedPageWindow: () => {}, applyLoadedPageDelta: () => {},
		clearClearedCommands: () => false, confirmInitScene: async () => true,
	});
	const first = create();
	await first.connect();
	const firstSocket = TestSocket.instances[0]!;
	firstSocket.receive("init-meta", { snapshotVersion: 0 });
	dispatcher.onSnapshot(0);
	const id = `op-${crypto.randomUUID()}`;
	expect(first.send("push-cmd", { cmd: { id, type: "scene-op", pageId: 0, schemaVersion: 2,
		sceneOperation: { schemaVersion: 2, opId: id, elementId: "stroke", actorId, roomId, pageId: 0, lamport: 1, historyGroupId: id, kind: "element.delete", payload: { elementIds: ["stroke"] } } } })).toBe(true);
	await vi.waitFor(() => expect(firstSocket.sent.some((message) => message.includes(id))).toBe(true));
	first.disconnect();

	const reopened = create();
	await reopened.connect();
	const secondSocket = TestSocket.instances[1]!;
	secondSocket.receive("init-meta", { snapshotVersion: 0 });
	dispatcher.onSnapshot(0);
	await vi.waitFor(() => expect(secondSocket.sent.some((message) => message.includes(id))).toBe(true));
	secondSocket.receive("ack.accepted", { opId: id });
	const store = await PendingSceneStore.open(roomId, 123, actorId);
	await vi.waitFor(async () => expect(await store.load()).toEqual([]));
	reopened.disconnect();
});
