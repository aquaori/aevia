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

module.exports = {
  protocolPageToState,
  statePageToProtocol,
  normalizeLoadedPageIds,
  normalizeCommandFromProtocol,
  normalizeCommandsFromProtocol,
  commandToProtocol,
};
