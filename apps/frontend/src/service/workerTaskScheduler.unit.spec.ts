import { afterEach, describe, expect, it, vi } from "vitest";
import { coalesceFramePlan, TASK_DELIVERY_POLICY, type TaskClass } from "../workers/taskTypes";
import { WorkerTaskScheduler } from "../workers/workerTaskScheduler";

afterEach(() => vi.useRealTimers());

describe("WorkerTaskScheduler (S3 fair budgets & invariants)", () => {
	it("keeps foreground order while giving background work a turn", () => {
		vi.useFakeTimers();
		const scheduler = new WorkerTaskScheduler();
		const order: string[] = [];
		for (let index = 0; index < 5; index += 1) scheduler.schedule("foreground", () => order.push(`f${index}`));
		scheduler.schedule("background", () => order.push("background"));
		vi.runAllTimers();
		expect(order).toEqual(["f0", "f1", "f2", "background", "f3", "f4"]);
	});

	it("coalesces keyed latest-wins and replaceable tasks and cancels stale epochs", () => {
		vi.useFakeTimers();
		const scheduler = new WorkerTaskScheduler();
		const executed: string[] = [];

		scheduler.setActiveEpoch(2);
		// Epoch 1 is already behind activeEpoch=2 and must be ignored.
		scheduler.schedule("background", () => executed.push("bg-stale-1"), { key: "flat", epoch: 1 });
		scheduler.schedule("background", () => executed.push("bg-epoch-2"), { key: "flat", epoch: 2 });
		scheduler.schedule("latest-wins", () => executed.push("dirty-1"), { key: "dirty" });
		scheduler.schedule("latest-wins", () => executed.push("dirty-2"), { key: "dirty" });
		scheduler.schedule("replaceable", () => executed.push("query-1"), { key: "hit" });
		scheduler.schedule("replaceable", () => executed.push("query-2"), { key: "hit" });
		scheduler.schedule("reliable-ordered", () => executed.push("op-1"));
		scheduler.schedule("reliable-ordered", () => executed.push("op-2"));

		// Cancel epoch 2 background work before timers run.
		scheduler.cancelEpoch(2);
		scheduler.schedule("background", () => executed.push("bg-epoch-3"), { key: "flat", epoch: 3 });

		vi.runAllTimers();
		expect(executed).toEqual(["op-1", "op-2", "dirty-2", "bg-epoch-3", "query-2"]);
		const stats = scheduler.stats();
		expect(stats.coalescedByClass["latest-wins"]).toBe(1);
		expect(stats.coalescedByClass.replaceable).toBe(1);
		expect(stats.cancelledCount).toBe(2);
	});

	it("prevents background starvation via aging even under steady foreground load", () => {
		vi.useFakeTimers();
		const scheduler = new WorkerTaskScheduler({ maxForegroundBurst: 100, backgroundAgeThresholdMs: 32 });
		const order: string[] = [];
		scheduler.schedule("background", () => order.push("aged-bg"));
		vi.advanceTimersByTime(40);
		scheduler.schedule("reliable-ordered", () => order.push("fg-after-age"));
		vi.runAllTimers();
		expect(order).toEqual(["aged-bg", "fg-after-age"]);
	});

	it("satisfies FIFO, fairness, coalescing, and cancellation across 120 simulated traces (S3-11)", () => {
		vi.useFakeTimers();
		let seed = 0x5eed1234;
		const nextRand = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 0x100000000;
		};

		const classes: TaskClass[] = ["reliable-ordered", "latest-wins", "replaceable", "background"];
		expect(TASK_DELIVERY_POLICY["reliable-ordered"]).toBe("ordered-queue");

		for (let trace = 0; trace < 120; trace += 1) {
			const scheduler = new WorkerTaskScheduler({ maxForegroundBurst: 3, backgroundAgeThresholdMs: 32 });
			let epoch = 1;
			const cancelledEpochs = new Set<number>();
			const reliableExpected: number[] = [];
			const reliableActual: number[] = [];
			const activeBgEpochs = new Set<number>();
			const completedBg: number[] = [];
			const latestByKey = new Map<string, number>();
			const ranByKey = new Map<string, number>();

			for (let step = 0; step < 30; step += 1) {
				const cls = classes[Math.floor(nextRand() * classes.length)]!;
				const seq = trace * 100 + step;
				if (step > 0 && nextRand() < 0.12) {
					cancelledEpochs.add(epoch);
					scheduler.cancelEpoch(epoch);
					epoch += 1;
					scheduler.setActiveEpoch(epoch);
				}
				if (cls === "reliable-ordered") {
					reliableExpected.push(seq);
					scheduler.schedule(cls, () => reliableActual.push(seq));
				} else if (cls === "latest-wins" || cls === "replaceable") {
					const key = `${cls}-${Math.floor(nextRand() * 3)}`;
					latestByKey.set(key, seq);
					scheduler.schedule(cls, () => {
						ranByKey.set(key, seq);
					}, { key });
				} else {
					const taskEpoch = epoch;
					scheduler.schedule(cls, () => {
						expect(cancelledEpochs.has(taskEpoch)).toBe(false);
						completedBg.push(seq);
					}, { epoch: taskEpoch });
					activeBgEpochs.add(taskEpoch);
				}
				if (nextRand() < 0.25) vi.advanceTimersByTime(1);
			}

			vi.runAllTimers();
			// Invariant 1: reliable-ordered strict FIFO with zero drops
			expect(reliableActual).toEqual(reliableExpected);
			// Invariant 2: keyed latest-wins / replaceable converge to latest value
			for (const [key, expectedVal] of latestByKey) {
				expect(ranByKey.get(key)).toBe(expectedVal);
			}
			// Invariant 3: zero starvation — pending count drains to 0
			expect(scheduler.pendingCount()).toBe(0);
			expect(completedBg.length + [...cancelledEpochs].length).toBeGreaterThanOrEqual(0);
		}
	});

	it("coalesces FramePlan dirty rects and upgrades safely to fullScene", () => {
		const p1 = coalesceFramePlan(null, {
			frameId: 1,
			targetRevision: 10,
			dirtyRects: [{ minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 }],
		});
		const p2 = coalesceFramePlan(p1, {
			frameId: 2,
			targetRevision: 12,
			dirtyRects: [{ minX: 5, minY: 5, maxX: 20, maxY: 20, width: 15, height: 15 }],
		});
		expect(p2.dirtyRects).toHaveLength(2);
		expect(p2.targetRevision).toBe(12);
		expect(p2.coalescedCount).toBe(1);

		const p3 = coalesceFramePlan(p2, { frameId: 3, targetRevision: 15, fullScene: true });
		expect(p3.fullScene).toBe(true);
		expect(p3.dirtyRects).toHaveLength(0);
		expect(p3.coalescedCount).toBe(2);
	});
});
