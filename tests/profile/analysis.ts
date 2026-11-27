export type Span = { name: string; startMs: number; endMs: number; count?: number };
export type Wire = { t: number; target: number; direction: "send" | "receive"; type: string; id?: string; seq?: number; bytes: number; code?: string; reason?: string };

export function summarizeSpans(rows: Span[]) {
	const grouped = new Map<string, { name: string; calls: number; inclusiveMs: number; longestMs: number }>();
	for (const span of rows) {
		const duration = span.endMs - span.startMs;
		if (!Number.isFinite(duration) || duration < 0) continue;
		const entry = grouped.get(span.name) ?? { name: span.name, calls: 0, inclusiveMs: 0, longestMs: 0 };
		entry.calls++;
		entry.inclusiveMs += duration;
		entry.longestMs = Math.max(entry.longestMs, duration);
		grouped.set(span.name, entry);
	}
	return [...grouped.values()].sort((a, b) => b.inclusiveMs - a.inclusiveMs);
}

export function wireMetrics(events: Wire[]) {
	const pending = new Map<string, Wire>();
	const accepted = new Map<string, Wire>();
	const acknowledgements: number[] = [], remoteDeliveries: number[] = [];
	for (const event of events) {
		if (!event.id) continue;
		const key = `${event.target}:${event.id}`;
		if (event.direction === "send" && (event.type === "push-cmd" || event.type === "binary-scene-append") && !pending.has(key)) pending.set(key, event);
		if (event.direction === "receive" && event.type === "ack.accepted" && !accepted.has(key)) {
			accepted.set(key, event);
			const sent = pending.get(key);
			if (sent) acknowledgements.push(event.t - sent.t);
		}
		if (event.direction === "receive" && event.type === "push-cmd") {
			const sent = [...pending.values()].find(op => op.id === event.id && op.target !== event.target);
			if (sent) remoteDeliveries.push(event.t - sent.t);
		}
	}
	return { acknowledgements, remoteDeliveries, committed: accepted.size, submitted: pending.size,
		lastAccepted: accepted.size ? Math.max(...[...accepted.values()].map(entry => entry.t)) : undefined };
}

export type Stage = { id: string; ms: number; after: string[] };

export function criticalPath(stages: Stage[], sink: string, removed?: string) {
	const byId = new Map(stages.map(stage => [stage.id, stage]));
	if (stages.length !== byId.size) throw new Error("Duplicate stage");
	const active = new Set<string>();
	const cache = new Map<string, { ms: number; path: string[] }>();
	function visit(id: string): { ms: number; path: string[] } {
		const saved = cache.get(id);
		if (saved) return saved;
		const stage = byId.get(id);
		if (!stage || active.has(id) || !Number.isFinite(stage.ms) || stage.ms < 0) throw new Error(`Invalid dependency at ${id}`);
		active.add(id);
		const predecessor = stage.after.map(visit).reduce((best, next) => next.ms > best.ms ? next : best, { ms: 0, path: [] } as { ms: number; path: string[] });
		const result = { ms: predecessor.ms + (removed === id ? 0 : stage.ms), path: [...predecessor.path, id] };
		active.delete(id);
		cache.set(id, result);
		return result;
	}
	return visit(sink);
}

export type RawTraceEvent = {
	name?: string;
	ph?: string;
	ts?: number;
	dur?: number;
	pid?: number;
	tid?: number;
	id?: string;
	args?: Record<string, unknown>;
};

export type TimelineThreadSummary = {
	thread: string;
	tasks: number;
	totalBusyMs: number;
	busyPct: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	over6_9ms: number;
	over16_7ms: number;
	over50ms: number;
};

export type TimelineBucketSummary = {
	bucketStartS: number;
	bucketEndS: number;
	mainBusyPct: number;
	mainMaxMs: number;
	workerBusyPct: number;
	workerMaxMs: number;
	gpuBusyPct: number;
	gpuMaxMs: number;
};

export type TimelineFpsSummary = {
	beginFrameCount: number;
	beginFrameHz: number;
	compositorSwapCount: number;
	swapFps: number;
	pipelineTotal: number;
	pipelineDroppedSmoothness: number;
	dropRatePct: number;
};

export type TimelineSummary = {
	durationMs: number;
	totalEvents: number;
	threads: TimelineThreadSummary[];
	fps: TimelineFpsSummary;
	buckets: TimelineBucketSummary[];
};

