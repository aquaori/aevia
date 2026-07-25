export type CollabPressureLevel = "normal" | "elevated" | "high" | "critical";

export interface CollabPressurePolicy {
	level: CollabPressureLevel;
	cursorMinIntervalMs: number;
	updateMinIntervalMs: number;
	updateMinPoints: number;
	sampleMinDistancePx: number;
	simplificationTolerancePx: number;
	maxUpdatePoints: number;
}

const POLICIES: Record<CollabPressureLevel, CollabPressurePolicy> = {
	normal: {
		level: "normal",
		cursorMinIntervalMs: 16,
		updateMinIntervalMs: 16,
		updateMinPoints: 1,
		sampleMinDistancePx: 2,
		simplificationTolerancePx: 0.4,
		maxUpdatePoints: 128,
	},
	elevated: {
		level: "elevated",
		cursorMinIntervalMs: 50,
		updateMinIntervalMs: 33,
		updateMinPoints: 4,
		sampleMinDistancePx: 3,
		simplificationTolerancePx: 0.8,
		maxUpdatePoints: 128,
	},
	high: {
		level: "high",
		cursorMinIntervalMs: 100,
		updateMinIntervalMs: 50,
		updateMinPoints: 8,
		sampleMinDistancePx: 4,
		simplificationTolerancePx: 1.2,
		maxUpdatePoints: 96,
	},
	critical: {
		level: "critical",
		cursorMinIntervalMs: 200,
		updateMinIntervalMs: 100,
		updateMinPoints: 16,
		sampleMinDistancePx: 6,
		simplificationTolerancePx: 1.8,
		maxUpdatePoints: 64,
	},
};

let currentPolicy = POLICIES.normal;

export const getCollabPressurePolicy = () => currentPolicy;

export const resetCollabPressurePolicy = () => {
	currentPolicy = POLICIES.normal;
};

export const applyServerPressurePolicy = (payload: unknown) => {
	const data = payload as {
		level?: unknown;
		policy?: Partial<Record<keyof Omit<CollabPressurePolicy, "level">, unknown>>;
	};
	const level = normalizeLevel(data?.level);
	const basePolicy = POLICIES[level];
	const serverPolicy = data?.policy ?? {};
	currentPolicy = {
		level,
		cursorMinIntervalMs: clampNumber(serverPolicy.cursorMinIntervalMs, basePolicy.cursorMinIntervalMs, 16, 500),
		updateMinIntervalMs: clampNumber(serverPolicy.updateMinIntervalMs, basePolicy.updateMinIntervalMs, 16, 500),
		updateMinPoints: clampNumber(serverPolicy.updateMinPoints, basePolicy.updateMinPoints, 1, 64),
		sampleMinDistancePx: clampNumber(serverPolicy.sampleMinDistancePx, basePolicy.sampleMinDistancePx, 1, 12),
		simplificationTolerancePx: clampFloat(
			serverPolicy.simplificationTolerancePx,
			basePolicy.simplificationTolerancePx,
			0,
			4
		),
		maxUpdatePoints: clampNumber(serverPolicy.maxUpdatePoints, basePolicy.maxUpdatePoints, 16, 512),
	};
	return currentPolicy;
};

export const shouldFlushCommandUpdate = (
	policy: CollabPressurePolicy,
	pendingPointCount: number,
	elapsedMs: number,
	force = false
) => {
	if (pendingPointCount <= 0) return false;
	if (force) return true;
	if (pendingPointCount >= policy.maxUpdatePoints) return true;
	return pendingPointCount >= policy.updateMinPoints && elapsedMs >= policy.updateMinIntervalMs;
};

const normalizeLevel = (level: unknown): CollabPressureLevel => {
	if (level === "critical" || level === "high" || level === "elevated" || level === "normal") {
		return level;
	}
	return "normal";
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(Math.max(Math.round(numeric), min), max);
};

const clampFloat = (value: unknown, fallback: number, min: number, max: number) => {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(Math.max(numeric, min), max);
};
