// File role: applies local command actions and coordinates local history with transport updates.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import type { Command } from "@collaborative-whiteboard/shared";
import { getCommandDirtyRect } from "./commandDirtyRect";

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
	pruneDeletedCommandsAfterPointer: (
		userId: string,
		pageId: number,
		pointer: number
	) => string[];
	renderCanvas: () => void;
	requestDirtyRender?: (rect: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
		candidateCommandIds?: string[];
	}) => void;
	syncCommandState?: (command: Command) => void;
	requestSceneRefresh?: () => void;
	syncWorkerScene?: (commands: Command[], pageId: number, transformingCmdIds?: string[]) => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	send: (type: string, data: unknown) => boolean;
}

export const createLocalCommandService = (options: LocalCommandServiceOptions) => {
	const sendFailedMessage = "连接已断开，操作未发送。";

	const pruneDeletedCommandsAfterPointer = () => {
		const removedCommandIds = options.pruneDeletedCommandsAfterPointer(
			options.userId.value,
			options.currentPageId.value,
			options.currentCommandIndex.value
		);
		removedCommandIds.forEach((cmdId) => {
			options.send("delete-cmd", { cmdId });
		});
	};

	const pushCommand = (
		cmdPartial: Partial<Command>,
		type: PushCommandType = "normal"
	): CommandActionResult => {
		pruneDeletedCommandsAfterPointer();

		if (type === "start") {
			const sent = options.send("cmd-start", {
				id: cmdPartial.id,
				cmd: cmdPartial,
				lamport: useLamportStore().lamport,
			});
			if (!sent) return { ok: false, error: sendFailedMessage };

			if (!options.commands.value.find((command) => command.id === cmdPartial.id)) {
				options.insertCommand(cmdPartial as Command);
				options.currentCommandIndex.value = options.commands.value.length - 1;
			}
			return { ok: true, command: cmdPartial as Command };
		}

		if (type === "update" && cmdPartial.id && cmdPartial.points) {
			const sent = options.send("cmd-update", {
				cmdId: cmdPartial.id,
				points: cmdPartial.points,
				lamport: useLamportStore().getNextLamport(),
			});
			if (!sent) return { ok: false, error: sendFailedMessage };
			return { ok: true };
		}

		if (type === "stop") {
			const sent = options.send("cmd-stop", {
				cmdId: cmdPartial.id,
				cmd: cmdPartial,
				lamport: useLamportStore().lamport,
				points: cmdPartial.points || [],
				box: cmdPartial.box || null,
			});
			if (!sent) return { ok: false, error: sendFailedMessage };
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

				const sent = options.send("push-cmd", command);
				if (!sent) return { ok: false, error: sendFailedMessage };
				if (!options.commands.value.find((item) => item.id === command.id)) {
					options.insertCommand(command);
				}
				options.currentCommandIndex.value = options.commands.value.length - 1;
				options.renderCanvas();
				return { ok: true, command };
			} catch (error: unknown) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : "Failed to create command",
				};
			}
		}

		return { ok: false, error: "Unsupported command type" };
	};

	const undo = (): CommandActionResult => {
		for (let index = options.commands.value.length - 1; index >= 0; index -= 1) {
			const command = options.commands.value[index];
			if (!command) continue;
			if (
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				!command.isDeleted &&
				command.type !== "clear"
			) {

				const sent = options.send("undo-cmd", { cmdId: command.id });
				if (!sent) return { ok: false, error: sendFailedMessage };
				command.isDeleted = true;
				options.currentCommandIndex.value = index - 1;
				options.syncCommandState?.(command);
				const dirtyRect = getCommandDirtyRect(command);
				if (dirtyRect && options.requestDirtyRender) {
					options.requestDirtyRender(dirtyRect);
				} else if (options.requestSceneRefresh) {
					options.requestSceneRefresh();
				} else {
					options.renderCanvas();
				}
				options.setTool(options.currentTool.value);
				return { ok: true, command };
			}
		}

		return { ok: false };
	};

	const redo = (): CommandActionResult => {
		const startIndex = Math.max(0, options.currentCommandIndex.value + 1);
		for (let index = startIndex; index < options.commands.value.length; index += 1) {
			const command = options.commands.value[index];
			if (!command) continue;
			if (
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				command.isDeleted &&
				command.type !== "clear"
			) {
				const sent = options.send("redo-cmd", { cmdId: command.id });
				if (!sent) return { ok: false, error: sendFailedMessage };
				command.isDeleted = false;
				options.currentCommandIndex.value = index;
				options.syncCommandState?.(command);
				const dirtyRect = getCommandDirtyRect(command);
				if (dirtyRect && options.requestDirtyRender) {
					options.requestDirtyRender(dirtyRect);
				} else if (options.requestSceneRefresh) {
					options.requestSceneRefresh();
				} else {
					options.renderCanvas();
				}
				options.setTool(options.currentTool.value);
				return { ok: true, command };
			}
		}

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

		const userName = Array.isArray(options.username.value)
			? options.username.value[0]
			: options.username.value;

		const sent = options.send("push-cmd", {
			id: clearCommand.id,
			cmd: clearCommand,
			username: userName,
		});
		if (!sent) return { ok: false, error: sendFailedMessage };

		options.insertCommand(clearCommand);
		options.currentCommandIndex.value = options.commands.value.length - 1;

		const cleared = options.clearClearedCommands(clearCommand);
		options.syncWorkerScene?.(options.commands.value, options.currentPageId.value, []);
		options.renderCanvas();
		options.currentCommandIndex.value =
			options.commands.value.length === 0 ? 0 : options.commands.value.length - 1;

		return {
			ok: true,
			command: clearCommand,
			notice: cleared ? `${userName} 在页面 ${clearCommand.pageId + 1} 执行了清屏操作` : undefined,
		};
	};

	return {
		pushCommand,
		undo,
		redo,
		clearCanvas,
	};
};
