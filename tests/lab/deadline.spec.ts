import { describe, expect, it, vi } from "vitest";
import { withDeadline } from "../../apps/frontend/tests/e2e/external/deadline";
import { beginLabScope, endLabScope, trackLabPage } from "../../apps/frontend/tests/e2e/external/lab/install";
import type { Page } from "playwright";

describe("host measurement deadline", () => {
	it("bounds an unresolved browser command without a browser timer", async () => {
		vi.useFakeTimers();
		try {
			const result = withDeadline(new Promise(() => {}), 100, "render");
			const rejection = expect(result).rejects.toThrow("host deadline");
			await vi.advanceTimersByTimeAsync(100);
			await rejection;
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});
	it("clears its watchdog on completion or rejection", async () => {
		vi.useFakeTimers();
		try {
			await expect(withDeadline(Promise.resolve(42), 100, "render")).resolves.toBe(42);
			await expect(withDeadline(Promise.reject(new Error("browser crashed")), 100, "render")).rejects.toThrow("browser crashed");
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});
	it("closes each scoped browser context once after a sample", async () => {
		const context = { close: vi.fn().mockResolvedValue(undefined) };
		beginLabScope();
		trackLabPage({ context: () => context } as unknown as Page);
		trackLabPage({ context: () => context } as unknown as Page);
		await endLabScope();
		expect(context.close).toHaveBeenCalledTimes(1);
	});
	it("bounds cleanup when a browser context cannot close", async () => {
		vi.useFakeTimers();
		try {
			beginLabScope();
			trackLabPage({ context: () => ({ close: () => new Promise(() => {}) }) } as unknown as Page);
			const cleanup = expect(endLabScope()).rejects.toThrow("sample page cleanup timeout");
			await vi.advanceTimersByTimeAsync(5000);
			await cleanup;
		} finally { vi.useRealTimers(); }
	});
});
