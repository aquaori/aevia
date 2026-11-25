// Single producer and single consumer. A descriptor message accompanies each
// write so ring records stay ordered with ordinary worker messages.
export class SceneBatchRing {
	readonly buffer: SharedArrayBuffer;
	private readonly positions: Int32Array;
	private readonly bytes: Uint8Array;
	private canEncodeShared = true;

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

	// Encode directly only when the contiguous free region can hold the UTF-8
	// worst case. The caller can use the ordinary byte path for wrapped records.
	writeText(text: string, encoder: TextEncoder): number | null {
		if (!this.canEncodeShared) return null;
		const read = Atomics.load(this.positions, 0) >>> 0;
		const write = Atomics.load(this.positions, 1) >>> 0;
		const start = write % this.bytes.length;
		const free = this.bytes.length - ((write - read) >>> 0);
		const contiguous = Math.min(free, this.bytes.length - start);
		if (text.length * 3 > contiguous) return null;
		try {
			const result = encoder.encodeInto(text, this.bytes.subarray(start, start + contiguous));
			if (result.read !== text.length) return null;
			Atomics.store(this.positions, 1, (write + result.written) | 0);
			return result.written;
		} catch {
			this.canEncodeShared = false;
			return null;
		}
	}

	readText(length: number, decoder: TextDecoder): string {
		const read = Atomics.load(this.positions, 0) >>> 0;
		const write = Atomics.load(this.positions, 1) >>> 0;
		if (length > ((write - read) >>> 0)) throw new Error("Incomplete scene batch");
		const start = read % this.bytes.length;
		const first = Math.min(length, this.bytes.length - start);
		const text = first === length
			? decoder.decode(this.bytes.subarray(start, start + first))
			: decoder.decode(this.bytes.subarray(start, start + first), { stream: true }) + decoder.decode(this.bytes.subarray(0, length - first));
		Atomics.store(this.positions, 0, (read + length) | 0);
		return text;
	}

	read(length: number, target = new Uint8Array(length)): Uint8Array {
		const read = Atomics.load(this.positions, 0) >>> 0;
		const write = Atomics.load(this.positions, 1) >>> 0;
		if (length > ((write - read) >>> 0)) throw new Error("Incomplete scene batch");
		if (target.length < length) throw new Error("Scene batch buffer is too small");
		const result = target.subarray(0, length);
		const start = read % this.bytes.length;
		const first = Math.min(length, this.bytes.length - start);
		result.set(this.bytes.subarray(start, start + first));
		result.set(this.bytes.subarray(0, length - first), first);
		Atomics.store(this.positions, 0, (read + length) | 0);
		return result;
	}
}
