// File role: remote collaboration handlers for command-related websocket messages.
import { markRaw } from "vue";
import { toast } from "vue-sonner";
import { canvasRef, ctx, lastWidths, renderIncrementPoint } from "./canvas";
import { getCommandDirtyRect } from "./commandDirtyRect";
import { useLamportStore } from "../store/lamportStore";
import { useCommandStore } from "../store/commandStore";
import type { Command, FlatPoint, Point } from "../utils/type";
import type {
	CollabIncomingMessage,
	CollabMessageDispatcherOptions,
	InitRenderChunkMetaPayload,
	PageChangeRenderChunkMetaPayload,
} from "./collabDispatcherTypes";
import {
	recordInitChunkHandled,
	markRemoteCommandReceived,
	recordCommandsHydrated,
	recordRedoEnd,
	recordRedoStart,
	recordUndoEnd,
	recordUndoStart,
} from "../instrumentation/runtimeInstrumentation";
import { paintStrokeSample } from "./strokeRasterizer";
import {
	normalizeCommandFromProtocol,
	normalizeCommandsFromProtocol,
	normalizeLoadedPageIds,
	protocolPageToState,
} from "./collabProtocol";

interface InitStreamState {
	snapshotVersion: number;
	renderNextChunkIndex: number;
	renderExpectedChunkCount: number | null;
	renderDoneReceived: boolean;
	pendingRenderChunkMetas: Map<number, InitRenderChunkMetaPayload>;
	completedRenderChunkIndexes: Set<number>;
	renderReady: boolean;
	commandsNextChunkIndex: number;
	commandsExpectedChunkCount: number | null;
	commandsDoneReceived: boolean;
	pendingCommandChunks: Map<number, InitCommandsChunkPayload>;
	commandsBuffer: Command[];
	commandsReady: boolean;
	currentPageId: number;
	loadedPageIds: number[];
	totalPages: number;
	lastLamport: number;
	completeReceived: boolean;
}

interface InitMetaPayload {
	status?: string;
	userId?: string;
	roomId?: string;
	roomName?: string;
	onlineCount?: number;
	snapshotVersion?: number;
	totalPage?: number;
	pageId?: number;
	loadedPageIds?: unknown;
	chunkSummary?: {
		commandChunkSize?: number;
		flatPointChunkSize?: number;
		totalCommands?: number;
		totalFlatPoints?: number;
		totalRenderChunks?: number;
		totalCommandChunks?: number;
		totalChunks?: number;
	};
	maxLamport?: number;
	lastLamport?: number;
}

interface InitRenderMetaPayload {
	snapshotVersion?: number;
	pageId?: number;
	totalChunks?: number;
	totalPointChunks?: number;
	totalFlatPoints?: number;
}

interface InitRenderDonePayload {
	snapshotVersion?: number;
	totalChunks?: number;
}

interface InitCommandsMetaPayload {
	snapshotVersion?: number;
	loadedPageIds?: unknown;
	totalChunks?: number;
	commandChunkSize?: number;
	totalCommands?: number;
}

interface InitCommandsChunkPayload {
	snapshotVersion?: number;
	chunkIndex?: number;
	isLastChunk?: boolean;
	commands?: unknown;
	commandsChunk?: unknown;
	commandChunk?: unknown;
}

interface InitCommandsDonePayload {
	snapshotVersion?: number;
	totalChunks?: number;
}

interface InitCompletePayload {
	snapshotVersion?: number;
}

interface PageChangeMetaPayload {
	requestId?: number;
	snapshotVersion?: number;
	mode?: "flat-only" | "full";
	pageId?: number;
	loadedPageIds?: unknown;
	loadPageIds?: unknown;
	unloadPageIds?: unknown;
	previousPageId?: number;
	totalPages?: number;
	totalPage?: number;
	chunkSummary?: {
		commandChunkSize?: number;
		flatPointChunkSize?: number;
		totalCommands?: number;
		totalFlatPoints?: number;
		totalRenderChunks?: number;
		totalCommandChunks?: number;
		totalFlatPointChunks?: number;
		totalChunks?: number;
	};
}

interface PageChangeChunkPayload {
	requestId?: number;
	snapshotVersion?: number;
	chunkIndex?: number;
	isLastChunk?: boolean;
	commands?: unknown;
	commandsChunk?: unknown;
	flatPoints?: unknown;
	flatPointChunk?: unknown;
	commandChunk?: unknown;
}

interface PageChangeRenderMetaPayload {
	requestId?: number;
	snapshotVersion?: number;
	pageId?: number;
	totalChunks?: number;
	totalPointChunks?: number;
	totalFlatPoints?: number;
}

interface PageChangeRenderDonePayload {
	requestId?: number;
	snapshotVersion?: number;
	totalChunks?: number;
}

interface PageChangeCommandsMetaPayload {
	requestId?: number;
	snapshotVersion?: number;
	loadedPageIds?: unknown;
	loadPageIds?: unknown;
	unloadPageIds?: unknown;
	totalChunks?: number;
	commandChunkSize?: number;
	totalCommands?: number;
}

interface PageChangeCommandsChunkPayload {
	requestId?: number;
	snapshotVersion?: number;
	chunkIndex?: number;
	isLastChunk?: boolean;
	commands?: unknown;
	commandsChunk?: unknown;
	commandChunk?: unknown;
}

interface PageChangeCommandsDonePayload {
	requestId?: number;
	snapshotVersion?: number;
	totalChunks?: number;
}

interface PageChangeCompletePayload {
	requestId?: number;
	snapshotVersion?: number;
}

interface PageChangeDonePayload {
	requestId?: number;
	snapshotVersion?: number;
}

