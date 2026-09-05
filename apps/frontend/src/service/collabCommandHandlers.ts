// File role: remote collaboration handlers for command-related websocket messages.
import { markRaw } from "vue";
import { toast } from "vue-sonner";
import { canvasRef, ctx, renderIncrementPoint } from "./canvas";
import { getCommandDirtyRect } from "./commandDirtyRect";
import { useLamportStore } from "../store/lamportStore";
import { useCommandStore } from "../store/commandStore";
import type { Command, FlatPoint, Point } from "@collaborative-whiteboard/shared";
import type {
	CollabIncomingMessage,
	CollabMessageDispatcherOptions,
	InitRenderChunkMetaPayload,
	PageChangeRenderChunkMetaPayload,
} from "./collabDispatcherTypes";
import {
	normalizeCommandFromProtocol,
	normalizeCommandsFromProtocol,
	normalizeLoadedPageIds,
	protocolPageToState,
} from "@collaborative-whiteboard/shared";

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
	liveCommands: Command[];
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
	userName?: string;
	roomId?: string;
	roomName?: string;
	onlineCount?: number;
	memberList?: unknown;
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
	maxLamport?: number;
	lastLamport?: number;
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

interface OperationRejectedPayload {
	opType?: string;
	code?: string;
	reason?: string;
	cmdId?: string | null;
	pageId?: number | null;
	shouldRefresh?: boolean;
	shouldResync?: boolean;
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
	let remoteUpdateFlushFrameId: number | null = null;
	let renderCommitFrameId: number | null = null;
	let pendingFullRender = false;
	let pendingSceneRefresh = false;
	let pendingDirtyRect:
		| {
				minX: number;
				minY: number;
				maxX: number;
				maxY: number;
				width: number;
				height: number;
				candidateCommandIds?: string[];
		  }
		| null = null;
	const pendingRemoteCommandUpdates = new Map<string, Point[]>();

	const mergeDirtyRect = (rect: NonNullable<typeof pendingDirtyRect>) => {
		if (!pendingDirtyRect) {
			pendingDirtyRect = { ...rect };
			return;
		}
		const minX = Math.min(pendingDirtyRect.minX, rect.minX);
		const minY = Math.min(pendingDirtyRect.minY, rect.minY);
		const maxX = Math.max(pendingDirtyRect.maxX, rect.maxX);
		const maxY = Math.max(pendingDirtyRect.maxY, rect.maxY);
		pendingDirtyRect = {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
			candidateCommandIds: Array.from(
				new Set([
					...(pendingDirtyRect.candidateCommandIds ?? []),
					...(rect.candidateCommandIds ?? []),
				])
			),
		};
	};

	const flushRenderCommit = () => {
		renderCommitFrameId = null;
		if (pendingSceneRefresh && options.requestSceneRefresh) {
			pendingSceneRefresh = false;
			pendingFullRender = false;
			pendingDirtyRect = null;
			options.requestSceneRefresh();
			return;
		}
		pendingSceneRefresh = false;
		if (pendingDirtyRect && options.requestDirtyRender) {
			const rect = pendingDirtyRect;
			pendingDirtyRect = null;
			pendingFullRender = false;
			options.requestDirtyRender(rect);
			return;
		}
		pendingDirtyRect = null;
		if (pendingFullRender) {
			pendingFullRender = false;
			options.renderCanvas();
		}
	};

	const scheduleRenderCommit = () => {
		if (renderCommitFrameId !== null) return;
		if (typeof document !== "undefined" && document.hidden) {
			renderCommitFrameId = window.setTimeout(flushRenderCommit, 0);
			return;
		}
		renderCommitFrameId = window.requestAnimationFrame(flushRenderCommit);
	};

	const queueFullRender = () => {
		pendingFullRender = true;
		scheduleRenderCommit();
	};

	const queueSceneRefresh = () => {
		pendingSceneRefresh = true;
		scheduleRenderCommit();
	};

	const queueDirtyRender = (rect: NonNullable<typeof pendingDirtyRect>) => {
		mergeDirtyRect(rect);
		scheduleRenderCommit();
	};

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

	const flushPendingRemoteCommandUpdates = (targetCmdId?: string) => {
		const flushEntries =
			typeof targetCmdId === "string"
				? pendingRemoteCommandUpdates.has(targetCmdId)
					? [[targetCmdId, pendingRemoteCommandUpdates.get(targetCmdId) ?? []] as const]
					: []
				: Array.from(pendingRemoteCommandUpdates.entries());

		if (typeof targetCmdId === "string") {
			pendingRemoteCommandUpdates.delete(targetCmdId);
		} else {
			pendingRemoteCommandUpdates.clear();
			remoteUpdateFlushFrameId = null;
		}

		flushEntries.forEach(([cmdId, points]) => {
			if (!points.length) return;

			const localCmd = options.commandMap.get(cmdId);
			if (localCmd) {
				if (!localCmd.points) {
					localCmd.points = markRaw([...points]);
				} else {
					localCmd.points.push(...points);
				}
				renderIncrement(localCmd, points);
				return;
			}

			const existingPendingPoints = options.pendingUpdates.value.get(cmdId) ?? [];
			options.pendingUpdates.value.set(cmdId, [...existingPendingPoints, ...points]);
		});
	};

