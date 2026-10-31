import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { QueuePoint } from "@collaborative-whiteboard/shared";
import { onDirtyPointAdded } from "../service/dirtyPointBus";
import { useLamportStore } from "./lamportStore";

const point = (lamport: number): QueuePoint => ({
	x: 0.1,
	y: 0.2,
	p: 0.5,
	lamport,
	cmdId: "cmd-1",
	userId: "user-1",
	tool: "pen",
	color: "#111111",
	size: 3,
	isDeleted: false,
	lastX: 0,
	lastY: 0,
	lastWidth: 0,
});

describe("lamport store", () => {
	let unsubscribe: (() => void) | undefined;

	beforeEach(() => {
		setActivePinia(createPinia());
	});

	afterEach(() => {
		unsubscribe?.();
		unsubscribe = undefined;
	});

	it("advances the lamport clock and never moves backwards", () => {
		const store = useLamportStore();
		expect(store.getNextLamport()).toBe(1);
		expect(store.getNextLamport()).toBe(2);
		expect(store.lamport).toBe(2);

		store.syncLamport(10);
		expect(store.lamport).toBe(10);
		store.syncLamport(4);
		expect(store.lamport).toBe(10);
		store.syncLamport("12");
		expect(store.lamport).toBe(12);
		store.syncLamport("not-a-number");
		expect(store.lamport).toBe(12);
	});

	it("keeps only the newest few lamport queues", () => {
		const store = useLamportStore();
		for (let lamport = 1; lamport <= 5; lamport += 1) store.pushToQueue(point(lamport));

		expect(Object.keys(store.pointQueue)).toEqual(["3", "4", "5"]);
		for (const lamport of [3, 4, 5]) {
			expect(store.pointQueue[lamport]).toHaveLength(1);
		}
	});

	it("batches points that share a lamport value", () => {
		const emitted: QueuePoint[] = [];
		unsubscribe = onDirtyPointAdded((item) => emitted.push(item));
		const store = useLamportStore();

		store.pushToQueue(point(1));
		store.pushToQueue(point(1));

		expect(store.pointQueue[1]).toHaveLength(2);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]!.lamport).toBe(1);
	});

	it("forwards out-of-order points to the dirty bus without queueing them", () => {
		const emitted: QueuePoint[] = [];
		unsubscribe = onDirtyPointAdded((item) => emitted.push(item));
		const store = useLamportStore();

		store.pushToQueue(point(1));
		store.pushToQueue(point(2));
		store.pushToQueue(point(3));
		expect(emitted).toHaveLength(2);

		// A late point below the active window is still rendered immediately.
		store.pushToQueue(point(0));
		expect(store.pointQueue[0]).toBeUndefined();
		expect(Object.keys(store.pointQueue)).toEqual(["1", "2", "3"]);
		expect(emitted).toHaveLength(3);
		expect(emitted[2]!.lamport).toBe(0);
	});

	it("does not emit the very first point because it opens the queue", () => {
		const emit = vi.fn();
		unsubscribe = onDirtyPointAdded(emit);
		const store = useLamportStore();

		store.pushToQueue(point(7));
		expect(emit).not.toHaveBeenCalled();
		store.pushToQueue(point(8));
		expect(emit).toHaveBeenCalledTimes(1);
	});
});
