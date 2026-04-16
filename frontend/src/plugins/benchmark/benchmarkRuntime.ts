// File role: benchmark runtime controller that is activated by the benchmark plugin only.
import type { Ref } from "vue";
import type { RuntimeInstrumentationAdapter } from "../../instrumentation/runtimeInstrumentation";

export type BenchmarkEventName =
	| "init-received"
	| "init-parsed"
	| "commands-hydrated"
	| "render-start"
	| "render-end"
	| "incremental-render-start"
	| "incremental-render-end"
	| "dirty-redraw-start"
	| "dirty-redraw-end"
	| "undo-start"
	| "undo-end"
	| "redo-start"
	| "redo-end"
	| "page-switch-start"
	| "page-switch-end"
	| "local-input-start"
	| "local-input-render-start"
	| "local-input-render-end"
	| "remote-command-sent"
	| "remote-command-received"
	| "remote-render-start"
	| "remote-render-end"
	| "heap-sample"
	| "visible-paint";

export interface BenchmarkRuntimeEvent {
	name: BenchmarkEventName;
	ts: number;
	detail?: Record<string, unknown>;
}

interface BenchmarkRenderSummary {
	reason: string;
	points: number;
	durationMs: number;
	ts: number;
	visiblePaintTs?: number;
	visiblePaintMs?: number;
	canvasSignature?: string;
}

interface BenchmarkDirtySummary {
	count: number;
	lastDurationMs: number;
	lastRect: { minX: number; minY: number; width: number; height: number } | null;
	lastPointCount: number;
	lastVisiblePaintTs: number;
	lastVisiblePaintMs: number;
	lastCanvasSignature: string;
}

interface BenchmarkHeapSummary {
	lastUsedMb: number;
	peakUsedMb: number;
	startUsedMb: number;
	endUsedMb: number;
	samples: Array<{ ts: number; usedMb: number }>;
}

interface BenchmarkRemoteCommandState {
	commandId: string;
	sendTs: number;
	receiveTs?: number;
	renderStartTs?: number;
	renderEndTs?: number;
	visiblePaintTs?: number;
	visiblePaintMs?: number;
	canvasSignature?: string;
}

export interface BenchmarkRuntimeState {
	events: BenchmarkRuntimeEvent[];
	lastFullRender: BenchmarkRenderSummary | null;
	lastIncrementalRender: BenchmarkRenderSummary | null;
	lastDirtyRedraw: BenchmarkDirtySummary;
	lastPageSwitch: { fromPageId: number; toPageId: number; durationMs: number } | null;
	lastUndo: { source: string; durationMs: number } | null;
	lastRedo: { source: string; durationMs: number } | null;
	lastInit:
		| {
				payloadBytes: number;
				commandCount: number;
				receiveTs: number;
				parseDurationMs: number;
				hydrateDurationMs: number;
				visiblePaintTs?: number;
				visiblePaintMs?: number;
				canvasSignature?: string;
		  }
		| null;
	localInput: {
		lastStartTs: number;
		lastRenderStartTs: number;
		lastRenderEndTs: number;
		lastVisiblePaintTs: number;
		lastVisiblePaintMs: number;
		lastCommandId: string;
		canvasSignature: string;
	};
	remoteCommands: Record<string, BenchmarkRemoteCommandState>;
	renderCounters: Record<string, number>;
	heap: BenchmarkHeapSummary;
	currentPageId: number;
	totalPages: number;
	commandCount: number;
	lastCommandDigest: string;
	lastRenderReason: string | null;
}

declare global {
	interface Window {
		__benchmarkRuntime?: BenchmarkRuntimeState;
		__benchmarkCommands?: Ref<Array<{ id: string }>> | { value?: Array<{ id: string }> };
		__benchmarkCurrentColor?: Ref<string> | { value?: string };
		__benchmarkRenderPageContentFromPoints?: (
			ctx: CanvasRenderingContext2D,
			width: number,
			height: number,
			points: Array<Record<string, unknown>>
		) => void;
		__benchmarkRunMicroRender?: () => Promise<{
			microAppRenderMs: number;
			microVisiblePaintMs: number;
			microPoints: number;
			microCostPerPoint: number;
		}>;
		__ENABLE_BENCHMARK__?: boolean;
		__BENCHMARK_DEBUG_LOGS__?: boolean;
	}
}