	const scheduleRemoteUpdateFlush = () => {
		if (remoteUpdateFlushFrameId !== null) {
			return;
		}

		if (typeof document !== "undefined" && document.hidden) {
			flushPendingRemoteCommandUpdates();
			return;
		}

		remoteUpdateFlushFrameId = window.requestAnimationFrame(() => {
			flushPendingRemoteCommandUpdates();
		});
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

			const normalizedCommands = getChunkCommands(chunk);
			for (const command of normalizedCommands) {
				const operation = command.sceneOperation;
				const lamport = Number(operation?.lamport ?? command.lamport ?? 0);
				if (Number.isFinite(lamport)) {
					initStreamState.lastLamport = Math.max(initStreamState.lastLamport, lamport);
				}
			}
			if (normalizedCommands.length > 0) {
				initStreamState.commandsBuffer.push(...normalizedCommands);
				options.setInitSceneOperations?.(normalizedCommands, initStreamState.currentPageId);
			}
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

		const commandsById = new Map(
			initStreamState.commandsBuffer.map((command) => [command.id, command] as const)
		);
		for (const command of initStreamState.liveCommands) commandsById.set(command.id, command);
		const mergedCommands = Array.from(commandsById.values());
		options.replaceLoadedPageWindow(initStreamState.loadedPageIds, mergedCommands);
		options.loadedPageIds.value = initStreamState.loadedPageIds;
		options.setInitSceneOperations?.(mergedCommands, initStreamState.currentPageId);
		if (!options.isOffscreenMainCanvas?.()) options.renderCanvas();
		for (const command of initStreamState.liveCommands) {
			options.emitHook?.("command:before-apply", { command, source: "remote" });
			options.emitHook?.("command:applied", { command, source: "remote" });
		}
		useLamportStore().syncLamport(initStreamState.lastLamport);
		initStreamState.commandsReady = true;
		tryCompleteInitStream();
	};

