import type { AabbBox } from "@collaborative-whiteboard/shared";

/**
 * Scheduling lane classification aligned with V3 S3 fair worker budgets:
 * - `reliable-ordered`: FIFO state mutations that must preserve exact arrival order.
 * - `latest-wins`: keyed intermediate operations where only the latest pending value matters.
 * - `replaceable`: keyed queries/projections where newer requests supersede stale unstarted ones.
 * - `background`: sliceable catch-up or projection tasks protected by aging and burst quotas.
 */
export type TaskClass = "reliable-ordered" | "latest-wins" | "replaceable" | "background";

export type DeliveryPolicy = "ordered-queue" | "coalesce-key" | "replace-key" | "cancellable-epoch";

export const TASK_DELIVERY_POLICY: Record<TaskClass, DeliveryPolicy> = {
	"reliable-ordered": "ordered-queue",
	"latest-wins": "coalesce-key",
	"replaceable": "replace-key",
	"background": "cancellable-epoch",
};

export interface FramePlan {
	frameId: number;
	targetRevision: number;
	dirtyRects: AabbBox[];
	fullScene: boolean;
	transformingIds: string[];
	coalescedCount: number;
}

export const createEmptyFramePlan = (frameId: number, targetRevision: number): FramePlan => ({
	frameId,
	targetRevision,
	dirtyRects: [],
	fullScene: false,
	transformingIds: [],
	coalescedCount: 0,
});

export const coalesceFramePlan = (
	current: FramePlan | null,
	incoming: {
		frameId: number;
		targetRevision: number;
		dirtyRects?: AabbBox[];
		fullScene?: boolean;
		transformingIds?: string[];
	}
): FramePlan => {
	const base = current ?? createEmptyFramePlan(incoming.frameId, incoming.targetRevision);
	const rects = incoming.fullScene || base.fullScene
		? []
		: [...base.dirtyRects, ...(incoming.dirtyRects ?? [])];
	return {
		frameId: incoming.frameId,
		targetRevision: Math.max(base.targetRevision, incoming.targetRevision),
		dirtyRects: rects,
		fullScene: base.fullScene || Boolean(incoming.fullScene),
		transformingIds: incoming.transformingIds ?? base.transformingIds,
		coalescedCount: current ? current.coalescedCount + 1 : 0,
	};
};
