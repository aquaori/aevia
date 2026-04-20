import type { Command, FlatPoint, Point } from "../utils/type";
import { paintStrokeSample, type StrokeState } from "../service/strokeRasterizer";
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

	let renderedPointCount = 0;
	points.forEach((point) => {
		if (point.pageId !== currentPageId) return;
		if (point.isDeleted) return;
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
		renderedPointCount += 1;
	});

	return renderedPointCount;
};

const clearCanvas = () => {
	if (!offscreenCanvas || !mainCtx) return;
	incrementalStates.clear();
	mainCtx.save();
	mainCtx.setTransform(1, 0, 0, 1, 0, 0);
	mainCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
	mainCtx.restore();
};

const appendFlatPointsToCanvas = (points: FlatPoint[]) => {
	if (!mainCtx || points.length === 0) return 0;
	points.forEach((point) => {
		if (point.pageId !== currentPageId) return;
		if (point.isDeleted) return;
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
	if (view.byteLength < INIT_RENDER_CHUNK_HEADER_SIZE) {
		console.error("[canvasWorker] init render binary chunk header is truncated.");
		return [];
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
		return [];
	}

	if (version !== INIT_RENDER_CHUNK_VERSION) {
		console.error("[canvasWorker] init render binary chunk version mismatch.", {
			expected: INIT_RENDER_CHUNK_VERSION,
			received: version,
		});
		return [];
	}

	if (recordSize !== INIT_RENDER_CHUNK_RECORD_SIZE) {
		console.error("[canvasWorker] init render binary chunk record size mismatch.", {
			expected: INIT_RENDER_CHUNK_RECORD_SIZE,
			received: recordSize,
		});
		return [];
	}

	if (snapshotVersion !== data.snapshotVersion || chunkIndex !== data.chunkIndex) {
		console.error("[canvasWorker] init render binary chunk identity mismatch.", {
			expectedSnapshotVersion: data.snapshotVersion,
			receivedSnapshotVersion: snapshotVersion,
			expectedChunkIndex: data.chunkIndex,
			receivedChunkIndex: chunkIndex,
		});
		return [];
	}

	if (pointCount !== data.pointCount) {
		console.error("[canvasWorker] init render binary chunk point count mismatch.", {
			expected: data.pointCount,
			received: pointCount,
		});
		return [];
	}

	const expectedByteLength =
		INIT_RENDER_CHUNK_HEADER_SIZE + pointCount * INIT_RENDER_CHUNK_RECORD_SIZE;
	if (view.byteLength !== expectedByteLength) {
		console.error("[canvasWorker] init render binary chunk byte length mismatch.", {
			expected: expectedByteLength,
			received: view.byteLength,
		});
		return [];
	}

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
	commands.forEach((cmd) => {
		sceneCommands.set(cmd.id, cloneCommand(cmd));
	});
	currentPageId = pageId;
	currentTransformingIds = new Set(transformingCmdIds);
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
};

const getDirtyCandidateCommands = (dirtyRect: Rect) => {
	const intersectingCommands = Array.from(sceneCommands.values()).filter((command) => {
		if (command.pageId !== currentPageId || command.isDeleted || command.type !== "path") return false;
		const box = command.box;
		return !(
			box.maxX * viewport.width < dirtyRect.minX ||
			box.minX * viewport.width > dirtyRect.minX + dirtyRect.width ||
			box.maxY * viewport.height < dirtyRect.minY ||
			box.minY * viewport.height > dirtyRect.minY + dirtyRect.height
		);
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

	if (type === "render-full") {
		const startedAt = performance.now();
		syncSceneCommands(data.commands as Command[], data.pageId, data.transformingCmdIds);
		const pointCount = renderFullScene();
		self.postMessage({
			type: "benchmark-render-full-complete",
			points: pointCount,
			durationMs: performance.now() - startedAt,
		});
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
		const points = decodeInitRenderBinaryChunk(data as InitRenderBinaryChunkData);
		if (points.length === 0) return;
		if (mainCtx && offscreenCanvas) {
			appendFlatPointsToCanvas(points);
			return;
		}
		self.postMessage({
			type: "init-render-points-decoded",
			points,
			snapshotVersion: (data as InitRenderBinaryChunkData).snapshotVersion,
			chunkIndex: (data as InitRenderBinaryChunkData).chunkIndex,
		});
		return;
	}

	if (type === "finish-init-stream") {
		return;
	}

	if (type === "render-increment-batch") {
		(data as IncrementBatchItem[]).forEach((entry) => {
			const startedAt = performance.now();
			const pointCount = renderIncrementalPoints(entry.cmd, entry.points);
			self.postMessage({
				type: "benchmark-incremental-complete",
				commandId: entry.cmd.id,
				source: entry.source,
				points: pointCount,
				durationMs: performance.now() - startedAt,
			});
		});
		return;
	}

	if (type === "sync-scene") {
		const commands = data.commands as Command[];
		syncSceneCommands(data.commands as Command[], data.pageId, data.transformingCmdIds);
		return;
	}

	if (type === "render-flat-points-scene") {
		const startedAt = performance.now();
		currentPageId = data.pageId as number;
		const pointCount = renderPointsToCanvas((data.points as FlatPoint[]) ?? []);
		self.postMessage({
			type: "benchmark-render-full-complete",
			points: pointCount,
			durationMs: performance.now() - startedAt,
		});
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

	if (type === "rerender-scene") {
		const startedAt = performance.now();
		currentPageId = data.pageId as number;
		currentTransformingIds = new Set((data.transformingCmdIds as string[]) ?? []);
		const pointCount = renderFullScene();
		self.postMessage({
			type: "benchmark-render-full-complete",
			points: pointCount,
			durationMs: performance.now() - startedAt,
		});
		return;
	}

	if (type === "merge-dirty-rects") {
		const merged = mergeRects(data.rects as Rect[]);
		self.postMessage({ type: "merge-dirty-rects-result", rects: merged });
		return;
	}

	if (type === "dispose") {
		incrementalStates.clear();
		sceneCommands.clear();
		currentTransformingIds.clear();
		offscreenCanvas = null;
		mainCtx = null;
	}
};
