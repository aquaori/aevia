import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { EditorPlugin, WhiteboardSessionState } from "../utils/editorTypes";
import { createWhiteboardSession } from "./whiteboardSession";

const makeState = (): WhiteboardSessionState => ({
	currentTool: ref("pen"),
	currentColor: ref("#000000"),
	currentPageId: ref(0),
	totalPages: ref(1),
	onlineCount: ref(1),
	isReconnecting: ref(false),
	remoteCursors: ref(new Map()),
	selection: ref(null),
});

describe("createWhiteboardSession", () => {
	it("manages plugins, canvas mounting, lifecycle transitions, render hooks, and teardown", async () => {
		const calls: string[] = [];
		const teardownFn = vi.fn();
		const disposeObj = vi.fn();
		const options = {
			state: makeState(),
			canUndo: computed(() => true),
			canRedo: computed(() => false),
			initialize: vi.fn(() => false),
			dispose: vi.fn(),
			connect: vi.fn(),
			disconnect: vi.fn(),
			setTool: vi.fn(),
			undo: vi.fn(),
			redo: vi.fn(),
			goToPage: vi.fn(),
			resize: vi.fn(),
			requestDirtyRender: vi.fn(),
			requestRender: vi.fn(),
			requestOverlayRender: vi.fn(),
			getConsistencyWatermarks: vi.fn(async () => ({ roomSeq: 5, render: null })),
			getRenderIR: vi.fn(async () => null),
		};

		const session = createWhiteboardSession(options);
		session.hooks.on("session:lifecycle", ({ phase }) => calls.push(phase));

		const pluginA: EditorPlugin = {
			name: "plugin-a",
			setup: () => teardownFn,
		};
		const pluginB: EditorPlugin = {
			name: "plugin-b",
			setup: () => ({ dispose: disposeObj }),
		};

		const removeA = session.use(pluginA);
		session.use(pluginA); // duplicate ignored
		session.use(pluginB);
		expect(session.hasPlugin("plugin-a")).toBe(true);
		expect(session.listPlugins()).toEqual(["plugin-a", "plugin-b"]);

		const ctx2d = {} as CanvasRenderingContext2D;
		const canvas = {
			getContext: vi.fn(() => ctx2d),
			transferControlToOffscreen: () => ({}),
		} as unknown as HTMLCanvasElement;
		const uiCanvas = { getContext: vi.fn(() => ctx2d) } as unknown as HTMLCanvasElement;

		session.mountCanvas({ canvas, uiCanvas });
		expect(options.initialize).toHaveBeenCalled();
		expect(options.resize).toHaveBeenCalled();

		session.connect();
		session.emitHook("collab:connected", {});
		session.setTool("rect");
		session.goToPage(2);
		session.resize();
		session.requestDirtyRender({ minX: 0 });
		session.requestRender("full");
		session.requestOverlayRender();
		session.undo();
		session.redo();

		expect(await session.getConsistencyWatermarks()).toEqual({ roomSeq: 5, render: null });
		expect(await session.getRenderIR()).toBeNull();

		removeA();
		expect(teardownFn).toHaveBeenCalledTimes(1);
		session.unmount();
		expect(disposeObj).toHaveBeenCalledTimes(1);
		expect(options.dispose).toHaveBeenCalledTimes(1);
		expect(session.lifecycle.value).toBe("destroyed");
		expect(calls).toContain("mounting");
		expect(calls).toContain("ready");
		expect(calls).toContain("connecting");
		expect(calls).toContain("connected");
		expect(calls).toContain("destroyed");
	});
});
