// File role: command-state store for command collections, indexes, and pending remote updates.
import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { Command, FlatPoint, Point } from "../utils/type";

export const useCommandStore = defineStore("command", () => {
	const pageCommands = shallowRef<Map<number, Command[]>>(new Map());
	const loadedPageIds = ref<number[]>([]);
	const commandMap = new Map<string, Command>();
	const pendingUpdates = ref<Map<string, Point[]>>(new Map());
	const currentCommandIndex = ref(-1);
	const lastSortedPoints = ref<FlatPoint[]>([]);
	const pendingRenderCallbacks = new Map<string, (points: FlatPoint[]) => void>();
	const commands = computed<Command[]>(() => {
		const merged = Array.from(pageCommands.value.values()).flat();
		merged.sort((left, right) => {
			if (left.lamport !== right.lamport) {
				return left.lamport - right.lamport;
			}
			return left.id.toLocaleLowerCase().localeCompare(right.id.toLocaleLowerCase());
		});
		return merged;
	});

	const rebuildCommandMap = () => {
		commandMap.clear();
		Array.from(pageCommands.value.values())
			.flat()
			.forEach((command) => {
			commandMap.set(command.id, command);
		});
	};

	const ensurePageBucket = (pageId: number) => {
		const bucket = pageCommands.value.get(pageId);
		if (bucket) return bucket;
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

		const bucket = [...ensurePageBucket(cmd.pageId)];
		if (bucket.length === 0 || resolveConflict(cmd, bucket[bucket.length - 1] ?? cmd) === cmd) {
			let left = 0;
			let right = bucket.length - 1;

			while (left <= right) {
				const mid = left + ((right - left) >> 1);
				const current = bucket[mid];

				if (resolveConflict(cmd, current!) === cmd) {
					right = mid - 1;
				} else {
					left = mid + 1;
				}
			}

			if (left === bucket.length) {
				bucket.push(cmd);
			} else {
				bucket.splice(left, 0, cmd);
			}
		} else {
			bucket.push(cmd);
		}

		const nextBuckets = new Map(pageCommands.value);
		nextBuckets.set(cmd.pageId, bucket);
		pageCommands.value = nextBuckets;
		commandMap.set(cmd.id, cmd);
	};

	const resolveConflict = (cmd1: Command, cmd2: Command) => {
		if (cmd1.lamport < cmd2.lamport) {
			return cmd1;
		}
		if (cmd1.lamport > cmd2.lamport) {
			return cmd2;
		}
		return cmd1.id.toLocaleLowerCase() < cmd2.id.toLocaleLowerCase() ? cmd1 : cmd2;
	};

	const updateLastSortedPoints = (points: FlatPoint[]) => {
		lastSortedPoints.value = points;
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
			if (command.points) {
				command.points = markRaw(command.points);
			}
			if (!nextBuckets.has(command.pageId)) {
				nextBuckets.set(command.pageId, []);
			}
			nextBuckets.get(command.pageId)?.push(command);
		});

		nextBuckets.forEach((bucket) => {
			bucket.sort((left, right) => {
				if (left.lamport !== right.lamport) {
					return left.lamport - right.lamport;
				}
				return left.id.toLocaleLowerCase().localeCompare(right.id.toLocaleLowerCase());
			});
		});

		pageCommands.value = nextBuckets;
		loadedPageIds.value = normalizedPageIds;
		rebuildCommandMap();
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
			if (command.points) {
				command.points = markRaw(command.points);
			}
			const bucket = nextBuckets.get(command.pageId) ?? [];
			bucket.push(command);
			nextBuckets.set(command.pageId, bucket);
		});

		nextBuckets.forEach((bucket) => {
			bucket.sort((left, right) => {
				if (left.lamport !== right.lamport) {
					return left.lamport - right.lamport;
				}
				return left.id.toLocaleLowerCase().localeCompare(right.id.toLocaleLowerCase());
			});
		});

		pageCommands.value = nextBuckets;
		loadedPageIds.value = Array.from(new Set(input.loadedPageIds)).sort((left, right) => left - right);
		rebuildCommandMap();
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
		nextBuckets.set(clearCmd.pageId, bucket.filter((_, index) => index > clearCmdIndex));
		pageCommands.value = nextBuckets;
		rebuildCommandMap();

		return true;
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
		pruneDeletedCommandsAfterPointer,
	};
});
