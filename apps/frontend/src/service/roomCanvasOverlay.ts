// File role: renders overlay canvas content such as selections, cursors, previews, and transform visuals.
import { toRaw, watch, type Ref, type ComponentPublicInstance } from "vue";
import { uiCanvasRef, uiCtx, renderPageContentFromPoints } from "./canvas";
import { SceneEngine } from "../scene/sceneEngine";
import type {
	AffineMatrix,
	Command,
	EditorTool,
	FlatPoint,
	RemoteCursor,
	StrokePattern,
	aabbBox,
} from "@collaborative-whiteboard/shared";
import { IDENTITY_MATRIX } from "@collaborative-whiteboard/shared";
import { drawPrimitive } from "../scene/primitiveRenderer";
import type { BitmapAtom, GlyphAtom, ShapeAtom } from "../scene/sceneTypes";
import type { ProductPreviewState } from "../states/roomInteractionState";

interface TransformAnimState {
	progress: number;
	phase: "entering" | "dragging" | "exiting";
	initialBox: aabbBox | null;
}

interface RoomCanvasOverlayOptions {
	interactionMode: Ref<"none" | "box-selecting" | "dragging" | "resizing" | "rotating">;
	selectionRect: Ref<{ x: number; y: number; w: number; h: number } | null>;
	remoteSelectionRects: Ref<Map<string, { x: number; y: number; w: number; h: number }>>;
	transformAnim: Ref<TransformAnimState | null>;
	transformingCmdIds: Ref<Set<string>>;
	previewTransform: Ref<AffineMatrix | null>;
	selectedCommandIds: Ref<Set<string>>;
	selectedSceneBounds: Ref<aabbBox | null>;
	productPreview: Ref<ProductPreviewState | null>;
	currentTool: Ref<EditorTool>;
	currentColor: Ref<string>;
	currentSize: Ref<number>;
	currentStrokePattern: Ref<StrokePattern>;
	currentSticker: Ref<string>;
	commands: Ref<Command[]>;
	commandMap: Map<string, Command>;
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

const CURSOR_LABEL_FONT = "500 12px 'Segoe UI', sans-serif";

const previewBox = (
	preview: ProductPreviewState,
	width: number,
	height: number
): aabbBox => {
	let minX = Math.min(preview.start.x, preview.end.x);
	let minY = Math.min(preview.start.y, preview.end.y);
	let maxX = Math.max(preview.start.x, preview.end.x);
	let maxY = Math.max(preview.start.y, preview.end.y);
	if (preview.tool === "sticker" && maxX - minX < 0.002 && maxY - minY < 0.002) {
		minX = preview.end.x - 32 / Math.max(1, width);
		maxX = preview.end.x + 32 / Math.max(1, width);
		minY = preview.end.y - 32 / Math.max(1, height);
		maxY = preview.end.y + 32 / Math.max(1, height);
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

const transformBox = (box: aabbBox, matrix: AffineMatrix): aabbBox => {
	const points = [
		[box.minX, box.minY],
		[box.maxX, box.minY],
		[box.maxX, box.maxY],
		[box.minX, box.maxY],
	].map(([x, y]) => ({
		x: matrix[0] * x! + matrix[2] * y! + matrix[4],
		y: matrix[1] * x! + matrix[3] * y! + matrix[5],
	}));
	const minX = Math.min(...points.map((point) => point.x));
	const minY = Math.min(...points.map((point) => point.y));
	const maxX = Math.max(...points.map((point) => point.x));
	const maxY = Math.max(...points.map((point) => point.y));
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

export const createRoomCanvasOverlay = (options: RoomCanvasOverlayOptions) => {
	let renderRafId: number | null = null;
	let animationRafId: number | null = null;
	let cursorExpiryTimer: number | null = null;
	let stopWatches: Array<() => void> = [];
	let wasVisible = false;
	const cursorLabelWidthCache = new Map<string, number>();
	const transformPreviewEngine = new SceneEngine();
	let transformPreviewSignature = "";

	const drawProductPreview = (width: number, height: number) => {
		const preview = options.productPreview.value;
		const context = uiCtx.value;
		if (!preview || !context) return;
		if (preview.tool === "eraser" || preview.tool === "object-eraser") {
			const points = preview.points.length > 0 ? preview.points : [preview.start, preview.end];
			context.save();
			context.strokeStyle = "rgba(255, 255, 255, 0.98)";
			context.lineWidth = Math.max(2, options.currentSize.value);
			context.lineCap = "round";
			context.lineJoin = "round";
			context.setLineDash([]);
			context.beginPath();
			points.forEach((point, index) => {
				if (index === 0) context.moveTo(point.x * width, point.y * height);
				else context.lineTo(point.x * width, point.y * height);
			});
			context.stroke();
			context.restore();
			return;
		}

		const box = previewBox(preview, width, height);
		const style = {
			color: options.currentColor.value,
			size: options.currentSize.value,
			strokePattern: options.currentStrokePattern.value,
			opacity: 0.72,
		};
		if (["line", "arrow", "rectangle", "rounded-rectangle", "ellipse"].includes(preview.tool)) {
			const atom: ShapeAtom = {
				ref: -1, atomId: "preview:shape", elementId: "preview", elementRevision: 0, pageId: options.currentPageId.value,
				order: { lamport: 0, opId: "preview", sourceIndex: 0, subIndex: 0 }, recipeId: "shape", primitive: "shape",
				toolId: preview.tool, style, bounds: box, box, shapeKind: preview.tool as ShapeAtom["shapeKind"],
				shapeStart: preview.start, shapeEnd: preview.end,
			};
			drawPrimitive(context, atom, IDENTITY_MATRIX, width, height);
			return;
		}

		if (preview.tool === "sticker") {
			const atom: BitmapAtom = {
				ref: -1, atomId: "preview:sticker", elementId: "preview", elementRevision: 0, pageId: options.currentPageId.value,
				order: { lamport: 0, opId: "preview", sourceIndex: 0, subIndex: 0 }, recipeId: "bitmap", primitive: "bitmap",
				toolId: "sticker", style, bounds: box, box, value: options.currentSticker.value,
			};
			drawPrimitive(context, atom, IDENTITY_MATRIX, width, height);
			return;
		}

		const textBox = box.width > 0.002 || box.height > 0.002
			? box
			: {
				minX: preview.start.x,
				minY: preview.start.y,
				maxX: Math.min(1, preview.start.x + (preview.tool === "sticky" ? 0.22 : 0.32)),
				maxY: Math.min(1, preview.start.y + (preview.tool === "sticky" ? 0.22 : 0.12)),
				width: preview.tool === "sticky" ? 0.22 : 0.32,
				height: preview.tool === "sticky" ? 0.22 : 0.12,
			};
		const background: ShapeAtom = {
			ref: -1, atomId: "preview:text-box", elementId: "preview", elementRevision: 0, pageId: options.currentPageId.value,
			order: { lamport: 0, opId: "preview", sourceIndex: 0, subIndex: 0 }, recipeId: "shape", primitive: "shape",
			toolId: preview.tool, style: {
				...style,
				fillColor: preview.tool === "sticky" ? "#fef3c7" : undefined,
			}, bounds: textBox, box: textBox, shapeKind: "rounded-rectangle",
		};
		drawPrimitive(context, background, IDENTITY_MATRIX, width, height);
		const label: GlyphAtom = {
			ref: -1, atomId: "preview:text-label", elementId: "preview", elementRevision: 0, pageId: options.currentPageId.value,
			order: { lamport: 0, opId: "preview", sourceIndex: 1, subIndex: 0 }, recipeId: "glyph", primitive: "glyph",
			toolId: preview.tool, style: { ...style, fontSize: 16 }, bounds: textBox,
			grapheme: preview.tool === "sticky" ? "便签" : "文字", x: textBox.minX + 0.008, y: textBox.minY + 0.008, maxWidth: textBox.width - 0.016,
		};
		drawPrimitive(context, label, IDENTITY_MATRIX, width, height);
	};

	const operationTargetsSelectedElement = (command: Command, selected: ReadonlySet<string>) => {
		const operation = command.sceneOperation;
		if (!operation) return false;
		if (operation.kind === "element.transform" || operation.kind === "element.erase") {
			return operation.payload.targets.some((target) => selected.has(target.elementId));
		}
		if (operation.kind === "element.delete") {
			return operation.payload.elementIds.some((elementId) => selected.has(elementId));
		}
		return selected.has(operation.elementId);
	};

	const ensureTransformPreviewScene = (selected: ReadonlySet<string>) => {
		const historyGroups = new Set<string>();
		const relevant = options.commands.value.filter((command) => {
			if (command.type === "path") return selected.has(command.id);
			if (!operationTargetsSelectedElement(command, selected)) return false;
			if (command.sceneOperation?.kind !== "history.toggle") historyGroups.add(command.sceneOperation?.historyGroupId ?? "");
			return command.sceneOperation?.kind !== "history.toggle";
		});
		for (const command of options.commands.value) {
			const operation = command.sceneOperation;
			if (operation?.kind === "history.toggle" && historyGroups.has(operation.payload.targetHistoryGroupId)) relevant.push(command);
		}
		const signature = `${options.currentPageId.value}|${Array.from(selected).sort().join(",")}|${relevant.map((command) => `${command.id}:${command.isDeleted ? 1 : 0}`).join(",")}`;
		if (signature === transformPreviewSignature) return;
		transformPreviewSignature = signature;
		transformPreviewEngine.rebuildFromCommands(relevant, options.currentPageId.value);
	};

	const hasVisibleOverlay = (now: number) => {
		const hasRemoteCursor = Array.from(options.remoteCursors.value.values()).some(
			(cursor) =>
				cursor.userId !== options.userId.value &&
				cursor.pageId === options.currentPageId.value &&
				now - (cursor.lastUpdate || 0) <= 10000
		);

		return (
			hasRemoteCursor ||
			Boolean(options.selectionRect.value) ||
			Boolean(options.productPreview.value) ||
			options.remoteSelectionRects.value.size > 0 ||
			options.transformingCmdIds.value.size > 0 ||
			options.selectedCommandIds.value.size > 0 ||
			Boolean(options.transformAnim.value)
		);
	};

	const scheduleCursorExpiryCheck = (now: number) => {
		if (cursorExpiryTimer) {
			clearTimeout(cursorExpiryTimer);
			cursorExpiryTimer = null;
		}

		let nextExpiryDelay = Number.POSITIVE_INFINITY;
		options.remoteCursors.value.forEach((cursor) => {
			if (cursor.userId === options.userId.value) return;
			if (cursor.pageId !== options.currentPageId.value) return;
			const remaining = 10000 - (now - (cursor.lastUpdate || 0));
			if (remaining > 0) {
				nextExpiryDelay = Math.min(nextExpiryDelay, remaining);
			}
		});

		if (!Number.isFinite(nextExpiryDelay)) return;
		cursorExpiryTimer = window.setTimeout(() => {
			render();
		}, Math.max(16, nextExpiryDelay));
	};

	const scheduleRender = () => {
		if (renderRafId !== null) return;
		renderRafId = requestAnimationFrame(() => {
			renderRafId = null;
			render();
		});
	};

	const ensureAnimationLoop = () => {
		if (animationRafId !== null) return;
		animationRafId = requestAnimationFrame(() => {
			animationRafId = null;
			render();
		});
	};

	const render = () => {
		if (!uiCtx.value || !uiCanvasRef.value) return;

		const now = Date.now();
		const visible = hasVisibleOverlay(now);
		if (!visible && !wasVisible) {
			return;
		}

		const dpr = window.devicePixelRatio || 1;
		const width = uiCanvasRef.value.width / dpr;
		const height = uiCanvasRef.value.height / dpr;

		uiCtx.value.clearRect(0, 0, width, height);
		wasVisible = visible;

		if (!visible) {
			return;
		}

		drawProductPreview(width, height);

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

		let shouldAnimate = false;
		if (options.transformAnim.value) {
			const step = 1 / 8;
			if (options.transformAnim.value.phase === "entering") {
				options.transformAnim.value.progress = Math.min(
					1,
					options.transformAnim.value.progress + step
				);
				if (options.transformAnim.value.progress >= 1) {
					options.transformAnim.value.phase = "dragging";
				} else {
					shouldAnimate = true;
				}
			} else if (options.transformAnim.value.phase === "exiting") {
				options.transformAnim.value.progress = Math.max(
					0,
					options.transformAnim.value.progress - step
				);
				if (options.transformAnim.value.progress <= 0) {
					options.finalizeDrop();
				} else {
					shouldAnimate = true;
				}
			}
		}

		if (options.transformingCmdIds.value.size > 0) {
			shouldAnimate = true;
			ensureTransformPreviewScene(options.transformingCmdIds.value);
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

			transformPreviewEngine.renderElements(
				uiCtx.value,
				options.transformingCmdIds.value,
				options.previewTransform.value,
				width,
				height
			);

			uiCtx.value.restore();
		}

		if (options.selectedCommandIds.value.size > 0) {
			const sourceGroupBox = options.selectedSceneBounds.value ?? options.getGroupBoundingBox(
				options.selectedCommandIds.value,
				options.commands.value,
				options.currentPageId.value
			);
			const groupBox = sourceGroupBox && options.previewTransform.value
				? transformBox(sourceGroupBox, options.previewTransform.value)
				: sourceGroupBox;

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

				const handles = [
					{ x: bx - padding, y: by - padding },
					{ x: bx + bw / 2, y: by - padding },
					{ x: bx + bw + padding, y: by - padding },
					{ x: bx + bw + padding, y: by + bh / 2 },
					{ x: bx + bw + padding, y: by + bh + padding },
					{ x: bx + bw / 2, y: by + bh + padding },
					{ x: bx - padding, y: by + bh + padding },
					{ x: bx - padding, y: by + bh / 2 },
				];

				const rotateHandle = { x: bx + bw / 2, y: by - padding - 28 };
				uiCtx.value.beginPath();
				uiCtx.value.moveTo(bx + bw / 2, by - padding);
				uiCtx.value.lineTo(rotateHandle.x, rotateHandle.y);
				uiCtx.value.stroke();
				handles.forEach((point) => {
					uiCtx.value!.beginPath();
					uiCtx.value!.rect(point.x - 4.5, point.y - 4.5, 9, 9);
					uiCtx.value!.fill();
					uiCtx.value!.stroke();
				});
				uiCtx.value.beginPath();
				uiCtx.value.arc(rotateHandle.x, rotateHandle.y, 6, 0, Math.PI * 2);
				uiCtx.value.fill();
				uiCtx.value.stroke();
				uiCtx.value.beginPath();
				uiCtx.value.arc(rotateHandle.x, rotateHandle.y, 2, 0, Math.PI * 2);
				uiCtx.value.fillStyle = "#3b82f6";
				uiCtx.value.fill();

				uiCtx.value.restore();
			}
		}

		let fontPrepared = false;
		options.remoteCursors.value.forEach((cursor) => {
			if (cursor.userId === options.userId.value) return;
			if (cursor.pageId !== options.currentPageId.value) return;

			if (now - (cursor.lastUpdate || 0) > 10000) {
				options.remoteCursors.value.delete(cursor.userId);
				cursorLabelWidthCache.delete(cursor.userName || "");
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
				if (!fontPrepared) {
					uiCtx.value!.font = CURSOR_LABEL_FONT;
					fontPrepared = true;
				}
				const textPaddingX = 6;
				const textPaddingY = 3;
				let textWidth = cursorLabelWidthCache.get(cursor.userName);
				if (textWidth === undefined) {
					textWidth = uiCtx.value!.measureText(cursor.userName).width;
					cursorLabelWidthCache.set(cursor.userName, textWidth);
				}
				const trX = 10;
				const trY = 10;
				const trW = textWidth + textPaddingX * 2;
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

		scheduleCursorExpiryCheck(now);
		if (shouldAnimate || options.interactionMode.value === "box-selecting") {
			ensureAnimationLoop();
		}
	};

	const startLoop = () => {
		stopWatches = [
			watch(
				() => options.productPreview.value,
				() => scheduleRender(),
				{ deep: true }
			),
			watch(
				() => options.interactionMode.value,
				() => scheduleRender()
			),
			watch(
				() =>
					options.selectionRect.value
						? [
								options.selectionRect.value.x,
								options.selectionRect.value.y,
								options.selectionRect.value.w,
								options.selectionRect.value.h,
							]
						: null,
				() => scheduleRender()
			),
			watch(
				() =>
					Array.from(options.remoteSelectionRects.value.entries()).map(([userId, rect]) => [
						userId,
						rect.x,
						rect.y,
						rect.w,
						rect.h,
					]),
				() => scheduleRender(),
				{ deep: true }
			),
			watch(
				() =>
					options.transformAnim.value
						? [
								options.transformAnim.value.phase,
								options.transformAnim.value.progress,
							]
						: null,
				() => scheduleRender()
			),
			watch(
				() => Array.from(options.transformingCmdIds.value),
				() => scheduleRender(),
				{ deep: true }
			),
			watch(
				() =>
					Array.from(options.selectedCommandIds.value).map((cmdId) => {
						const cmd = options.commandMap.get(cmdId);
						return [
							cmdId,
							cmd?.box?.minX,
							cmd?.box?.minY,
							cmd?.box?.maxX,
							cmd?.box?.maxY,
							cmd?.box?.width,
							cmd?.box?.height,
						];
					}),
				() => scheduleRender(),
				{ deep: true }
			),
			watch(
				() => options.previewTransform.value,
				() => scheduleRender(),
				{ deep: true }
			),
			watch(
				() =>
					Array.from(options.remoteCursors.value.values()).map((cursor) => [
						cursor.userId,
						cursor.pageId,
						cursor.x,
						cursor.y,
						cursor.userName,
						cursor.lastUpdate,
					]),
				() => scheduleRender(),
				{ deep: true }
			),
			watch(
				() => options.currentPageId.value,
				() => scheduleRender()
			),
		];

		scheduleRender();
	};

	const stopLoop = () => {
		stopWatches.forEach((stop) => stop());
		stopWatches = [];
		if (renderRafId !== null) {
			cancelAnimationFrame(renderRafId);
			renderRafId = null;
		}
		if (animationRafId !== null) {
			cancelAnimationFrame(animationRafId);
			animationRafId = null;
		}
		if (cursorExpiryTimer) {
			clearTimeout(cursorExpiryTimer);
			cursorExpiryTimer = null;
		}
		wasVisible = false;
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
