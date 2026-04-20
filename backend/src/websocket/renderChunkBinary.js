const buildRenderChunkDictionary = (flatPoints) => {
  const commandMap = new Map();
  const commands = [];

  flatPoints.forEach((point) => {
    if (!commandMap.has(point.cmdId)) {
      const cmdIndex = commands.length;
      commandMap.set(point.cmdId, cmdIndex);
      commands.push({
        cmdIndex,
        cmdId: point.cmdId,
        userId: point.userId,
        tool: point.tool,
        color: point.color,
        size: point.size,
        isDeleted: point.isDeleted,
      });
    }
  });

  return {
    commandMap,
    commands,
  };
};

const encodeRenderChunkBinary = (
  flatPoints,
  commandMap,
  snapshotVersion,
  chunkIndex,
) => {
  const MAGIC = 0x49524348;
  const VERSION = 1;
  const HEADER_SIZE = 20;
  const RECORD_SIZE = 22;
  const buffer = Buffer.allocUnsafe(HEADER_SIZE + flatPoints.length * RECORD_SIZE);

  let offset = 0;
  buffer.writeUInt32BE(MAGIC, offset);
  offset += 4;
  buffer.writeUInt16BE(VERSION, offset);
  offset += 2;
  buffer.writeUInt16BE(RECORD_SIZE, offset);
  offset += 2;
  buffer.writeUInt32BE(snapshotVersion >>> 0, offset);
  offset += 4;
  buffer.writeUInt32BE(chunkIndex >>> 0, offset);
  offset += 4;
  buffer.writeUInt32BE(flatPoints.length >>> 0, offset);
  offset += 4;

  flatPoints.forEach((point) => {
    buffer.writeFloatBE(point.x ?? 0, offset);
    offset += 4;
    buffer.writeFloatBE(point.y ?? 0, offset);
    offset += 4;
    buffer.writeFloatBE(point.p ?? 0, offset);
    offset += 4;
    buffer.writeDoubleBE(point.lamport ?? 0, offset);
    offset += 8;
    buffer.writeUInt16BE(commandMap.get(point.cmdId) ?? 0, offset);
    offset += 2;
  });

  return buffer;
};

module.exports = {
  buildRenderChunkDictionary,
  encodeRenderChunkBinary,
};