interface BenchmarkRuntimeBindings {
	getMainCanvas?: () => HTMLCanvasElement | null;
	commands?: Ref<Array<{ id: string }>>;
	currentColor?: Ref<string>;
	exposeGlobals?: boolean;
	debugLogs?: boolean;
}

type VisibleMeasurementKind =
	| { type: "full-render"; points: number }
	| { type: "dirty-redraw"; pointCount: number }
	| { type: "incremental-render"; commandId?: string; points: number; source: "local" | "remote" }
	| { type: "init"; commandCount: number };

const MAX_EVENTS = 4000;

const createInitialState = (): BenchmarkRuntimeState => ({
	events: [],
	lastFullRender: null,
	lastIncrementalRender: null,
	lastDirtyRedraw: {
		count: 0,
		lastDurationMs: 0,
		lastRect: null,
		lastPointCount: 0,
		lastVisiblePaintTs: 0,
		lastVisiblePaintMs: 0,
		lastCanvasSignature: "",
	},
	lastPageSwitch: null,
	lastUndo: null,
	lastRedo: null,
	lastInit: null,
	localInput: {
		lastStartTs: 0,
		lastRenderStartTs: 0,
		lastRenderEndTs: 0,
		lastVisiblePaintTs: 0,
		lastVisiblePaintMs: 0,
		lastCommandId: "",
		canvasSignature: "",
	},
	remoteCommands: {},
	renderCounters: {},
	heap: {
		lastUsedMb: 0,
		peakUsedMb: 0,
		startUsedMb: 0,
		endUsedMb: 0,
		samples: [],
	},
	currentPageId: 0,
	totalPages: 1,
	commandCount: 0,
	lastCommandDigest: "",
	lastRenderReason: null,
});

let activeRuntime: BenchmarkRuntimeState | null = null;
let runtimeBindings: BenchmarkRuntimeBindings = {};
const visiblePaintTokens = new Map<string, number>();

const shouldEnableBenchmarkRuntime = () => {
	if (typeof window !== "undefined" && window.__ENABLE_BENCHMARK__ === true) {
		return true;
	}
	return import.meta.env.VITE_ENABLE_BENCHMARK === "true";
};

const ensureRuntime = (): BenchmarkRuntimeState | null => activeRuntime;

const exposeGlobals = () => {
	if (typeof window === "undefined" || !activeRuntime) return;
	window.__benchmarkRuntime = activeRuntime;
	if (runtimeBindings.commands) {
		window.__benchmarkCommands = runtimeBindings.commands;
	}
	if (runtimeBindings.currentColor) {
		window.__benchmarkCurrentColor = runtimeBindings.currentColor;
	}
};

const clearGlobals = () => {
	if (typeof window === "undefined") return;
	delete window.__benchmarkRuntime;
	delete window.__benchmarkCommands;
	delete window.__benchmarkCurrentColor;
};

const activateBenchmarkRuntime = (bindings: BenchmarkRuntimeBindings = {}) => {
	activeRuntime = createInitialState();
	runtimeBindings = bindings;
	if (bindings.exposeGlobals !== false) {
		exposeGlobals();
	}
	return activeRuntime;
};

const deactivateBenchmarkRuntime = () => {
	activeRuntime = null;
	runtimeBindings = {};
	visiblePaintTokens.clear();
	clearGlobals();
};

const pushEvent = (name: BenchmarkEventName, detail?: Record<string, unknown>) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.events.push({ name, ts: performance.now(), detail });
	if (runtime.events.length > MAX_EVENTS) {
		runtime.events.splice(0, runtime.events.length - MAX_EVENTS);
	}
};

const sampleHeapUsage = () => {
	const runtime = ensureRuntime();
	if (!runtime || typeof performance === "undefined") return 0;
	const memory = (performance as any).memory;
	const usedMb = memory ? memory.usedJSHeapSize / (1024 * 1024) : 0;
	runtime.heap.lastUsedMb = usedMb;
	runtime.heap.endUsedMb = usedMb;
	if (runtime.heap.startUsedMb === 0) {
		runtime.heap.startUsedMb = usedMb;
	}
	runtime.heap.peakUsedMb = Math.max(runtime.heap.peakUsedMb, usedMb);
	runtime.heap.samples.push({ ts: performance.now(), usedMb });
	if (runtime.heap.samples.length > 500) {
		runtime.heap.samples.splice(0, runtime.heap.samples.length - 500);
	}
	pushEvent("heap-sample", { usedMb });
	return usedMb;
};

