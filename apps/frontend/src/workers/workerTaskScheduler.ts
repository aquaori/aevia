import type { TaskClass } from "./taskTypes";

export type WorkerTaskPriority = "foreground" | "background" | TaskClass;

export interface ScheduleTaskOptions {
	key?: string;
	epoch?: number;
}

export interface SchedulerStats {
	executedByClass: Record<TaskClass, number>;
	coalescedByClass: Record<TaskClass, number>;
	cancelledCount: number;
	backgroundTurns: number;
	foregroundTurns: number;
}

interface QueuedTask {
	taskClass: TaskClass;
	key?: string;
	epoch?: number;
	enqueuedAt: number;
	run: (deadline: number) => void;
}

const normalizeTaskClass = (priority: WorkerTaskPriority): TaskClass => {
	if (priority === "foreground") return "reliable-ordered";
	return priority;
};

/**
 * Fair cooperative worker scheduler implementing:
 * - Lane classification (`reliable-ordered`, `latest-wins`, `replaceable`, `background`)
 * - Keyed coalescing/replacement for `latest-wins` and `replaceable`
 * - Epoch-based cancellation for stale background/init work
 * - Quota + age-based anti-starvation for background tasks
 */
export class WorkerTaskScheduler {
	private readonly lanes: Record<TaskClass, QueuedTask[]> = {
		"reliable-ordered": [],
		"latest-wins": [],
		"replaceable": [],
		"background": [],
	};
	private scheduled = false;
	private foregroundTurns = 0;
	private cancelledCount = 0;
	private backgroundTurns = 0;
	private activeEpoch = 0;
	private readonly executedByClass: Record<TaskClass, number> = {
		"reliable-ordered": 0,
		"latest-wins": 0,
		"replaceable": 0,
		"background": 0,
	};
	private readonly coalescedByClass: Record<TaskClass, number> = {
		"reliable-ordered": 0,
		"latest-wins": 0,
		"replaceable": 0,
		"background": 0,
	};
	private readonly maxForegroundBurst: number;
	private readonly backgroundAgeThresholdMs: number;
	private readonly sliceBudgetMs: number;

	constructor(options?: {
		maxForegroundBurst?: number;
		backgroundAgeThresholdMs?: number;
		sliceBudgetMs?: number;
	}) {
		this.maxForegroundBurst = options?.maxForegroundBurst ?? 3;
		this.backgroundAgeThresholdMs = options?.backgroundAgeThresholdMs ?? 32;
		this.sliceBudgetMs = options?.sliceBudgetMs ?? 4;
	}

	setActiveEpoch(epoch: number) {
		this.activeEpoch = Math.max(this.activeEpoch, epoch);
	}

	cancelEpoch(maxCancelledEpoch: number) {
		for (const lane of Object.values(this.lanes)) {
			for (let i = lane.length - 1; i >= 0; i -= 1) {
				const entry = lane[i]!;
				if (typeof entry.epoch === "number" && entry.epoch <= maxCancelledEpoch) {
					lane.splice(i, 1);
					this.cancelledCount += 1;
				}
			}
		}
	}

	cancelKey(key: string) {
		for (const lane of Object.values(this.lanes)) {
			for (let i = lane.length - 1; i >= 0; i -= 1) {
				if (lane[i]!.key === key) {
					lane.splice(i, 1);
					this.cancelledCount += 1;
				}
			}
		}
	}

	schedule(priority: WorkerTaskPriority, task: (deadline: number) => void, options?: ScheduleTaskOptions) {
		const taskClass = normalizeTaskClass(priority);
		if (typeof options?.epoch === "number" && options.epoch < this.activeEpoch) {
			this.cancelledCount += 1;
			return;
		}
		const lane = this.lanes[taskClass];
		const entry: QueuedTask = {
			taskClass,
			key: options?.key,
			epoch: options?.epoch,
			enqueuedAt: performance.now(),
			run: task,
		};

		if (options?.key && (taskClass === "latest-wins" || taskClass === "replaceable" || taskClass === "background")) {
			const existingIndex = lane.findIndex((queued) => queued.key === options.key);
			if (existingIndex >= 0) {
				lane[existingIndex] = entry;
				this.coalescedByClass[taskClass] += 1;
				this.ensureScheduled();
				return;
			}
		}

		lane.push(entry);
		this.ensureScheduled();
	}

	pendingCount(taskClass?: TaskClass): number {
		if (taskClass) return this.lanes[taskClass].length;
		return (
			this.lanes["reliable-ordered"].length +
			this.lanes["latest-wins"].length +
			this.lanes["replaceable"].length +
			this.lanes["background"].length
		);
	}

	stats(): SchedulerStats {
		return {
			executedByClass: { ...this.executedByClass },
			coalescedByClass: { ...this.coalescedByClass },
			cancelledCount: this.cancelledCount,
			backgroundTurns: this.backgroundTurns,
			foregroundTurns: this.foregroundTurns,
		};
	}

	private ensureScheduled() {
		if (this.scheduled) return;
		this.scheduled = true;
		setTimeout(this.runTurn, 0);
	}

	private hasForegroundWork() {
		return (
			this.lanes["reliable-ordered"].length > 0 ||
			this.lanes["latest-wins"].length > 0 ||
			this.lanes["replaceable"].length > 0
		);
	}

	private pickNextTask(now: number): QueuedTask | undefined {
		const bgHead = this.lanes.background[0];
		const shouldRunBackground =
			bgHead &&
			(!this.hasForegroundWork() ||
				this.foregroundTurns >= this.maxForegroundBurst ||
				now - bgHead.enqueuedAt >= this.backgroundAgeThresholdMs);
		if (shouldRunBackground) {
			this.foregroundTurns = 0;
			this.backgroundTurns += 1;
			return this.lanes.background.shift();
		}

		if (this.lanes["reliable-ordered"].length > 0) {
			this.foregroundTurns += 1;
			return this.lanes["reliable-ordered"].shift();
		}
		if (this.lanes["latest-wins"].length > 0) {
			this.foregroundTurns += 1;
			return this.lanes["latest-wins"].shift();
		}
		if (this.lanes["replaceable"].length > 0) {
			this.foregroundTurns += 1;
			return this.lanes["replaceable"].shift();
		}
		return undefined;
	}

	private readonly runTurn = () => {
		this.scheduled = false;
		const now = performance.now();
		const task = this.pickNextTask(now);
		if (task) {
			this.executedByClass[task.taskClass] += 1;
			task.run(now + this.sliceBudgetMs);
		}
		if (this.pendingCount() > 0) this.ensureScheduled();
	};
}
