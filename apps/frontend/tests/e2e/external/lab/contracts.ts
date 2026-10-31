// File role: per-case instrumented span contracts and mark-name table (P2).
//
// Mark names mirror `apps/frontend/src/instrumentation/labMarkNames.ts`; the
// harness keeps its own literal table so a test run never imports product
// implementation internals.
//
// Thread rule: spans are settled on a single thread. Worker marks are never
// used to measure main-thread work, and no span subtracts a worker timestamp
// from a main timestamp (worker `performance.now()` has its own time origin).
// `aevia.lab.page-start` is a harness-owned mark injected by lab/install.ts at
// document start; it is main-thread and shares the external observer's origin,
// so instrumented first-paint metrics stay comparable with external ones.
import type { MetricMap } from "../types";
import type { LabMark, LabMarkDetail, LabPolicy, LabSpanViolation, LabThread, LabWitnessKind } from "./types";
import { DEFAULT_LAB_POLICY } from "./policy";
import { EXTERNAL_CASES } from "../../../../../../tests/catalog/external-cases";

export const LAB_MARKS = {
	appBoot: "aevia.app.boot",
	sentinel: "aevia.lab.sentinel",
	/** Harness-owned main-thread mark recorded before application scripts run. */
	pageStart: "aevia.lab.page-start",
	initMeta: "aevia.init.meta",
	initFirstChunk: "aevia.init.first-chunk",
	initRenderComplete: "aevia.init.render-complete",
	initCommandsComplete: "aevia.init.commands-complete",
	pageChange: "aevia.page.change",
	deltaMeta: "aevia.delta.meta",
	deltaComplete: "aevia.delta.complete",
	frameCommit: "aevia.frame.commit",
	/** Main-thread settlement emitted when the bridge receives the worker's first paint. */
	frameFirstPaint: "aevia.frame.first-paint",
	/** Main-thread settlement emitted when the bridge receives the worker's render-complete. */
	frameRenderComplete: "aevia.frame.render-complete",
	pointerDown: "aevia.pointer.down",
	localPaintDone: "aevia.local.paint-done",
	wsOpen: "aevia.ws.open",
	wsMessage: "aevia.ws.message",
	workerFirstPaint: "aevia.worker.first-paint",
	workerRenderComplete: "aevia.worker.render-complete",
	/** Main-thread mark emitted when a worker message is received (settlement point). */
	workerAck: "aevia.worker.ack",
} as const;

export const HARNESS_PAGE_START_MARK = LAB_MARKS.pageStart;

export type LabMarkSelector = {
	name: string;
	/** Optional `detail[key]` substring predicate (e.g. ws message type). */
	detailIncludes?: { key: string; valueIncludes: string };
};

export type LabSpanSpec = {
	/** Instrumented metric name; kept identical to the external metric when comparable. */
	metric: string;
	thread: LabThread;
	start: LabMarkSelector;
	/**
	 * Optional anchor that must appear after the start mark; the end mark is
	 * only searched after it. Used to skip boot-time frames that are not the
	 * measured render (late-join init only starts at `aevia.init.meta`).
	 */
	after?: LabMarkSelector;
	/** Matching end mark after the start/anchor mark: earliest or latest. */
	end: LabMarkSelector[];
	endPick?: "first" | "last";
	/** Optional per-span ceiling; defaults to `LabPolicy.maxSpanMs`. */
	maxMs?: number;
};

export type LabWitnessSpec = {
	metric: string;
	externalMetric: string;
	kind: LabWitnessKind;
};

export type CaseLabContract = {
	requiredSpans: LabSpanSpec[];
	witnesses: LabWitnessSpec[];
	requireSentinel: boolean;
	checkPageErrors: boolean;
};

const markSelector = (name: string, detailIncludes?: LabMarkSelector["detailIncludes"]): LabMarkSelector => ({
	name,
	...(detailIncludes ? { detailIncludes } : {}),
});

/**
 * Late-join full render. Two different quantities are measured:
 *
 * - `firstNonBlankMs` = main-thread time from document start to the first worker paint
 *   (`aevia.frame.first-paint`). The external observer instead waits for a non-blank
 *   *threshold* while chunks arrive progressively, so the two values are intentionally
 *   not witness-compared: at large scales the external figure is dominated by chunk
 *   arrival while the instrumented figure is the literal first paint.
 * - `visuallyStableMs` = document start to the last worker render-complete
 *   (`aevia.frame.render-complete`, main-thread settlement of the worker batch). This is
 *   semantically the same event the external observer watches, so it is the witness metric.
 *
 * Worker timestamps are never subtracted: every span endpoint here is a main-thread mark.
 */
