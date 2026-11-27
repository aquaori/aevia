import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingSceneStore } from "./pendingSceneStore";

describe("PendingSceneStore", () => {
	const records = new Map<string, { order: number; value: unknown }>();
	let openFail = false;
	let txFail = false;

	beforeEach(() => {
		records.clear();
		openFail = false;
		txFail = false;

		vi.stubGlobal("IDBKeyRange", {
			bound: (lower: string, upper: string) => ({ lower, upper }),
		});

		vi.stubGlobal("indexedDB", {
			open: () => {
				const db = {
					createObjectStore: vi.fn(),
					transaction: (_storeName: string, mode: string) => {
						if (txFail) throw new Error("tx open failed");
						const tx: {
							oncomplete: (() => void) | null;
							onabort: (() => void) | null;
							error: Error | null;
							objectStore: () => Record<string, unknown>;
						} = {
							oncomplete: null,
							onabort: null,
							error: new Error("aborted"),
							objectStore: () => ({
								put: (val: { order: number; value: unknown }, key: string) => {
									records.set(key, val);
								},
								delete: (key: string) => {
									records.delete(key);
								},
								openCursor: (range: { lower: string; upper: string }) => {
									const req: { onsuccess: (() => void) | null; result: unknown } = {
										onsuccess: null,
										result: null,
									};
									queueMicrotask(() => {
										const matched = [...records.entries()].filter(
											([k]) => k >= range.lower && k <= range.upper,
										);
										let idx = 0;
										const advance = () => {
											if (idx >= matched.length) {
												req.result = null;
												req.onsuccess?.();
												tx.oncomplete?.();
												return;
											}
											const [key, value] = matched[idx++];
											req.result = {
												key,
												value,
												continue: advance,
											};
											req.onsuccess?.();
										};
										advance();
									});
									return req;
								},
							}),
						};
						if (mode !== "readonly") {
							queueMicrotask(() => {
								tx.oncomplete?.();
							});
						}
						return tx;
					},
				};
				const req: {
					result: unknown;
					error: Error;
					onupgradeneeded: (() => void) | null;
					onsuccess: (() => void) | null;
					onerror: (() => void) | null;
				} = {
					result: db,
					error: new Error("open failed"),
					onupgradeneeded: null,
					onsuccess: null,
					onerror: null,
				};
				queueMicrotask(() => {
					if (openFail) {
						req.onerror?.();
						return;
					}
					req.onupgradeneeded?.();
					req.onsuccess?.();
				});
				return req;
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("opens, puts, loads in order, deletes, and surfaces errors", async () => {
		const store = await PendingSceneStore.open("r1", 100, "u1");
		await Promise.all([store.put("b", { x: 2 }), store.put("a", { x: 1 })]);
		records.set('["other",1,"u2"]\u0000ignored', { order: 1, value: { z: 9 } });

		const loaded = await store.load();
		expect(loaded).toEqual([
			["b", { x: 2 }],
			["a", { x: 1 }],
		]);

		await store.delete("b");
		expect(await store.load()).toEqual([["a", { x: 1 }]]);

		txFail = true;
		await expect(store.put("c", { x: 3 })).rejects.toThrow("tx open failed");

		openFail = true;
		await expect(PendingSceneStore.open("r1", 100, "u1")).rejects.toThrow("open failed");
	});
});
