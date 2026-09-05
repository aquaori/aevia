// File role: command-state store for command collections, indexes, and pending remote updates.
import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { Command, FlatPoint, Point } from "@collaborative-whiteboard/shared";
import { compareCommandOrder } from "@collaborative-whiteboard/shared";

/**
 * Merges per-page buckets that are each already in canonical order into one
 * sorted array, without re-sorting. O(total x buckets) with a tiny bucket count
 * (the loaded page window), versus O(n log n) plus per-comparison string
 * allocation for a full re-sort.
 */
const mergeSortedBuckets = (buckets: Command[][]): Command[] => {
	const nonEmpty = buckets.filter((bucket) => bucket.length > 0);
	if (nonEmpty.length === 0) return [];
	if (nonEmpty.length === 1) return nonEmpty[0]!.slice();

	let total = 0;
	for (const bucket of nonEmpty) total += bucket.length;

	const merged: Command[] = new Array(total);
	const cursors = new Array(nonEmpty.length).fill(0);

	for (let index = 0; index < total; index += 1) {
		let pick = -1;
		let pickCommand: Command | null = null;
		for (let bucketIndex = 0; bucketIndex < nonEmpty.length; bucketIndex += 1) {
			const cursor = cursors[bucketIndex]!;
			const bucket = nonEmpty[bucketIndex]!;
			if (cursor >= bucket.length) continue;
			const candidate = bucket[cursor]!;
			if (pickCommand === null || compareCommandOrder(candidate, pickCommand) < 0) {
				pick = bucketIndex;
				pickCommand = candidate;
			}
		}
		merged[index] = pickCommand!;
		cursors[pick] += 1;
	}

	return merged;
};

