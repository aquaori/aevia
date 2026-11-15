// Single producer and single consumer. A descriptor message accompanies each
// write so ring records stay ordered with ordinary worker messages.
export class SceneBatchRing {
	readonly buffer: SharedArrayBuffer;
	private readonly positions: Int32Array;
	private readonly bytes: Uint8Array;

	constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer;
		this.positions = new Int32Array(buffer, 0, 2);
		this.bytes = new Uint8Array(buffer, 8);
	}

	write(data: Uint8Array): boolean {
		const read = Atomics.load(this.positions, 0) >>> 0;
		const write = Atomics.load(this.positions, 1) >>> 0;
		if (data.length > this.bytes.length - ((write - read) >>> 0)) return false;
		const start = write % this.bytes.length;
		const first = Math.min(data.length, this.bytes.length - start);
		this.bytes.set(data.subarray(0, first), start);
		this.bytes.set(data.subarray(first), 0);
		Atomics.store(this.positions, 1, (write + data.length) | 0);
		return true;
	}

	read(length: number): Uint8Array {
		const read = Atomics.load(this.positions, 0) >>> 0;
		const write = Atomics.load(this.positions, 1) >>> 0;
		if (length > ((write - read) >>> 0)) throw new Error("Incomplete scene batch");
		const result = new Uint8Array(length);
		const start = read % this.bytes.length;
		const first = Math.min(length, this.bytes.length - start);
		result.set(this.bytes.subarray(start, start + first));
		result.set(this.bytes.subarray(0, length - first), first);
		Atomics.store(this.positions, 0, (read + length) | 0);
		return result;
	}
}
