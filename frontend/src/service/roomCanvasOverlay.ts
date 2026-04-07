import { toRaw, type Ref, type ComponentPublicInstance } from "vue";
import { uiCanvasRef, uiCtx, renderIncrementPoint, renderPageContentFromPoints } from "./canvas";
import type { Command, FlatPoint, RemoteCursor } from "../utils/type";
import type { aabbBox } from "../utils/type";

interface TransformAnimState {
	progress: number;
	phase: "entering" | "dragging" | "exiting";
	initialBox: aabbBox | null;
}

interface RoomCanvasOverlayOptions {
	interactionMode: Ref<"none" | "box-selecting" | "dragging" | "resizing">;
	selectionRect: Ref<{ x: number; y: number; w: number; h: number } | null>;
	remoteSelectionRects: Ref<Map<string, { x: number; y: number; w: number; h: number }>>;
	transformAnim: Ref<TransformAnimState | null>;
	transformingCmdIds: Ref<Set<string>>;
	selectedCommandIds: Ref<Set<string>>;
	commands: Ref<Command[]>;
	currentPageId: Ref<number>;
	remoteCursors: Ref<Map<string, RemoteCursor>>;
	userId: Ref<string>;
	finalizeDrop: () => void;
	getGroupBoundingBox: (
		cmdIds: Set<string>,
		commands: Command[],
		currentPageId: number
	) => aabbBox | null;
	requestFlatPoints: (
		payload: {
			commands: Command[];
			pageId: number;
			transformingCmdIds: string[];
			requestId: string;
		},
		onResult?: (points: FlatPoint[]) => void
	) => void;
}

