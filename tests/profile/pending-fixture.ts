import { PendingSceneStore } from "../../apps/frontend/src/service/pendingSceneStore";

export async function measure(count: number, pointsPerOperation = 0) {
	const room = crypto.randomUUID();
	const store = await PendingSceneStore.open(room, 1, "profile");
	const points = Array.from({ length: pointsPerOperation }, (_, index) => ({ x: index / 100, y: index / 200, p: 0.5 }));
	const started = performance.now();
	await Promise.all(Array.from({ length: count }, (_, index) => store.put(`op-${index}`, { index, points })));
	const writeMs = performance.now() - started;
	const loadStarted = performance.now();
	const loaded = await store.load();
	const loadMs = performance.now() - loadStarted;
	if (loaded.length !== count || loaded.some(([id, value], index) => id !== `op-${index}` || (value as { index: number; points: unknown[] }).index !== index || (value as { points: unknown[] }).points.length !== pointsPerOperation)) {
		throw new Error("Pending operations failed order or content check");
	}
	const deleteStarted = performance.now();
	await Promise.all(loaded.map(([id]) => store.delete(id)));
	const deleteMs = performance.now() - deleteStarted;
	if ((await store.load()).length !== 0) throw new Error("Pending operations were not removed");
	return { count, pointsPerOperation, writeMs, loadMs, deleteMs };
}
