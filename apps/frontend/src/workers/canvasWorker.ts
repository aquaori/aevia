import type { Command, FlatPoint, Point } from "@collaborative-whiteboard/shared";
import {
	createStrokeBatch,
	finishStroke,
	paintStrokeSample,
	type StrokeState,
} from "../service/strokeRasterizer";
import type { InitRenderChunkCommandDictionaryEntry } from "../service/collabDispatcherTypes";

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

interface DirtySegmentRange {
	start: number;
	end: number;
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
const incrementalStates = new Map<string, StrokeState>();
const activeStrokeIds = new Set<string>();
const sceneCommands = new Map<string, Command>();
const INIT_RENDER_CHUNK_MAGIC = 0x49524348;
const INIT_RENDER_CHUNK_VERSION = 1;
const INIT_RENDER_CHUNK_HEADER_SIZE = 20;
const INIT_RENDER_CHUNK_RECORD_SIZE = 22;

const clonePoint = (point: Point): Point => ({
	x: point.x,
	y: point.y,
	p: point.p,
	lamport: point.lamport,
});

const cloneCommand = (cmd: Command): Command => ({
	...cmd,
	points: cmd.points ? cmd.points.map(clonePoint) : [],
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

const flattenCommands = (commands: Command[], pageId: number, transformingCmdIds: string[]) => {
	const transformSet = new Set(transformingCmdIds);
	const points: FlatPoint[] = [];

	commands.forEach((cmd) => {
		if (transformSet.has(cmd.id)) return;
		if (!cmd.points || cmd.pageId !== pageId) return;
		cmd.points.forEach((pt) => {
			points.push({
				x: pt.x,
				y: pt.y,
				p: pt.p,
				lamport: pt.lamport,
				cmdId: cmd.id,
				pageId: cmd.pageId,
				userId: cmd.userId,
				tool: cmd.tool ?? "pen",
				color: cmd.color ?? "#000000",
				size: cmd.size ?? 3,
				isDeleted: cmd.isDeleted,
			});
		});
	});

	points.sort((a, b) => {
		if (a.lamport !== b.lamport) return a.lamport - b.lamport;
		return a.cmdId < b.cmdId ? -1 : 1;
	});

	return points;
};

const renderPointsToCanvas = (points: FlatPoint[]) => {
	if (!offscreenCanvas || !mainCtx) return 0;
	incrementalStates.clear();
	mainCtx.save();
	mainCtx.setTransform(1, 0, 0, 1, 0, 0);
	mainCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
	mainCtx.restore();

	const remainingPoints = new Map<string, number>();
	points.forEach((point) => {
		if (point.pageId !== currentPageId || point.isDeleted) return;
		remainingPoints.set(point.cmdId, (remainingPoints.get(point.cmdId) ?? 0) + 1);
	});

	// Full replay batches same-style geometry; the batch disables itself when the
	// stream turns out to be interleaved (see createStrokeBatch).
	const batch = createStrokeBatch(mainCtx as unknown as CanvasRenderingContext2D);
	let renderedPointCount = 0;
	points.forEach((point) => {
		if (point.pageId !== currentPageId) return;
		if (point.isDeleted) return;
		let nextState = paintStrokeSample({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			sample: point,
			previousState: incrementalStates.get(point.cmdId) ?? null,
			tool: point.tool,
			color: point.color,
			baseSize: point.size,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
			batch,
		});
		const remaining = (remainingPoints.get(point.cmdId) ?? 1) - 1;
		remainingPoints.set(point.cmdId, remaining);
		if (remaining === 0 && !activeStrokeIds.has(point.cmdId)) {
			nextState =
				finishStroke({
					ctx: mainCtx as unknown as CanvasRenderingContext2D,
					state: nextState,
					tool: point.tool,
					color: point.color,
					baseSize: point.size,
					logicalWidth: viewport.width,
					logicalHeight: viewport.height,
					batch,
				}) ?? nextState;
		}
		if (nextState.finished) {
			incrementalStates.delete(point.cmdId);
		} else {
			incrementalStates.set(point.cmdId, nextState);
		}
		renderedPointCount += 1;
	});
	batch.flush();

	return renderedPointCount;
};

const clearCanvas = () => {
	if (!offscreenCanvas || !mainCtx) return;
	incrementalStates.clear();
	activeStrokeIds.clear();
	mainCtx.save();
	mainCtx.setTransform(1, 0, 0, 1, 0, 0);
	mainCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
	mainCtx.restore();
};

const appendFlatPointsToCanvas = (points: FlatPoint[]) => {
	if (points.length === 0) return 0;
	points.forEach((point) => {
		if (point.pageId !== currentPageId) return;
		if (point.isDeleted) return;
		appendSceneFlatPoint(point);
		if (!mainCtx) return;
		const nextState = paintStrokeSample({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			sample: point,
			previousState: incrementalStates.get(point.cmdId) ?? null,
			tool: point.tool,
			color: point.color,
			baseSize: point.size,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
		});
		incrementalStates.set(point.cmdId, nextState);
	});
	return points.length;
};

const decodeInitRenderBinaryChunk = (data: InitRenderBinaryChunkData): FlatPoint[] => {
	const view = new DataView(data.buffer);
	const header = validateInitRenderBinaryChunk(data, view);
	if (!header) return [];

	const { pointCount } = header;
	const commandDictionary = new Map<number, InitRenderChunkCommandDictionaryEntry>();
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

		points.push({
			x,
			y,
			p,
			lamport,
			cmdId: commandMeta.cmdId,
			pageId: currentPageId,
			userId: commandMeta.userId,
			tool: commandMeta.tool,
			color: commandMeta.color,
			size: commandMeta.size,
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

	const commandDictionary: InitRenderChunkCommandDictionaryEntry[] = [];
	for (const command of data.commands) {
		commandDictionary[command.cmdIndex] = command;
	}

	let renderedPointCount = 0;
	let offset = INIT_RENDER_CHUNK_HEADER_SIZE;
	const sample: Point = { x: 0, y: 0, p: 0, lamport: 0 };
	// One batch per chunk: flushed below, so buffered geometry stays bounded while
	// incrementalStates keeps carrying stroke continuity across chunks.
	const batch = createStrokeBatch(mainCtx as unknown as CanvasRenderingContext2D);
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
		if (!commandMeta || commandMeta.isDeleted) continue;
		appendInitScenePoint(commandMeta, sample);

		const nextState = paintStrokeSample({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			sample,
			previousState: incrementalStates.get(commandMeta.cmdId) ?? null,
			tool: commandMeta.tool,
			color: commandMeta.color,
			baseSize: commandMeta.size,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
			batch,
		});
		incrementalStates.set(commandMeta.cmdId, nextState);
		renderedPointCount += 1;
	}
	batch.flush();

	return renderedPointCount;
};

const renderFullScene = () => {
	const points = flattenCommands(
		Array.from(sceneCommands.values()),
		currentPageId,
		Array.from(currentTransformingIds)
	);
	renderPointsToCanvas(points);
	return points.length;
};

const syncSceneCommands = (commands: Command[], pageId: number, transformingCmdIds: string[]) => {
	sceneCommands.clear();
	incrementalStates.clear();
	activeStrokeIds.clear();
	commands.forEach((cmd) => {
		sceneCommands.set(cmd.id, cloneCommand(cmd));
	});
	currentPageId = pageId;
	currentTransformingIds = new Set(transformingCmdIds);
};

const appendInitScenePoint = (
	commandMeta: InitRenderChunkCommandDictionaryEntry,
	point: Point
) => {
	let command = sceneCommands.get(commandMeta.cmdId);
	if (!command) {
		command = {
			id: commandMeta.cmdId,
			type: "path",
			tool: commandMeta.tool,
			color: commandMeta.color,
			size: commandMeta.size,
			points: [],
			timestamp: 0,
			userId: commandMeta.userId,
			roomId: "",
			pageId: currentPageId,
			isDeleted: commandMeta.isDeleted,
			lamport: point.lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};
		sceneCommands.set(commandMeta.cmdId, command);
	}
	command.points ??= [];
	command.points.push(clonePoint(point));
	command.lamport = Math.max(command.lamport ?? 0, point.lamport);
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
			points: [],
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
	command.points ??= [];
	command.points.push(clonePoint(point));
	command.lamport = Math.max(command.lamport ?? 0, point.lamport);
};

const upsertSceneCommand = (cmd: Command, points: Point[]) => {
	const existing = sceneCommands.get(cmd.id);
	if (!existing) {
		sceneCommands.set(
			cmd.id,
			cloneCommand({
				...cmd,
				points,
			})
		);
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
	if (!existing.points) {
		existing.points = points.map(clonePoint);
	} else if (points.length > 0) {
		existing.points.push(...points.map(clonePoint));
	}
	return existing;
};

const renderIncrementalPoints = (cmd: Command, points: Point[]) => {
	if (!mainCtx || cmd.pageId !== currentPageId || currentTransformingIds.has(cmd.id)) return 0;
	const sceneCommand = upsertSceneCommand(cmd, points);
	activeStrokeIds.add(sceneCommand.id);
	points.forEach((point) => {
		const nextState = paintStrokeSample({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			sample: point,
			previousState: incrementalStates.get(sceneCommand.id) ?? null,
			tool: sceneCommand.tool ?? "pen",
			color: sceneCommand.color,
			baseSize: sceneCommand.size ?? 3,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
		});
		incrementalStates.set(sceneCommand.id, nextState);
	});
	return points.length;
};

const finishIncrementalCommand = (cmdId: string) => {
	const state = incrementalStates.get(cmdId);
	const command = sceneCommands.get(cmdId);
	if (state && command && mainCtx) {
		finishStroke({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			state,
			tool: command.tool,
			color: command.color,
			baseSize: command.size ?? 3,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
		});
	}
	incrementalStates.delete(cmdId);
	activeStrokeIds.delete(cmdId);
};

const pointIntersectsDirtyRect = (point: Pick<Point, "x" | "y">, dirtyRect: Rect, padding = 20) => {
	const x = point.x * viewport.width;
	const y = point.y * viewport.height;
	return (
		x >= dirtyRect.minX - padding &&
		x <= dirtyRect.minX + dirtyRect.width + padding &&
		y >= dirtyRect.minY - padding &&
		y <= dirtyRect.minY + dirtyRect.height + padding
	);
};

const segmentIntersectsDirtyRect = (from: Point, to: Point, dirtyRect: Rect, padding = 20) => {
	const x1 = from.x * viewport.width;
	const y1 = from.y * viewport.height;
	const x2 = to.x * viewport.width;
	const y2 = to.y * viewport.height;
	const minX = Math.min(x1, x2) - padding;
	const maxX = Math.max(x1, x2) + padding;
	const minY = Math.min(y1, y2) - padding;
	const maxY = Math.max(y1, y2) + padding;

	return !(
		maxX < dirtyRect.minX ||
		minX > dirtyRect.minX + dirtyRect.width ||
		maxY < dirtyRect.minY ||
		minY > dirtyRect.minY + dirtyRect.height
	);
};

const mergeSegmentRanges = (ranges: DirtySegmentRange[]) => {
	if (ranges.length <= 1) return ranges;

	ranges.sort((a, b) => a.start - b.start);
	const merged: DirtySegmentRange[] = [{ ...ranges[0]! }];
	for (let index = 1; index < ranges.length; index += 1) {
		const current = ranges[index];
		const previous = merged[merged.length - 1];
		if (!current || !previous) continue;
		if (current.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, current.end);
			continue;
		}
		merged.push({ ...current });
	}
	return merged;
};

const collectDirtySegments = (points: Point[], dirtyRect: Rect, padding = 20) => {
	if (points.length === 0) return [] as DirtySegmentRange[];

	const ranges: DirtySegmentRange[] = [];
	let activeStart: number | null = null;

	for (let index = 0; index < points.length; index += 1) {
		const current = points[index];
		if (!current) continue;

		const intersects =
			(index === 0 && pointIntersectsDirtyRect(current, dirtyRect, padding)) ||
			(index > 0 && segmentIntersectsDirtyRect(points[index - 1]!, current, dirtyRect, padding));

		if (intersects) {
			if (activeStart === null) {
				activeStart = Math.max(0, index - 1);
			}
			continue;
		}

		if (activeStart !== null) {
			ranges.push({
				start: activeStart,
				end: Math.min(points.length - 1, index),
			});
			activeStart = null;
		}
	}

	if (activeStart !== null) {
		ranges.push({
			start: activeStart,
			end: points.length - 1,
		});
	}

	return mergeSegmentRanges(ranges);
};

const renderCommandRange = (command: Command, range: DirtySegmentRange) => {
	if (!mainCtx || command.type !== "path" || !command.points?.length) return;

	const baseSize = command.size ?? 3;
	let previousState: StrokeState | null = null;
	for (let index = 0; index <= range.end; index += 1) {
		const point = command.points[index];
		if (!point) continue;
		previousState = paintStrokeSample({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			sample: point,
			previousState,
			tool: command.tool,
			color: command.color,
			baseSize,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
		});
	}
	if (previousState && range.end === command.points.length - 1) {
		finishStroke({
			ctx: mainCtx as unknown as CanvasRenderingContext2D,
			state: previousState,
			tool: command.tool,
			color: command.color,
			baseSize,
			logicalWidth: viewport.width,
			logicalHeight: viewport.height,
		});
	}
};

const getDirtyCandidateCommands = (dirtyRect: Rect) => {
	const intersectingCommands = Array.from(sceneCommands.values()).filter((command) => {
		if (command.pageId !== currentPageId || command.isDeleted || command.type !== "path") return false;
		const box = command.box;
		const padding = 20;
		const boxIntersects =
			box &&
			!(
				box.maxX * viewport.width < dirtyRect.minX - padding ||
				box.minX * viewport.width > dirtyRect.minX + dirtyRect.width + padding ||
				box.maxY * viewport.height < dirtyRect.minY - padding ||
				box.minY * viewport.height > dirtyRect.minY + dirtyRect.height + padding
			);
		if (boxIntersects) return true;
		return command.points
			? collectDirtySegments(command.points, dirtyRect, padding).length > 0
			: false;
	});

	if (!dirtyRect.candidateCommandIds || dirtyRect.candidateCommandIds.length === 0) {
		return intersectingCommands;
	}

	const commandMap = new Map<string, Command>();
	intersectingCommands.forEach((command) => {
		commandMap.set(command.id, command);
	});
	dirtyRect.candidateCommandIds.forEach((commandId) => {
		const command = sceneCommands.get(commandId);
		if (command) {
			commandMap.set(command.id, command);
		}
	});

	return Array.from(commandMap.values());
};

const renderDirtyRect = (dirtyRect: Rect, transformingCmdIds: string[]) => {
	if (!mainCtx || !offscreenCanvas) return;
	currentTransformingIds = new Set(transformingCmdIds);
	const padding = 20;
	const candidateCommands = getDirtyCandidateCommands(dirtyRect);

	mainCtx.save();
	mainCtx.beginPath();
	mainCtx.clearRect(
		dirtyRect.minX - padding,
		dirtyRect.minY - padding,
		dirtyRect.width + padding * 2,
		dirtyRect.height + padding * 2
	);
	mainCtx.rect(
		dirtyRect.minX - padding,
		dirtyRect.minY - padding,
		dirtyRect.width + padding * 2,
		dirtyRect.height + padding * 2
	);
	mainCtx.clip();

	candidateCommands.forEach((command) => {
		if (
			command.pageId !== currentPageId ||
			command.isDeleted ||
			command.type !== "path" ||
			!command.points?.length ||
			currentTransformingIds.has(command.id)
		) {
			return;
		}

		const ranges = collectDirtySegments(command.points, dirtyRect, padding);
		ranges.forEach((range) => renderCommandRange(command, range));
	});

	mainCtx.restore();
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
		const points = flattenCommands(data.commands as Command[], data.pageId, data.transformingCmdIds);
		self.postMessage({ type: "flat-points-result", points, requestId: data.requestId });
		return;
	}

	if (type === "flat-points-from-scene") {
		const points = flattenCommands(
			Array.from(sceneCommands.values()),
			data.pageId,
			data.transformingCmdIds
		);
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
		clearCanvas();
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
		points.forEach((point) => appendSceneFlatPoint(point));
		self.postMessage({
			type: "init-render-points-decoded",
			points,
			snapshotVersion: (data as InitRenderBinaryChunkData).snapshotVersion,
			chunkIndex: (data as InitRenderBinaryChunkData).chunkIndex,
		});
		return;
	}

	if (type === "finish-init-stream") {
		Array.from(incrementalStates.keys()).forEach(finishIncrementalCommand);
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
		points.forEach((point) => appendSceneFlatPoint(point));
		renderPointsToCanvas(points);
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
			if (cmd.points) {
				existing.points = cmd.points.map(clonePoint);
			}
		} else {
			sceneCommands.set(cmd.id, cloneCommand(cmd));
		}
		return;
	}

	if (type === "remove-command-state") {
		const cmdId = typeof data.cmdId === "string" ? data.cmdId : "";
		if (cmdId) {
			sceneCommands.delete(cmdId);
			incrementalStates.delete(cmdId);
			activeStrokeIds.delete(cmdId);
		}
		return;
	}

	if (type === "translate-command-points") {
		const cmdIds = Array.isArray(data.cmdIds) ? (data.cmdIds as string[]) : [];
		const dx = Number(data.dx ?? 0);
		const dy = Number(data.dy ?? 0);
		cmdIds.forEach((cmdId) => {
			const command = sceneCommands.get(cmdId);
			command?.points?.forEach((point) => {
				point.x += dx;
				point.y += dy;
			});
		});
		return;
	}

	if (type === "get-command-points") {
		const requestId = typeof data.requestId === "string" ? data.requestId : "";
		const cmdIds = Array.isArray(data.cmdIds) ? (data.cmdIds as string[]) : [];
		const commands = cmdIds.map((cmdId) => {
			const command = sceneCommands.get(cmdId);
			return {
				cmdId,
				points: command?.points ? command.points.map(clonePoint) : [],
			};
		});
		self.postMessage({ type: "command-points-result", requestId, commands });
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
		incrementalStates.clear();
		activeStrokeIds.clear();
		sceneCommands.clear();
		currentTransformingIds.clear();
		offscreenCanvas = null;
		mainCtx = null;
	}
};