const setRuntimeSnapshot = (
	partial: Partial<
		Pick<
			BenchmarkRuntimeState,
			"currentPageId" | "totalPages" | "commandCount" | "lastCommandDigest" | "lastRenderReason"
		>
	>
) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	Object.assign(runtime, partial);
};

const nextDoubleRaf = () =>
	new Promise<number>((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame((ts) => resolve(ts));
		});
	});

const sampleCanvasSignature = (canvas: HTMLCanvasElement | null) => {
	if (!canvas) return "";
	try {
		const sampleSize = 8;
		const snapshotCanvas = document.createElement("canvas");
		snapshotCanvas.width = Math.max(sampleSize, canvas.width || sampleSize);
		snapshotCanvas.height = Math.max(sampleSize, canvas.height || sampleSize);
		const snapshotCtx = snapshotCanvas.getContext("2d", { willReadFrequently: true });
		if (!snapshotCtx) return "";
		snapshotCtx.drawImage(canvas, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
		const stepX = Math.max(1, Math.floor(snapshotCanvas.width / sampleSize));
		const stepY = Math.max(1, Math.floor(snapshotCanvas.height / sampleSize));
		const parts: number[] = [];
		for (let row = 0; row < sampleSize; row += 1) {
			for (let col = 0; col < sampleSize; col += 1) {
				const x = Math.min(snapshotCanvas.width - 1, col * stepX);
				const y = Math.min(snapshotCanvas.height - 1, row * stepY);
				const data = snapshotCtx.getImageData(x, y, 1, 1).data;
				parts.push(data[0] || 0, data[1] || 0, data[2] || 0, data[3] || 0);
			}
		}
		return parts.join("-");
	} catch {
		return "";
	}
};

const scheduleVisiblePaintMeasurement = (
	key: string,
	startTs: number,
	kind: VisibleMeasurementKind
) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const token = (visiblePaintTokens.get(key) || 0) + 1;
	visiblePaintTokens.set(key, token);

	void nextDoubleRaf().then((visiblePaintTs) => {
		if (visiblePaintTokens.get(key) !== token) return;
		const signature = sampleCanvasSignature(runtimeBindings.getMainCanvas?.() ?? null);
		const visiblePaintMs = Math.max(0, visiblePaintTs - startTs);

		if (kind.type === "full-render" && runtime.lastFullRender) {
			runtime.lastFullRender.visiblePaintTs = visiblePaintTs;
			runtime.lastFullRender.visiblePaintMs = visiblePaintMs;
			runtime.lastFullRender.canvasSignature = signature;
		} else if (kind.type === "dirty-redraw") {
			runtime.lastDirtyRedraw.lastVisiblePaintTs = visiblePaintTs;
			runtime.lastDirtyRedraw.lastVisiblePaintMs = visiblePaintMs;
			runtime.lastDirtyRedraw.lastCanvasSignature = signature;
		} else if (kind.type === "incremental-render") {
			if (runtime.lastIncrementalRender) {
				runtime.lastIncrementalRender.visiblePaintTs = visiblePaintTs;
				runtime.lastIncrementalRender.visiblePaintMs = visiblePaintMs;
				runtime.lastIncrementalRender.canvasSignature = signature;
			}
			if (kind.source === "local") {
				runtime.localInput.lastVisiblePaintTs = visiblePaintTs;
				runtime.localInput.lastVisiblePaintMs = visiblePaintMs;
				runtime.localInput.canvasSignature = signature;
			} else if (kind.commandId) {
				const state = runtime.remoteCommands[kind.commandId] || { commandId: kind.commandId, sendTs: 0 };
				state.visiblePaintTs = visiblePaintTs;
				state.visiblePaintMs = visiblePaintMs;
				state.canvasSignature = signature;
				runtime.remoteCommands[kind.commandId] = state;
			}
		} else if (kind.type === "init" && runtime.lastInit) {
			runtime.lastInit.visiblePaintTs = visiblePaintTs;
			runtime.lastInit.visiblePaintMs = visiblePaintMs;
			runtime.lastInit.canvasSignature = signature;
		}

		pushEvent("visible-paint", {
			type: kind.type,
			commandId: "commandId" in kind ? (kind.commandId ?? "") : undefined,
			source: "source" in kind ? kind.source : undefined,
			visiblePaintMs,
			visiblePaintTs,
			canvasSignature: signature,
		});
	});
};