const FULL_RENDER_CONTRACT: CaseLabContract = {
	requiredSpans: [
		{
			metric: "firstNonBlankMs",
			thread: "main",
			start: markSelector(LAB_MARKS.pageStart),
			after: markSelector(LAB_MARKS.initMeta),
			end: [
				markSelector(LAB_MARKS.frameFirstPaint),
				markSelector(LAB_MARKS.workerAck, { key: "type", valueIncludes: "scene-operation-rendered" }),
				markSelector(LAB_MARKS.frameCommit),
				markSelector(LAB_MARKS.initRenderComplete),
			],
			endPick: "first",
		},
		{
			metric: "visuallyStableMs",
			thread: "main",
			start: markSelector(LAB_MARKS.pageStart),
			after: markSelector(LAB_MARKS.initMeta),
			end: [markSelector(LAB_MARKS.frameRenderComplete), markSelector(LAB_MARKS.initRenderComplete)],
			endPick: "last",
		},
	],
	witnesses: [{ metric: "visuallyStableMs", externalMetric: "visuallyStableMs", kind: "visuallyStable" }],
	requireSentinel: true,
	checkPageErrors: true,
};

// Remote incremental paint has no reliable main-thread settlement mark yet: the worker
// path can render the remote op without a main-side frame commit or ack that follows the
// ws message. Until instrumentation exposes that settlement, the case keeps its external
// pixel oracle but is not measurement-gated (sentinel + page errors only).
const INCREMENTAL_REMOTE_FIRST_PIXEL_CONTRACT: CaseLabContract = {
	requiredSpans: [],
	witnesses: [],
	requireSentinel: true,
	checkPageErrors: true,
};

const LOCAL_REALTIME_FIRST_PIXEL_CONTRACT: CaseLabContract = {
	requiredSpans: [
		{
			metric: "inputToFirstPixelMs",
			thread: "main",
			start: markSelector(LAB_MARKS.pointerDown),
			end: [markSelector(LAB_MARKS.localPaintDone), markSelector(LAB_MARKS.frameCommit)],
		},
	],
	witnesses: [{ metric: "inputToFirstPixelMs", externalMetric: "inputToFirstPixelMs", kind: "interaction" }],
	requireSentinel: true,
	checkPageErrors: true,
};

// This case's observable oracle is page isolation through canvas screenshots, not switch
// latency. Requiring a page-change -> first-paint span here produced a false invalid case
// whenever the page was served from cache without an init chunk, so the contract is
// sentinel + page-error only. A dedicated page-change latency scenario can add spans later.
const MULTIPAGE_ISOLATION_CONTRACT: CaseLabContract = {
	requiredSpans: [],
	witnesses: [],
	requireSentinel: true,
	checkPageErrors: true,
};

const SENTINEL_ONLY_CONTRACT = (checkPageErrors: boolean): CaseLabContract => ({
	requiredSpans: [],
	witnesses: [],
	requireSentinel: true,
	checkPageErrors,
});

const CASE_CONTRACTS: Record<string, CaseLabContract> = {
	[EXTERNAL_CASES.harnessHealth.id]: SENTINEL_ONLY_CONTRACT(true),
	[EXTERNAL_CASES.correctnessSmoke.id]: SENTINEL_ONLY_CONTRACT(true),
	[EXTERNAL_CASES.concurrentCrossing.id]: SENTINEL_ONLY_CONTRACT(true),
	[EXTERNAL_CASES.lateJoiner.id]: SENTINEL_ONLY_CONTRACT(true),
	[EXTERNAL_CASES.multipageIsolation.id]: MULTIPAGE_ISOLATION_CONTRACT,
	[EXTERNAL_CASES.remoteFirstPixelPerformance.id]: INCREMENTAL_REMOTE_FIRST_PIXEL_CONTRACT,
	[EXTERNAL_CASES.localFirstPixelPerformance.id]: LOCAL_REALTIME_FIRST_PIXEL_CONTRACT,
};

