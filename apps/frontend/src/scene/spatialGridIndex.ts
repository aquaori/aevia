// File role: coarse normalized grid over bounded geometry chunks.
import type { AabbBox } from "@collaborative-whiteboard/shared";

const GRID_SIZE = 32;
const MAX_CHUNK_ATOMS = 64;
const MAX_CHUNK_CELLS = 8;
const LARGE_CHUNK_CELLS = 64;

interface GeometryChunk {
	id: number;
	elementId: string;
	atomRefs: number[];
	cellIds: number[];
	large: boolean;
}

const clampCell = (value: number) => Math.min(GRID_SIZE - 1, Math.max(0, value));

const cellsForBounds = (bounds: AabbBox) => {
	const minX = clampCell(Math.floor(bounds.minX * GRID_SIZE));
	const minY = clampCell(Math.floor(bounds.minY * GRID_SIZE));
	const maxX = clampCell(Math.floor(bounds.maxX * GRID_SIZE));
	const maxY = clampCell(Math.floor(bounds.maxY * GRID_SIZE));
	const cells: number[] = [];
	for (let y = minY; y <= maxY; y += 1) {
		for (let x = minX; x <= maxX; x += 1) cells.push(y * GRID_SIZE + x);
	}
	return cells;
};

export class SpatialGridIndex {
	private readonly buckets = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => [] as number[]);
	private readonly chunks: GeometryChunk[] = [];
	private readonly elementChunkIds = new Map<string, number[]>();
	private readonly activeChunkByElement = new Map<string, number>();
	private readonly largeChunkIds: number[] = [];
	private seen = new Uint32Array(128);
	private generation = 1;

	clear() {
		for (const bucket of this.buckets) bucket.length = 0;
		this.chunks.length = 0;
		this.elementChunkIds.clear();
		this.activeChunkByElement.clear();
		this.largeChunkIds.length = 0;
		this.seen.fill(0);
		this.generation = 1;
	}

	addAtom(elementId: string, atomRef: number, bounds: AabbBox) {
		const atomCells = cellsForBounds(bounds);
		let chunk = this.getActiveChunk(elementId);
		if (chunk) {
			const addedCells = atomCells.filter((cellId) => !chunk!.cellIds.includes(cellId));
			if (chunk.atomRefs.length < MAX_CHUNK_ATOMS && chunk.cellIds.length + addedCells.length <= MAX_CHUNK_CELLS) {
				chunk.atomRefs.push(atomRef);
				if (addedCells.length > 0) {
					this.updateChunkCells(chunk, [...chunk.cellIds, ...addedCells]);
				}
				return;
			}
			chunk = this.createChunk(elementId);
		} else {
			chunk = this.createChunk(elementId);
		}
		chunk.atomRefs.push(atomRef);
		this.updateChunkCells(chunk, atomCells);
	}

	query(bounds: AabbBox) {
		this.nextGeneration();
		const chunkIds: number[] = [];
		for (const cellId of cellsForBounds(bounds)) {
			for (const chunkId of this.buckets[cellId]!) this.addCandidate(chunkId, chunkIds);
		}
		for (const chunkId of this.largeChunkIds) this.addCandidate(chunkId, chunkIds);
		return {
			chunkIds,
			atomRefs: chunkIds.flatMap((chunkId) => this.chunks[chunkId]?.atomRefs ?? []),
			gridCells: cellsForBounds(bounds).length,
		};
	}

	getElementAtomRefs(elementId: string) {
		return (this.elementChunkIds.get(elementId) ?? []).flatMap(
			(chunkId) => this.chunks[chunkId]?.atomRefs ?? []
		);
	}

	reindexElement(elementId: string, boundsFor: (ref: number) => AabbBox) {
		for (const chunkId of this.elementChunkIds.get(elementId) ?? []) {
			const chunk = this.chunks[chunkId];
			if (!chunk) continue;
			this.unregisterChunk(chunk);
			const cells = new Set<number>();
			for (const ref of chunk.atomRefs) {
				for (const cell of cellsForBounds(boundsFor(ref))) cells.add(cell);
			}
			this.updateChunkCells(chunk, Array.from(cells));
		}
	}

	stats() {
		let gridReferences = 0;
		for (const bucket of this.buckets) gridReferences += bucket.length;
		return {
			chunks: this.chunks.length,
			gridReferences,
			largeChunks: this.largeChunkIds.length,
		};
	}

	private getActiveChunk(elementId: string) {
		const id = this.activeChunkByElement.get(elementId);
		return id === undefined ? undefined : this.chunks[id];
	}

	private createChunk(elementId: string) {
		const chunk: GeometryChunk = {
			id: this.chunks.length,
			elementId,
			atomRefs: [],
			cellIds: [],
			large: false,
		};
		this.chunks.push(chunk);
		this.activeChunkByElement.set(elementId, chunk.id);
		const ids = this.elementChunkIds.get(elementId) ?? [];
		ids.push(chunk.id);
		this.elementChunkIds.set(elementId, ids);
		this.ensureSeenCapacity();
		return chunk;
	}

	private updateChunkCells(chunk: GeometryChunk, nextCells: number[]) {
		this.unregisterChunk(chunk);
		chunk.cellIds = nextCells;
		chunk.large = nextCells.length > LARGE_CHUNK_CELLS;
		if (chunk.large) {
			this.largeChunkIds.push(chunk.id);
			return;
		}
		for (const cellId of nextCells) this.buckets[cellId]!.push(chunk.id);
	}

	private unregisterChunk(chunk: GeometryChunk) {
		if (chunk.large) {
			const index = this.largeChunkIds.indexOf(chunk.id);
			if (index >= 0) this.largeChunkIds.splice(index, 1);
		} else {
			for (const cellId of chunk.cellIds) {
				const bucket = this.buckets[cellId]!;
				const index = bucket.indexOf(chunk.id);
				if (index >= 0) bucket.splice(index, 1);
			}
		}
		chunk.large = false;
	}

	private addCandidate(chunkId: number, out: number[]) {
		if (this.seen[chunkId] === this.generation) return;
		this.seen[chunkId] = this.generation;
		out.push(chunkId);
	}

	private nextGeneration() {
		this.generation += 1;
		if (this.generation === 0xffffffff) {
			this.seen.fill(0);
			this.generation = 1;
		}
	}

	private ensureSeenCapacity() {
		if (this.chunks.length <= this.seen.length) return;
		const next = new Uint32Array(this.seen.length * 2);
		next.set(this.seen);
		this.seen = next;
	}
}

export const spatialGridConstants = {
	gridSize: GRID_SIZE,
	maxChunkAtoms: MAX_CHUNK_ATOMS,
	maxChunkCells: MAX_CHUNK_CELLS,
	largeChunkCells: LARGE_CHUNK_CELLS,
};
