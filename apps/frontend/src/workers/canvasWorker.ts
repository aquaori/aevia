import {
	compareRenderOrder,
	sceneOperationOrderKey,
	type AabbBox,
	type Command,
	type FlatPoint,
	type Point,
	type SceneOperationEnvelopeV2,
} from "@collaborative-whiteboard/shared";
import type { InitRenderChunkCommandDictionaryEntry } from "../service/collabDispatcherTypes";
import { SceneEngine } from "../scene/sceneEngine";

interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
	candidateCommandIds?: string[];
}

interface WorkerViewport {
	width: number;
	height: number;
	dpr: number;
}

interface IncrementBatchItem {
	cmd: Command;
	points: Point[];
	pageId: number;
	source: "local" | "remote";
}

interface InitRenderBinaryChunkData {
	snapshotVersion: number;
	chunkIndex: number;
	isLastChunk: boolean;
	pointCount: number;
	commands: InitRenderChunkCommandDictionaryEntry[];
	lamportStart?: number;
	lamportEnd?: number;
	buffer: ArrayBuffer;
}

class DSU {
	parent: number[];
	constructor(n: number) {
		this.parent = Array.from({ length: n }, (_, i) => i);
	}
	find(i: number): number {
		if (this.parent[i] === i) return i;
		const parent = this.parent[i];
		if (parent === undefined) return i;
		return (this.parent[i] = this.find(parent));
	}
	union(i: number, j: number) {
		const rootI = this.find(i);
		const rootJ = this.find(j);
		if (rootI !== rootJ) this.parent[rootI] = rootJ;
	}
}

let offscreenCanvas: OffscreenCanvas | null = null;
let mainCtx: OffscreenCanvasRenderingContext2D | null = null;
let viewport: WorkerViewport = { width: 0, height: 0, dpr: 1 };
let currentPageId = 0;
let currentTransformingIds = new Set<string>();
const activeStrokeIds = new Set<string>();
const sceneCommands = new Map<string, Command>();
const sceneEngine = new SceneEngine();
let initRenderFinished = false;
let initCanvasStarted = false;
let pendingInitSceneCommands: Command[] = [];
const liveSceneCommandsDuringInit = new Map<string, Command>();
const INIT_RENDER_CHUNK_MAGIC = 0x49524348;
const INIT_RENDER_CHUNK_VERSION = 1;
const INIT_RENDER_CHUNK_HEADER_SIZE = 20;
const INIT_RENDER_CHUNK_RECORD_SIZE = 22;

const cloneCommandMetadata = (cmd: Command): Command => ({
	...cmd,
	points: undefined,
	box: { ...cmd.box },
});

const configureContext = () => {
	if (!offscreenCanvas || !mainCtx) return;
	offscreenCanvas.width = viewport.width * viewport.dpr;
	offscreenCanvas.height = viewport.height * viewport.dpr;
	mainCtx.setTransform(1, 0, 0, 1, 0, 0);
	mainCtx.scale(viewport.dpr, viewport.dpr);
	mainCtx.lineCap = "round";
	mainCtx.lineJoin = "round";
};

const clearCanvas = () => {
	if (!offscreenCanvas || !mainCtx) return;
	activeStrokeIds.clear();
	mainCtx.save();
	mainCtx.setTransform(1, 0, 0, 1, 0, 0);
	mainCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
	mainCtx.restore();
};

const ensureInitCanvasStarted = () => {
	if (initCanvasStarted) return;
	clearCanvas();
	initCanvasStarted = true;
};

const appendFlatPointsToCanvas = (points: FlatPoint[]) => {
	if (points.length === 0) return 0;
	ensureInitCanvasStarted();
	const refs: number[] = [];
	points.forEach((point) => {
		if (point.pageId !== currentPageId) return;
		appendSceneFlatPoint(point);
		refs.push(...sceneEngine.ingestFlatPoint(point));
	});
	return mainCtx
		? sceneEngine.renderAtomRefs(mainCtx, refs, viewport.width, viewport.height)
		: 0;
};

