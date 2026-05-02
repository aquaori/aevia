import type { Page } from "playwright";

export const installPerformanceObserver = async (page: Page) => {
	await page.addInitScript(() => {
		const state = {
			longTasks: [] as Array<{ startTime: number; duration: number }>,
			events: [] as Array<{ name: string; startTime: number; duration: number; processingStart?: number }>,
			paints: [] as Array<{ name: string; startTime: number }>,
		};
		(window as any).__externalPerf = state;

		if ("PerformanceObserver" in window) {
			try {
				const longTaskObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
					}
				});
				longTaskObserver.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
			} catch {
				// Browser does not expose longtask in every mode.
			}

			try {
				const eventObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as PerformanceEventTiming[]) {
						state.events.push({
							name: entry.name,
							startTime: entry.startTime,
							duration: entry.duration,
							processingStart: entry.processingStart,
						});
					}
				});
				eventObserver.observe({ type: "event", buffered: true, durationThreshold: 0 } as PerformanceObserverInit);
			} catch {
				// Event Timing is not always available.
			}

			try {
				const paintObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						state.paints.push({ name: entry.name, startTime: entry.startTime });
					}
				});
				paintObserver.observe({ type: "paint", buffered: true } as PerformanceObserverInit);
			} catch {
				// Paint Timing is best-effort in tests.
			}
		}
	});
};

export const readPerformanceObserver = async (page: Page) =>
	page.evaluate(() => {
		const state = (window as any).__externalPerf || { longTasks: [], events: [], paints: [] };
		return {
			longTaskCount: state.longTasks.length,
			longTaskTotalMs: state.longTasks.reduce((sum: number, item: { duration: number }) => sum + item.duration, 0),
			eventDelayMaxMs: state.events.reduce(
				(max: number, item: { startTime: number; processingStart?: number }) =>
					Math.max(max, item.processingStart ? item.processingStart - item.startTime : 0),
				0
			),
			events: state.events.slice(-20),
			paints: state.paints,
		};
	});
