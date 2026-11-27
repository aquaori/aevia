// Pending operations are scoped to the room instance and actor, so reusing a
// room number cannot replay operations from the deleted room.
export class PendingSceneStore {
	private sequence = 0;
	private readonly db: IDBDatabase;
	private readonly prefix: string;
	private writes: Array<{ action: (store: IDBObjectStore) => void; resolve: () => void; reject: (reason: unknown) => void }> = [];
	private constructor(db: IDBDatabase, prefix: string) {
		this.db = db;
		this.prefix = prefix;
	}

	static async open(roomId: string, roomCreatedAt: number, userId: string): Promise<PendingSceneStore> {
		const request = indexedDB.open("aevia-pending-scene", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("operations");
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return new PendingSceneStore(db, `${JSON.stringify([roomId, roomCreatedAt, userId])}\u0000`);
	}

	async load(): Promise<Array<[string, unknown]>> {
		const range = IDBKeyRange.bound(this.prefix, `${this.prefix}\uffff`);
		return new Promise((resolve, reject) => {
			const entries: Array<{ id: string; order: number; value: unknown }> = [];
			const transaction = this.db.transaction("operations", "readonly");
			const request = transaction.objectStore("operations").openCursor(range);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const record = cursor.value as { order: number; value: unknown };
				entries.push({ id: (cursor.key as string).slice(this.prefix.length), ...record });
				cursor.continue();
			};
			transaction.oncomplete = () => {
				entries.sort((a, b) => a.order - b.order);
				this.sequence = entries[entries.length - 1]?.order ?? 0;
				resolve(entries.map(({ id, value }) => [id, value]));
			};
			transaction.onabort = () => reject(transaction.error);
		});
	}

	private change(action: (store: IDBObjectStore) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			this.writes.push({ action, resolve, reject });
			if (this.writes.length === 1) queueMicrotask(() => this.flush());
		});
	}

	private flush() {
		const writes = this.writes.splice(0);
		try {
			const transaction = this.db.transaction("operations", "readwrite");
			const store = transaction.objectStore("operations");
			for (const write of writes) write.action(store);
			transaction.oncomplete = () => { for (const write of writes) write.resolve(); };
			transaction.onabort = () => { for (const write of writes) write.reject(transaction.error); };
		} catch (error) {
			for (const write of writes) write.reject(error);
		}
	}

	put(id: string, value: unknown): Promise<void> {
		this.sequence = Math.max(Date.now() * 1000, this.sequence + 1);
		const order = this.sequence;
		return this.change((store) => { store.put({ order, value }, this.prefix + id); });
	}

	delete(id: string): Promise<void> {
		return this.change((store) => { store.delete(this.prefix + id); });
	}
}
