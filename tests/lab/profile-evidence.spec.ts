import { describe, expect, it } from "vitest";
import { criticalPath, summarizeSpans, wireMetrics, type Wire } from "../profile/analysis";
import { traceCpuTargets } from "../profile/collectors";

describe("profile evidence", () => {
	it("recomputes the longest dependency when eliminating a bottleneck", () => {
		const stages = [{ id: "start", ms: 3, after: [] }, { id: "heavy", ms: 8, after: ["start"] },
			{ id: "other", ms: 5, after: ["start"] }, { id: "end", ms: 1, after: ["heavy", "other"] }];
		expect(criticalPath(stages, "end")).toEqual({ ms: 12, path: ["start", "heavy", "end"] });
		expect(criticalPath(stages, "end", "heavy")).toEqual({ ms: 9, path: ["start", "other", "end"] });
	});
	it("pairs durability and remote receive by operation identity without reusing duplicates", () => {
		const wire = (t: number, target: number, direction: Wire["direction"], type: string, id: string): Wire =>
			({ t, target, direction, type, id, bytes: 20 });
		expect(wireMetrics([
			wire(2, 0, "send", "push-cmd", "a"), wire(4, 0, "send", "push-cmd", "a"),
			wire(12, 0, "receive", "ack.accepted", "a"), wire(13, 0, "receive", "ack.accepted", "a"),
			wire(15, 1, "receive", "push-cmd", "a"), wire(25, 0, "receive", "ack.accepted", "b"),
		])).toEqual({ acknowledgements: [10], remoteDeliveries: [13], committed: 2, submitted: 1, lastAccepted: 25 });
	});
	it("ranks the sampled worker leaf separately from its parent and reports elapsed span calls", () => {
		const frame = (functionName: string) => ({ functionName, url: "/worker.js", lineNumber: 0, columnNumber: 0 });
		const [profile] = traceCpuTargets(JSON.stringify({ traceEvents: [
			{ name: "thread_name", pid: 3, tid: 5, args: { name: "DedicatedWorker" } },
			{ name: "ProfileChunk", pid: 3, tid: 5, id: "1", args: { data: { cpuProfile: {
				nodes: [{ id: 1, callFrame: frame("parent") }, { id: 2, parent: 1, callFrame: frame("child") }], samples: [2, 2],
			}, timeDeltas: [1000, 2000] } } },
		] }));
		expect(profile?.thread).toBe("DedicatedWorker");
		expect(profile?.rows.map(row => [row.name.split(" ")[0], row.selfMs, row.totalMs])).toEqual([["child", 3, 3], ["parent", 0, 3]]);
		expect(summarizeSpans([{ name: "queue", startMs: 3, endMs: 9 }, { name: "queue", startMs: 10, endMs: 12 }]))
			.toEqual([{ name: "queue", calls: 2, inclusiveMs: 8, longestMs: 6 }]);
	});
});