	const handleInitMeta = (msg: CollabIncomingMessage) => {
		options.onInitConnectionState();
		const meta = (msg.data ?? {}) as InitMetaPayload;
		const currentPageId = protocolPageToState(meta.pageId);
		const loadedPageIds = normalizeLoadedPageIds(meta.loadedPageIds);
		const nextLoadedPageIds = loadedPageIds.length > 0 ? loadedPageIds : [currentPageId];
		const nextMemberList = Array.isArray(meta.memberList)
			? meta.memberList.filter(
					(member): member is [string, string] =>
						Array.isArray(member) &&
						typeof member[0] === "string" &&
						typeof member[1] === "string"
			  )
			: [];
		const totalPages = Number(meta.totalPage ?? 1) || 1;
		const lastLamport = Number(meta.maxLamport ?? meta.lastLamport ?? 0) || 0;
		const snapshotVersion = Number(meta.snapshotVersion ?? 0) || 0;

		options.userId.value = String(meta.userId ?? options.userId.value);
		options.username.value = String(meta.userName ?? options.username.value);
		options.roomId.value = String(meta.roomId ?? options.roomId.value);
		options.roomName.value = String(meta.roomName ?? options.roomName.value);
		options.onlineCount.value = Number(meta.onlineCount ?? options.onlineCount.value);
		if (nextMemberList.length > 0) {
			options.memberList.value = nextMemberList;
		}
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
			liveCommands: [],
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

	/**
	 * Reconnect resumed from a delta stream instead of a full init.
	 *
	 * The events that follow are ordinary push-cmd/delete-cmd/undo messages, so no
	 * buffering is needed here — but the connection-established side effects that
	 * normally hang off `init-meta` (reconnect toast, clearing the reconnect
	 * overlay, scheduling session renewal) still have to run, otherwise a
	 * delta-resumed reconnect leaves the UI stuck in "reconnecting".
	 */
	const handleDeltaReplayMeta = (_msg: CollabIncomingMessage) => {
		options.onInitConnectionState();
	};

	const handleDeltaReplayComplete = (_msg: CollabIncomingMessage) => {
		// Replayed events already went through the normal handlers; the scene is
		// current once the last one is applied.
		options.requestSceneRefresh?.();
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
		commandStore.updateLastSortedPoints([]);
		options.setInitSceneOperations?.(
			pageChangeStreamState.commands,
			pageChangeStreamState.pageId
		);
		options.finishInitRenderStream?.();
		if (!options.isOffscreenMainCanvas?.()) options.renderCanvas();
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
				options.setInitSceneOperations?.(normalizedCommands, pageChangeStreamState.pageId);
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
		options.setInitSceneOperations?.(pageChangeStreamState.commands, pageChangeStreamState.pageId);
		if (!options.isOffscreenMainCanvas?.()) options.renderCanvas();
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
			lastLamport: Number(meta.maxLamport ?? meta.lastLamport ?? 0) || 0,
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
		if (pushType === "normal" && cmd && initStreamState && !initStreamState.commandsReady) {
			if (!initStreamState.liveCommands.some((command) => command.id === cmd.id)) {
				initStreamState.liveCommands.push(cmd);
			}
			useLamportStore().syncLamport(Number(msg.data.lamport ?? cmd.lamport ?? 0));
			return;
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
				const operation = cmd.sceneOperation;
				const restoresClearedHistory = Boolean(
					operation?.kind === "history.toggle" &&
					operation.payload.enabled === false &&
					options.commands.value.some((candidate) =>
						candidate.sceneOperation?.kind === "page.clear" &&
						candidate.sceneOperation.historyGroupId === operation.payload.targetHistoryGroupId
					)
				);
				if (
					operation?.kind === "text.patch" &&
					operation.actorId !== options.userId.value
				) {
					options.notifyRemoteTextPatch?.(operation.elementId);
				}
				if (restoresClearedHistory) {
					options.requestCurrentPageResync?.();
					options.emitHook?.("command:applied", { command: cmd, source: "remote" });
					return;
				}
				if (cmd.type === "clear") {
					if (options.clearClearedCommands(cmd)) {
						toast.info(
							`${msg.data.username ? msg.data.username : "有用户"}  在页面${cmd.pageId + 1} 执行了清屏操作`
						);
					}
					if (cmd.pageId === options.currentPageId.value) {
						options.syncWorkerScene?.(options.commands.value, cmd.pageId, []);
					}
					options.currentCommandIndex.value = 0;
				}
				options.syncCommandState?.(cmd);
				const handledIncrementally = cmd.type === "scene-op" && options.isOffscreenMainCanvas?.();
				if (options.isOffscreenMainCanvas?.()) {
					cmd.points = undefined;
				}
				if (!handledIncrementally) queueFullRender();
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
			} else if (Array.isArray(msg.data.points) && msg.data.points.length > 0) {
				const maxLamport = Math.max(
					...msg.data.points.map((point: Point) => Number(point?.lamport ?? 0))
				);
				if (Number.isFinite(maxLamport)) {
					useLamportStore().syncLamport(maxLamport);
				}
			}

			const cmdId = msg.data.cmdId;
			const points = (msg.data.points ?? []) as Point[];
			if (!points.length) return;
			const existingPoints = pendingRemoteCommandUpdates.get(cmdId);
			if (existingPoints) {
				existingPoints.push(...points);
			} else {
				pendingRemoteCommandUpdates.set(cmdId, [...points]);
			}
			scheduleRemoteUpdateFlush();
			return;
		}

		if (pushType === "stop") {
			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			const cmdId = msg.data.cmdId;
			flushPendingRemoteCommandUpdates(cmdId);
			const stopPoints = (msg.data.points ?? msg.data.cmd?.points ?? []) as Point[];
			const localCmd = options.commandMap.get(cmdId);
			let stoppedCommand = localCmd;

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
				stoppedCommand = fallbackCmd;
				options.emitHook?.("command:before-apply", {
					command: fallbackCmd,
					source: "remote",
				});
				if (stopPoints.length > 0) {
					fallbackCmd.points = stopPoints;
				}
				options.insertCommand(fallbackCmd);
				options.syncCommandState?.(fallbackCmd);
				if (options.isOffscreenMainCanvas?.()) {
					fallbackCmd.points = undefined;
				}
				queueFullRender();
				options.emitHook?.("command:applied", {
					command: fallbackCmd,
					source: "remote",
				});
			}

			if (stoppedCommand?.type === "path") {
				options.finishIncrementalCommand?.(stoppedCommand);
			}
			if (localCmd && options.isOffscreenMainCanvas?.()) {
				localCmd.points = undefined;
			}

			useLamportStore().lamport = Math.max(useLamportStore().lamport, msg.data.lamport);
		}
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
		const incomingCmd = msg.data.cmd ? normalizeCommandFromProtocol(msg.data.cmd as Command) : null;
		const cmdId = typeof msg.data.cmdId === "string" ? msg.data.cmdId : incomingCmd?.id;
		if (!cmdId) {
			return;
		}
		let cmd = options.commandMap.get(cmdId);
		if (!cmd) {
			if (!incomingCmd) return;
			cmd = incomingCmd;
			options.insertCommand(cmd);
		} else if (incomingCmd) {
			cmd.tool = incomingCmd.tool;
			cmd.color = incomingCmd.color;
			cmd.size = incomingCmd.size;
			cmd.pageId = incomingCmd.pageId;
			cmd.lamport = incomingCmd.lamport;
			cmd.box = incomingCmd.box;
			if (incomingCmd.points?.length) {
				cmd.points = incomingCmd.points;
			}
		}
		flushPendingRemoteCommandUpdates(cmdId);
		cmd.isDeleted = msg.type === "undo-cmd";
		options.syncCommandState?.(cmd);
		options.syncWorkerScene?.(options.commands.value, options.currentPageId.value, []);
		queueSceneRefresh();
		options.setTool(options.currentTool.value);
	};

	const handleDeleteCommand = (msg: CollabIncomingMessage) => {
		const cmdId = typeof msg.data?.cmdId === "string" ? msg.data.cmdId : "";
		if (!cmdId) return;

		const removed = options.removeCommand(cmdId);
		if (!removed) return;
		options.removeCommandState?.(cmdId);

		if (options.requestSceneRefresh) {
			queueSceneRefresh();
			return;
		}

		const dirtyRect =
			removed.pageId === options.currentPageId.value ? getCommandDirtyRect(removed) : null;
		if (dirtyRect) {
			queueDirtyRender(dirtyRect);
			return;
		}

		queueFullRender();
	};

	const handleOperationRejected = (msg: CollabIncomingMessage) => {
		const payload = (msg.data ?? {}) as OperationRejectedPayload;
		const opType = String(payload.opType ?? "unknown");
		const cmdId = typeof payload.cmdId === "string" ? payload.cmdId : null;
		const cmd = cmdId ? options.commandMap.get(cmdId) ?? null : null;
		const canRollbackRejectedPush = opType === "push-cmd" && Boolean(cmdId && cmd);
		const shouldResync =
			payload.shouldResync === true ||
			(opType === "push-cmd" && !canRollbackRejectedPush) ||
			opType === "cmd-update" ||
			opType === "cmd-stop" ||
			opType === "cmd-batch-move" ||
			opType === "cmd-batch-update" ||
			opType === "cmd-batch-stop";
		const rejectionMessage = payload.reason || "Server rejected the latest operation.";

		if (cmdId) {
			options.pendingUpdates.value.delete(cmdId);
			options.cancelRejectedLocalCommand?.(cmdId);
		}
		if (canRollbackRejectedPush || payload.shouldRefresh !== false || shouldResync) {
			options.cancelRejectedOperation?.();
		}

		if (canRollbackRejectedPush && cmdId) {
			options.removeCommand(cmdId);
			options.removeCommandState?.(cmdId);
			queueSceneRefresh();
		} else if (opType === "cmd-start" && cmdId) {
			const removed = options.removeCommand(cmdId);
			options.removeCommandState?.(cmdId);
			const dirtyRect =
				removed && removed.pageId === options.currentPageId.value
					? getCommandDirtyRect(removed)
					: null;

			if (options.requestSceneRefresh) {
				queueSceneRefresh();
			} else if (dirtyRect && payload.shouldRefresh !== false) {
				queueDirtyRender(dirtyRect);
			} else {
				queueFullRender();
			}
		} else if ((opType === "undo-cmd" || opType === "redo-cmd") && cmd) {
			cmd.isDeleted = opType === "redo-cmd";
			options.syncCommandState?.(cmd);
			const dirtyRect =
				cmd.pageId === options.currentPageId.value ? getCommandDirtyRect(cmd) : null;
			if (dirtyRect && payload.shouldRefresh !== false && options.requestDirtyRender) {
				queueDirtyRender(dirtyRect);
			} else if (options.requestSceneRefresh) {
				queueSceneRefresh();
			} else {
				queueFullRender();
			}
			options.setTool(options.currentTool.value);
		} else if (payload.shouldRefresh !== false) {
			queueSceneRefresh();
		}

		if (shouldResync) {
			options.requestCurrentPageResync?.();
		}

		toast.error(rejectionMessage, {
			description: payload.code ? `${opType} | ${payload.code}` : opType,
		});
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
		handleDeltaReplayMeta,
		handleDeltaReplayComplete,
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
		handleDeleteCommand,
		handlePageAdd,
		handleUndoRedo,
		handleOperationRejected,
	};
};