interface PageChangeStreamState {
	requestId: number;
	snapshotVersion: number;
	mode: "flat-only" | "full";
	nextChunkIndex: number;
	expectedChunkCount: number | null;
	doneReceived: boolean;
	pendingChunks: Map<number, PageChangeChunkPayload>;
	receivedChunkIndexes: Set<number>;
	commands: Command[];
	flatPoints: FlatPoint[];
	renderNextChunkIndex: number;
	renderExpectedChunkCount: number | null;
	renderDoneReceived: boolean;
	pendingRenderChunkMetas: Map<number, PageChangeRenderChunkMetaPayload>;
	completedRenderChunkIndexes: Set<number>;
	renderReady: boolean;
	commandsNextChunkIndex: number;
	commandsExpectedChunkCount: number | null;
	commandsDoneReceived: boolean;
	pendingCommandChunks: Map<number, PageChangeCommandsChunkPayload>;
	commandsReady: boolean;
	completeReceived: boolean;
	lastLamport: number;
	pageId: number;
	loadedPageIds: number[];
	loadPageIds: number[];
	unloadPageIds: number[];
	totalPages: number;
}

export const createCollabCommandHandlers = (options: CollabMessageDispatcherOptions) => {
	const commandStore = useCommandStore();
	let initStreamState: InitStreamState | null = null;
	let pageChangeStreamState: PageChangeStreamState | null = null;

	const getLoadedCommandsSnapshot = () =>
		Array.from(commandStore.pageCommands.values()).flat() as Command[];

	const renderIncrement = (cmd: Command, points: Point[]) => {
		if (options.renderIncrementalCommand) {
			options.renderIncrementalCommand(cmd, points);
			return;
		}
		if (!canvasRef.value || !ctx.value || cmd.pageId !== options.currentPageId.value) return;
		const dpr = window.devicePixelRatio || 1;
		const logicalWidth = canvasRef.value.width / dpr;
		const logicalHeight = canvasRef.value.height / dpr;
		renderIncrementPoint(cmd, points, ctx.value, logicalWidth, logicalHeight);
	};

	const renderSinglePoint = (cmd: Command) => {
		if (options.renderSinglePointCommand) {
			options.renderSinglePointCommand(cmd);
			return;
		}
		if (!canvasRef.value || !ctx.value || cmd.pageId !== options.currentPageId.value) return;
		const p0 = cmd.points?.[0];
		if (!p0) return;

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value.width / dpr;
		const height = canvasRef.value.height / dpr;
		ctx.value.save();
		paintStrokeSample({
			ctx: ctx.value,
			sample: p0,
			tool: cmd.tool,
			color: cmd.color,
			baseSize: cmd.size || 3,
			logicalWidth: width,
			logicalHeight: height,
		});
		ctx.value.restore();
	};

	const normalizeFlatPoints = (points: unknown, fallbackPageId?: number): FlatPoint[] => {
		if (!Array.isArray(points)) return [];
		const flatPoints = points as FlatPoint[];
		if (typeof fallbackPageId !== "number" || !Number.isFinite(fallbackPageId)) {
			return flatPoints;
		}

		const normalizedFallbackPageId = protocolPageToState(fallbackPageId);
		let missingPageId = false;
		for (const point of flatPoints) {
			if (typeof point.pageId !== "number" || !Number.isFinite(point.pageId)) {
				missingPageId = true;
				break;
			}
		}

		if (!missingPageId) {
			return flatPoints;
		}

		for (const point of flatPoints) {
			if (typeof point.pageId !== "number" || !Number.isFinite(point.pageId)) {
				point.pageId = normalizedFallbackPageId;
			}
		}

		return flatPoints;
	};

	const getChunkSequence = (payload: { seq?: number; chunkSeq?: number; chunkIndex?: number }) => {
		const rawValue = payload.seq ?? payload.chunkSeq ?? payload.chunkIndex;
		return Number.isFinite(Number(rawValue)) ? Number(rawValue) : -1;
	};

	const getChunkCommands = (payload: InitCommandsChunkPayload | PageChangeChunkPayload) => {
		const rawCommands =
			payload.commands ??
			(payload.commandsChunk as { items?: unknown } | undefined)?.items ??
			payload.commandsChunk ??
			(payload.commandChunk as { commands?: unknown } | undefined)?.commands ??
			(payload.commandChunk as { items?: unknown } | undefined)?.items ??
			payload.commandChunk;
		return normalizeCommandsFromProtocol(rawCommands);
	};

	const getPageChangeFlatPoints = (payload: {
		flatPoints?: unknown;
		flatPointChunk?: unknown;
	}, fallbackPageId?: number) => {
		const rawFlatPoints =
			payload.flatPoints ??
			(payload.flatPointChunk as { flatPoints?: unknown; points?: unknown } | undefined)
				?.flatPoints ??
			(payload.flatPointChunk as { flatPoints?: unknown; points?: unknown } | undefined)?.points ??
			(payload.flatPointChunk as { items?: unknown } | undefined)?.items ??
			payload.flatPointChunk;
		return normalizeFlatPoints(rawFlatPoints, fallbackPageId);
	};

	const tryCompleteInitStream = () => {
		if (
			initStreamState &&
			initStreamState.completeReceived &&
			initStreamState.renderReady &&
			initStreamState.commandsReady
		) {
			initStreamState = null;
		}
	};

	const flushInitRenderChunks = () => {
		if (!initStreamState) return;

		while (initStreamState.completedRenderChunkIndexes.has(initStreamState.renderNextChunkIndex)) {
			const chunkMeta = initStreamState.pendingRenderChunkMetas.get(
				initStreamState.renderNextChunkIndex
			);
			initStreamState.completedRenderChunkIndexes.delete(initStreamState.renderNextChunkIndex);
			initStreamState.pendingRenderChunkMetas.delete(initStreamState.renderNextChunkIndex);
			initStreamState.renderNextChunkIndex += 1;
			if (!chunkMeta) continue;

			const lamportEnd = Number(
				chunkMeta.lamportEnd ?? chunkMeta.lamportStart ?? initStreamState.lastLamport
			);
			if (Number.isFinite(lamportEnd)) {
				initStreamState.lastLamport = Math.max(initStreamState.lastLamport, lamportEnd);
			}
		}
	};

	const tryFinalizeInitRenderStream = () => {
		if (!initStreamState || !initStreamState.renderDoneReceived) return;
		if (
			typeof initStreamState.renderExpectedChunkCount === "number" &&
			initStreamState.renderNextChunkIndex < initStreamState.renderExpectedChunkCount
		) {
			return;
		}
		if (initStreamState.renderReady) return;

		commandStore.updateLastSortedPoints([]);
		options.finishInitRenderStream?.();
		useLamportStore().syncLamport(initStreamState.lastLamport);
		initStreamState.renderReady = true;
		tryCompleteInitStream();
	};

	const flushInitCommandChunks = () => {
		if (!initStreamState) return;

		while (initStreamState.pendingCommandChunks.has(initStreamState.commandsNextChunkIndex)) {
			const chunk = initStreamState.pendingCommandChunks.get(initStreamState.commandsNextChunkIndex);
			initStreamState.pendingCommandChunks.delete(initStreamState.commandsNextChunkIndex);
			initStreamState.commandsNextChunkIndex += 1;
			if (!chunk) continue;

			const chunkHandleStart = performance.now();
			const chunkPayloadBytes = Number((chunk as { __payloadBytes?: number }).__payloadBytes ?? 0);
			const normalizedCommands = getChunkCommands(chunk);
			if (normalizedCommands.length > 0) {
				initStreamState.commandsBuffer.push(...normalizedCommands);
			}

			recordInitChunkHandled(
				chunkPayloadBytes,
				normalizedCommands.length,
				0,
				performance.now() - chunkHandleStart
			);
		}
	};

	const tryFinalizeInitCommands = () => {
		if (!initStreamState || !initStreamState.commandsDoneReceived) return;
		if (
			typeof initStreamState.commandsExpectedChunkCount === "number" &&
			initStreamState.commandsNextChunkIndex < initStreamState.commandsExpectedChunkCount
		) {
			return;
		}
		if (initStreamState.commandsReady) return;

		const hydrateStart = performance.now();
		options.replaceLoadedPageWindow(
			initStreamState.loadedPageIds,
			initStreamState.commandsBuffer
		);
		options.loadedPageIds.value = initStreamState.loadedPageIds;
		options.syncWorkerScene?.(
			getLoadedCommandsSnapshot(),
			initStreamState.currentPageId,
			[]
		);
		useLamportStore().syncLamport(initStreamState.lastLamport);
		recordCommandsHydrated(
			initStreamState.commandsBuffer.length,
			performance.now() - hydrateStart
		);
		initStreamState.commandsReady = true;
		tryCompleteInitStream();
	};

	const handleInitMeta = (msg: CollabIncomingMessage) => {
		options.onInitConnectionState();
		const meta = (msg.data ?? {}) as InitMetaPayload;
		const currentPageId = protocolPageToState(meta.pageId);
		const loadedPageIds = normalizeLoadedPageIds(meta.loadedPageIds);
		const nextLoadedPageIds = loadedPageIds.length > 0 ? loadedPageIds : [currentPageId];
		const totalPages = Number(meta.totalPage ?? 1) || 1;
		const lastLamport = Number(meta.maxLamport ?? meta.lastLamport ?? 0) || 0;
		const snapshotVersion = Number(meta.snapshotVersion ?? 0) || 0;

		options.userId.value = String(meta.userId ?? options.userId.value);
		options.roomId.value = String(meta.roomId ?? options.roomId.value);
		options.roomName.value = String(meta.roomName ?? options.roomName.value);
		options.onlineCount.value = Number(meta.onlineCount ?? options.onlineCount.value);
		options.totalPages.value = totalPages;
		options.replaceLoadedPageWindow(nextLoadedPageIds, []);
		options.loadedPageIds.value = nextLoadedPageIds;
		options.applyRemotePageChange(currentPageId, totalPages, {
			deferRender: true,
		});
		useLamportStore().syncLamport(lastLamport);

		initStreamState = {
			snapshotVersion,
			renderNextChunkIndex: 0,
			renderExpectedChunkCount: Number.isFinite(
				Number(meta.chunkSummary?.totalRenderChunks ?? NaN)
			)
				? Number(meta.chunkSummary?.totalRenderChunks)
				: null,
			renderDoneReceived: false,
			pendingRenderChunkMetas: new Map(),
			completedRenderChunkIndexes: new Set(),
			renderReady: false,
			commandsNextChunkIndex: 0,
			commandsExpectedChunkCount: Number.isFinite(
				Number(meta.chunkSummary?.totalCommandChunks ?? NaN)
			)
				? Number(meta.chunkSummary?.totalCommandChunks)
				: null,
			commandsDoneReceived: false,
			pendingCommandChunks: new Map(),
			commandsBuffer: [],
			commandsReady: false,
			currentPageId,
			loadedPageIds: nextLoadedPageIds,
			totalPages,
			lastLamport,
			completeReceived: false,
		};

		commandStore.updateLastSortedPoints([]);
		options.beginInitRenderStream?.(currentPageId);
	};

	const handleInitRenderMeta = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const meta = (msg.data ?? {}) as InitRenderMetaPayload;
		if (
			typeof meta.snapshotVersion === "number" &&
			meta.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		if (typeof meta.pageId === "number") {
			initStreamState.currentPageId = protocolPageToState(meta.pageId);
		}
		const expectedChunkCountRaw = Number(meta.totalChunks ?? meta.totalPointChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			initStreamState.renderExpectedChunkCount = expectedChunkCountRaw;
		}
	};

	const handleInitRenderChunkMeta = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const chunkMeta = (msg.data ?? {}) as InitRenderChunkMetaPayload;
		if (
			typeof chunkMeta.snapshotVersion === "number" &&
			chunkMeta.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		const sequence = getChunkSequence(chunkMeta);
		if (!Number.isFinite(sequence) || sequence < initStreamState.renderNextChunkIndex) {
			return;
		}

		initStreamState.pendingRenderChunkMetas.set(sequence, chunkMeta);
		if (chunkMeta.isLastChunk === true && initStreamState.renderExpectedChunkCount === null) {
			initStreamState.renderExpectedChunkCount = sequence + 1;
		}
	};

	const handleInitRenderChunkBinary = (meta: InitRenderChunkMetaPayload) => {
		if (!initStreamState) return;
		if (
			typeof meta.snapshotVersion === "number" &&
			meta.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}

		const sequence = getChunkSequence(meta);
		if (!Number.isFinite(sequence) || sequence < initStreamState.renderNextChunkIndex) {
			return;
		}
		if (!initStreamState.pendingRenderChunkMetas.has(sequence)) {
			initStreamState.pendingRenderChunkMetas.set(sequence, meta);
		}

		initStreamState.completedRenderChunkIndexes.add(sequence);
		flushInitRenderChunks();
		tryFinalizeInitRenderStream();
	};

	const handleInitRenderDone = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const donePayload = (msg.data ?? {}) as InitRenderDonePayload;
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		const expectedChunkCountRaw = Number(donePayload.totalChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			initStreamState.renderExpectedChunkCount = expectedChunkCountRaw;
		}
		initStreamState.renderDoneReceived = true;
		flushInitRenderChunks();
		tryFinalizeInitRenderStream();
	};

	const handleInitCommandsMeta = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const meta = (msg.data ?? {}) as InitCommandsMetaPayload;
		if (
			typeof meta.snapshotVersion === "number" &&
			meta.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		const nextLoadedPageIds = normalizeLoadedPageIds(meta.loadedPageIds);
		if (nextLoadedPageIds.length > 0) {
			initStreamState.loadedPageIds = nextLoadedPageIds;
		}
		const expectedChunkCountRaw = Number(meta.totalChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			initStreamState.commandsExpectedChunkCount = expectedChunkCountRaw;
		}
	};

	const handleInitCommandsChunk = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const chunk = (msg.data ?? {}) as InitCommandsChunkPayload;
		if (
			typeof chunk.snapshotVersion === "number" &&
			chunk.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		const sequence = getChunkSequence(chunk);
		if (!Number.isFinite(sequence) || sequence < initStreamState.commandsNextChunkIndex) {
			return;
		}

		initStreamState.pendingCommandChunks.set(sequence, chunk);
		if (chunk.isLastChunk === true && initStreamState.commandsExpectedChunkCount === null) {
			initStreamState.commandsExpectedChunkCount = sequence + 1;
		}
		flushInitCommandChunks();
		tryFinalizeInitCommands();
	};

	const handleInitCommandsDone = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const donePayload = (msg.data ?? {}) as InitCommandsDonePayload;
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		const expectedChunkCountRaw = Number(donePayload.totalChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			initStreamState.commandsExpectedChunkCount = expectedChunkCountRaw;
		}
		initStreamState.commandsDoneReceived = true;
		flushInitCommandChunks();
		tryFinalizeInitCommands();
	};

	const handleInitComplete = (msg: CollabIncomingMessage) => {
		if (!initStreamState) return;
		const donePayload = (msg.data ?? {}) as InitCompletePayload;
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== initStreamState.snapshotVersion
		) {
			return;
		}
		initStreamState.completeReceived = true;
		tryCompleteInitStream();
	};

	const flushPageChangeChunks = () => {
		if (!pageChangeStreamState) return;

		while (pageChangeStreamState.pendingChunks.has(pageChangeStreamState.nextChunkIndex)) {
			const chunk = pageChangeStreamState.pendingChunks.get(pageChangeStreamState.nextChunkIndex);
			pageChangeStreamState.pendingChunks.delete(pageChangeStreamState.nextChunkIndex);
			pageChangeStreamState.nextChunkIndex += 1;
			if (!chunk) continue;

			const normalizedCommands = getChunkCommands(chunk);
			if (normalizedCommands.length > 0) {
				pageChangeStreamState.commands.push(...normalizedCommands);
			}

			const normalizedFlatPoints = getPageChangeFlatPoints(
				chunk,
				pageChangeStreamState.pageId
			);
			if (normalizedFlatPoints.length > 0) {
				pageChangeStreamState.flatPoints.push(...normalizedFlatPoints);
				options.appendInitRenderChunk?.(normalizedFlatPoints);
			}
		}
	};

	const tryFinalizePageChangeStream = (donePayload?: PageChangeDonePayload) => {
		if (!pageChangeStreamState || !pageChangeStreamState.doneReceived) return;
		if (
			typeof pageChangeStreamState.expectedChunkCount === "number" &&
			pageChangeStreamState.nextChunkIndex < pageChangeStreamState.expectedChunkCount
		) {
			return;
		}

		options.applyLoadedPageDelta({
			loadedPageIds: pageChangeStreamState.loadedPageIds,
			loadPageIds: pageChangeStreamState.loadPageIds,
			unloadPageIds: pageChangeStreamState.unloadPageIds,
			commands: pageChangeStreamState.commands,
		});
		commandStore.updateLastSortedPoints(pageChangeStreamState.flatPoints);
		options.syncWorkerScene?.(getLoadedCommandsSnapshot(), pageChangeStreamState.pageId, []);
		options.renderSceneFromFlatPoints?.(
			pageChangeStreamState.flatPoints,
			pageChangeStreamState.pageId
		);
		options.finishInitRenderStream?.();
		options.clearActivePageChangeRequest?.(donePayload?.requestId);
		pageChangeStreamState = null;
	};

	const tryCompletePageChangeStream = () => {
		if (
			pageChangeStreamState &&
			pageChangeStreamState.completeReceived &&
			pageChangeStreamState.renderReady &&
			pageChangeStreamState.commandsReady
		) {
			options.clearActivePageChangeRequest?.(pageChangeStreamState.requestId);
			pageChangeStreamState = null;
		}
	};

	const flushPageChangeRenderChunks = () => {
		if (!pageChangeStreamState) return;

		while (
			pageChangeStreamState.completedRenderChunkIndexes.has(
				pageChangeStreamState.renderNextChunkIndex
			)
		) {
			const chunkMeta = pageChangeStreamState.pendingRenderChunkMetas.get(
				pageChangeStreamState.renderNextChunkIndex
			);
			pageChangeStreamState.completedRenderChunkIndexes.delete(
				pageChangeStreamState.renderNextChunkIndex
			);
			pageChangeStreamState.pendingRenderChunkMetas.delete(
				pageChangeStreamState.renderNextChunkIndex
			);
			pageChangeStreamState.renderNextChunkIndex += 1;
			if (!chunkMeta) continue;

			const lamportEnd = Number(
				chunkMeta.lamportEnd ?? chunkMeta.lamportStart ?? pageChangeStreamState.lastLamport
			);
			if (Number.isFinite(lamportEnd)) {
				pageChangeStreamState.lastLamport = Math.max(
					pageChangeStreamState.lastLamport,
					lamportEnd
				);
			}
		}
	};

	const tryFinalizePageChangeRender = () => {
		if (!pageChangeStreamState || !pageChangeStreamState.renderDoneReceived) return;
		if (
			typeof pageChangeStreamState.renderExpectedChunkCount === "number" &&
			pageChangeStreamState.renderNextChunkIndex < pageChangeStreamState.renderExpectedChunkCount
		) {
			return;
		}
		if (pageChangeStreamState.renderReady) return;

		commandStore.updateLastSortedPoints([]);
		options.finishInitRenderStream?.();
		useLamportStore().syncLamport(pageChangeStreamState.lastLamport);
		pageChangeStreamState.renderReady = true;
		tryCompletePageChangeStream();
	};

	const flushPageChangeCommandChunks = () => {
		if (!pageChangeStreamState) return;

		while (
			pageChangeStreamState.pendingCommandChunks.has(
				pageChangeStreamState.commandsNextChunkIndex
			)
		) {
			const chunk = pageChangeStreamState.pendingCommandChunks.get(
				pageChangeStreamState.commandsNextChunkIndex
			);
			pageChangeStreamState.pendingCommandChunks.delete(
				pageChangeStreamState.commandsNextChunkIndex
			);
			pageChangeStreamState.commandsNextChunkIndex += 1;
			if (!chunk) continue;

			const normalizedCommands = getChunkCommands(chunk);
			if (normalizedCommands.length > 0) {
				pageChangeStreamState.commands.push(...normalizedCommands);
			}
		}
	};

	const tryFinalizePageChangeCommands = () => {
		if (!pageChangeStreamState || !pageChangeStreamState.commandsDoneReceived) return;
		if (
			typeof pageChangeStreamState.commandsExpectedChunkCount === "number" &&
			pageChangeStreamState.commandsNextChunkIndex <
				pageChangeStreamState.commandsExpectedChunkCount
		) {
			return;
		}
		if (pageChangeStreamState.commandsReady) return;

		options.applyLoadedPageDelta({
			loadedPageIds: pageChangeStreamState.loadedPageIds,
			loadPageIds: pageChangeStreamState.loadPageIds,
			unloadPageIds: pageChangeStreamState.unloadPageIds,
			commands: pageChangeStreamState.commands,
		});
		options.loadedPageIds.value = pageChangeStreamState.loadedPageIds;
		options.syncWorkerScene?.(getLoadedCommandsSnapshot(), pageChangeStreamState.pageId, []);
		useLamportStore().syncLamport(pageChangeStreamState.lastLamport);
		pageChangeStreamState.commandsReady = true;
		tryCompletePageChangeStream();
	};

	const handlePageChangeMeta = (msg: CollabIncomingMessage) => {
		const meta = (msg.data ?? {}) as PageChangeMetaPayload;
		const requestId = Number(meta.requestId);
		if (!Number.isFinite(requestId)) return;
		const activeRequestId = options.getActivePageChangeRequestId?.();
		if (typeof activeRequestId === "number" && activeRequestId !== requestId) {
			return;
		}

		const requestedPageId = options.getActivePageChangeTargetId?.();
		const pageId =
			typeof requestedPageId === "number" ? requestedPageId : protocolPageToState(meta.pageId);
		const loadedPageIds = normalizeLoadedPageIds(meta.loadedPageIds);
		const loadPageIds = normalizeLoadedPageIds(meta.loadPageIds);
		const unloadPageIds = normalizeLoadedPageIds(meta.unloadPageIds);
		const mode = meta.mode === "flat-only" ? "flat-only" : "full";
		const totalPages = Number(meta.totalPages ?? meta.totalPage ?? options.totalPages.value);
		const renderExpectedChunkCountRaw = Number(meta.chunkSummary?.totalRenderChunks ?? NaN);
		const commandsExpectedChunkCountRaw = Number(meta.chunkSummary?.totalCommandChunks ?? NaN);
		const legacyExpectedChunkCountRaw = Number(meta.chunkSummary?.totalChunks ?? NaN);
		const legacyExpectedChunkCount = Number.isFinite(legacyExpectedChunkCountRaw)
			? legacyExpectedChunkCountRaw
			: null;

		pageChangeStreamState = {
			requestId,
			snapshotVersion: Number(meta.snapshotVersion ?? 0),
			mode,
			nextChunkIndex: 0,
			expectedChunkCount: legacyExpectedChunkCount,
			doneReceived: false,
			pendingChunks: new Map(),
			receivedChunkIndexes: new Set(),
			commands: [],
			flatPoints: [],
			renderNextChunkIndex: 0,
			renderExpectedChunkCount: Number.isFinite(renderExpectedChunkCountRaw)
				? renderExpectedChunkCountRaw
				: null,
			renderDoneReceived: false,
			pendingRenderChunkMetas: new Map(),
			completedRenderChunkIndexes: new Set(),
			renderReady: false,
			commandsNextChunkIndex: 0,
			commandsExpectedChunkCount: Number.isFinite(commandsExpectedChunkCountRaw)
				? commandsExpectedChunkCountRaw
				: null,
			commandsDoneReceived: false,
			pendingCommandChunks: new Map(),
			commandsReady: false,
			completeReceived: false,
			lastLamport: 0,
			pageId,
			loadedPageIds,
			loadPageIds,
			unloadPageIds,
			totalPages,
		};

		options.applyRemotePageChange(pageId, totalPages, {
			deferRender: true,
			requestId,
		});
		commandStore.updateLastSortedPoints([]);
		options.beginInitRenderStream?.(pageId);
	};

	const handlePageChangeChunk = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const chunk = (msg.data ?? {}) as PageChangeChunkPayload;
		if (Number(chunk.requestId) !== pageChangeStreamState.requestId) return;
		if (
			typeof chunk.snapshotVersion === "number" &&
			chunk.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		const sequence = Number(chunk.chunkIndex);
		if (!Number.isFinite(sequence) || sequence < pageChangeStreamState.nextChunkIndex) {
			return;
		}
		if (
			pageChangeStreamState.nextChunkIndex === 0 &&
			pageChangeStreamState.pendingChunks.size === 0 &&
			pageChangeStreamState.commands.length === 0 &&
			pageChangeStreamState.flatPoints.length === 0 &&
			sequence === 1
		) {
			pageChangeStreamState.nextChunkIndex = 1;
		}

		pageChangeStreamState.pendingChunks.set(sequence, chunk);
		pageChangeStreamState.receivedChunkIndexes.add(sequence);
		if (chunk.isLastChunk === true && pageChangeStreamState.expectedChunkCount === null) {
			pageChangeStreamState.expectedChunkCount = sequence + 1;
		}
		flushPageChangeChunks();
		tryFinalizePageChangeStream();
	};

	const handlePageChangeRenderMeta = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const meta = (msg.data ?? {}) as PageChangeRenderMetaPayload;
		if (
			Number(meta.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof meta.snapshotVersion === "number" &&
			meta.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		if (typeof meta.pageId === "number") {
			pageChangeStreamState.pageId = protocolPageToState(meta.pageId);
		}
		const expectedChunkCountRaw = Number(meta.totalChunks ?? meta.totalPointChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			pageChangeStreamState.renderExpectedChunkCount = expectedChunkCountRaw;
		}
	};

	const handlePageChangeRenderChunkMeta = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const chunkMeta = (msg.data ?? {}) as PageChangeRenderChunkMetaPayload;
		if (
			Number(chunkMeta.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof chunkMeta.snapshotVersion === "number" &&
			chunkMeta.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		const sequence = getChunkSequence(chunkMeta);
		if (!Number.isFinite(sequence) || sequence < pageChangeStreamState.renderNextChunkIndex) {
			return;
		}

		pageChangeStreamState.pendingRenderChunkMetas.set(sequence, chunkMeta);
		if (
			chunkMeta.isLastChunk === true &&
			pageChangeStreamState.renderExpectedChunkCount === null
		) {
			pageChangeStreamState.renderExpectedChunkCount = sequence + 1;
		}
	};

	const handlePageChangeRenderChunkBinary = (meta: PageChangeRenderChunkMetaPayload) => {
		if (!pageChangeStreamState) return;
		if (
			Number(meta.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof meta.snapshotVersion === "number" &&
			meta.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		const sequence = getChunkSequence(meta);
		if (!Number.isFinite(sequence) || sequence < pageChangeStreamState.renderNextChunkIndex) {
			return;
		}
		if (!pageChangeStreamState.pendingRenderChunkMetas.has(sequence)) {
			pageChangeStreamState.pendingRenderChunkMetas.set(sequence, meta);
		}

		pageChangeStreamState.completedRenderChunkIndexes.add(sequence);
		flushPageChangeRenderChunks();
		tryFinalizePageChangeRender();
	};

	const handlePageChangeRenderDone = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const donePayload = (msg.data ?? {}) as PageChangeRenderDonePayload;
		if (
			Number(donePayload.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		const expectedChunkCountRaw = Number(donePayload.totalChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			pageChangeStreamState.renderExpectedChunkCount = expectedChunkCountRaw;
		}
		pageChangeStreamState.renderDoneReceived = true;
		flushPageChangeRenderChunks();
		tryFinalizePageChangeRender();
	};

	const handlePageChangeCommandsMeta = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const meta = (msg.data ?? {}) as PageChangeCommandsMetaPayload;
		if (
			Number(meta.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof meta.snapshotVersion === "number" &&
			meta.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}

		const loadedPageIds = normalizeLoadedPageIds(meta.loadedPageIds);
		const loadPageIds = normalizeLoadedPageIds(meta.loadPageIds);
		const unloadPageIds = normalizeLoadedPageIds(meta.unloadPageIds);
		if (loadedPageIds.length > 0) pageChangeStreamState.loadedPageIds = loadedPageIds;
		if (loadPageIds.length > 0) pageChangeStreamState.loadPageIds = loadPageIds;
		if (unloadPageIds.length > 0) pageChangeStreamState.unloadPageIds = unloadPageIds;

		const expectedChunkCountRaw = Number(meta.totalChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			pageChangeStreamState.commandsExpectedChunkCount = expectedChunkCountRaw;
		}
	};

	const handlePageChangeCommandsChunk = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const chunk = (msg.data ?? {}) as PageChangeCommandsChunkPayload;
		if (
			Number(chunk.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof chunk.snapshotVersion === "number" &&
			chunk.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		const sequence = getChunkSequence(chunk);
		if (!Number.isFinite(sequence) || sequence < pageChangeStreamState.commandsNextChunkIndex) {
			return;
		}

		pageChangeStreamState.pendingCommandChunks.set(sequence, chunk);
		if (
			chunk.isLastChunk === true &&
			pageChangeStreamState.commandsExpectedChunkCount === null
		) {
			pageChangeStreamState.commandsExpectedChunkCount = sequence + 1;
		}
		flushPageChangeCommandChunks();
		tryFinalizePageChangeCommands();
	};

	const handlePageChangeCommandsDone = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const donePayload = (msg.data ?? {}) as PageChangeCommandsDonePayload;
		if (
			Number(donePayload.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		const expectedChunkCountRaw = Number(donePayload.totalChunks ?? NaN);
		if (Number.isFinite(expectedChunkCountRaw)) {
			pageChangeStreamState.commandsExpectedChunkCount = expectedChunkCountRaw;
		}
		pageChangeStreamState.commandsDoneReceived = true;
		flushPageChangeCommandChunks();
		tryFinalizePageChangeCommands();
	};

	const handlePageChangeComplete = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const donePayload = (msg.data ?? {}) as PageChangeCompletePayload;
		if (
			Number(donePayload.requestId ?? pageChangeStreamState.requestId) !==
			pageChangeStreamState.requestId
		) {
			return;
		}
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		pageChangeStreamState.completeReceived = true;
		tryCompletePageChangeStream();
	};

	const handlePageChangeDone = (msg: CollabIncomingMessage) => {
		if (!pageChangeStreamState) return;
		const donePayload = (msg.data ?? {}) as PageChangeDonePayload;
		if (Number(donePayload.requestId) !== pageChangeStreamState.requestId) return;
		if (
			typeof donePayload.snapshotVersion === "number" &&
			donePayload.snapshotVersion !== pageChangeStreamState.snapshotVersion
		) {
			return;
		}
		pageChangeStreamState.doneReceived = true;
		tryFinalizePageChangeStream(donePayload);
	};

	const handlePushCommand = (msg: CollabIncomingMessage) => {
		const cmd = msg.data.cmd ? normalizeCommandFromProtocol(msg.data.cmd as Command) : undefined;
		const pushType = msg.pushType as "normal" | "start" | "update" | "stop";
		const remoteCommandId = cmd?.id || msg.data.cmdId;
		const remotePointCount = (msg.data.points ?? cmd?.points ?? []).length || 0;
		if (remoteCommandId) {
			markRemoteCommandReceived(remoteCommandId, pushType, remotePointCount);
		}

		if ((pushType === "normal" || pushType === "start") && cmd) {
			options.emitHook?.("command:before-apply", {
				command: cmd,
				source: "remote",
			});
		}

		if (pushType === "normal" || pushType === "start") {
			if (!cmd) return;

			if (cmd.userId === options.userId.value) {
				options.currentCommandIndex.value = options.commands.value.length - 1;
			}

			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			if (pushType === "normal") {
				options.insertCommand(cmd);
				if (cmd.type === "clear") {
					if (options.clearClearedCommands(cmd)) {
						toast.info(
							`${msg.data.username ? msg.data.username : "有用户"}  在页面${cmd.pageId + 1} 执行了清屏操作`
						);
					}
					options.currentCommandIndex.value = 0;
				}
				options.renderCanvas();
				options.emitHook?.("command:applied", {
					command: cmd,
					source: "remote",
				});
				return;
			}

			if (options.pendingUpdates.value.has(cmd.id)) {
				const points = options.pendingUpdates.value.get(cmd.id) || [];
				if (!cmd.points) {
					cmd.points = markRaw([...points]);
				} else {
					cmd.points.push(...points);
				}
				options.pendingUpdates.value.delete(cmd.id);
			}

			options.insertCommand(cmd);
			renderIncrement(cmd, cmd.points ?? []);
			options.emitHook?.("command:applied", {
				command: cmd,
				source: "remote",
			});
			return;
		}

		if (pushType === "update") {
			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			const cmdId = msg.data.cmdId;
			const points = (msg.data.points ?? []) as Point[];
			if (!points.length) return;

			const localCmd = options.commandMap.get(cmdId);
			if (localCmd) {
				if (!localCmd.points) {
					localCmd.points = markRaw([...points]);
				} else {
					localCmd.points.push(...points);
				}
			} else {
				options.pendingUpdates.value.set(cmdId, points);
				return;
			}

			renderIncrement(localCmd, points);
			return;
		}

		if (pushType === "stop") {
			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			const cmdId = msg.data.cmdId;
			delete lastWidths[cmdId];
			const stopPoints = (msg.data.points ?? msg.data.cmd?.points ?? []) as Point[];
			const localCmd = options.commandMap.get(cmdId);

			if (localCmd) {
				if (stopPoints.length > 0) {
					if (!localCmd.points) {
						localCmd.points = markRaw([...stopPoints]);
					} else {
						localCmd.points.push(...stopPoints);
					}
					renderIncrement(localCmd, stopPoints);
				}
			} else if (msg.data.cmd) {
				const fallbackCmd = normalizeCommandFromProtocol(msg.data.cmd as Command);
				options.emitHook?.("command:before-apply", {
					command: fallbackCmd,
					source: "remote",
				});
				if (stopPoints.length > 0) {
					fallbackCmd.points = stopPoints;
				}
				options.insertCommand(fallbackCmd);
				options.renderCanvas();
				options.emitHook?.("command:applied", {
					command: fallbackCmd,
					source: "remote",
				});
			}

			if (localCmd?.type === "path" && localCmd.points?.length === 1) {
				renderSinglePoint(localCmd);
			}

			useLamportStore().lamport = Math.max(useLamportStore().lamport, msg.data.lamport);
		}
	};

	const handleBatchMove = (msg: CollabIncomingMessage) => {
		const { userId: msgUserId, cmdIds, dx, dy } = msg.data;
		if (msgUserId === options.userId.value) return;

		let hasUpdates = false;
		cmdIds.forEach((id: string) => {
			const cmd = options.commandMap.get(id);
			if (!cmd?.points) return;
			cmd.points.forEach((point) => {
				point.x += dx;
				point.y += dy;
			});
			hasUpdates = true;
		});
		if (hasUpdates) options.renderCanvas();
	};

	const handleBatchUpdate = (msg: CollabIncomingMessage) => {
		const { userId: msgUserId, updates } = msg.data;
		if (msgUserId === options.userId.value) return;

		let hasUpdates = false;
		updates.forEach((update: any) => {
			const cmd = options.commandMap.get(update.cmdId);
			if (!cmd) return;
			cmd.points = update.points;
			if (msg.type === "cmd-batch-stop") {
				cmd.box = update.boxes;
			}
			hasUpdates = true;
		});
		if (hasUpdates) options.renderCanvas();
	};

	const handlePageAdd = (msg: CollabIncomingMessage) => {
		const { totalPages: newTotalPages } = msg.data;
		if (newTotalPages > options.totalPages.value) {
			const createdByCurrentUser = msg.data.userId === options.userId.value;
			toast.info(`${msg.data.username ? msg.data.username : "有用户"} 创建了页面${msg.data.totalPages}`, {
				action: {
					label: "前往",
					onClick: () => options.goToPage(msg.data.totalPages - 1),
				},
			});
			options.totalPages.value = newTotalPages;
			if (createdByCurrentUser) {
				options.goToPage(newTotalPages - 1);
			}
		}
	};

	const handleUndoRedo = (msg: CollabIncomingMessage) => {
		const timer =
			msg.type === "undo-cmd" ? recordUndoStart("remote") : recordRedoStart("remote");
		const cmd = options.commandMap.get(msg.data.cmdId);
		if (!cmd) {
			if (msg.type === "undo-cmd") {
				recordUndoEnd("remote", 0);
			} else {
				recordRedoEnd("remote", 0);
			}
			return;
		}
		cmd.isDeleted = msg.type === "undo-cmd";
		options.syncCommandState?.(cmd);
		if (options.requestSceneRefresh) {
			options.requestSceneRefresh();
		} else {
			const dirtyRect =
				cmd.pageId === options.currentPageId.value ? getCommandDirtyRect(cmd) : null;
			if (dirtyRect) {
				options.requestDirtyRender?.(dirtyRect);
			} else {
				options.renderCanvas();
			}
		}
		options.setTool(options.currentTool.value);
		if (msg.type === "undo-cmd") {
			recordUndoEnd("remote", performance.now() - timer);
		} else {
			recordRedoEnd("remote", performance.now() - timer);
		}
	};

	return {
		handleInitMeta,
		handleInitRenderMeta,
		handleInitRenderChunkMeta,
		handleInitRenderChunkBinary,
		handleInitRenderDone,
		handleInitCommandsMeta,
		handleInitCommandsChunk,
		handleInitCommandsDone,
		handleInitComplete,
		handlePageChangeMeta,
		handlePageChangeRenderMeta,
		handlePageChangeRenderChunkMeta,
		handlePageChangeRenderChunkBinary,
		handlePageChangeRenderDone,
		handlePageChangeCommandsMeta,
		handlePageChangeCommandsChunk,
		handlePageChangeCommandsDone,
		handlePageChangeComplete,
		handlePageChangeChunk,
		handlePageChangeDone,
		handlePushCommand,
		handleBatchMove,
		handleBatchUpdate,
		handlePageAdd,
		handleUndoRedo,
	};
};
