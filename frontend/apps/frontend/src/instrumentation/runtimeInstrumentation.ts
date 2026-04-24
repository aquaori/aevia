// File role: neutral runtime instrumentation facade that business code can call without depending on any plugin implementation.
interface RuntimeSnapshot {
	currentPageId?: number;
	totalPages?: number;
	commandCount?: number;
	lastCommandDigest?: string;
	lastRenderReason?: string | null;
}

interface DirtyRect {
	minX: number;
	minY: number;
	width: number;
	height: number;
}

type RenderSource = "local" | "remote";
type HistorySource = "local" | "remote";
type RenderReason = "full" | "incremental" | "overlay" | "dirty" | "local-input" | "remote-input";

export interface RuntimeInstrumentationAdapter {
	setRuntimeSnapshot?(partial: RuntimeSnapshot): void;
	markLocalInputStart?(commandId: string): void;
	markRemoteCommandReceived?(
		commandId: string,
		pushType: "normal" | "start" | "update" | "stop",
		points: number
	): void;
	recordInitReceived?(payloadBytes: number, commandCount: number): void;
	recordInitParsed?(payloadBytes: number, commandCount: number, durationMs: number): void;
	recordInitChunkParsed?(payloadBytes: number, durationMs: number): void;
	recordInitChunkHandled?(
		payloadBytes: number,
		commandCount: number,
		flatPointCount: number,
		durationMs: number
	): void;
	recordCommandsHydrated?(commandCount: number, durationMs: number): void;
	recordRenderStart?(reason: RenderReason, points?: number): number;
	recordRenderEnd?(reason: RenderReason, points: number, durationMs: number): void;
	recordIncrementalRenderStart?(
		commandId: string | undefined,
		points: number,
		source: RenderSource
	): number;
	recordIncrementalRenderEnd?(
		commandId: string | undefined,
		points: number,
		source: RenderSource,
		durationMs: number
	): void;
	recordWorkerFullRender?(points: number, durationMs: number): void;
	recordWorkerIncrementalRender?(
		commandId: string | undefined,
		points: number,
		source: RenderSource,
		durationMs: number
	): void;
	recordDirtyRedrawStart?(rect: DirtyRect): number;
	recordDirtyRedrawEnd?(rect: DirtyRect, durationMs: number, pointCount: number): void;
	recordUndoStart?(source: HistorySource): number;
	recordUndoEnd?(source: HistorySource, durationMs: number): void;
	recordRedoStart?(source: HistorySource): number;
	recordRedoEnd?(source: HistorySource, durationMs: number): void;
	recordPageSwitchStart?(fromPageId: number, toPageId: number): number;
	recordPageSwitchEnd?(fromPageId: number, toPageId: number, durationMs: number): void;
	isDebugLoggingEnabled?(): boolean;
}

let activeAdapter: RuntimeInstrumentationAdapter | null = null;

export const setRuntimeInstrumentationAdapter = (adapter: RuntimeInstrumentationAdapter | null) => {
	activeAdapter = adapter;
};

export const setRuntimeSnapshot = (partial: RuntimeSnapshot) => {
	activeAdapter?.setRuntimeSnapshot?.(partial);
};

export const markLocalInputStart = (commandId: string) => {
	activeAdapter?.markLocalInputStart?.(commandId);
};

export const markRemoteCommandReceived = (
	commandId: string,
	pushType: "normal" | "start" | "update" | "stop",
	points: number
) => {
	activeAdapter?.markRemoteCommandReceived?.(commandId, pushType, points);
};

export const recordInitReceived = (payloadBytes: number, commandCount: number) => {
	activeAdapter?.recordInitReceived?.(payloadBytes, commandCount);
};

export const recordInitParsed = (payloadBytes: number, commandCount: number, durationMs: number) => {
	activeAdapter?.recordInitParsed?.(payloadBytes, commandCount, durationMs);
};

export const recordInitChunkParsed = (payloadBytes: number, durationMs: number) => {
	activeAdapter?.recordInitChunkParsed?.(payloadBytes, durationMs);
};

export const recordInitChunkHandled = (
	payloadBytes: number,
	commandCount: number,
	flatPointCount: number,
	durationMs: number
) => {
	activeAdapter?.recordInitChunkHandled?.(
		payloadBytes,
		commandCount,
		flatPointCount,
		durationMs
	);
};

export const recordCommandsHydrated = (commandCount: number, durationMs: number) => {
	activeAdapter?.recordCommandsHydrated?.(commandCount, durationMs);
};

export const recordRenderStart = (reason: RenderReason, points = 0) =>
	activeAdapter?.recordRenderStart?.(reason, points) ?? performance.now();

export const recordRenderEnd = (reason: RenderReason, points: number, durationMs: number) => {
	activeAdapter?.recordRenderEnd?.(reason, points, durationMs);
};

export const recordIncrementalRenderStart = (
	commandId: string | undefined,
	points: number,
	source: RenderSource
) => activeAdapter?.recordIncrementalRenderStart?.(commandId, points, source) ?? performance.now();

export const recordIncrementalRenderEnd = (
	commandId: string | undefined,
	points: number,
	source: RenderSource,
	durationMs: number
) => {
	activeAdapter?.recordIncrementalRenderEnd?.(commandId, points, source, durationMs);
};

export const recordWorkerFullRender = (points: number, durationMs: number) => {
	activeAdapter?.recordWorkerFullRender?.(points, durationMs);
};

export const recordWorkerIncrementalRender = (
	commandId: string | undefined,
	points: number,
	source: RenderSource,
	durationMs: number
) => {
	activeAdapter?.recordWorkerIncrementalRender?.(commandId, points, source, durationMs);
};

export const recordDirtyRedrawStart = (rect: DirtyRect) =>
	activeAdapter?.recordDirtyRedrawStart?.(rect) ?? performance.now();

export const recordDirtyRedrawEnd = (rect: DirtyRect, durationMs: number, pointCount: number) => {
	activeAdapter?.recordDirtyRedrawEnd?.(rect, durationMs, pointCount);
};

export const recordUndoStart = (source: HistorySource) =>
	activeAdapter?.recordUndoStart?.(source) ?? performance.now();

export const recordUndoEnd = (source: HistorySource, durationMs: number) => {
	activeAdapter?.recordUndoEnd?.(source, durationMs);
};

export const recordRedoStart = (source: HistorySource) =>
	activeAdapter?.recordRedoStart?.(source) ?? performance.now();

export const recordRedoEnd = (source: HistorySource, durationMs: number) => {
	activeAdapter?.recordRedoEnd?.(source, durationMs);
};

export const recordPageSwitchStart = (fromPageId: number, toPageId: number) =>
	activeAdapter?.recordPageSwitchStart?.(fromPageId, toPageId) ?? performance.now();

export const recordPageSwitchEnd = (
	fromPageId: number,
	toPageId: number,
	durationMs: number
) => {
	activeAdapter?.recordPageSwitchEnd?.(fromPageId, toPageId, durationMs);
};

export const isRuntimeDebugLoggingEnabled = () =>
	activeAdapter?.isDebugLoggingEnabled?.() ?? false;