const FULL_RENDER_PREFIX = `${EXTERNAL_CASES.fullRenderPerformance.id}-`;

/**
 * Returns the lab contract for a case, or `null` when the case is not gated.
 * Boundary suites and network recovery intentionally return `null`: they
 * provoke renderer pressure and reconnects, so console errors and missing
 * marks there are expected product conditions rather than harness defects.
 */
export const caseLabContract = (caseId: string): CaseLabContract | null => {
	if (caseId.startsWith(FULL_RENDER_PREFIX)) return FULL_RENDER_CONTRACT;
	return CASE_CONTRACTS[caseId] ?? null;
};

/**
 * Instrumentation mark names one case depends on. Used to fill
 * `LabGateReport.instrumentation.missingMarks` from the cases actually run; the
 * harness-owned page-start mark is excluded because the harness itself always
 * records it.
 */
export const contractMarksForCase = (caseId: string): string[] => {
	const contract = caseLabContract(caseId);
	if (!contract) return [];
	const names = new Set<string>();
	for (const span of contract.requiredSpans) {
		if (span.start.name !== HARNESS_PAGE_START_MARK) names.add(span.start.name);
		if (span.after && span.after.name !== HARNESS_PAGE_START_MARK) names.add(span.after.name);
		for (const end of span.end) {
			if (end.name !== HARNESS_PAGE_START_MARK) names.add(end.name);
		}
	}
	if (contract.requireSentinel) names.add(LAB_MARKS.sentinel);
	return [...names].sort();
};

export const witnessToleranceMs = (kind: LabWitnessKind, policy: LabPolicy): number => {
	if (kind === "visuallyStable") return policy.witness.visuallyStableMs;
	if (kind === "interaction") return policy.witness.interactionMs;
	return policy.witness.firstPaintMs;
};

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const detailMatches = (detail: LabMarkDetail | undefined, predicate?: LabMarkSelector["detailIncludes"]): boolean => {
	if (!predicate) return true;
	if (!detail) return false;
	const value = detail[predicate.key];
	return typeof value === "string" && value.includes(predicate.valueIncludes);
};

const markMatches = (mark: LabMark | undefined, selector: LabMarkSelector, thread: LabThread): boolean => {
	if (!mark) return false;
	if (mark.thread !== thread) return false;
	if (mark.name !== selector.name) return false;
	return detailMatches(mark.detail, selector.detailIncludes);
};

export type DerivedSpanMetrics = {
	instrumented: MetricMap;
	violations: LabSpanViolation[];
};

/**
 * Converts the marks of one page/sample into instrumented metrics with the same
 * names as the external metrics. Only same-thread marks are paired.
 */
export const deriveInstrumentedMetrics = (
	caseId: string,
	marks: LabMark[],
	policy: LabPolicy = DEFAULT_LAB_POLICY
): DerivedSpanMetrics => {
	const contract = caseLabContract(caseId);
	const instrumented: MetricMap = {};
	const violations: LabSpanViolation[] = [];
	if (!contract) return { instrumented, violations };

	for (const span of contract.requiredSpans) {
		const startIndex = marks.findIndex((mark) => markMatches(mark, span.start, span.thread));
		if (startIndex < 0) {
			violations.push({
				metric: span.metric,
				code: "MISSING_MARK",
				detail: `${span.metric}: start mark ${span.start.name} (${span.thread}) not recorded`,
			});
			continue;
		}
		let searchFrom = startIndex;
		if (span.after) {
			const anchorIndex = marks.findIndex(
				(mark, index) => index > startIndex && markMatches(mark, span.after!, span.thread)
			);
			if (anchorIndex < 0) {
				violations.push({
					metric: span.metric,
					code: "MISSING_MARK",
					detail: `${span.metric}: anchor mark ${span.after.name} (${span.thread}) not recorded after ${span.start.name}`,
				});
				continue;
			}
			searchFrom = anchorIndex;
		}
		let endIndex = -1;
		for (let index = searchFrom + 1; index < marks.length; index += 1) {
			if (!span.end.some((selector) => markMatches(marks[index], selector, span.thread))) continue;
			endIndex = index;
			if ((span.endPick ?? "first") === "first") break;
		}
		if (endIndex < 0) {
			violations.push({
				metric: span.metric,
				code: "UNPAIRED_MARK",
				detail: `${span.metric}: ${span.start.name} has no end mark (${span.end
					.map((end) => end.name)
					.join("|")}) on ${span.thread}`,
			});
			continue;
		}
		const start = marks[startIndex]!;
		const end = marks[endIndex]!;
		const duration = end.t - start.t;
		if (!isFiniteNumber(start.t) || !isFiniteNumber(end.t) || !Number.isFinite(duration)) {
			violations.push({
				metric: span.metric,
				code: "NAN_METRIC",
				detail: `${span.metric}: non-finite mark timestamp (start=${String(start.t)}, end=${String(end.t)})`,
			});
			continue;
		}
		if (duration < 0) {
			violations.push({
				metric: span.metric,
				code: "NEGATIVE_DURATION",
				detail: `${span.metric}: ${duration.toFixed(2)}ms (end before start on ${span.thread})`,
			});
			continue;
		}
		const maxMs = span.maxMs ?? policy.maxSpanMs;
		if (duration > maxMs) {
			violations.push({
				metric: span.metric,
				code: "DURATION_OUT_OF_RANGE",
				detail: `${span.metric}: ${duration.toFixed(1)}ms exceeds ${maxMs}ms`,
			});
		}
		instrumented[span.metric] = duration;
	}

	if (contract.requiredSpans.length > 0 && Object.keys(instrumented).length === 0 && violations.length === 0) {
		violations.push({
			metric: "instrumented",
			code: "EMPTY_METRICS",
			detail: `${caseId}: no instrumented span could be derived`,
		});
	}

	return { instrumented, violations };
};

