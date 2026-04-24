// File role: reusable geometry helpers for boxes, hit testing, and command bounds.
import type { Command } from "./type";

// 计算单个命令包围盒
const getCommandBoundingBox = (cmd: Command, padding = 0) => {
	if (!cmd.points || cmd.points.length === 0) return null;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of cmd.points) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	return {
		minX: minX - padding,
		minY: minY - padding,
		maxX: maxX + padding,
		maxY: maxY + padding,
		width: maxX - minX + padding * 2,
		height: maxY - minY + padding * 2,
	};
};

// 计算多个命令的联合包围盒
const getGroupBoundingBox = (cmdIds: Set<string>, commands: Command[], currentPageId: number) => {
	if (cmdIds.size === 0) return null;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	let hasValid = false;

	cmdIds.forEach((id) => {
		const cmd = commands.find((c) => c.id === id);
		if (
			cmd &&
			!cmd.isDeleted &&
			cmd.pageId === currentPageId &&
			cmd.points &&
			cmd.points.length > 0
		) {
			const box = getCommandBoundingBox(cmd);
			if (box) {
				hasValid = true;
				if (box.minX < minX) minX = box.minX;
				if (box.minY < minY) minY = box.minY;
				if (box.maxX > maxX) maxX = box.maxX;
				if (box.maxY > maxY) maxY = box.maxY;
			}
		}
	});

	if (!hasValid) return null;
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
};

export { getCommandBoundingBox, getGroupBoundingBox };

