// File role: translate collaboration protocol payloads between backend wire format and local editor state.
import type { Command } from "../utils/type";

const toFiniteNumber = (value: unknown, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

export const protocolPageToState = (pageId: unknown) => Math.max(0, toFiniteNumber(pageId, 0));

export const statePageToProtocol = (pageId: number) => Math.max(0, Math.floor(pageId));

export const normalizeLoadedPageIds = (pageIds: unknown): number[] => {
	if (!Array.isArray(pageIds)) return [];
	return Array.from(
		new Set(
			pageIds
				.map((pageId) => protocolPageToState(pageId))
				.filter((pageId) => Number.isFinite(pageId) && pageId >= 0)
		)
	).sort((left, right) => left - right);
};

export const normalizeCommandFromProtocol = <T extends Partial<Command>>(command: T): T => ({
	...command,
	pageId: protocolPageToState(command.pageId),
});

export const normalizeCommandsFromProtocol = (commands: unknown): Command[] => {
	if (!Array.isArray(commands)) return [];
	return commands.map((command) => normalizeCommandFromProtocol(command as Command));
};

export const commandToProtocol = <T extends Partial<Command>>(command: T): T => ({
	...command,
	pageId:
		typeof command.pageId === "number"
			? statePageToProtocol(command.pageId)
			: (command.pageId as T["pageId"]),
});
