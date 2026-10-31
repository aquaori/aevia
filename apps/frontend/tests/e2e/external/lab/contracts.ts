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
	pointerDown: "aevia.pointer.down",
	localPaintDone: "aevia.local.paint-done",
	wsOpen: "aevia.ws.open",
	wsMessage: "aevia.ws.message",
	workerFirstPaint: "aevia.worker.first-paint",
	workerRenderComplete: "aevia.worker.render-complete",
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
	/** First matching end mark after the start/anchor mark wins. */
	end: LabMarkSelector[];
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
 * Late-join full render. `firstNonBlankMs` ends on the first main-thread paint
 * commit after the init meta message; that is the main-side settlement of the
 * worker's first paint, not a cross-thread subtraction of worker time.
 */
const FULL_RENDER_CONTRACT: CaseLabContract = {
	requiredSpans: [
		{
			metric: "firstNonBlankMs",
			thread: "main",
			start: markSelector(LAB_MARKS.pageStart),
			after: markSelector(LAB_MARKS.initMeta),
			end: [markSelector(LAB_MARKS.frameCommit), markSelector(LAB_MARKS.initRenderComplete)],
		},
		{
			metric: "visuallyStableMs",
			thread: "main",
			start: markSelector(LAB_MARKS.pageStart),
			after: markSelector(LAB_MARKS.initMeta),
			end: [markSelector(LAB_MARKS.initCommandsComplete)],
		},
	],
	witnesses: [
		{ metric: "firstNonBlankMs", externalMetric: "firstNonBlankMs", kind: "firstPaint" },
		{ metric: "visuallyStableMs", externalMetric: "visuallyStableMs", kind: "visuallyStable" },
	],
	requireSentinel: true,
	checkPageErrors: true,
};

const INCREMENTAL_REMOTE_FIRST_PIXEL_CONTRACT: CaseLabContract = {
	requiredSpans: [
		{
			metric: "remoteFirstPixelMs",
			thread: "main",
			start: markSelector(LAB_MARKS.wsMessage, { key: "type", valueIncludes: "cmd" }),
			end: [markSelector(LAB_MARKS.frameCommit)],
		},
	],
	witnesses: [{ metric: "remoteFirstPixelMs", externalMetric: "remoteFirstPixelMs", kind: "firstPaint" }],
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

const MULTIPAGE_ISOLATION_CONTRACT: CaseLabContract = {
	requiredSpans: [
		{
			metric: "page1ClickToObservedScreenshotMs",
			thread: "main",
			start: markSelector(LAB_MARKS.pageChange),
			end: [markSelector(LAB_MARKS.frameCommit), markSelector(LAB_MARKS.initFirstChunk)],
		},
	],
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
			if (span.end.some((selector) => markMatches(marks[index], selector, span.thread))) {
				endIndex = index;
				break;
			}
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
		if (Math.abs(delta) > toleranceMs) {
			violations.push({
				metric: witness.metric,
				code: "EXTERNAL_DISAGREEMENT",
				detail: `${witness.metric}: instrumented=${instrumentedValue.toFixed(1)}ms external=${externalValue.toFixed(
					1
				)}ms delta=${delta.toFixed(1)}ms tolerance=${toleranceMs}ms`,
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