const decodeInitRenderBinaryChunk = (data: InitRenderBinaryChunkData): FlatPoint[] => {
	const view = new DataView(data.buffer);
	const header = validateInitRenderBinaryChunk(data, view);
	if (!header) return [];

	const { pointCount } = header;
	const commandDictionary = new Map<number, InitRenderChunkCommandDictionaryEntry>();
	const dictionaryOffsets = new Map<number, number>();
	for (const command of data.commands) {
		commandDictionary.set(command.cmdIndex, command);
	}

	const points: FlatPoint[] = [];
	let offset = INIT_RENDER_CHUNK_HEADER_SIZE;
	for (let index = 0; index < pointCount; index += 1) {
		const x = view.getFloat32(offset, false);
		offset += 4;
		const y = view.getFloat32(offset, false);
		offset += 4;
		const p = view.getFloat32(offset, false);
		offset += 4;
		const lamport = view.getFloat64(offset, false);
		offset += 8;
		const cmdIndex = view.getUint16(offset, false);
		offset += 2;

		const commandMeta = commandDictionary.get(cmdIndex);
		if (!commandMeta) {
			continue;
		}
		const sourceOffset = dictionaryOffsets.get(cmdIndex) ?? 0;
		dictionaryOffsets.set(cmdIndex, sourceOffset + 1);

		points.push({
			x,
			y,
			p,
			lamport,
			cmdId: commandMeta.cmdId,
			orderOpId: commandMeta.orderOpId,
			pointIndex: (commandMeta.sourceStart ?? 0) + sourceOffset,
			pageId: currentPageId,
			userId: commandMeta.userId,
			tool: commandMeta.tool,
			color: commandMeta.color,
			size: commandMeta.size,
			strokePattern: commandMeta.strokePattern,
			isDeleted: commandMeta.isDeleted,
		});
	}

	return points;
};

const validateInitRenderBinaryChunk = (data: InitRenderBinaryChunkData, view: DataView) => {
	if (view.byteLength < INIT_RENDER_CHUNK_HEADER_SIZE) {
		console.error("[canvasWorker] init render binary chunk header is truncated.");
		return null;
	}

	const magic = view.getUint32(0, false);
	const version = view.getUint16(4, false);
	const recordSize = view.getUint16(6, false);
	const snapshotVersion = view.getUint32(8, false);
	const chunkIndex = view.getUint32(12, false);
	const pointCount = view.getUint32(16, false);

	if (magic !== INIT_RENDER_CHUNK_MAGIC) {
		console.error("[canvasWorker] init render binary chunk magic mismatch.", {
			expected: INIT_RENDER_CHUNK_MAGIC,
			received: magic,
		});
		return null;
	}

	if (version !== INIT_RENDER_CHUNK_VERSION) {
		console.error("[canvasWorker] init render binary chunk version mismatch.", {
			expected: INIT_RENDER_CHUNK_VERSION,
			received: version,
		});
		return null;
	}

	if (recordSize !== INIT_RENDER_CHUNK_RECORD_SIZE) {
		console.error("[canvasWorker] init render binary chunk record size mismatch.", {
			expected: INIT_RENDER_CHUNK_RECORD_SIZE,
			received: recordSize,
		});
		return null;
	}

	if (snapshotVersion !== data.snapshotVersion || chunkIndex !== data.chunkIndex) {
		console.error("[canvasWorker] init render binary chunk identity mismatch.", {
			expectedSnapshotVersion: data.snapshotVersion,
			receivedSnapshotVersion: snapshotVersion,
			expectedChunkIndex: data.chunkIndex,
			receivedChunkIndex: chunkIndex,
		});
		return null;
	}

	if (pointCount !== data.pointCount) {
		console.error("[canvasWorker] init render binary chunk point count mismatch.", {
			expected: data.pointCount,
			received: pointCount,
		});
		return null;
	}

	const expectedByteLength =
		INIT_RENDER_CHUNK_HEADER_SIZE + pointCount * INIT_RENDER_CHUNK_RECORD_SIZE;
	if (view.byteLength !== expectedByteLength) {
		console.error("[canvasWorker] init render binary chunk byte length mismatch.", {
			expected: expectedByteLength,
			received: view.byteLength,
		});
		return null;
	}

	return { pointCount };
};