const markLocalInputStart = (commandId: string) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.localInput.lastStartTs = performance.now();
	runtime.localInput.lastRenderStartTs = 0;
	runtime.localInput.lastRenderEndTs = 0;
	runtime.localInput.lastVisiblePaintTs = 0;
	runtime.localInput.lastVisiblePaintMs = 0;
	runtime.localInput.lastCommandId = commandId;
	runtime.localInput.canvasSignature = "";
	pushEvent("local-input-start", { commandId });
};

const markLocalInputRenderStart = (commandId: string) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.localInput.lastRenderStartTs = performance.now();
	pushEvent("local-input-render-start", { commandId });
};

const markLocalInputRenderEnd = (commandId: string) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.localInput.lastRenderEndTs = performance.now();
	pushEvent("local-input-render-end", { commandId });
};

const markRemoteCommandSent = (commandId: string) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const state = runtime.remoteCommands[commandId] || { commandId, sendTs: performance.now() };
	state.sendTs = performance.now();
	runtime.remoteCommands[commandId] = state;
	pushEvent("remote-command-sent", { commandId });
};

const markRemoteCommandReceived = (
	commandId: string,
	pushType: "normal" | "start" | "update" | "stop",
	points: number
) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const state = runtime.remoteCommands[commandId] || { commandId, sendTs: 0 };
	state.receiveTs = performance.now();
	runtime.remoteCommands[commandId] = state;
	pushEvent("remote-command-received", { commandId, pushType, points });
};

const markRemoteRenderStart = (commandId: string, points: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const state = runtime.remoteCommands[commandId] || { commandId, sendTs: 0 };
	state.renderStartTs = performance.now();
	runtime.remoteCommands[commandId] = state;
	pushEvent("remote-render-start", { commandId, points });
};

const markRemoteRenderEnd = (commandId: string, points: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const state = runtime.remoteCommands[commandId] || { commandId, sendTs: 0 };
	state.renderEndTs = performance.now();
	runtime.remoteCommands[commandId] = state;
	pushEvent("remote-render-end", { commandId, points });
};

const recordInitReceived = (payloadBytes: number, commandCount: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	pushEvent("init-received", { payloadBytes, commandCount });
	runtime.lastInit = {
		payloadBytes,
		commandCount,
		receiveTs: performance.now(),
		parseDurationMs: 0,
		hydrateDurationMs: 0,
	};
};

const recordInitParsed = (payloadBytes: number, commandCount: number, durationMs: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	pushEvent("init-parsed", { payloadBytes, commandCount, durationMs });
	runtime.lastInit = {
		payloadBytes,
		commandCount,
		receiveTs: runtime.lastInit?.receiveTs ?? performance.now(),
		parseDurationMs: durationMs,
		hydrateDurationMs: runtime.lastInit?.hydrateDurationMs ?? 0,
	};
};

const recordCommandsHydrated = (commandCount: number, durationMs: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	pushEvent("commands-hydrated", { commandCount, durationMs });
	if (runtime.lastInit) {
		runtime.lastInit.hydrateDurationMs = durationMs;
		runtime.lastInit.commandCount = commandCount;
		scheduleVisiblePaintMeasurement(`init:${commandCount}`, performance.now(), {
			type: "init",
			commandCount,
		});
	}
	runtime.commandCount = commandCount;
};

const recordRenderStart = (
	reason: "full" | "incremental" | "overlay" | "dirty" | "local-input" | "remote-input",
	points = 0
) => {
	const runtime = ensureRuntime();
	if (!runtime) return performance.now();
	runtime.lastRenderReason = reason;
	runtime.renderCounters[reason] = (runtime.renderCounters[reason] || 0) + 1;
	pushEvent("render-start", { reason, points });
	return performance.now();
};