const percentile = (sorted: number[], q: number) => {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
	return sorted[index]!;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function summarizeTimelineTrace(
	input: string | { traceEvents?: RawTraceEvent[] } | RawTraceEvent[],
	options: { bucketMs?: number } = {}
): TimelineSummary {
	const parsed = typeof input === "string" ? (JSON.parse(input) as { traceEvents?: RawTraceEvent[] } | RawTraceEvent[]) : input;
	const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
	const bucketMs = Math.max(500, options.bucketMs ?? 5000);

	const threadNames = new Map<string, string>();
	const workerKeys = new Set<string>();
	let t0: number | undefined;
	let tMin: number | undefined;
	let tMax: number | undefined;

	for (const event of events) {
		const key = `${event.pid ?? 0}:${event.tid ?? 0}`;
		if (event.ph === "M" && event.name === "thread_name") {
			const name = (event.args as { name?: string } | undefined)?.name;
			if (name) threadNames.set(key, name);
		} else if (event.name === "ProfileChunk") {
			const cpuProfile = (event.args as { data?: { cpuProfile?: { nodes?: Array<{ callFrame?: { url?: string } }> } } } | undefined)?.data?.cpuProfile;
			if (cpuProfile?.nodes?.some(node => /\/canvasWorker[-.]/.test(node.callFrame?.url ?? ""))) {
				workerKeys.add(key);
			}
		}
		if (event.name === "TracingStartedInBrowser" || event.name === "TracingStartedInPage") {
			if (typeof event.ts === "number" && (t0 === undefined || event.ts < t0)) t0 = event.ts;
		}
		if (event.ph !== "M" && typeof event.ts === "number" && event.ts > 0) {
			if (tMin === undefined || event.ts < tMin) tMin = event.ts;
			const end = event.ts + (typeof event.dur === "number" ? event.dur : 0);
			if (tMax === undefined || end > tMax) tMax = end;
		}
	}

	const startUs = t0 ?? tMin ?? 0;
	const endUs = Math.max(startUs + 1000, tMax ?? startUs + 1000);
	const durationMs = (endUs - startUs) / 1000;

	const roleOf = (pid?: number, tid?: number): "Main" | "Worker" | "GPU" | "Compositor" | "Viz" | null => {
		const key = `${pid ?? 0}:${tid ?? 0}`;
		if (workerKeys.has(key)) return "Worker";
		const name = threadNames.get(key);
		if (name === "CrRendererMain") return "Main";
		if (name === "DedicatedWorker thread") return "Worker";
		if (name === "CrGpuMain") return "GPU";
		if (name === "Compositor") return "Compositor";
		if (name === "VizCompositorThread") return "Viz";
		return null;
	};

	const threadTasks: Record<string, number[]> = { Main: [], Worker: [], GPU: [], Compositor: [], Viz: [] };
	const gpuFallbackTasks: number[] = [];
	const bucketCount = Math.max(1, Math.ceil(durationMs / bucketMs));
	const buckets = Array.from({ length: bucketCount }, (_, index) => ({
		bucketStartS: round2((index * bucketMs) / 1000),
		bucketEndS: round2(Math.min(durationMs, (index + 1) * bucketMs) / 1000),
		mainSumMs: 0,
		mainMaxMs: 0,
		workerSumMs: 0,
		workerMaxMs: 0,
		gpuSumMs: 0,
		gpuMaxMs: 0,
	}));

	const beginFramesUs: number[] = [];
	let compositorSwapCount = 0;
	let pipelineTotal = 0;
	let pipelineDroppedSmoothness = 0;

	for (const event of events) {
		const ts = event.ts;
		if (typeof ts !== "number" || ts < startUs || ts > endUs) continue;
		const role = roleOf(event.pid, event.tid);
		const relMs = (ts - startUs) / 1000;
		const bIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor(relMs / bucketMs)));
		const bucket = buckets[bIdx]!;

		if (role && event.ph === "X" && typeof event.dur === "number") {
			const durMs = event.dur / 1000;
			if (event.name === "RunTask") {
				threadTasks[role]!.push(durMs);
				if (role === "Main") {
					bucket.mainSumMs += durMs;
					if (durMs > bucket.mainMaxMs) bucket.mainMaxMs = durMs;
				} else if (role === "Worker") {
					bucket.workerSumMs += durMs;
					if (durMs > bucket.workerMaxMs) bucket.workerMaxMs = durMs;
				} else if (role === "GPU") {
					bucket.gpuSumMs += durMs;
					if (durMs > bucket.gpuMaxMs) bucket.gpuMaxMs = durMs;
				}
			} else if (role === "GPU" && event.name === "GPUTask") {
				gpuFallbackTasks.push(durMs);
			}
		}

		if (role === "Compositor" && event.name === "BeginFrame") {
			beginFramesUs.push(ts);
		}
		if (role === "Compositor" && event.name === "Swap" && (event.ph === "b" || event.ph === "X")) {
			compositorSwapCount += 1;
		}
		if (event.name === "PipelineReporter" && event.ph === "b") {
			const reporter = (event.args as { frame_reporter?: { state?: string; affects_smoothness?: boolean } } | undefined)?.frame_reporter;
			if (reporter) {
				pipelineTotal += 1;
				if (reporter.state === "STATE_DROPPED" && reporter.affects_smoothness) {
					pipelineDroppedSmoothness += 1;
				}
			}
		}
	}

	if (threadTasks.GPU!.length === 0 && gpuFallbackTasks.length > 0) {
		threadTasks.GPU = gpuFallbackTasks;
	}

	const threads: TimelineThreadSummary[] = (["Main", "Worker", "GPU", "Compositor", "Viz"] as const).map(thread => {
		const raw = threadTasks[thread]!;
		const sorted = raw.slice().sort((a, b) => a - b);
		const totalBusyMs = raw.reduce((sum, value) => sum + value, 0);
		return {
			thread,
			tasks: raw.length,
			totalBusyMs: round2(totalBusyMs),
			busyPct: round2((totalBusyMs / durationMs) * 100),
			p50Ms: round2(percentile(sorted, 0.5)),
			p95Ms: round2(percentile(sorted, 0.95)),
			p99Ms: round2(percentile(sorted, 0.99)),
			maxMs: round2(sorted[sorted.length - 1] ?? 0),
			over6_9ms: raw.filter(v => v > 6.94).length,
			over16_7ms: raw.filter(v => v > 16.67).length,
			over50ms: raw.filter(v => v > 50).length,
		};
	});

	beginFramesUs.sort((a, b) => a - b);
	const bfDiffsMs: number[] = [];
	for (let i = 1; i < beginFramesUs.length; i += 1) {
		const diff = (beginFramesUs[i]! - beginFramesUs[i - 1]!) / 1000;
		if (diff > 0) bfDiffsMs.push(diff);
	}
	bfDiffsMs.sort((a, b) => a - b);
	const medianBfMs = percentile(bfDiffsMs, 0.5);

	const durationS = Math.max(0.001, durationMs / 1000);
	const fps: TimelineFpsSummary = {
		beginFrameCount: beginFramesUs.length,
		beginFrameHz: medianBfMs > 0 ? round2(1000 / medianBfMs) : 0,
		compositorSwapCount,
		swapFps: round2(compositorSwapCount / durationS),
		pipelineTotal,
		pipelineDroppedSmoothness,
		dropRatePct: pipelineTotal > 0 ? round2((pipelineDroppedSmoothness / pipelineTotal) * 100) : 0,
	};

	const bucketSummaries: TimelineBucketSummary[] = buckets.map(bucket => {
		const spanMs = Math.max(1, (bucket.bucketEndS - bucket.bucketStartS) * 1000);
		return {
			bucketStartS: bucket.bucketStartS,
			bucketEndS: bucket.bucketEndS,
			mainBusyPct: round2((bucket.mainSumMs / spanMs) * 100),
			mainMaxMs: round2(bucket.mainMaxMs),
			workerBusyPct: round2((bucket.workerSumMs / spanMs) * 100),
			workerMaxMs: round2(bucket.workerMaxMs),
			gpuBusyPct: round2((bucket.gpuSumMs / spanMs) * 100),
			gpuMaxMs: round2(bucket.gpuMaxMs),
		};
	});

	return {
		durationMs: round2(durationMs),
		totalEvents: events.length,
		threads,
		fps,
		buckets: bucketSummaries,
	};
}
