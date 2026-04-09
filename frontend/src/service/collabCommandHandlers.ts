// File role: remote collaboration handlers for command-related websocket messages.
import { markRaw } from "vue";
import { toast } from "vue-sonner";
import { canvasRef, ctx, lastWidths, renderIncrementPoint } from "./canvas";
import { useLamportStore } from "../store/lamportStore";
import type { Command, Point } from "../utils/type";
import type { CollabIncomingMessage, CollabMessageDispatcherOptions } from "./collabDispatcherTypes";
import {
	markRemoteCommandReceived,
	recordCommandsHydrated,
	recordRedoEnd,
	recordRedoStart,
	recordUndoEnd,
	recordUndoStart,
} from "./benchmarkRuntime";

export const createCollabCommandHandlers = (options: CollabMessageDispatcherOptions) => {
	const renderIncrement = (cmd: Command, points: Point[]) => {
		if (!canvasRef.value || !ctx.value || cmd.pageId !== options.currentPageId.value) return;
		const dpr = window.devicePixelRatio || 1;
		const logicalWidth = canvasRef.value.width / dpr;
		const logicalHeight = canvasRef.value.height / dpr;
		renderIncrementPoint(cmd, points, ctx.value, logicalWidth, logicalHeight);
	};

	const renderSinglePoint = (cmd: Command) => {
		if (!canvasRef.value || !ctx.value || cmd.pageId !== options.currentPageId.value) return;
		const p0 = cmd.points?.[0];
		if (!p0) return;

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value.width / dpr;
		const height = canvasRef.value.height / dpr;
		const x = p0.x * width;
		const y = p0.y * height;
		const baseSize = cmd.size || 3;
		let pointWidth = baseSize * (p0.p * 2);
		if (cmd.tool === "eraser") pointWidth = baseSize;

		const color = cmd.tool === "eraser" ? "#ffffff" : cmd.color || "#000000";
		const op = cmd.tool === "eraser" ? "destination-out" : "source-over";

		ctx.value.save();
		ctx.value.globalCompositeOperation = op;
		ctx.value.fillStyle = color;
		ctx.value.beginPath();
		ctx.value.arc(x, y, pointWidth / 2, 0, Math.PI * 2);
		ctx.value.fill();
		ctx.value.restore();
	};

	const handleInit = (msg: CollabIncomingMessage) => {
		options.onInitConnectionState();
		const hydrateStart = performance.now();

		const initData = msg.data;
		options.userId.value = initData.userId;
		options.roomId.value = initData.roomId;
		options.username.value = initData.userName;
		options.roomName.value = initData.roomName;
		options.onlineCount.value = initData.onlineCount;
		options.totalPages.value = initData.totalPage || 1;

		const lastPoint = initData.commands?.at(-1)?.points?.at(-1);
		if (lastPoint) {
			useLamportStore().lamport = Math.max(useLamportStore().lamport, lastPoint.lamport);
		}

		initData.commands.forEach((cmd: Command) => {
			options.insertCommand(cmd);
		});
		recordCommandsHydrated(initData.commands?.length || 0, performance.now() - hydrateStart);
		options.renderCanvas();
	};

	const handlePushCommand = (msg: CollabIncomingMessage) => {
		const cmd = msg.data.cmd as Command;
		const pushType = msg.pushType as "normal" | "start" | "update" | "stop";
		const remoteCommandId = cmd?.id || msg.data.cmdId;
		const remotePointCount = (msg.data.points ?? cmd?.points ?? []).length || 0;
		if (remoteCommandId) {
			markRemoteCommandReceived(remoteCommandId, pushType, remotePointCount);
		}

		if ((pushType === "normal" || pushType === "start") && cmd) {
			options.emitHook?.("command:before-apply", {
				command: cmd,
				source: "remote",
			});
		}

		if (pushType === "normal" || pushType === "start") {
			if (cmd.userId === options.userId.value) {
				options.currentCommandIndex.value = options.commands.value.length - 1;
			}

			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			if (pushType === "normal") {
				options.insertCommand(cmd);
				if (cmd.type === "clear") {
					if (options.clearClearedCommands(cmd)) {
						toast.info(
							`${msg.data.username ? msg.data.username : "有用户"}  在页面${cmd.pageId + 1} 执行了清屏操作`
						);
					}
					options.currentCommandIndex.value = 0;
				}
				options.renderCanvas();
				options.emitHook?.("command:applied", {
					command: cmd,
					source: "remote",
				});
				return;
			}

			if (options.pendingUpdates.value.has(cmd.id)) {
				const points = options.pendingUpdates.value.get(cmd.id) || [];
				cmd.points = markRaw([...(cmd.points || []), ...points]);
				options.pendingUpdates.value.delete(cmd.id);
			}

			options.insertCommand(cmd);
			renderIncrement(cmd, cmd.points ?? []);
			options.emitHook?.("command:applied", {
				command: cmd,
				source: "remote",
			});
			return;
		}

		if (pushType === "update") {
			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			const cmdId = msg.data.cmdId;
			const points = (msg.data.points ?? []) as Point[];
			if (!points.length) return;

			const localCmd = options.commandMap.get(cmdId);
			if (localCmd) {
				localCmd.points = markRaw([...(localCmd.points || []), ...points]);
			} else {
				options.pendingUpdates.value.set(cmdId, points);
				return;
			}

			renderIncrement(localCmd, points);
			return;
		}

		if (pushType === "stop") {
			if (msg.data.lamport) {
				useLamportStore().syncLamport(msg.data.lamport);
			}

			const cmdId = msg.data.cmdId;
			delete lastWidths[cmdId];
			const stopPoints = (msg.data.points ?? msg.data.cmd?.points ?? []) as Point[];
			const localCmd = options.commandMap.get(cmdId);

			if (localCmd) {
				if (stopPoints.length > 0) {
					localCmd.points = [...(localCmd.points || []), ...stopPoints];
					renderIncrement(localCmd, stopPoints);
				}
			} else if (msg.data.cmd) {
				const fallbackCmd = msg.data.cmd as Command;
				options.emitHook?.("command:before-apply", {
					command: fallbackCmd,
					source: "remote",
				});
				if (stopPoints.length > 0) {
					fallbackCmd.points = stopPoints;
				}
				options.insertCommand(fallbackCmd);
				options.renderCanvas();
				options.emitHook?.("command:applied", {
					command: fallbackCmd,
					source: "remote",
				});
			}

			if (localCmd?.type === "path" && localCmd.points?.length === 1) {
				renderSinglePoint(localCmd);
			}

			useLamportStore().lamport = Math.max(useLamportStore().lamport, msg.data.lamport);
		}
	};

	const handleBatchMove = (msg: CollabIncomingMessage) => {
		const { userId: msgUserId, cmdIds, dx, dy } = msg.data;
		if (msgUserId === options.userId.value) return;

		let hasUpdates = false;
		cmdIds.forEach((id: string) => {
			const cmd = options.commands.value.find((candidate) => candidate.id === id);
			if (!cmd?.points) return;
			cmd.points.forEach((point) => {
				point.x += dx;
				point.y += dy;
			});
			hasUpdates = true;
		});
		if (hasUpdates) options.renderCanvas();
	};

	const handleBatchUpdate = (msg: CollabIncomingMessage) => {
		const { userId: msgUserId, updates } = msg.data;
		if (msgUserId === options.userId.value) return;

		let hasUpdates = false;
		updates.forEach((update: any) => {
			const cmd = options.commands.value.find((candidate) => candidate.id === update.cmdId);
			if (!cmd) return;
			cmd.points = update.points;
			if (msg.type === "cmd-batch-stop") {
				cmd.box = update.boxes;
			}
			hasUpdates = true;
		});
		if (hasUpdates) options.renderCanvas();
	};

	const handlePageAdd = (msg: CollabIncomingMessage) => {
		const { totalPages: newTotalPages } = msg.data;
		if (newTotalPages > options.totalPages.value) {
			toast.info(`${msg.data.username ? msg.data.username : "有用户"} 创建了页面${msg.data.totalPages}`, {
				action: {
					label: "前往",
					onClick: () => options.goToPage(msg.data.totalPages - 1),
				},
			});
			options.totalPages.value = newTotalPages;
		}
	};

	const handleUndoRedo = (msg: CollabIncomingMessage) => {
		const timer =
			msg.type === "undo-cmd" ? recordUndoStart("remote") : recordRedoStart("remote");
		const cmd = options.commands.value.find((candidate) => candidate.id === msg.data.cmdId);
		if (!cmd) {
			if (msg.type === "undo-cmd") {
				recordUndoEnd("remote", 0);
			} else {
				recordRedoEnd("remote", 0);
			}
			return;
		}
		cmd.isDeleted = msg.type === "undo-cmd";
		options.renderCanvas();
		options.setTool(options.currentTool.value);
		if (msg.type === "undo-cmd") {
			recordUndoEnd("remote", performance.now() - timer);
		} else {
			recordRedoEnd("remote", performance.now() - timer);
		}
	};

	return {
		handleInit,
		handlePushCommand,
		handleBatchMove,
		handleBatchUpdate,
		handlePageAdd,
		handleUndoRedo,
	};
};
