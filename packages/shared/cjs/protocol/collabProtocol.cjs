const toFiniteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const protocolPageToState = (pageId) => Math.max(0, toFiniteNumber(pageId, 0));

const statePageToProtocol = (pageId) => Math.max(0, Math.floor(pageId));

const normalizeLoadedPageIds = (pageIds) => {
  if (!Array.isArray(pageIds)) return [];
  return Array.from(
    new Set(
      pageIds
        .map((pageId) => protocolPageToState(pageId))
        .filter((pageId) => Number.isFinite(pageId) && pageId >= 0),
    ),
  ).sort((left, right) => left - right);
};

const normalizeCommandFromProtocol = (command) => ({
  ...command,
  pageId: protocolPageToState(command?.pageId),
});

const normalizeCommandsFromProtocol = (commands) => {
  if (!Array.isArray(commands)) return [];
  return commands.map((command) => normalizeCommandFromProtocol(command));
};

const commandToProtocol = (command) => ({
  ...command,
  pageId:
    typeof command?.pageId === "number"
      ? statePageToProtocol(command.pageId)
      : command?.pageId,
});

// Byte-exact, locale-independent tie-break for equal Lamport timestamps. Mirrors
// compareCommandIds in ../../src/protocol/collabProtocol.ts and the Go backend's
// domain.CompareFlatPoint; all three must agree or clients diverge.
const compareCommandIds = (leftId, rightId) => {
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
};

const compareCommandOrder = (left, right) => {
  if (left.lamport !== right.lamport) {
    return left.lamport - right.lamport;
  }
  return compareCommandIds(left.id, right.id);
};

module.exports = {
  protocolPageToState,
  statePageToProtocol,
  normalizeLoadedPageIds,
  normalizeCommandFromProtocol,
  normalizeCommandsFromProtocol,
  commandToProtocol,
  compareCommandIds,
  compareCommandOrder,
};