export const useCommandStore = defineStore("command", () => {
	const pageCommands = shallowRef<Map<number, Command[]>>(new Map());
	const loadedPageIds = ref<number[]>([]);
	const commandMap = new Map<string, Command>();
	const pendingUpdates = ref<Map<string, Point[]>>(new Map());
	const currentCommandIndex = ref(-1);
	const lastSortedPoints = shallowRef<FlatPoint[]>([]);
	const pendingRenderCallbacks = new Map<string, (points: FlatPoint[]) => void>();

	// `commands` is read on every stroke start and by toolbar computeds, and each
	// read used to re-sort every command in the loaded page window. Per-bucket
	// order is already maintained on insert, so the merged view only needs a
	// k-way merge of sorted buckets, and only when a bucket actually changed.
	// A revision counter drives invalidation so in-place bucket mutation stays
	// observable without cloning the bucket array on every insert.
	const revision = ref(0);
	let mergedCache: Command[] = [];
	let mergedRevision = -1;

	const touch = () => {
		revision.value += 1;
	};

	const commands = computed<Command[]>(() => {
		// Depend on revision so Vue invalidates when buckets mutate in place.
		const currentRevision = revision.value;
		if (mergedRevision === currentRevision) {
			return mergedCache;
		}
		mergedCache = mergeSortedBuckets(Array.from(pageCommands.value.values()));
		mergedRevision = currentRevision;
		return mergedCache;
	});

	const rebuildCommandMap = () => {
		commandMap.clear();
		pageCommands.value.forEach((bucket) => {
			bucket.forEach((command) => {
				commandMap.set(command.id, command);
			});
		});
	};

	const foldBucketAfterClear = (bucket: Command[]) => {
		if (bucket.length === 0) return bucket;
		let lastClearIndex = -1;
		for (let index = bucket.length - 1; index >= 0; index -= 1) {
			if (bucket[index]?.type === "clear") {
				lastClearIndex = index;
				break;
			}
		}
		return lastClearIndex >= 0 ? bucket.slice(lastClearIndex) : bucket;
	};

	const sortAndFoldBucket = (bucket: Command[]) => {
		bucket.sort(compareCommandOrder);
		return foldBucketAfterClear(bucket);
	};

	const ensurePageBucket = (pageId: number) => {
		const existing = pageCommands.value.get(pageId);
		if (existing) return existing;
		const nextBuckets = new Map(pageCommands.value);
		const nextBucket: Command[] = [];
		nextBuckets.set(pageId, nextBucket);
		pageCommands.value = nextBuckets;
		return nextBucket;
	};

	const insertCommand = (cmd: Command) => {
		if (cmd.points) {
			cmd.points = markRaw(cmd.points);
		}
		if (commandMap.has(cmd.id)) {
			return;
		}

		if (loadedPageIds.value.length > 0 && !loadedPageIds.value.includes(cmd.pageId)) {
			return;
		}

		// Insert in place. This used to clone the whole bucket and the page Map on
		// every insert, so hydrating a page of N commands was O(N^2) and the
		// binary search below bought nothing.
		const bucket = ensurePageBucket(cmd.pageId);
		const insertAt = lowerBound(bucket, cmd);
		if (insertAt === bucket.length) {
			bucket.push(cmd);
		} else {
			bucket.splice(insertAt, 0, cmd);
		}

		commandMap.set(cmd.id, cmd);
		touch();
	};

	// lowerBound returns the first index whose command sorts at or after cmd.
	const lowerBound = (bucket: Command[], cmd: Command) => {
		let low = 0;
		let high = bucket.length;
		while (low < high) {
			const mid = low + ((high - low) >> 1);
			if (compareCommandOrder(bucket[mid]!, cmd) < 0) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}
		return low;
	};

	const stripCommandPoints = (command: Command) => {
		if (command.points) {
			command.points = undefined;
		}
		return command;
	};

	// Returns whichever command sorts first. Delegates to the shared comparator so
	// it cannot drift from bucket ordering: these were previously two different
	// comparisons (`localeCompare` when sorting, `<` on lowercased ids here), so
	// insertion position and sort order could disagree.
	const resolveConflict = (cmd1: Command, cmd2: Command) =>
		compareCommandOrder(cmd1, cmd2) <= 0 ? cmd1 : cmd2;

	const updateLastSortedPoints = (points: FlatPoint[]) => {
		lastSortedPoints.value = markRaw(points);
	};

	const setCurrentCommandIndex = (index: number) => {
		currentCommandIndex.value = index;
	};

	const replaceLoadedPageWindow = (nextLoadedPageIds: number[], nextCommands: Command[]) => {
		const normalizedPageIds = Array.from(new Set(nextLoadedPageIds)).sort((left, right) => left - right);
		const nextBuckets = new Map<number, Command[]>();
		normalizedPageIds.forEach((pageId) => {
			nextBuckets.set(pageId, []);
		});

		nextCommands.forEach((command) => {
			stripCommandPoints(command);
			if (!nextBuckets.has(command.pageId)) {
				nextBuckets.set(command.pageId, []);
			}
			nextBuckets.get(command.pageId)?.push(command);
		});

		nextBuckets.forEach((bucket, pageId) => {
			nextBuckets.set(pageId, sortAndFoldBucket(bucket));
		});

		pageCommands.value = nextBuckets;
		loadedPageIds.value = normalizedPageIds;
		rebuildCommandMap();
		touch();
	};

	const applyLoadedPageDelta = (input: {
		loadedPageIds: number[];
		loadPageIds: number[];
		unloadPageIds: number[];
		commands: Command[];
	}) => {
		const nextBuckets = new Map(pageCommands.value);

		input.unloadPageIds.forEach((pageId) => {
			nextBuckets.delete(pageId);
		});

		input.loadPageIds.forEach((pageId) => {
			if (!nextBuckets.has(pageId)) {
				nextBuckets.set(pageId, []);
			}
		});

		input.commands.forEach((command) => {
			stripCommandPoints(command);
			const bucket = nextBuckets.get(command.pageId) ?? [];
			bucket.push(command);
			nextBuckets.set(command.pageId, bucket);
		});

		nextBuckets.forEach((bucket, pageId) => {
			nextBuckets.set(pageId, sortAndFoldBucket(bucket));
		});

		pageCommands.value = nextBuckets;
		loadedPageIds.value = Array.from(new Set(input.loadedPageIds)).sort((left, right) => left - right);
		rebuildCommandMap();
		touch();
	};

	const clearClearedCommands = (clearCmd: Command) => {
		const bucket = pageCommands.value.get(clearCmd.pageId);
		if (!bucket) {
			return false;
		}

		const clearCmdIndex = bucket.findIndex((command) => command.id === clearCmd.id);
		if (clearCmdIndex === -1) {
			return false;
		}

		const nextBuckets = new Map(pageCommands.value);
		nextBuckets.set(clearCmd.pageId, bucket.slice(clearCmdIndex));
		pageCommands.value = nextBuckets;
		rebuildCommandMap();
		touch();

		return true;
	};

	const removeCommand = (cmdId: string) => {
		if (!commandMap.has(cmdId)) {
			return null;
		}

		let removedCommand: Command | null = null;
		let mutated = false;
		const nextBuckets = new Map<number, Command[]>();

		pageCommands.value.forEach((bucket, pageId) => {
			const nextBucket = bucket.filter((command) => {
				const shouldKeep = command.id !== cmdId;
				if (!shouldKeep && !removedCommand) {
					removedCommand = command;
				}
				if (!shouldKeep) {
					mutated = true;
				}
				return shouldKeep;
			});

			if (nextBucket.length > 0) {
				nextBuckets.set(pageId, nextBucket);
			} else if (loadedPageIds.value.includes(pageId)) {
				nextBuckets.set(pageId, []);
			}
		});

		if (!mutated) {
			return null;
		}

		pageCommands.value = nextBuckets;
		pendingUpdates.value.delete(cmdId);
		rebuildCommandMap();
		touch();
		currentCommandIndex.value = commands.value.length - 1;
		return removedCommand;
	};

	const pruneDeletedCommandsAfterPointer = (userId: string, pageId: number, pointer: number) => {
		if (pointer < 0) {
			return [];
		}

		const removedCommandIds: string[] = [];
		const nextBuckets = new Map(pageCommands.value);
		let mutated = false;

		nextBuckets.forEach((bucket, bucketPageId) => {
			const nextBucket = bucket.filter((command, index) => {
				const shouldRemove =
					index >= pointer &&
					command.userId === userId &&
					command.pageId === pageId &&
					command.isDeleted;
				if (shouldRemove) {
					removedCommandIds.push(command.id);
					mutated = true;
				}
				return !shouldRemove;
			});

			if (nextBucket.length !== bucket.length) {
				nextBuckets.set(bucketPageId, nextBucket);
			}
		});

		if (mutated) {
			pageCommands.value = nextBuckets;
			rebuildCommandMap();
			touch();
		}

		return removedCommandIds;
	};

	return {
		commands,
		pageCommands,
		loadedPageIds,
		commandMap,
		pendingUpdates,
		currentCommandIndex,
		lastSortedPoints,
		pendingRenderCallbacks,
		insertCommand,
		updateLastSortedPoints,
		setCurrentCommandIndex,
		resolveConflict,
		replaceLoadedPageWindow,
		applyLoadedPageDelta,
		clearClearedCommands,
		removeCommand,
		pruneDeletedCommandsAfterPointer,
	};
});