export const createRoomCanvasOverlay = (options: RoomCanvasOverlayOptions) => {
	let uiLoopId: number | null = null;

	const render = () => {
		if (!uiCtx.value || !uiCanvasRef.value) return;

		const dpr = window.devicePixelRatio || 1;
		const width = uiCanvasRef.value.width / dpr;
		const height = uiCanvasRef.value.height / dpr;

		uiCtx.value.clearRect(0, 0, width, height);

		if (options.interactionMode.value === "box-selecting" && options.selectionRect.value) {
			const r = options.selectionRect.value;
			const rx = r.x * width;
			const ry = r.y * height;
			const rw = r.w * width;
			const rh = r.h * height;

			uiCtx.value.save();
			uiCtx.value.fillStyle = "rgba(59, 130, 246, 0.1)";
			uiCtx.value.strokeStyle = "#3b82f6";
			uiCtx.value.lineWidth = 1;
			uiCtx.value.fillRect(rx, ry, rw, rh);
			uiCtx.value.strokeRect(rx, ry, rw, rh);
			uiCtx.value.restore();
		}

		options.remoteSelectionRects.value.forEach((r) => {
			const rx = r.x * width;
			const ry = r.y * height;
			const rw = r.w * width;
			const rh = r.h * height;

			uiCtx.value!.save();
			uiCtx.value!.fillStyle = "rgba(156, 163, 175, 0.1)";
			uiCtx.value!.strokeStyle = "#9ca3af";
			uiCtx.value!.setLineDash([2, 4]);
			uiCtx.value!.lineWidth = 1;
			uiCtx.value!.fillRect(rx, ry, rw, rh);
			uiCtx.value!.strokeRect(rx, ry, rw, rh);
			uiCtx.value!.restore();
		});

		if (options.transformAnim.value) {
			const step = 1 / 8;
			if (options.transformAnim.value.phase === "entering") {
				options.transformAnim.value.progress = Math.min(
					1,
					options.transformAnim.value.progress + step
				);
				if (options.transformAnim.value.progress >= 1) {
					options.transformAnim.value.phase = "dragging";
				}
			} else if (options.transformAnim.value.phase === "exiting") {
				options.transformAnim.value.progress = Math.max(
					0,
					options.transformAnim.value.progress - step
				);
				if (options.transformAnim.value.progress <= 0) {
					options.finalizeDrop();
				}
			}
		}

		if (options.transformingCmdIds.value.size > 0) {
			uiCtx.value.save();

			if (options.transformAnim.value) {
				const p = options.transformAnim.value.progress;
				uiCtx.value.globalAlpha = 0.3 + 0.55 * p;
				uiCtx.value.shadowColor = `rgba(0, 0, 0, ${0.2 * p})`;
				uiCtx.value.shadowBlur = 12 * p;
				uiCtx.value.shadowOffsetX = 6 * p;
				uiCtx.value.shadowOffsetY = 6 * p;
			} else {
				uiCtx.value.globalAlpha = 0.85;
				uiCtx.value.shadowColor = "rgba(0, 0, 0, 0.2)";
				uiCtx.value.shadowBlur = 12;
				uiCtx.value.shadowOffsetX = 6;
				uiCtx.value.shadowOffsetY = 6;
			}

			options.transformingCmdIds.value.forEach((cmdId) => {
				const cmd = options.commands.value.find((candidate) => candidate.id === cmdId);
				if (!cmd?.points?.length) return;
				renderIncrementPoint(cmd, cmd.points, uiCtx.value!, width, height, true);
			});

			uiCtx.value.restore();
		}

		if (options.selectedCommandIds.value.size > 0) {
			const groupBox = options.getGroupBoundingBox(
				options.selectedCommandIds.value,
				options.commands.value,
				options.currentPageId.value
			);

			if (groupBox) {
				const bx = groupBox.minX * width;
				const by = groupBox.minY * height;
				const bw = groupBox.width * width;
				const bh = groupBox.height * height;
				const padding = 5;

				uiCtx.value.save();
				uiCtx.value.strokeStyle = "#3b82f6";
				uiCtx.value.lineWidth = 1.5;
				uiCtx.value.setLineDash([4, 4]);
				uiCtx.value.strokeRect(bx - padding, by - padding, bw + padding * 2, bh + padding * 2);

				uiCtx.value.setLineDash([]);
				uiCtx.value.fillStyle = "white";
				uiCtx.value.strokeStyle = "#3b82f6";
				uiCtx.value.lineWidth = 1.5;

				const corners = [
					{ x: bx - padding, y: by - padding },
					{ x: bx + bw + padding, y: by - padding },
					{ x: bx + bw + padding, y: by + bh + padding },
					{ x: bx - padding, y: by + bh + padding },
				];

				corners.forEach((point) => {
					uiCtx.value!.beginPath();
					uiCtx.value!.rect(point.x - 4, point.y - 4, 8, 8);
					uiCtx.value!.fill();
					uiCtx.value!.stroke();
				});

				uiCtx.value.restore();
			}
		}

		options.remoteCursors.value.forEach((cursor) => {
			if (cursor.userId === options.userId.value) return;
			if (cursor.pageId !== options.currentPageId.value) return;

			if (Date.now() - (cursor.lastUpdate || 0) > 10000) {
				options.remoteCursors.value.delete(cursor.userId);
				return;
			}

			const x = cursor.x * width;
			const y = cursor.y * height;
			const color = cursor.color || "#ff0000";

			uiCtx.value!.save();
			uiCtx.value!.translate(x, y);
			uiCtx.value!.fillStyle = color;
			uiCtx.value!.beginPath();
			uiCtx.value!.moveTo(0, 0);
			uiCtx.value!.lineTo(5.5, 15.5);
			uiCtx.value!.lineTo(8.5, 11);
			uiCtx.value!.lineTo(14, 11);
			uiCtx.value!.closePath();
			uiCtx.value!.shadowColor = "rgba(0, 0, 0, 0.4)";
			uiCtx.value!.shadowBlur = 3;
			uiCtx.value!.shadowOffsetX = 1;
			uiCtx.value!.shadowOffsetY = 1;
			uiCtx.value!.fill();
			uiCtx.value!.shadowColor = "transparent";
			uiCtx.value!.strokeStyle = "white";
			uiCtx.value!.lineWidth = 1;
			uiCtx.value!.stroke();

			if (cursor.userName) {
				uiCtx.value!.font = "500 12px 'Segoe UI', sans-serif";
				const textPaddingX = 6;
				const textPaddingY = 3;
				const textMetrics = uiCtx.value!.measureText(cursor.userName);
				const trX = 10;
				const trY = 10;
				const trW = textMetrics.width + textPaddingX * 2;
				const trH = 16 + textPaddingY * 2;
				const r = 4;

				uiCtx.value!.fillStyle = color;
				uiCtx.value!.beginPath();
				uiCtx.value!.moveTo(trX + r, trY);
				uiCtx.value!.lineTo(trX + trW - r, trY);
				uiCtx.value!.quadraticCurveTo(trX + trW, trY, trX + trW, trY + r);
				uiCtx.value!.lineTo(trX + trW, trY + trH - r);
				uiCtx.value!.quadraticCurveTo(trX + trW, trY + trH, trX + trW - r, trY + trH);
				uiCtx.value!.lineTo(trX + r, trY + trH);
				uiCtx.value!.quadraticCurveTo(trX, trY + trH, trX, trY + trH - r);
				uiCtx.value!.lineTo(trX, trY + r);
				uiCtx.value!.quadraticCurveTo(trX, trY, trX + r, trY);
				uiCtx.value!.closePath();
				uiCtx.value!.fill();

				uiCtx.value!.fillStyle = "white";
				uiCtx.value!.textBaseline = "middle";
				uiCtx.value!.fillText(cursor.userName, trX + textPaddingX, trY + trH / 2 + 1);
			}

			uiCtx.value!.restore();
		});
	};

	const startLoop = () => {
		const loop = () => {
			render();
			uiLoopId = requestAnimationFrame(loop);
		};
		loop();
	};

	const stopLoop = () => {
		if (uiLoopId) {
			cancelAnimationFrame(uiLoopId);
			uiLoopId = null;
		}
	};

	const renderPreviewCanvas = (el: Element | ComponentPublicInstance | null, index: number) => {
		if (!(el instanceof HTMLCanvasElement)) return;

		requestAnimationFrame(() => {
			const canvas = el;
			const context = canvas.getContext("2d");
			if (!context) return;

			const rect = canvas.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;

			const dpr = window.devicePixelRatio || 1;
			canvas.width = rect.width * dpr;
			canvas.height = rect.height * dpr;
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.scale(dpr, dpr);
			context.lineCap = "round";
			context.lineJoin = "round";

			const requestId = `preview-page-${index}-${Date.now()}`;
			const rawCommands = (toRaw(options.commands.value) as Command[]).map((cmd) => ({
				...cmd,
				points: cmd.points ? toRaw(cmd.points) : [],
			}));

			options.requestFlatPoints(
				{
					commands: rawCommands,
					pageId: index,
					transformingCmdIds: [],
					requestId,
				},
				(points) => {
					renderPageContentFromPoints(context, rect.width, rect.height, points);
				}
			);
		});
	};

	return {
		render,
		startLoop,
		stopLoop,
		renderPreviewCanvas,
	};
};
