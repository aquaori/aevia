// File role: lightweight event bridge for dirty-point notifications between layers.
import { createEventBus } from "../utils/editorEventBus";
import type { QueuePoint } from "../utils/type";

interface DirtyPointEventMap {
	"point:added": QueuePoint;
}

const dirtyPointBus = createEventBus<DirtyPointEventMap>();

export const emitDirtyPointAdded = (point: QueuePoint) => {
	dirtyPointBus.emit("point:added", point);
};

export const onDirtyPointAdded = (handler: (point: QueuePoint) => void) =>
	dirtyPointBus.on("point:added", handler);

