// File role: applies local command actions and coordinates local history with transport updates.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import type { Command } from "../utils/type";
import {
	recordRedoEnd,
	recordRedoStart,
	recordUndoEnd,
	recordUndoStart,
} from "./benchmarkRuntime";

type PushCommandType = "normal" | "start" | "update" | "stop";

export interface CommandActionResult {
	ok: boolean;
	error?: string;
	command?: Command;
	notice?: string;
}

interface LocalCommandServiceOptions {
	commands: Ref<Command[]>;
	currentCommandIndex: Ref<number>;
	userId: Ref<string>;
	roomId: Ref<string>;
	currentPageId: Ref<number>;
	username: Ref<string>;
	currentTool: Ref<"pen" | "eraser" | "cursor">;
	insertCommand: (cmd: Command) => void;
	clearClearedCommands: (cmd: Command) => boolean;
	renderCanvas: () => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	send: (type: string, data: unknown) => boolean;
}

export const createLocalCommandService = (options: LocalCommandServiceOptions) => {
	const pruneDeletedCommandsAfterPointer = () => {
		if (options.currentCommandIndex.value < 0) {
			return;
		}

		for (
			let index = options.commands.value.length - 1;
			index >= options.currentCommandIndex.value;
			index -= 1
		) {
			const command = options.commands.value[index];
			if (
				command &&
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				command.isDeleted
			) {
				options.send("delete-cmd", { cmdId: command.id });
				options.commands.value.splice(index, 1);
			}
		}
	};

	const pushCommand = (
		cmdPartial: Partial<Command>,
		type: PushCommandType = "normal"
	): CommandActionResult => {
		pruneDeletedCommandsAfterPointer();

		if (type === "start") {
			if (!options.commands.value.find((command) => command.id === cmdPartial.id)) {
				options.insertCommand(cmdPartial as Command);
				options.currentCommandIndex.value = options.commands.value.length - 1;
			}

			options.send("cmd-start", {
				id: cmdPartial.id,
				cmd: cmdPartial,
				lamport: useLamportStore().lamport,
			});
			return { ok: true, command: cmdPartial as Command };
		}

		if (type === "update" && cmdPartial.id && cmdPartial.points) {
			options.send("cmd-update", {
				cmdId: cmdPartial.id,
				points: cmdPartial.points,
				lamport: useLamportStore().getNextLamport(),
			});
			return { ok: true };
		}

		if (type === "stop") {
			options.send("cmd-stop", {
				cmdId: cmdPartial.id,
				cmd: cmdPartial,
				lamport: useLamportStore().lamport,
				points: cmdPartial.points || [],
				box: cmdPartial.box || null,
			});
			return { ok: true, command: cmdPartial as Command };
		}

		if (type === "normal") {
			try {
				const command = {
					id: uuidv4(),
					type: cmdPartial.type || "path",
					tool: cmdPartial.tool || "pen",
					color: cmdPartial.color || "#000000",
					size: cmdPartial.size || 3,
					points: cmdPartial.points || [],
					timestamp: Date.now(),
					userId: options.userId.value,
					roomId: options.roomId.value,
					pageId: options.currentPageId.value,
					isDeleted: false,
					...cmdPartial,
				} as Command;

				options.send("push-cmd", command);
				if (!options.commands.value.find((item) => item.id === command.id)) {
					options.insertCommand(command);
				}
				options.currentCommandIndex.value = options.commands.value.length - 1;
				options.renderCanvas();
				return { ok: true, command };
			} catch (error: any) {
				return { ok: false, error: error?.message || "Failed to create command" };
			}
		}

		return { ok: false, error: "Unsupported command type" };
	};

	const undo = (): CommandActionResult => {
		const undoStart = recordUndoStart("local");
		for (let index = options.commands.value.length - 1; index >= 0; index -= 1) {
			const command = options.commands.value[index];
			if (!command) continue;
			if (
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				!command.isDeleted
			) {
				if (command.type === "clear") {
					return { ok: false, error: "Clear commands cannot be undone" };
				}

				options.currentCommandIndex.value = index;
				options.send("undo-cmd", { cmdId: command.id });
				command.isDeleted = true;
				options.renderCanvas();
				options.setTool(options.currentTool.value);
				recordUndoEnd("local", performance.now() - undoStart);
				return { ok: true, command };
			}
		}

		recordUndoEnd("local", performance.now() - undoStart);
		return { ok: false };
	};

	const redo = (): CommandActionResult => {
		const redoStart = recordRedoStart("local");
		let lastVisibleIndex = -1;

		for (let index = options.commands.value.length - 1; index >= 0; index -= 1) {
			const command = options.commands.value[index];
			if (!command) continue;
			if (
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				!command.isDeleted
			) {
				lastVisibleIndex = index;
				break;
			}
		}

		for (let index = lastVisibleIndex + 1; index < options.commands.value.length; index += 1) {
			const command = options.commands.value[index];
			if (!command) continue;
			if (
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				command.isDeleted
			) {
				options.currentCommandIndex.value = index;
				options.send("redo-cmd", { cmdId: command.id });
				command.isDeleted = false;
				options.renderCanvas();
				options.setTool(options.currentTool.value);
				recordRedoEnd("local", performance.now() - redoStart);
				return { ok: true, command };
			}
		}

		recordRedoEnd("local", performance.now() - redoStart);
		return { ok: false };
	};

	const clearCanvas = (): CommandActionResult => {
		const clearCommand: Command = {
			id: uuidv4(),
			type: "clear",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: Array.isArray(options.roomId.value)
				? (options.roomId.value[0] ?? "")
				: options.roomId.value,
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport: useLamportStore().getNextLamport(),
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};

		options.insertCommand(clearCommand);
		options.currentCommandIndex.value = options.commands.value.length - 1;
		const userName = Array.isArray(options.username.value)
			? options.username.value[0]
			: options.username.value;

		options.send("push-cmd", {
			id: clearCommand.id,
			cmd: clearCommand,
			username: userName,
		});

		const cleared = options.clearClearedCommands(clearCommand);
		options.renderCanvas();
		options.currentCommandIndex.value =
			options.commands.value.length === 0 ? 0 : options.commands.value.length - 1;

		return {
			ok: true,
			command: clearCommand,
			notice: cleared ? `${userName} cleared page ${clearCommand.pageId + 1}` : undefined,
		};
	};

	return {
		pushCommand,
		undo,
		redo,
		clearCanvas,
	};
};