const appendInitRenderBinaryChunkToCanvas = (data: InitRenderBinaryChunkData) => {
	if (!mainCtx) return 0;
	const view = new DataView(data.buffer);
	const header = validateInitRenderBinaryChunk(data, view);
	if (!header) return 0;
	ensureInitCanvasStarted();

	const commandDictionary: InitRenderChunkCommandDictionaryEntry[] = [];
	const dictionaryOffsets: number[] = [];
	for (const command of data.commands) {
		commandDictionary[command.cmdIndex] = command;
	}

	let offset = INIT_RENDER_CHUNK_HEADER_SIZE;
	const sample: Point = { x: 0, y: 0, p: 0, lamport: 0 };
	const refs: number[] = [];
	for (let index = 0; index < header.pointCount; index += 1) {
		sample.x = view.getFloat32(offset, false);
		offset += 4;
		sample.y = view.getFloat32(offset, false);
		offset += 4;
		sample.p = view.getFloat32(offset, false);
		offset += 4;
		sample.lamport = view.getFloat64(offset, false);
		offset += 8;
		const cmdIndex = view.getUint16(offset, false);
		offset += 2;

		const commandMeta = commandDictionary[cmdIndex];
		if (!commandMeta) continue;
		const sourceOffset = dictionaryOffsets[cmdIndex] ?? 0;
		dictionaryOffsets[cmdIndex] = sourceOffset + 1;
		appendInitScenePoint(commandMeta, sample);
		refs.push(...sceneEngine.ingestFlatPoint({
			...sample,
			cmdId: commandMeta.cmdId,
			orderOpId: commandMeta.orderOpId,
			pointIndex: (commandMeta.sourceStart ?? 0) + sourceOffset,
			pageId: currentPageId,
			userId: commandMeta.userId,
			tool: commandMeta.tool,
			color: commandMeta.color,
			size: commandMeta.size,
			strokePattern: commandMeta.strokePattern,
			isDeleted: commandMeta.isDeleted,
		}));
	}

	return sceneEngine.renderAtomRefs(mainCtx, refs, viewport.width, viewport.height);
};

const renderFullScene = () => {
	if (!mainCtx) return 0;
	return sceneEngine.renderFull(
		mainCtx,
		viewport.width,
		viewport.height,
		currentTransformingIds
	);
};

const syncSceneCommands = (commands: Command[], pageId: number, transformingCmdIds: string[]) => {
	sceneCommands.clear();
	activeStrokeIds.clear();
	commands.forEach((cmd) => {
		sceneCommands.set(cmd.id, cloneCommandMetadata(cmd));
	});
	currentPageId = pageId;
	currentTransformingIds = new Set(transformingCmdIds);
	sceneEngine.rebuildFromCommands(commands, pageId);
};

const appendInitScenePoint = (
	commandMeta: InitRenderChunkCommandDictionaryEntry,
	point: Point
) => {
	if (sceneCommands.has(commandMeta.cmdId)) return;
	const command: Command = {
			id: commandMeta.cmdId,
			type: "path",
			tool: commandMeta.tool,
			color: commandMeta.color,
			size: commandMeta.size,
			points: undefined,
			timestamp: 0,
			userId: commandMeta.userId,
			roomId: "",
			pageId: currentPageId,
			isDeleted: commandMeta.isDeleted,
			lamport: point.lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
	};
	sceneCommands.set(commandMeta.cmdId, command);
};

const appendSceneFlatPoint = (point: FlatPoint) => {
	let command = sceneCommands.get(point.cmdId);
	if (!command) {
		command = {
			id: point.cmdId,
			type: "path",
			tool: point.tool,
			color: point.color,
			size: point.size,
			points: undefined,
			timestamp: 0,
			userId: point.userId,
			roomId: "",
			pageId: point.pageId,
			isDeleted: point.isDeleted,
			lamport: point.lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};
		sceneCommands.set(point.cmdId, command);
	}
	command.lamport = Math.max(command.lamport ?? 0, point.lamport);
};

