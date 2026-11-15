// File role: framed little-endian transport for Render IR frames and deltas.
import type { RenderIRDelta, RenderIRFrame } from "./renderIR";

const MAGIC = 0x52495641; // AVIR
const VERSION = 1;
const HEADER_BYTES = 16;

const checksum = (bytes: Uint8Array) => {
	let hash = 2166136261;
	for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
	return hash >>> 0;
};

const validItem = (item: unknown) => {
	if (!item || typeof item !== "object") return false;
	const value = item as Record<string, unknown>;
	const atom = value.atom as Record<string, unknown> | null;
	const handle = value.handle as Record<string, unknown> | null;
	return typeof value.id === "string" && !!atom && typeof atom.atomId === "string" && typeof atom.elementId === "string" &&
		["dot", "quadratic", "shape", "glyph", "bitmap"].includes(String(atom.primitive)) && !!atom.bounds &&
		!!handle && handle.id === value.id && Number.isSafeInteger(handle.generation) && typeof handle.epoch === "string" &&
		Array.isArray(value.matrix) && value.matrix.length === 6 && value.matrix.every(Number.isFinite) &&
		Array.isArray(value.erasedIntervals) && Array.isArray(value.eraseMasks);
};

export function encodeRenderIR(value: RenderIRFrame | RenderIRDelta): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(value));
	const bytes = new Uint8Array(HEADER_BYTES + body.length);
	const header = new DataView(bytes.buffer);
	header.setUint32(0, MAGIC, true);
	header.setUint16(4, VERSION, true);
	header.setUint8(6, "baseRevision" in value ? 2 : 1);
	header.setUint32(8, body.length, true);
	header.setUint32(12, checksum(body), true);
	bytes.set(body, HEADER_BYTES);
	return bytes;
}

export function decodeRenderIR(bytes: Uint8Array): RenderIRFrame | RenderIRDelta {
	if (bytes.byteLength < HEADER_BYTES) throw new Error("Truncated Render IR header");
	const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const kind = header.getUint8(6);
	if (header.getUint32(0, true) !== MAGIC || header.getUint16(4, true) !== VERSION || (kind !== 1 && kind !== 2)) throw new Error("Unsupported Render IR frame");
	if (header.getUint32(8, true) !== bytes.byteLength - HEADER_BYTES) throw new Error("Invalid Render IR length");
	const body = bytes.subarray(HEADER_BYTES);
	if (header.getUint32(12, true) !== checksum(body)) throw new Error("Corrupt Render IR frame");
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	if (!value || typeof value !== "object") throw new Error("Invalid Render IR payload");
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !Number.isSafeInteger(record.revision) || (kind === 1 ? !Array.isArray(record.items) : !Number.isSafeInteger(record.baseRevision) || !Array.isArray(record.upserted) || !Array.isArray(record.removed) || !Array.isArray(record.order) || !Array.isArray(record.dirtyBounds))) throw new Error("Invalid Render IR payload");
	const items = (kind === 1 ? record.items : record.upserted) as unknown[];
	if (!items.every(validItem)) throw new Error("Invalid Render IR item");
	return value as RenderIRFrame | RenderIRDelta;
}
