import { afterEach, expect, it, vi } from "vitest";
import { WorkerTaskScheduler } from "../workers/workerTaskScheduler";

afterEach(() => vi.useRealTimers());

it("keeps foreground order while giving background work a turn", () => {
	vi.useFakeTimers();
	const scheduler = new WorkerTaskScheduler();
	const order: string[] = [];
	for (let index = 0; index < 5; index += 1) scheduler.schedule("foreground", () => order.push(`f${index}`));
	scheduler.schedule("background", () => order.push("background"));
	vi.runAllTimers();
	expect(order).toEqual(["f0", "f1", "f2", "background", "f3", "f4"]);
});
