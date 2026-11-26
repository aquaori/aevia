import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@collaborative-whiteboard/shared";
import { PageHistoryCache } from "./pageHistoryCache";

describe("PageHistoryCache", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns null gracefully when indexedDB is unavailable", async () => {
		vi.stubGlobal("indexedDB", undefined);
		expect(await PageHistoryCache.open("r1", 100, "u1")).toBeNull();
	});

	it("isolates, persists, loads, and clears page history fragments by room instance and user", async () => {
		const backing = new Map<string, unknown>();
		const fakeDB = {
			objectStoreNames: { contains: () => true },
			createObjectStore: vi.fn(),
			transaction: (_store: string, _mode: string) => {
				const tx: Record<string, unknown> = {
					oncomplete: null,
					onerror: null,
					objectStore: () => ({
						get: (key: string) => {
							const req: Record<string, unknown> = { result: backing.get(key), onsuccess: null, onerror: null };
							queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
							return req;
						},
						put: (val: unknown, key: string) => {
							backing.set(key, structuredClone(val));
							queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
						},
						delete: (key: string) => {
							backing.delete(key);
							queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
						},
					}),
				};
				return tx;
			},
		};
		vi.stubGlobal("indexedDB", {
			open: () => {
				const req: Record<string, unknown> = { result: fakeDB, onsuccess: null, onerror: null, onupgradeneeded: null };
				queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
				return req;
			},
		});

		const cacheA = (await PageHistoryCache.open("room-1", 1000, "u1"))!;
		const cacheRecreatedRoom = (await PageHistoryCache.open("room-1", 2000, "u1"))!;
		const cmd: Command = {
			id: "old-1", type: "path", tool: "pen", color: "#000", size: 3, points: [], timestamp: 1,
			userId: "u1", roomId: "room-1", pageId: 0, isDeleted: false, lamport: 1,
			box: { minX: 0, minY: 0, maxX: 0.2, maxY: 0.2, width: 0.2, height: 0.2 },
		};
		await cacheA.save(0, { snapshotVersion: 12, cursor: "old-1", commands: [cmd] });
		expect(await cacheA.load(0)).toEqual({ snapshotVersion: 12, cursor: "old-1", commands: [cmd] });
		expect(await cacheRecreatedRoom.load(0)).toBeNull();
		await cacheA.delete(0);
		expect(await cacheA.load(0)).toBeNull();
	});
});
