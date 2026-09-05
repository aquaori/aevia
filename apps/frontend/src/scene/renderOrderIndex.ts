// File role: bounded sorted blocks for deterministic full-scene traversal.
import { compareRenderOrder, type RenderOrderKey } from "@collaborative-whiteboard/shared";

const DEFAULT_BLOCK_SIZE = 2000;

export class RenderOrderIndex {
	private readonly blocks: number[][] = [];
	private readonly keyFor: (ref: number) => RenderOrderKey;
	private readonly blockSize: number;

	constructor(keyFor: (ref: number) => RenderOrderKey, blockSize = DEFAULT_BLOCK_SIZE) {
		this.keyFor = keyFor;
		this.blockSize = blockSize;
	}

	clear() {
		this.blocks.length = 0;
	}

	insert(ref: number) {
		if (this.blocks.length === 0) {
			this.blocks.push([ref]);
			return;
		}

		const lastBlock = this.blocks[this.blocks.length - 1]!;
		const lastRef = lastBlock[lastBlock.length - 1];
		if (lastRef === undefined || compareRenderOrder(this.keyFor(lastRef), this.keyFor(ref)) < 0) {
			if (lastBlock.length >= this.blockSize) {
				this.blocks.push([ref]);
			} else {
				lastBlock.push(ref);
			}
			return;
		}

		const blockIndex = this.findBlock(ref);
		const block = this.blocks[blockIndex]!;
		let low = 0;
		let high = block.length;
		while (low < high) {
			const middle = low + ((high - low) >> 1);
			if (compareRenderOrder(this.keyFor(block[middle]!), this.keyFor(ref)) < 0) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		block.splice(low, 0, ref);
		if (block.length > this.blockSize * 2) {
			const right = block.splice(block.length >> 1);
			this.blocks.splice(blockIndex + 1, 0, right);
		}
	}

	forEach(visit: (ref: number) => void) {
		for (const block of this.blocks) {
			for (const ref of block) visit(ref);
		}
	}

	toArray() {
		const result: number[] = [];
		this.forEach((ref) => result.push(ref));
		return result;
	}

	get blockCount() {
		return this.blocks.length;
	}

	private findBlock(ref: number) {
		let low = 0;
		let high = this.blocks.length;
		const key = this.keyFor(ref);
		while (low < high) {
			const middle = low + ((high - low) >> 1);
			const block = this.blocks[middle]!;
			const lastRef = block[block.length - 1];
			if (lastRef !== undefined && compareRenderOrder(this.keyFor(lastRef), key) < 0) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return Math.min(low, this.blocks.length - 1);
	}
}