const upsertSceneCommand = (cmd: Command) => {
	const existing = sceneCommands.get(cmd.id);
	if (!existing) {
		sceneCommands.set(cmd.id, cloneCommandMetadata(cmd));
		return sceneCommands.get(cmd.id)!;
	}

	existing.type = cmd.type;
	existing.tool = cmd.tool;
	existing.color = cmd.color;
	existing.size = cmd.size;
	existing.pageId = cmd.pageId;
	existing.isDeleted = cmd.isDeleted;
	existing.lamport = cmd.lamport;
	existing.box = { ...cmd.box };
	return existing;
};

const renderIncrementalPoints = (cmd: Command, points: Point[]) => {
	if (!mainCtx || cmd.pageId !== currentPageId || currentTransformingIds.has(cmd.id)) return 0;
	const sceneCommand = upsertSceneCommand(cmd);
	activeStrokeIds.add(sceneCommand.id);
	const refs = sceneEngine.appendCommandPoints(sceneCommand, points);
	return sceneEngine.renderAtomRefs(mainCtx, refs, viewport.width, viewport.height);
};

const finishIncrementalCommand = (cmdId: string) => {
	const refs = sceneEngine.finishElement(cmdId);
	if (mainCtx) sceneEngine.renderAtomRefs(mainCtx, refs, viewport.width, viewport.height);
	activeStrokeIds.delete(cmdId);
};

const renderDirtyRect = (dirtyRect: Rect, transformingCmdIds: string[]) => {
	if (!mainCtx || !offscreenCanvas) return;
	currentTransformingIds = new Set(transformingCmdIds);
	sceneEngine.renderDirty(
		mainCtx,
		dirtyRect,
		viewport.width,
		viewport.height,
		currentTransformingIds
	);
};

const renderDirtyRegions = (dirtyRects: Rect[], transformingCmdIds: string[]) => {
	if (!mainCtx || !offscreenCanvas || dirtyRects.length === 0) return;
	currentTransformingIds = new Set(transformingCmdIds);
	sceneEngine.renderDirtyRegions(
		mainCtx,
		dirtyRects,
		viewport.width,
		viewport.height,
		currentTransformingIds
	);
};

const applyPendingInitSceneOperations = () => {
	if (!initRenderFinished || (pendingInitSceneCommands.length === 0 && liveSceneCommandsDuringInit.size === 0)) return;
	const merged = new Map<string, Command>();
	for (const command of pendingInitSceneCommands) merged.set(command.id, command);
	for (const command of liveSceneCommandsDuringInit.values()) merged.set(command.id, command);
	const commands = Array.from(merged.values())
		.filter((command) => command.sceneOperation && command.pageId === currentPageId)
		.sort((left, right) => compareRenderOrder(
			sceneOperationOrderKey(left.sceneOperation!),
			sceneOperationOrderKey(right.sceneOperation!)
		));
	pendingInitSceneCommands = [];
	liveSceneCommandsDuringInit.clear();
	let needsFullRender = false;
	for (const command of commands) {
		const operation = command.sceneOperation!;
		if (operation.kind === "element.create") {
			const hydratedThrough = operation.payload.points?.length ?? 0;
			if (
				operation.payload.descriptor.elementKind !== "path" ||
				!sceneEngine.hasHydratedPathRange(operation.elementId, hydratedThrough)
			) {
				needsFullRender = true;
			}
		} else if (operation.kind === "element.append") {
			const hydratedThrough = operation.payload.sourceStart + operation.payload.points.length;
			if (!sceneEngine.hasHydratedPathRange(operation.elementId, hydratedThrough)) {
				needsFullRender = true;
			}
		} else {
			needsFullRender = true;
		}
		sceneCommands.set(command.id, cloneCommandMetadata(command));
		sceneEngine.applyOperation(operation);
	}
	if (needsFullRender) renderFullScene();
};

const operationElementIds = (operation: SceneOperationEnvelopeV2) => {
	switch (operation.kind) {
		case "element.transform":
		case "element.erase":
			return operation.payload.targets.map((target) => target.elementId);
		case "element.delete":
			return operation.payload.elementIds;
		default:
			return [operation.elementId];
	}
};

