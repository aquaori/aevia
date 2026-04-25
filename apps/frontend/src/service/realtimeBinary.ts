import type { Point } from "@collaborative-whiteboard/shared";
import type { CollabIncomingMessage } from "./collabDispatcherTypes";

const MAGIC = 0x43574252;
const VERSION = 1;
const HEADER_SIZE = 6;
const POINT_RECORD_SIZE = 20;

const FRAME_TYPES = {
	MOUSE_MOVE_CLIENT: 1,
	MOUSE_MOVE_SERVER: 2,
	CMD_UPDATE: 3,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const writeUtf8 = (view: Uint8Array, offset: number, value: string) => {
	const bytes = encoder.encode(value);
	view.set(bytes, offset);
	return bytes.length;
};

const readUtf8 = (view: Uint8Array, offset: number, length: number) =>
	decoder.decode(view.subarray(offset, offset + length));

export const hasRealtimeBinaryMagic = (payload: ArrayBuffer) => {
	if (payload.byteLength < HEADER_SIZE) return false;
	const view = new DataView(payload);
	return view.getUint32(0, false) === MAGIC;
};

export const encodeMouseMoveBinary = (input: { pageId: number; x: number; y: number }) => {
	const buffer = new ArrayBuffer(HEADER_SIZE + 12);
	const view = new DataView(buffer);
	view.setUint32(0, MAGIC, false);
	view.setUint8(4, VERSION);
	view.setUint8(5, FRAME_TYPES.MOUSE_MOVE_CLIENT);
	view.setUint32(HEADER_SIZE, input.pageId >>> 0, false);
	view.setFloat32(HEADER_SIZE + 4, input.x ?? 0, false);
	view.setFloat32(HEADER_SIZE + 8, input.y ?? 0, false);
	return buffer;
};

export const encodeCmdUpdateBinary = (input: { cmdId: string; points: Point[] }) => {
	const cmdIdBytes = encoder.encode(input.cmdId || "");
	const points = Array.isArray(input.points) ? input.points : [];
	const buffer = new ArrayBuffer(
		HEADER_SIZE + 1 + cmdIdBytes.length + 2 + points.length * POINT_RECORD_SIZE
	);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	view.setUint32(0, MAGIC, false);
	view.setUint8(4, VERSION);
	view.setUint8(5, FRAME_TYPES.CMD_UPDATE);
	let offset = HEADER_SIZE;
	view.setUint8(offset, cmdIdBytes.length);
	offset += 1;
	bytes.set(cmdIdBytes, offset);
	offset += cmdIdBytes.length;
	view.setUint16(offset, points.length, false);
	offset += 2;

	points.forEach((point) => {
		view.setFloat32(offset, point?.x ?? 0, false);
		offset += 4;
		view.setFloat32(offset, point?.y ?? 0, false);
		offset += 4;
		view.setFloat32(offset, point?.p ?? 0, false);
		offset += 4;
		view.setFloat64(offset, point?.lamport ?? 0, false);
		offset += 8;
	});

	return buffer;
};

const decodeMouseMoveServerBinary = (payload: ArrayBuffer): CollabIncomingMessage => {
	const view = new DataView(payload);
	const bytes = new Uint8Array(payload);
	let offset = HEADER_SIZE;
	const userIdLength = view.getUint8(offset);
	offset += 1;
	const userId = readUtf8(bytes, offset, userIdLength);
	offset += userIdLength;
	const userNameLength = view.getUint8(offset);
	offset += 1;
	const userName = readUtf8(bytes, offset, userNameLength);
	offset += userNameLength;
	const pageId = view.getUint32(offset, false);
	offset += 4;
	const x = view.getFloat32(offset, false);
	offset += 4;
	const y = view.getFloat32(offset, false);

	return {
		type: "mouseMove",
		data: {
			userId,
			userName,
			x,
			y,
			pageId,
		},
	};
};

const decodeCmdUpdateBinary = (payload: ArrayBuffer): CollabIncomingMessage => {
	const view = new DataView(payload);
	const bytes = new Uint8Array(payload);
	let offset = HEADER_SIZE;
	const cmdIdLength = view.getUint8(offset);
	offset += 1;
	const cmdId = readUtf8(bytes, offset, cmdIdLength);
	offset += cmdIdLength;
	const pointCount = view.getUint16(offset, false);
	offset += 2;

	const points: Point[] = [];
	for (let index = 0; index < pointCount; index += 1) {
		const x = view.getFloat32(offset, false);
		offset += 4;
		const y = view.getFloat32(offset, false);
		offset += 4;
		const p = view.getFloat32(offset, false);
		offset += 4;
		const lamport = view.getFloat64(offset, false);
		offset += 8;
		points.push({ x, y, p, lamport });
	}

	return {
		type: "push-cmd",
		pushType: "update",
		data: {
			cmdId,
			points,
		},
	};
};

export const decodeRealtimeBinaryMessage = (payload: ArrayBuffer): CollabIncomingMessage => {
	const view = new DataView(payload);
	if (view.byteLength < HEADER_SIZE) {
		throw new Error("binary realtime frame is truncated.");
	}

	const magic = view.getUint32(0, false);
	if (magic !== MAGIC) {
		throw new Error("binary realtime frame magic mismatch.");
	}

	const version = view.getUint8(4);
	if (version !== VERSION) {
		throw new Error(`unsupported binary realtime frame version: ${version}`);
	}

	const frameType = view.getUint8(5);
	if (frameType === FRAME_TYPES.MOUSE_MOVE_SERVER) {
		return decodeMouseMoveServerBinary(payload);
	}

	if (frameType === FRAME_TYPES.CMD_UPDATE) {
		return decodeCmdUpdateBinary(payload);
	}

	throw new Error(`unsupported binary realtime frame type: ${frameType}`);
};