const recordRenderEnd = (
	reason: "full" | "incremental" | "overlay" | "dirty" | "local-input" | "remote-input",
	points: number,
	durationMs: number
) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const summary = { reason, points, durationMs, ts: performance.now() };
	if (reason === "full") {
		if (points > 0) {
			runtime.lastFullRender = summary;
			scheduleVisiblePaintMeasurement(`render:full`, summary.ts, { type: "full-render", points });
		}
	} else if (reason === "dirty") {
		scheduleVisiblePaintMeasurement(`render:dirty`, summary.ts, {
			type: "dirty-redraw",
			pointCount: points,
		});
	} else if (reason !== "overlay") {
		runtime.lastIncrementalRender = summary;
	}
	pushEvent("render-end", { reason, points, durationMs });
};

const recordWorkerFullRender = (points: number, durationMs: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const safeDurationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 0.01) : 0.01;
	const endTs = performance.now();
	runtime.lastRenderReason = "full";
	runtime.renderCounters.full = (runtime.renderCounters.full || 0) + 1;
	if (points > 0) {
		runtime.lastFullRender = {
			reason: "full",
			points,
			durationMs: safeDurationMs,
			ts: endTs,
		};
		pushEvent("render-start", {
			reason: "full",
			points,
			source: "worker",
			ts: endTs - safeDurationMs,
		});
		pushEvent("render-end", { reason: "full", points, durationMs: safeDurationMs, source: "worker" });
		scheduleVisiblePaintMeasurement(`render:full`, endTs, { type: "full-render", points });
	}
};

const recordIncrementalRenderStart = (
	commandId: string | undefined,
	points: number,
	source: "local" | "remote"
) => {
	pushEvent("incremental-render-start", { commandId, points, source });
	if (source === "remote" && commandId) {
		markRemoteRenderStart(commandId, points);
	} else if (source === "local" && commandId) {
		markLocalInputRenderStart(commandId);
	}
	return performance.now();
};

const recordIncrementalRenderEnd = (
	commandId: string | undefined,
	points: number,
	source: "local" | "remote",
	durationMs: number
) => {
	const safeDurationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 0.01) : 0.01;
	const runtime = ensureRuntime();
	if (runtime) {
		const ts = performance.now();
		runtime.lastIncrementalRender = {
			reason: `${source}-incremental`,
			points,
			durationMs: safeDurationMs,
			ts,
		};
		scheduleVisiblePaintMeasurement(`incremental:${source}:${commandId || "unknown"}`, ts, {
			type: "incremental-render",
			commandId,
			points,
			source,
		});
	}
	pushEvent("incremental-render-end", { commandId, points, source, durationMs: safeDurationMs });
	if (source === "remote" && commandId) {
		markRemoteRenderEnd(commandId, points);
	} else if (source === "local" && commandId) {
		markLocalInputRenderEnd(commandId);
	}
};

const recordWorkerIncrementalRender = (
	commandId: string | undefined,
	points: number,
	source: "local" | "remote",
	durationMs: number
) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const safeDurationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 0.01) : 0.01;
	const endTs = performance.now();
	const startTs = endTs - safeDurationMs;
	runtime.lastIncrementalRender = {
		reason: `${source}-incremental`,
		points,
		durationMs: safeDurationMs,
		ts: endTs,
	};
	pushEvent("incremental-render-start", { commandId, points, source, ts: startTs, via: "worker" });
	pushEvent("incremental-render-end", {
		commandId,
		points,
		source,
		durationMs: safeDurationMs,
		via: "worker",
	});
	scheduleVisiblePaintMeasurement(`incremental:${source}:${commandId || "unknown"}`, endTs, {
		type: "incremental-render",
		commandId,
		points,
		source,
	});
	if (source === "local" && commandId) {
		runtime.localInput.lastCommandId = commandId;
		runtime.localInput.lastRenderStartTs = startTs;
		runtime.localInput.lastRenderEndTs = endTs;
		pushEvent("local-input-render-start", { commandId, ts: startTs, via: "worker" });
		pushEvent("local-input-render-end", { commandId, ts: endTs, via: "worker" });
	} else if (source === "remote" && commandId) {
		const state = runtime.remoteCommands[commandId] || { commandId, sendTs: 0 };
		state.renderStartTs = startTs;
		state.renderEndTs = endTs;
		runtime.remoteCommands[commandId] = state;
		pushEvent("remote-render-start", { commandId, points, ts: startTs, via: "worker" });
		pushEvent("remote-render-end", { commandId, points, ts: endTs, via: "worker" });
	}
};

