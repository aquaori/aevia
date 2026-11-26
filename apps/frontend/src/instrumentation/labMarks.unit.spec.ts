import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../utils/editorEventBus";
import {
	LAB_MARK_LIMIT,
	labCounter,
	labDrainMarks,
	labEnabled,
	labMark,
	labSetEnabled,
	labSpanEnd,
	labSpanStart,
	mergeWorkerMarks,
} from "./labMarks";
import { createLabInstrumentationPlugin } from "./labPlugin";

describe("labMarks and labPlugin", () => {
	afterEach(() => {
		labSetEnabled(false);
		window.__AEVIA_LAB__!.marks.length = 0;
		window.__AEVIA_LAB__!.counters = {};
		window.__AEVIA_LAB__!.dropped = 0;
		vi.restoreAllMocks();
	});

	it("stays no-op when disabled and records marks/counters/spans/worker merges when enabled", () => {
		labSetEnabled(false);
		expect(labEnabled()).toBe(false);
		labMark("disabled.mark");
		labCounter("disabled.count");
		expect(labDrainMarks()).toEqual([]);

		labSetEnabled(true);
		expect(labEnabled()).toBe(true);
		labMark("boot", { step: 1 });
		labCounter("frames", 2);
		labSpanStart("init");
		labSpanEnd("init");
		mergeWorkerMarks([
			{ name: "worker.frame", thread: "worker", t: 12.5, detail: { count: 3 } },
			null as never,
		]);

		expect(window.__AEVIA_LAB__?.counters.frames).toBe(2);
		const drained = labDrainMarks();
		expect(drained.map((m) => m.name)).toEqual([
			"boot",
			"init.start",
			"init.end",
			"worker.frame",
		]);
		expect(labDrainMarks()).toEqual([]);
	});

	it("evicts oldest marks above LAB_MARK_LIMIT and wires session hooks when enabled", () => {
		labSetEnabled(true);
		for (let i = 0; i < LAB_MARK_LIMIT + 5; i += 1) {
			labMark("overflow");
		}
		expect(window.__AEVIA_LAB__?.marks.length).toBe(LAB_MARK_LIMIT);
		expect(window.__AEVIA_LAB__?.dropped).toBe(5);
		window.__AEVIA_LAB__!.marks.length = 0;

		const events = createEventBus();
		const host = { events } as never;
		labSetEnabled(false);
		const disabledDispose = createLabInstrumentationPlugin().setup(host);
		disabledDispose?.();

		labSetEnabled(true);
		const dispose = createLabInstrumentationPlugin().setup(host);
		events.emit("session:before-init", {});
		events.emit("session:ready", {});
		events.emit("collab:connected", {});
		events.emit("page:changed", { pageId: 2 });
		events.emit("render:before", { reason: "test" });
		events.emit("render:after", { reason: "test" });
		dispose?.();

		const names = labDrainMarks().map((m) => m.name);
		expect(names.length).toBeGreaterThanOrEqual(7);
	});
});