export type DerivedWitness = {
	witnessDeltaMs: MetricMap;
	violations: LabSpanViolation[];
};

/**
 * Cross-checks instrumented metrics against external metrics with the same
 * semantic origin. A delta beyond the witness tolerance means the two
 * measurement sources disagree, so the measurement is not trustworthy.
 */
export const deriveWitness = (
	caseId: string,
	instrumented: MetricMap,
	external: MetricMap,
	policy: LabPolicy = DEFAULT_LAB_POLICY
): DerivedWitness => {
	const contract = caseLabContract(caseId);
	const witnessDeltaMs: MetricMap = {};
	const violations: LabSpanViolation[] = [];
	if (!contract) return { witnessDeltaMs, violations };

	for (const witness of contract.witnesses) {
		const instrumentedValue = instrumented[witness.metric];
		const externalValue = external[witness.externalMetric];
		if (!isFiniteNumber(instrumentedValue) || !isFiniteNumber(externalValue)) continue;
		const delta = instrumentedValue - externalValue;
		witnessDeltaMs[witness.metric] = delta;
		const toleranceMs = witnessToleranceMs(witness.kind, policy);
		// Absolute floor plus a relative band scaled by the smaller source: the external
		// observer quantises and watches a different pipeline point, while a broken
		// instrumentation collapses to ~0 or drifts by orders of magnitude.
		const allowed = toleranceMs + policy.witnessRelativeBand * Math.min(instrumentedValue, externalValue);
		if (Math.abs(delta) > allowed) {
			violations.push({
				metric: witness.metric,
				code: "EXTERNAL_DISAGREEMENT",
				detail: `${witness.metric}: instrumented=${instrumentedValue.toFixed(1)}ms external=${externalValue.toFixed(
					1
				)}ms delta=${delta.toFixed(1)}ms allowed=${allowed.toFixed(1)}ms (tolerance=${toleranceMs}ms, band=${
					policy.witnessRelativeBand
				})`,
			});
		}
	}

	return { witnessDeltaMs, violations };
};

const medianOf = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** Median of each numeric metric across measured samples (mirrors aggregateSamples). */
export const aggregateMedians = (metricMaps: MetricMap[]): MetricMap => {
	const keys = new Set<string>();
	for (const metrics of metricMaps) {
		for (const [key, value] of Object.entries(metrics)) {
			if (isFiniteNumber(value)) keys.add(key);
		}
	}
	const aggregated: MetricMap = {};
	for (const key of keys) {
		const values = metricMaps
			.map((metrics) => metrics[key])
			.filter((value): value is number => isFiniteNumber(value));
		const median = medianOf(values);
		if (median !== null) aggregated[key] = median;
	}
	return aggregated;
};