const recordDirtyRedrawStart = (rect: { minX: number; minY: number; width: number; height: number }) => {
	pushEvent("dirty-redraw-start", { rect });
	return performance.now();
};

const recordDirtyRedrawEnd = (
	rect: { minX: number; minY: number; width: number; height: number },
	durationMs: number,
	pointCount: number
) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	const ts = performance.now();
	runtime.lastDirtyRedraw = {
		count: runtime.lastDirtyRedraw.count + 1,
		lastDurationMs: durationMs,
		lastRect: rect,
		lastPointCount: pointCount,
		lastVisiblePaintTs: 0,
		lastVisiblePaintMs: 0,
		lastCanvasSignature: runtime.lastDirtyRedraw.lastCanvasSignature,
	};
	pushEvent("dirty-redraw-end", { rect, durationMs, pointCount });
	scheduleVisiblePaintMeasurement(`dirty:${runtime.lastDirtyRedraw.count}`, ts, {
		type: "dirty-redraw",
		pointCount,
	});
};

const recordUndoStart = (source: "local" | "remote") => {
	pushEvent("undo-start", { source });
	return performance.now();
};

const recordUndoEnd = (source: "local" | "remote", durationMs: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.lastUndo = { source, durationMs };
	pushEvent("undo-end", { source, durationMs });
};

const recordRedoStart = (source: "local" | "remote") => {
	pushEvent("redo-start", { source });
	return performance.now();
};

const recordRedoEnd = (source: "local" | "remote", durationMs: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.lastRedo = { source, durationMs };
	pushEvent("redo-end", { source, durationMs });
};

const recordPageSwitchStart = (fromPageId: number, toPageId: number) => {
	pushEvent("page-switch-start", { fromPageId, toPageId });
	return performance.now();
};

const recordPageSwitchEnd = (fromPageId: number, toPageId: number, durationMs: number) => {
	const runtime = ensureRuntime();
	if (!runtime) return;
	runtime.lastPageSwitch = { fromPageId, toPageId, durationMs };
	runtime.currentPageId = toPageId;
	pushEvent("page-switch-end", { fromPageId, toPageId, durationMs });
};

const isBenchmarkDebugLoggingEnabled = () =>
	Boolean(runtimeBindings.debugLogs) ||
	(typeof window !== "undefined" && window.__BENCHMARK_DEBUG_LOGS__ === true);

const benchmarkRuntimeInstrumentationAdapter: RuntimeInstrumentationAdapter = {
	setRuntimeSnapshot,
	markLocalInputStart,
	markRemoteCommandReceived,
	recordInitReceived,
	recordInitParsed,
	recordCommandsHydrated,
	recordRenderStart,
	recordRenderEnd,
	recordIncrementalRenderStart,
	recordIncrementalRenderEnd,
	recordWorkerFullRender,
	recordWorkerIncrementalRender,
	recordDirtyRedrawStart,
	recordDirtyRedrawEnd,
	recordUndoStart,
	recordUndoEnd,
	recordRedoStart,
	recordRedoEnd,
	recordPageSwitchStart,
	recordPageSwitchEnd,
	isDebugLoggingEnabled: isBenchmarkDebugLoggingEnabled,
};

export {
	activateBenchmarkRuntime,
	deactivateBenchmarkRuntime,
	benchmarkRuntimeInstrumentationAdapter,
	shouldEnableBenchmarkRuntime,
	ensureRuntime,
	pushEvent,
	sampleHeapUsage,
	setRuntimeSnapshot,
	markLocalInputStart,
	markLocalInputRenderStart,
	markLocalInputRenderEnd,
	markRemoteCommandSent,
	markRemoteCommandReceived,
	markRemoteRenderStart,
	markRemoteRenderEnd,
	recordInitReceived,
	recordInitParsed,
	recordCommandsHydrated,
	recordRenderStart,
	recordRenderEnd,
	recordWorkerFullRender,
	recordIncrementalRenderStart,
	recordIncrementalRenderEnd,
	recordWorkerIncrementalRender,
	recordDirtyRedrawStart,
	recordDirtyRedrawEnd,
	recordUndoStart,
	recordUndoEnd,
	recordRedoStart,
	recordRedoEnd,
	recordPageSwitchStart,
	recordPageSwitchEnd,
	isBenchmarkDebugLoggingEnabled,
};
