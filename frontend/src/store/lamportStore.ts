// File role: Lamport clock store and point ordering state for collaborative command streams.
import { defineStore } from "pinia";
import { ref } from "vue";
import { emitDirtyPointAdded } from "../service/dirtyPointBus";
import type { QueuePoint } from "../utils/type";

export const useLamportStore = defineStore("lamport", () => {
	const lamport = ref(0);
	const pointQueue: Record<number, QueuePoint[]> = {};
	const activeLamports: number[] = [];
	const MAX_QUEUE_LAMPORT_SIZE = 3;

	const getNextLamport = () => {
		lamport.value += 1;
		return lamport.value;
	};

	const syncLamport = (remoteVal: number | string) => {
		const rv = typeof remoteVal === "string" ? parseInt(remoteVal, 10) : remoteVal;
		if (isNaN(rv)) {
			return;
		}
		lamport.value = Math.max(lamport.value, rv);
	};

	const pushToQueue = (point: QueuePoint) => {
		const newLamport = point.lamport;

		if (activeLamports.length === 0) {
			activeLamports.push(newLamport);
			pointQueue[newLamport] = [point];
		} else {
			const minLamport = activeLamports[0] as number;
			const maxLamport = activeLamports[activeLamports.length - 1] as number;
			if (newLamport > maxLamport || (newLamport >= minLamport && newLamport <= maxLamport)) {
				if (!pointQueue[newLamport]) {
					pointQueue[newLamport] = [];
					activeLamports.push(newLamport);
					activeLamports.sort((a, b) => a - b);
				}
				pointQueue[newLamport].push(point);

				emitDirtyPointAdded(point);
			} else {
				emitDirtyPointAdded(point);
				return;
			}
		}

		if (activeLamports.length > MAX_QUEUE_LAMPORT_SIZE) {
			const oldestLamport = activeLamports.shift()!;
			delete pointQueue[oldestLamport];
		}
	};

	return { lamport, pointQueue, getNextLamport, syncLamport, pushToQueue };
});

