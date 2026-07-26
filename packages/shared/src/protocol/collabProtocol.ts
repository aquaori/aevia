// File role: shared helpers for normalizing collaboration protocol payloads across transport boundaries.
import type { Command } from "../types/collab";

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

/**
 * Total order over command ids, used to break Lamport-timestamp ties.
 *
 * Convergence depends on every participant — every client and the server —
 * deriving the same order. That requires a comparison that is byte-exact and
 * locale-independent:
 *
 * - `localeCompare` is locale-sensitive, so two clients with different locales
 *   could order the same pair differently.
 * - `toLocaleLowerCase` is also locale-sensitive (e.g. Turkish dotless i) and
 *   allocates a string per comparison, which is measurable inside a sort.
 *
 * The Go backend orders flat points with a plain byte comparison of the command
 * id (`domain.CompareFlatPoint`). Comparing raw UTF-16 code units here matches
 * that for the ASCII ids the system generates, and never varies by environment.
 *
 * Returns a negative number when `leftId` sorts first, positive when `rightId`
 * sorts first, and 0 only when the ids are identical.
 */
export const compareCommandIds = (leftId: string, rightId: string): number => {
	if (leftId === rightId) return 0;
	return leftId < rightId ? -1 : 1;
};

/**
 * Canonical command ordering: ascending Lamport timestamp, ties broken by
 * {@link compareCommandIds}. Every place that sorts or binary-inserts commands
 * must use this so insertion position and sort order cannot disagree.
 */
export const compareCommandOrder = (
	left: { lamport: number; id: string },
	right: { lamport: number; id: string }
): number => {
	if (left.lamport !== right.lamport) {
		return left.lamport - right.lamport;
	}
	return compareCommandIds(left.id, right.id);
};
