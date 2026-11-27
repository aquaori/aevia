import { describe, expect, it } from "vitest";
import { criticalPath, summarizeSpans, summarizeTimelineTrace, wireMetrics, type Wire } from "../profile/analysis";
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
	it("summarizes timeline busy%, Swap FPS, PipelineReporter drop rate, and time buckets", () => {
		const summary = summarizeTimelineTrace({
			traceEvents: [
				{ ph: "M", name: "thread_name", pid: 1, tid: 10, args: { name: "CrRendererMain" } },
				{ ph: "M", name: "thread_name", pid: 1, tid: 20, args: { name: "DedicatedWorker thread" } },
				{ ph: "M", name: "thread_name", pid: 1, tid: 30, args: { name: "Compositor" } },
				{ ph: "I", name: "TracingStartedInBrowser", pid: 1, tid: 10, ts: 1_000_000 },
				{ ph: "X", name: "RunTask", pid: 1, tid: 10, ts: 1_100_000, dur: 20_000 },
				{ ph: "X", name: "RunTask", pid: 1, tid: 20, ts: 1_200_000, dur: 5_000 },
				{ ph: "I", name: "BeginFrame", pid: 1, tid: 30, ts: 1_000_000 },
				{ ph: "I", name: "BeginFrame", pid: 1, tid: 30, ts: 1_016_667 },
				{ ph: "b", name: "Swap", pid: 1, tid: 30, ts: 1_020_000 },
				{ ph: "b", name: "Swap", pid: 1, tid: 30, ts: 1_036_667 },
				{ ph: "b", name: "PipelineReporter", pid: 1, tid: 30, ts: 1_040_000, args: { frame_reporter: { state: "STATE_PRESENTED_ALL", affects_smoothness: false } } },
				{ ph: "b", name: "PipelineReporter", pid: 1, tid: 30, ts: 1_060_000, args: { frame_reporter: { state: "STATE_DROPPED", affects_smoothness: true } } },
				{ ph: "I", name: "Marker", pid: 1, tid: 10, ts: 2_000_000 },
			],
		}, { bucketMs: 500 });
		expect(summary.durationMs).toBe(1000);
		expect(summary.threads.find(t => t.thread === "Main")).toMatchObject({ tasks: 1, totalBusyMs: 20, busyPct: 2, over16_7ms: 1 });
		expect(summary.threads.find(t => t.thread === "Worker")).toMatchObject({ tasks: 1, totalBusyMs: 5, busyPct: 0.5 });
		expect(summary.fps).toMatchObject({ compositorSwapCount: 2, swapFps: 2, pipelineTotal: 2, pipelineDroppedSmoothness: 1, dropRatePct: 50 });
		expect(summary.buckets).toHaveLength(2);
		expect(summary.buckets[0]!.mainBusyPct).toBe(4);
	});
});
