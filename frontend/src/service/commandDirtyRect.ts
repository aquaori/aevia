import { canvasRef } from "./canvas";
import type { Command } from "../utils/type";

export const getCommandDirtyRect = (
	command: Command
):
	| {
			minX: number;
			minY: number;
			maxX: number;
			maxY: number;
			width: number;
			height: number;
			candidateCommandIds: string[];
	  }
	| null => {
	if (!canvasRef.value) return null;
	if (command.type !== "path") return null;
	const box = command.box;
	if (!box || box.width <= 0 || box.height <= 0) return null;

	const dpr = window.devicePixelRatio || 1;
	const logicalWidth = canvasRef.value.width / dpr;
	const logicalHeight = canvasRef.value.height / dpr;
	const padding = Math.max(command.size ?? 3, 6) + 8;

	const minX = Math.max(0, box.minX * logicalWidth - padding);
	const minY = Math.max(0, box.minY * logicalHeight - padding);
	const maxX = Math.min(logicalWidth, box.maxX * logicalWidth + padding);
	const maxY = Math.min(logicalHeight, box.maxY * logicalHeight + padding);

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: Math.max(0, maxX - minX),
		height: Math.max(0, maxY - minY),
		candidateCommandIds: [command.id],
	};
};
