// File role: applies local command actions and coordinates local history with transport updates.
import { v4 as uuidv4 } from "uuid";
import type { Ref } from "vue";
import { useLamportStore } from "../store/lamportStore";
import { SCENE_SCHEMA_VERSION, type Command, type EditorTool } from "@collaborative-whiteboard/shared";

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
	currentTool: Ref<EditorTool>;
	insertCommand: (cmd: Command) => void;
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
	isOffscreenMainCanvas?: () => boolean;
	requestSceneRefresh?: () => void;
	syncWorkerScene?: (commands: Command[], pageId: number, transformingCmdIds?: string[]) => void;
	setTool: (tool: EditorTool) => void;
	send: (type: string, data: unknown) => boolean;
}

export const createLocalCommandService = (options: LocalCommandServiceOptions) => {
	const sendFailedMessage = "连接已断开，操作未发送。";

	const pushCommand = (cmdPartial: Partial<Command>): CommandActionResult => {
		if (cmdPartial.type !== "scene-op" || !cmdPartial.sceneOperation) {
			return { ok: false, error: "新写入只允许使用 SceneOperation V2。" };
		}

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

			const sent = options.send("push-cmd", {
				id: command.id,
				cmd: command,
				username: Array.isArray(options.username.value)
					? options.username.value[0]
					: options.username.value,
			});
			if (!sent) return { ok: false, error: sendFailedMessage };
			if (!options.commands.value.find((item) => item.id === command.id)) {
				options.insertCommand(command);
			}
			options.currentCommandIndex.value = options.commands.value.length - 1;
			options.syncCommandState?.(command);
			if (!options.isOffscreenMainCanvas?.()) {
				options.renderCanvas();
			}
			return { ok: true, command };
		} catch (error: unknown) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : "Failed to create command",
			};
		}
	};

	const undo = (): CommandActionResult => {
		const sceneResult = toggleSceneHistory(false);
		if (sceneResult) return sceneResult;
		for (let index = options.commands.value.length - 1; index >= 0; index -= 1) {
			const command = options.commands.value[index];
			if (!command) continue;
			if (
				command.userId === options.userId.value &&
				command.pageId === options.currentPageId.value &&
				!command.isDeleted &&
				command.type !== "clear"
			) {
				const opId = uuidv4();
				const lamport = useLamportStore().getNextLamport();
				const roomId = Array.isArray(options.roomId.value) ? options.roomId.value[0] ?? "" : options.roomId.value;
				return pushCommand({
					id: opId,
					type: "scene-op",
					userId: options.userId.value,
					roomId,
					pageId: command.pageId,
					lamport,
					timestamp: Date.now(),
					isDeleted: false,
					box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
					schemaVersion: SCENE_SCHEMA_VERSION,
					sceneOperation: {
						schemaVersion: SCENE_SCHEMA_VERSION,
						opId,
						elementId: command.id,
						actorId: options.userId.value,
						roomId,
						pageId: command.pageId,
						lamport,
						historyGroupId: `legacy-undo:${opId}`,
						kind: "element.delete",
						payload: { elementIds: [command.id] },
					},
				});
			}
		}

		return { ok: false };
	};

	const redo = (): CommandActionResult => {
		const historyState = new Map<string, boolean>();
		for (const command of options.commands.value) {
			const operation = command.sceneOperation;
			if (operation?.kind === "history.toggle") historyState.set(operation.payload.targetHistoryGroupId, operation.payload.enabled);
		}
		const legacyInverse = [...options.commands.value].reverse().find((command) => {
			const operation = command.sceneOperation;
			return Boolean(
				operation?.kind === "element.delete" &&
				operation.actorId === options.userId.value &&
				operation.pageId === options.currentPageId.value &&
				operation.historyGroupId.startsWith("legacy-undo:") &&
				(historyState.get(operation.historyGroupId) ?? true)
			);
		});
		if (legacyInverse?.sceneOperation) {
			return appendHistoryToggle(legacyInverse, legacyInverse.sceneOperation, false);
		}
		const sceneResult = toggleSceneHistory(true);
		if (sceneResult) return sceneResult;
		return { ok: false };
	};

	const appendHistoryToggle = (
		target: Command,
		targetOperation: NonNullable<Command["sceneOperation"]>,
		enabled: boolean
	): CommandActionResult => {
		const opId = uuidv4();
		const lamport = useLamportStore().getNextLamport();
		const roomId = Array.isArray(options.roomId.value)
			? options.roomId.value[0] ?? ""
			: options.roomId.value;
		const result = pushCommand({
			id: opId,
			type: "scene-op",
			userId: options.userId.value,
			roomId,
			pageId: targetOperation.pageId,
			lamport,
			timestamp: Date.now(),
			isDeleted: false,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId: targetOperation.elementId,
				actorId: options.userId.value,
				roomId,
				pageId: targetOperation.pageId,
				lamport,
				historyGroupId: opId,
				kind: "history.toggle",
				payload: {
					targetHistoryGroupId: targetOperation.historyGroupId,
					enabled,
				},
			},
		});
		return result.ok ? { ...result, command: target } : result;
	};

	const toggleSceneHistory = (enabled: boolean): CommandActionResult | null => {
		const historyState = new Map<string, boolean>();
		for (const command of options.commands.value) {
			const operation = command.sceneOperation;
			if (!operation) continue;
			if (operation.kind === "history.toggle") {
				historyState.set(operation.payload.targetHistoryGroupId, operation.payload.enabled);
			} else if (!historyState.has(operation.historyGroupId)) {
				historyState.set(operation.historyGroupId, true);
			}
		}
		const candidates = options.commands.value.filter((command) => {
			const operation = command.sceneOperation;
			return Boolean(
				operation &&
				operation.kind !== "history.toggle" &&
				operation.actorId === options.userId.value &&
				operation.pageId === options.currentPageId.value &&
				(historyState.get(operation.historyGroupId) ?? true) !== enabled
			);
		});
		const target = enabled ? candidates[0] : candidates[candidates.length - 1];
		const targetOperation = target?.sceneOperation;
		if (!target || !targetOperation) return null;

		return appendHistoryToggle(target, targetOperation, enabled);
	};

	const clearCanvas = (): CommandActionResult => {
		const opId = uuidv4();
		const lamport = useLamportStore().getNextLamport();
		const normalizedRoomId = Array.isArray(options.roomId.value)
			? (options.roomId.value[0] ?? "")
			: options.roomId.value;
		const clearCommand: Command = {
			id: opId,
			type: "scene-op",
			timestamp: Date.now(),
			userId: options.userId.value,
			roomId: normalizedRoomId,
			pageId: options.currentPageId.value,
			isDeleted: false,
			lamport,
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			schemaVersion: SCENE_SCHEMA_VERSION,
			sceneOperation: {
				schemaVersion: SCENE_SCHEMA_VERSION,
				opId,
				elementId: `page:${options.currentPageId.value}`,
				actorId: options.userId.value,
				roomId: normalizedRoomId,
				pageId: options.currentPageId.value,
				lamport,
				historyGroupId: opId,
				kind: "page.clear",
				payload: { before: { lamport, opId, sourceIndex: 0, subIndex: 0 } },
			},
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

		options.syncWorkerScene?.(options.commands.value, options.currentPageId.value, []);
		options.renderCanvas();
		options.currentCommandIndex.value =
			options.commands.value.length === 0 ? 0 : options.commands.value.length - 1;

		return {
			ok: true,
			command: clearCommand,
			notice: `${userName} 在页面 ${clearCommand.pageId + 1} 执行了清屏操作`,
		};
	};

	return {
		pushCommand,
		undo,
		redo,
		clearCanvas,
	};
};
