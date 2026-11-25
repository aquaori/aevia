import type { Command } from "@collaborative-whiteboard/shared";

export interface PageHistoryFragmentSnapshot {
	snapshotVersion: number;
	cursor: string;
	commands: Command[];
}

const MAX_CACHED_COMMANDS_PER_PAGE = 20000;

/**
 * Persists partial `page-history` backfill progress in IndexedDB so reloading
 * mid-backfill can resume from the last durable cursor instead of restarting.
 */
export class PageHistoryCache {
	private readonly db: IDBDatabase;
	private readonly prefix: string;

	private constructor(db: IDBDatabase, prefix: string) {
		this.db = db;
		this.prefix = prefix;
	}

	static async open(roomId: string, roomCreatedAt: number, userId: string): Promise<PageHistoryCache | null> {
		if (typeof indexedDB === "undefined") return null;
		try {
			const request = indexedDB.open("aevia-page-history", 1);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains("fragments")) {
					request.result.createObjectStore("fragments");
				}
			};
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			return new PageHistoryCache(db, `${JSON.stringify([roomId, roomCreatedAt, userId])}\u0000`);
		} catch {
			return null;
		}
	}

	private keyFor(pageId: number): string {
		return `${this.prefix}${pageId}`;
	}

	async load(pageId: number): Promise<PageHistoryFragmentSnapshot | null> {
		try {
			return await new Promise<PageHistoryFragmentSnapshot | null>((resolve, reject) => {
				const tx = this.db.transaction("fragments", "readonly");
				const req = tx.objectStore("fragments").get(this.keyFor(pageId));
				req.onsuccess = () => {
					const raw = req.result as PageHistoryFragmentSnapshot | undefined;
					if (
						!raw ||
						typeof raw.snapshotVersion !== "number" ||
						typeof raw.cursor !== "string" ||
						!Array.isArray(raw.commands)
					) {
						resolve(null);
						return;
					}
					resolve(raw);
				};
				req.onerror = () => reject(req.error);
			});
		} catch {
			return null;
		}
	}

	async save(pageId: number, fragment: PageHistoryFragmentSnapshot): Promise<void> {
		if (!fragment.cursor || fragment.commands.length > MAX_CACHED_COMMANDS_PER_PAGE) return;
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = this.db.transaction("fragments", "readwrite");
				tx.objectStore("fragments").put(fragment, this.keyFor(pageId));
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch {
			// Ignore quota / teardown errors: history falls back cleanly to a fresh pull.
		}
	}

	async delete(pageId: number): Promise<void> {
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = this.db.transaction("fragments", "readwrite");
				tx.objectStore("fragments").delete(this.keyFor(pageId));
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch {
			// Ignore cleanup failures.
		}
	}
}
