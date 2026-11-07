// File role: measurement validity policy for the external E2E lab gate (P3).
//
// Thresholds are intentionally conservative defaults derived from the P3 task:
// a single invalid case is a debuggable "degraded" run, a scenario whose cases
// are all invalid aborts the round. Every value can be overridden per host with
// `AEVIA_LAB_*` environment variables; the runner never writes them back.
import type { LabPolicy } from "./types";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const nonNegative = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);

const numberFromEnv = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
	const raw = env[key];
	if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
};

export const DEFAULT_LAB_POLICY: LabPolicy = {
	warnRatio: 0.25,
	abortRatio: 1,
	sampleInvalidRatio: 1 / 3,
	maxSpanMs: 120_000,
	witness: {
		firstPaintMs: 25,
		visuallyStableMs: 40,
		// The external observer polls the ROI once per animation frame, so a genuinely
		// instant local paint still shows up ~2 frames late. Treat two 60 Hz frames as
		// the observation floor instead of pretending both sources share a clock.
		interactionMs: 34,
	},
	witnessRelativeBand: 2,
};

export const resolveLabPolicy = (env: NodeJS.ProcessEnv = process.env): LabPolicy => ({
	warnRatio: clamp01(numberFromEnv(env, "AEVIA_LAB_WARN_RATIO", DEFAULT_LAB_POLICY.warnRatio)),
	abortRatio: clamp01(numberFromEnv(env, "AEVIA_LAB_ABORT_RATIO", DEFAULT_LAB_POLICY.abortRatio)),
	sampleInvalidRatio: clamp01(
		numberFromEnv(env, "AEVIA_LAB_SAMPLE_INVALID_RATIO", DEFAULT_LAB_POLICY.sampleInvalidRatio)
	),
	maxSpanMs: nonNegative(numberFromEnv(env, "AEVIA_LAB_MAX_SPAN_MS", DEFAULT_LAB_POLICY.maxSpanMs)),
	witness: {
		firstPaintMs: nonNegative(
			numberFromEnv(env, "AEVIA_LAB_WITNESS_FIRST_PAINT_MS", DEFAULT_LAB_POLICY.witness.firstPaintMs)
		),
		visuallyStableMs: nonNegative(
			numberFromEnv(env, "AEVIA_LAB_WITNESS_VISUALLY_STABLE_MS", DEFAULT_LAB_POLICY.witness.visuallyStableMs)
		),
		interactionMs: nonNegative(
			numberFromEnv(env, "AEVIA_LAB_WITNESS_INTERACTION_MS", DEFAULT_LAB_POLICY.witness.interactionMs)
		),
	},
	witnessRelativeBand: nonNegative(
		numberFromEnv(env, "AEVIA_LAB_WITNESS_RELATIVE_BAND", DEFAULT_LAB_POLICY.witnessRelativeBand)
	),
});
