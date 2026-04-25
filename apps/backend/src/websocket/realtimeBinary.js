const MAGIC = 0x43574252;
const VERSION = 1;
const HEADER_SIZE = 6;
const POINT_RECORD_SIZE = 20;

const FRAME_TYPES = {
  MOUSE_MOVE_CLIENT: 1,
  MOUSE_MOVE_SERVER: 2,
  CMD_UPDATE: 3,
};

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

const toBuffer = (payload) => {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
};

const binaryPayloadToUtf8 = (payload) => {
  const buffer = toBuffer(payload);
  return buffer ? buffer.toString("utf8") : null;
};

const hasRealtimeBinaryMagic = (payload) => {
  const buffer = toBuffer(payload);
  if (!buffer || buffer.length < HEADER_SIZE) return false;
  return buffer.readUInt32BE(0) === MAGIC;
};

const encodeHeader = (buffer, frameType) => {
  buffer.writeUInt32BE(MAGIC, 0);
  buffer.writeUInt8(VERSION, 4);
  buffer.writeUInt8(frameType, 5);
};

const encodeMouseMoveClientBinary = ({ pageId, x, y }) => {
  const buffer = Buffer.allocUnsafe(HEADER_SIZE + 12);
  encodeHeader(buffer, FRAME_TYPES.MOUSE_MOVE_CLIENT);
  let offset = HEADER_SIZE;
  buffer.writeUInt32BE(pageId >>> 0, offset);
  offset += 4;
  buffer.writeFloatBE(x ?? 0, offset);
  offset += 4;
  buffer.writeFloatBE(y ?? 0, offset);
  return buffer;
};

const encodeMouseMoveServerBinary = ({ userId, userName, pageId, x, y }) => {
  const userIdBuffer = Buffer.from(userId || "", "utf8");
  const userNameBuffer = Buffer.from(userName || "", "utf8");
  const buffer = Buffer.allocUnsafe(
    HEADER_SIZE + 1 + userIdBuffer.length + 1 + userNameBuffer.length + 12,
  );
  encodeHeader(buffer, FRAME_TYPES.MOUSE_MOVE_SERVER);
  let offset = HEADER_SIZE;
  buffer.writeUInt8(userIdBuffer.length, offset);
  offset += 1;
  userIdBuffer.copy(buffer, offset);
  offset += userIdBuffer.length;
  buffer.writeUInt8(userNameBuffer.length, offset);
  offset += 1;
  userNameBuffer.copy(buffer, offset);
  offset += userNameBuffer.length;
  buffer.writeUInt32BE(pageId >>> 0, offset);
  offset += 4;
  buffer.writeFloatBE(x ?? 0, offset);
  offset += 4;
  buffer.writeFloatBE(y ?? 0, offset);
  return buffer;
};

const encodeCmdUpdateBinary = ({ cmdId, points }) => {
  const cmdIdBuffer = Buffer.from(cmdId || "", "utf8");
  const safePoints = Array.isArray(points) ? points : [];
  const buffer = Buffer.allocUnsafe(
    HEADER_SIZE + 1 + cmdIdBuffer.length + 2 + safePoints.length * POINT_RECORD_SIZE,
  );
  encodeHeader(buffer, FRAME_TYPES.CMD_UPDATE);
  let offset = HEADER_SIZE;
  buffer.writeUInt8(cmdIdBuffer.length, offset);
  offset += 1;
  cmdIdBuffer.copy(buffer, offset);
  offset += cmdIdBuffer.length;
  buffer.writeUInt16BE(safePoints.length, offset);
  offset += 2;

  safePoints.forEach((point) => {
    buffer.writeFloatBE(point?.x ?? 0, offset);
    offset += 4;
    buffer.writeFloatBE(point?.y ?? 0, offset);
    offset += 4;
    buffer.writeFloatBE(point?.p ?? 0, offset);
    offset += 4;
    buffer.writeDoubleBE(point?.lamport ?? 0, offset);
    offset += 8;
  });

  return buffer;
};

const decodeMouseMoveClientBinary = (buffer) => {
  if (buffer.length < HEADER_SIZE + 12) {
    throw new Error("mouseMove binary frame is truncated.");
  }

  let offset = HEADER_SIZE;
  const pageId = buffer.readUInt32BE(offset);
  offset += 4;
  const x = buffer.readFloatBE(offset);
  offset += 4;
  const y = buffer.readFloatBE(offset);

  return {
    type: "mouseMove",
    data: {
      pageId,
      x,
      y,
      __binary: true,
    },
  };
};

const decodeCmdUpdateBinary = (buffer) => {
  let offset = HEADER_SIZE;
  if (buffer.length < offset + 3) {
    throw new Error("cmd-update binary frame is truncated.");
  }

  const cmdIdLength = buffer.readUInt8(offset);
  offset += 1;
  if (buffer.length < offset + cmdIdLength + 2) {
    throw new Error("cmd-update binary frame cmdId section is truncated.");
  }

  const cmdId = buffer.toString("utf8", offset, offset + cmdIdLength);
  offset += cmdIdLength;
  const pointCount = buffer.readUInt16BE(offset);
  offset += 2;

  const expectedLength = offset + pointCount * POINT_RECORD_SIZE;
  if (buffer.length !== expectedLength) {
    throw new Error("cmd-update binary frame point section length mismatch.");
  }

  const points = [];
  for (let index = 0; index < pointCount; index += 1) {
    const x = buffer.readFloatBE(offset);
    offset += 4;
    const y = buffer.readFloatBE(offset);
    offset += 4;
    const p = buffer.readFloatBE(offset);
    offset += 4;
    const lamport = buffer.readDoubleBE(offset);
    offset += 8;
    points.push({ x, y, p, lamport });
  }

  return {
    type: "cmd-update",
    data: {
      cmdId,
      points,
      __binary: true,
    },
  };
};

const decodeRealtimeBinaryMessage = (payload) => {
  const buffer = toBuffer(payload);
  if (!buffer || buffer.length < HEADER_SIZE) {
    throw new Error("binary frame is truncated.");
  }

  const magic = buffer.readUInt32BE(0);
  if (magic !== MAGIC) {
    throw new Error("binary frame magic mismatch.");
  }

  const version = buffer.readUInt8(4);
  if (version !== VERSION) {
    throw new Error(`unsupported binary frame version: ${version}`);
  }

  const frameType = buffer.readUInt8(5);
  if (frameType === FRAME_TYPES.MOUSE_MOVE_CLIENT) {
    return decodeMouseMoveClientBinary(buffer);
  }

  if (frameType === FRAME_TYPES.CMD_UPDATE) {
    return decodeCmdUpdateBinary(buffer);
  }

  throw new Error(`unsupported binary frame type: ${frameType}`);
};

module.exports = {
  FRAME_TYPES,
  HEADER_SIZE,
  hasRealtimeBinaryMagic,
  encodeMouseMoveClientBinary,
  encodeMouseMoveServerBinary,
  encodeCmdUpdateBinary,
  decodeRealtimeBinaryMessage,
  isNonEmptyString,
  binaryPayloadToUtf8,
};
