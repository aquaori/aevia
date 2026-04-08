// File role: command-state store for command collections, indexes, and pending remote updates.
import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { Command, FlatPoint, Point } from "../utils/type";

export const useCommandStore = defineStore("command", () => {
	const commands = shallowRef<Command[]>([]);
	const commandMap = new Map<string, Command>();
	const pendingUpdates = ref<Map<string, Point[]>>(new Map());
	const currentCommandIndex = ref(-1);
	const lastSortedPoints = ref<FlatPoint[]>([]);
	const pendingRenderCallbacks = new Map<string, (points: FlatPoint[]) => void>();

	const insertCommand = (cmd: Command) => {
		const cmds = commands.value;

		if (cmd.points) {
			cmd.points = markRaw(cmd.points);
		}

		if (commandMap.has(cmd.id)) {
			return;
		}

		commandMap.set(cmd.id, cmd);

		if (resolveConflict(cmd, cmds[cmds.length - 1] ?? cmd) === cmd) {
			let left = 0;
			let right = cmds.length - 1;

			while (left <= right) {
				const mid = left + ((right - left) >> 1);
				const current = cmds[mid];

				if (resolveConflict(cmd, current!) === cmd) {
					right = mid - 1;
				} else {
					left = mid + 1;
				}
			}

			if (left === cmds.length) {
				commands.value.push(cmd);
			} else {
				commands.value.splice(left, 0, cmd);
			}
			return;
		}

		commands.value.push(cmd);
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

	const clearClearedCommands = (clearCmd: Command) => {
		const clearCmdIndex = commands.value.findIndex((command) => command.id === clearCmd.id);
		if (clearCmdIndex === -1) {
			return false;
		}

		const toRemove = commands.value.slice(0, clearCmdIndex + 1);
		toRemove.forEach((command) => {
			if (command.pageId === clearCmd.pageId) {
				commandMap.delete(command.id);
			}
		});

		commands.value = commands.value.filter((command, index) => {
			return index > clearCmdIndex || command.pageId !== clearCmd.pageId;
		});

		return true;
	};

	return {
		commands,
		commandMap,
		pendingUpdates,
		currentCommandIndex,
		lastSortedPoints,
		pendingRenderCallbacks,
		insertCommand,
		updateLastSortedPoints,
		setCurrentCommandIndex,
		resolveConflict,
		clearClearedCommands,
	};
});

