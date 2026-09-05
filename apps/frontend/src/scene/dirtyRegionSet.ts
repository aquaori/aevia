// File role: preserves small disjoint dirty regions and decides full-render fallback.
import type { AabbBox } from "@collaborative-whiteboard/shared";

const MAX_DIRTY_RECTS = 8;
const FULL_AREA_RATIO = 0.35;
const FULL_CANDIDATE_RATIO = 0.4;
const EXIT_FULL_AREA_RATIO = 0.25;
const EXIT_FULL_CANDIDATE_RATIO = 0.3;

const intersects = (left: AabbBox, right: AabbBox) =>
	!(left.maxX < right.minX || left.minX > right.maxX || left.maxY < right.minY || left.minY > right.maxY);

const merge = (left: AabbBox, right: AabbBox): AabbBox => {
	const minX = Math.min(left.minX, right.minX);
	const minY = Math.min(left.minY, right.minY);
	const maxX = Math.max(left.maxX, right.maxX);
	const maxY = Math.max(left.maxY, right.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

export class DirtyRegionSet {
	private readonly regions: AabbBox[] = [];
	private overflowed = false;

	add(input: AabbBox) {
		let current = { ...input };
		for (let index = this.regions.length - 1; index >= 0; index -= 1) {
			const region = this.regions[index]!;
			if (!intersects(current, region)) continue;
			current = merge(current, region);
			this.regions.splice(index, 1);
		}
		this.regions.push(current);
		if (this.regions.length > MAX_DIRTY_RECTS) this.overflowed = true;
	}

	clear() {
		this.regions.length = 0;
		this.overflowed = false;
	}

	toArray() {
		return this.regions.map((region) => ({ ...region }));
	}

	shouldRenderFull(
		viewportWidth: number,
		viewportHeight: number,
		candidates: number,
		visible: number,
		retainFullMode = false
	) {
		if (this.overflowed) return true;
		const canvasArea = Math.max(1, viewportWidth * viewportHeight);
		const dirtyArea = this.regions.reduce((sum, region) => sum + region.width * region.height, 0);
		const areaRatio = dirtyArea / canvasArea;
		const candidateRatio = visible > 0 ? candidates / visible : 0;
		if (retainFullMode) {
			return areaRatio >= EXIT_FULL_AREA_RATIO || candidateRatio >= EXIT_FULL_CANDIDATE_RATIO;
		}
		return areaRatio >= FULL_AREA_RATIO || candidateRatio >= FULL_CANDIDATE_RATIO;
	}
}

export const dirtyRegionConstants = {
	maxRects: MAX_DIRTY_RECTS,
	fullAreaRatio: FULL_AREA_RATIO,
	fullCandidateRatio: FULL_CANDIDATE_RATIO,
	exitFullAreaRatio: EXIT_FULL_AREA_RATIO,
	exitFullCandidateRatio: EXIT_FULL_CANDIDATE_RATIO,
};
