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
