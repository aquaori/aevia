import { expect, it } from "vitest";
import { SceneBatchRing } from "../workers/sceneBatchRing";

it("preserves records across wraparound and falls back when full", () => {
	const ring = new SceneBatchRing(new SharedArrayBuffer(16));
	expect(ring.write(Uint8Array.from([1, 2, 3, 4, 5, 6]))).toBe(true);
	expect(ring.write(Uint8Array.from([7, 8, 9]))).toBe(false);
	expect(Array.from(ring.read(6))).toEqual([1, 2, 3, 4, 5, 6]);
	expect(ring.write(Uint8Array.from([7, 8, 9, 10]))).toBe(true);
	expect(Array.from(ring.read(4))).toEqual([7, 8, 9, 10]);
});

it("reads wrapped batches into a reusable ordinary buffer", () => {
	const ring = new SceneBatchRing(new SharedArrayBuffer(16));
	const scratch = new Uint8Array(8);
	const decoder = new TextDecoder();
	expect(ring.write(new TextEncoder().encode("123456"))).toBe(true);
	expect(decoder.decode(ring.read(6, scratch))).toBe("123456");
	expect(ring.write(new TextEncoder().encode("中A"))).toBe(true);
	const result = ring.read(4, scratch);
	expect(result.buffer).toBe(scratch.buffer);
	expect(decoder.decode(result)).toBe("中A");
});

it("publishes direct UTF-8 writes only when the whole record fits", () => {
	const ring = new SceneBatchRing(new SharedArrayBuffer(40));
	const encoder = new TextEncoder();
	const length = ring.writeText("中🙂", encoder);
	expect(length).toBe(7);
	expect(new TextDecoder().decode(ring.read(length!))).toBe("中🙂");
	expect(ring.writeText("x".repeat(20), encoder)).toBeNull();
	expect(ring.write(encoder.encode("ok"))).toBe(true);
	expect(new TextDecoder().decode(ring.read(2))).toBe("ok");
});

it("retains a wrapped record if direct decoding is unsupported", () => {
	const ring = new SceneBatchRing(new SharedArrayBuffer(16));
	const encoder = new TextEncoder();
	expect(ring.write(encoder.encode("123456"))).toBe(true);
	ring.read(6);
	expect(ring.write(encoder.encode("中A"))).toBe(true);
	const unsupported = { decode: () => { throw new TypeError("shared view unsupported"); } } as unknown as TextDecoder;
	expect(() => ring.readText(4, unsupported)).toThrow();
	expect(new TextDecoder().decode(ring.read(4))).toBe("中A");
	expect(ring.write(encoder.encode("中A"))).toBe(true);
	expect(ring.readText(4, new TextDecoder())).toBe("中A");
});

it("falls back without publishing bytes when shared encoding is unsupported", () => {
	const ring = new SceneBatchRing(new SharedArrayBuffer(40));
	const unsupported = { encodeInto: () => { throw new TypeError("shared view unsupported"); } } as unknown as TextEncoder;
	expect(ring.writeText("abc", unsupported)).toBeNull();
	expect(ring.write(new TextEncoder().encode("abc"))).toBe(true);
	expect(new TextDecoder().decode(ring.read(3))).toBe("abc");
});