const mergeBounds = (left: AabbBox | null, right: AabbBox | null): AabbBox | null => {
	if (!left) return right ? { ...right } : null;
	if (!right) return { ...left };
	const minX = Math.min(left.minX, right.minX);
	const minY = Math.min(left.minY, right.minY);
	const maxX = Math.max(left.maxX, right.maxX);
	const maxY = Math.max(left.maxY, right.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

const elementBounds = (ids: ReadonlySet<string>) => {
	let bounds: AabbBox | null = null;
	for (const id of ids) bounds = mergeBounds(bounds, sceneEngine.getElementBounds(id));
	return bounds;
};

const renderSceneOperation = (operation: SceneOperationEnvelopeV2) => {
	const historyImpact = operation.kind === "history.toggle"
		? sceneEngine.getHistoryImpact(operation.payload.targetHistoryGroupId)
		: null;
	const ids = new Set(historyImpact?.elementIds ?? operationElementIds(operation));
	const oldBounds = elementBounds(ids);
	const firstNewRef = sceneEngine.atomCount;
	sceneEngine.applyOperation(operation);
	if (!mainCtx || operation.pageId !== currentPageId) return;
	if (operation.kind === "page.clear" || historyImpact?.pageWide) {
		renderFullScene();
		return;
	}
	const addedBounds = sceneEngine.getAtomBoundsSince(firstNewRef, ids);
	const newBounds = addedBounds ?? elementBounds(ids);
	const dirty = mergeBounds(oldBounds, newBounds);
	if (!dirty) return;
	const pixelBounds: Rect = {
		minX: dirty.minX * viewport.width,
		minY: dirty.minY * viewport.height,
		maxX: dirty.maxX * viewport.width,
		maxY: dirty.maxY * viewport.height,
		width: dirty.width * viewport.width,
		height: dirty.height * viewport.height,
	};
	const excludedIds = operation.kind === "element.transform" ? new Set<string>() : currentTransformingIds;
	sceneEngine.renderDirty(mainCtx, pixelBounds, viewport.width, viewport.height, excludedIds);
};

const isIntersect = (a: Rect, b: Rect): boolean =>
	!(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

const mergeRects = (rects: Rect[]): Rect[] => {
	if (rects.length <= 1) return rects;

	const dsu = new DSU(rects.length);
	for (let i = 0; i < rects.length; i += 1) {
		for (let j = i + 1; j < rects.length; j += 1) {
			const left = rects[i];
			const right = rects[j];
			if (left && right && isIntersect(left, right)) {
				dsu.union(i, j);
			}
		}
	}

	const groups = new Map<number, Rect>();
	for (let i = 0; i < rects.length; i += 1) {
		const root = dsu.find(i);
		const current = rects[i];
		if (!current) continue;
		const existing = groups.get(root);
		if (!existing) {
			groups.set(root, { ...current });
			continue;
		}
		existing.minX = Math.min(existing.minX, current.minX);
		existing.minY = Math.min(existing.minY, current.minY);
		existing.maxX = Math.max(existing.maxX, current.maxX);
		existing.maxY = Math.max(existing.maxY, current.maxY);
		existing.width = existing.maxX - existing.minX;
		existing.height = existing.maxY - existing.minY;
		existing.candidateCommandIds = Array.from(
			new Set([...(existing.candidateCommandIds ?? []), ...(current.candidateCommandIds ?? [])])
		);
	}

	return Array.from(groups.values());
};

self.onmessage = (event: MessageEvent) => {
	const { type, data } = event.data;

	if (type === "init-canvas") {
		offscreenCanvas = data.canvas as OffscreenCanvas;
		viewport = { width: data.width, height: data.height, dpr: data.dpr };
		mainCtx = offscreenCanvas.getContext("2d");
		configureContext();
		return;
	}

	if (type === "resize") {
		viewport = { width: data.width, height: data.height, dpr: data.dpr };
		configureContext();
		renderFullScene();
		return;
	}

	if (type === "flat-points") {
		const projection = new SceneEngine();
		projection.rebuildFromCommands(data.commands as Command[], data.pageId);
		const points = projection.exportFlatPoints(new Set(data.transformingCmdIds ?? []));
		self.postMessage({ type: "flat-points-result", points, requestId: data.requestId });
		return;
	}

	if (type === "flat-points-from-scene") {
		const points = sceneEngine.exportFlatPoints(new Set(data.transformingCmdIds ?? []));
		self.postMessage({ type: "flat-points-result", points, requestId: data.requestId });
		return;
	}

	if (type === "render-full") {
		syncSceneCommands(data.commands as Command[], data.pageId, data.transformingCmdIds);
		renderFullScene();
		return;
	}

	if (type === "begin-init-stream") {
		if (typeof data?.pageId === "number") {
			currentPageId = data.pageId;
		}
		sceneCommands.clear();
		currentTransformingIds.clear();
		sceneEngine.reset(currentPageId);
		sceneEngine.beginBulkLoad();
		initRenderFinished = false;
		initCanvasStarted = false;
		pendingInitSceneCommands = [];
		for (const [id, command] of liveSceneCommandsDuringInit) {
			if (command.pageId !== currentPageId) liveSceneCommandsDuringInit.delete(id);
		}
		return;
	}

	if (type === "append-init-points") {
		const points = (data.points as FlatPoint[]) ?? [];
		appendFlatPointsToCanvas(points);
		return;
	}

	if (type === "append-init-binary-chunk") {
		if (mainCtx && offscreenCanvas) {
			appendInitRenderBinaryChunkToCanvas(data as InitRenderBinaryChunkData);
			return;
		}
		const points = decodeInitRenderBinaryChunk(data as InitRenderBinaryChunkData);
		if (points.length === 0) return;
		points.forEach((point) => {
			appendSceneFlatPoint(point);
			sceneEngine.ingestFlatPoint(point);
		});
		self.postMessage({
			type: "init-render-points-decoded",
			points,
			snapshotVersion: (data as InitRenderBinaryChunkData).snapshotVersion,
			chunkIndex: (data as InitRenderBinaryChunkData).chunkIndex,
		});
		return;
	}

	if (type === "finish-init-stream") {
		ensureInitCanvasStarted();
		const tailRefs = sceneEngine.finishAllOpenStrokes();
		if (mainCtx) sceneEngine.renderAtomRefs(mainCtx, tailRefs, viewport.width, viewport.height);
		initRenderFinished = true;
		sceneEngine.endBulkLoad();
		// Reconcile single-point and translucent strokes after their streamed atoms
		// have already provided first paint. This does not gate progressive display.
		renderFullScene();
		applyPendingInitSceneOperations();
		return;
	}

	if (type === "set-init-scene-operations") {
		if (typeof data.pageId === "number") currentPageId = data.pageId;
		const merged = new Map(pendingInitSceneCommands.map((command) => [command.id, command]));
		for (const command of (data.commands as Command[]) ?? []) merged.set(command.id, command);
		pendingInitSceneCommands = Array.from(merged.values());
		applyPendingInitSceneOperations();
		return;
	}

	if (type === "render-increment-batch") {
		(data as IncrementBatchItem[]).forEach((entry) => {
			renderIncrementalPoints(entry.cmd, entry.points);
		});
		return;
	}

	if (type === "finish-command-stroke") {
		const cmdId = typeof data?.cmdId === "string" ? data.cmdId : "";
		if (cmdId) finishIncrementalCommand(cmdId);
		return;
	}

	if (type === "sync-scene") {
		syncSceneCommands(data.commands as Command[], data.pageId, data.transformingCmdIds);
		return;
	}

	if (type === "render-flat-points-scene") {
		currentPageId = data.pageId as number;
		const points = (data.points as FlatPoint[]) ?? [];
		sceneCommands.clear();
		sceneEngine.reset(currentPageId);
		points.forEach((point) => {
			appendSceneFlatPoint(point);
			sceneEngine.ingestFlatPoint(point);
		});
		sceneEngine.finishAllOpenStrokes();
		renderFullScene();
		return;
	}

	if (type === "render-dirty") {
		if (data.pageId === currentPageId) {
			renderDirtyRect(data.rect as Rect, data.transformingCmdIds as string[]);
		}
		return;
	}

	if (type === "update-command-state") {
		const cmd = data.cmd as Command;
		if (cmd.type === "scene-op" && cmd.sceneOperation) {
			if (!initRenderFinished) {
				liveSceneCommandsDuringInit.set(cmd.id, cmd);
				return;
			}
			sceneCommands.set(cmd.id, cloneCommandMetadata(cmd));
			renderSceneOperation(cmd.sceneOperation);
			if (cmd.sceneOperation.kind === "element.transform") {
				self.postMessage({ type: "scene-operation-rendered", opId: cmd.sceneOperation.opId });
			}
			return;
		}
		const existing = sceneCommands.get(cmd.id);
		if (existing) {
			existing.type = cmd.type;
			existing.tool = cmd.tool;
			existing.color = cmd.color;
			existing.size = cmd.size;
			existing.pageId = cmd.pageId;
			existing.isDeleted = cmd.isDeleted;
			existing.lamport = cmd.lamport;
			existing.box = { ...cmd.box };
		} else {
			sceneCommands.set(cmd.id, cloneCommandMetadata(cmd));
		}
		sceneEngine.setLegacyCommandState(cmd);
		return;
	}

	if (type === "remove-command-state") {
		const cmdId = typeof data.cmdId === "string" ? data.cmdId : "";
		if (cmdId) {
			sceneCommands.delete(cmdId);
			sceneEngine.removeElement(cmdId);
			activeStrokeIds.delete(cmdId);
		}
		return;
	}

	if (type === "get-command-points") {
		const requestId = typeof data.requestId === "string" ? data.requestId : "";
		const cmdIds = Array.isArray(data.cmdIds) ? (data.cmdIds as string[]) : [];
		const commands = cmdIds.map((cmdId) => ({
			cmdId,
			points: sceneEngine.getElementPoints(cmdId),
		}));
		self.postMessage({ type: "command-points-result", requestId, commands });
		return;
	}

	if (type === "render-dirty-regions") {
		if (data.pageId === currentPageId) {
			renderDirtyRegions((data.rects as Rect[]) ?? [], data.transformingCmdIds as string[]);
		}
		return;
	}

	if (type === "compute-erase-targets") {
		const projection = Array.isArray(data.commands) ? new SceneEngine() : sceneEngine;
		if (projection !== sceneEngine) {
			projection.rebuildFromCommands(data.commands as Command[], Number(data.pageId ?? currentPageId));
		}
		const targets = projection.computeEraseTargets(
			(data.points as Point[]) ?? [],
			Number(data.size ?? 15),
			Number(data.width ?? viewport.width),
			Number(data.height ?? viewport.height),
			data.wholeObjects === true
		);
		self.postMessage({ type: "erase-targets-result", requestId: data.requestId, targets });
		return;
	}

	if (type === "scene-hit-test") {
		const elementId = sceneEngine.hitTestTopmost(
			Number(data.x ?? 0),
			Number(data.y ?? 0),
			viewport.width,
			viewport.height
		);
		self.postMessage({
			type: "scene-hit-result",
			requestId: data.requestId,
			elementId,
			bounds: elementId ? sceneEngine.getElementBounds(elementId) : null,
		});
		return;
	}

	if (type === "scene-query-elements") {
		const rect = data.rect as Rect;
		const elementIds = sceneEngine.queryElements(rect, viewport.width, viewport.height);
		const bounds = elementBounds(new Set(elementIds));
		self.postMessage({ type: "scene-query-result", requestId: data.requestId, elementIds, bounds });
		return;
	}

	if (type === "rerender-scene") {
		currentPageId = data.pageId as number;
		currentTransformingIds = new Set((data.transformingCmdIds as string[]) ?? []);
		renderFullScene();
		return;
	}

	if (type === "merge-dirty-rects") {
		const merged = mergeRects(data.rects as Rect[]);
		self.postMessage({ type: "merge-dirty-rects-result", rects: merged });
		return;
	}

	if (type === "dispose") {
		activeStrokeIds.clear();
		sceneCommands.clear();
		sceneEngine.reset(0);
		pendingInitSceneCommands = [];
		liveSceneCommandsDuringInit.clear();
		initRenderFinished = false;
		initCanvasStarted = false;
		currentTransformingIds.clear();
		offscreenCanvas = null;
		mainCtx = null;
	}
};
