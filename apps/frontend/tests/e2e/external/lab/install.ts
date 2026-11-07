// File role: inject, read, and scope the product lab runtime for external E2E pages.
//
// The harness never imports the product instrumentation implementation. It
// injects the documented `window.__AEVIA_LAB__` shape before application
// scripts and later reads marks/counters/page errors back out of the page. When
// lab mode is off nothing is injected and no page is touched.
import type { Page } from "playwright";
import { withDeadline } from "../deadline";
import type {
	LabInstrumentationSummary,
	LabMark,
	LabMarkDetail,
	LabPageError,
	LabPageSnapshot,
	LabThread,
} from "./types";
import { HARNESS_PAGE_START_MARK, LAB_MARKS } from "./contracts";

const LAB_RUNTIME_KEY = "__AEVIA_LAB__";
const PAGE_ERROR_LIMIT = 80;
const MARK_READ_LIMIT = 20_000;
const TIMELINE_MARK_PREFIX = "aevia.";

const LAB_INSTALL_SCRIPT = `
(function () {
	var runtimeKey = ${JSON.stringify(LAB_RUNTIME_KEY)};
	var pageStartName = ${JSON.stringify(HARNESS_PAGE_START_MARK)};
	var errorLimit = ${PAGE_ERROR_LIMIT};
	try {
		var runtime = window[runtimeKey];
		if (!runtime || typeof runtime !== "object") runtime = {};
		runtime.contractVersion = typeof runtime.contractVersion === "number" ? runtime.contractVersion : 1;
		runtime.enabled = true;
		if (!Array.isArray(runtime.marks)) runtime.marks = [];
		if (!runtime.counters || typeof runtime.counters !== "object") runtime.counters = {};
		if (typeof runtime.dropped !== "number") runtime.dropped = 0;
		if (!Array.isArray(runtime.pageErrors)) runtime.pageErrors = [];
		window[runtimeKey] = runtime;

		if (!runtime.__harnessHooked) {
			runtime.__harnessHooked = true;
			var pushError = function (source, message) {
				try {
					runtime.pageErrors.push({
						source: String(source),
						message: String(message).slice(0, 2000),
						t: performance.now()
					});
					if (runtime.pageErrors.length > errorLimit) {
						runtime.pageErrors.splice(0, runtime.pageErrors.length - errorLimit);
					}
				} catch (ignored) {}
			};
			var describe = function (value) {
				try {
					if (typeof value === "string") return value;
					if (value instanceof Error) return value.message;
					if (value instanceof Event && value.target instanceof WebSocket) {
						var endpoint = new URL(value.target.url);
						return JSON.stringify({ type: value.type, endpoint: endpoint.origin + endpoint.pathname, readyState: value.target.readyState });
					}
					return JSON.stringify(value);
				} catch (ignored) {
					return String(value);
				}
			};
			var originalConsoleError = console.error;
			console.error = function () {
				try {
					var parts = [];
					for (var index = 0; index < arguments.length; index += 1) {
						parts.push(describe(arguments[index]));
					}
					pushError("console.error", parts.join(" "));
				} catch (ignored) {}
				return originalConsoleError.apply(console, arguments);
			};
			window.addEventListener("error", function (event) {
				var message = event && event.error && event.error.message
					? event.error.message
					: event && event.message
						? event.message
						: "window error";
				pushError("pageerror", message);
			});
			window.addEventListener("unhandledrejection", function (event) {
				var reason = event && event.reason;
				pushError("unhandledrejection", reason && reason.message ? reason.message : describe(reason));
			});
			// Main-thread document-start mark: shares the external observer's clock
			// origin and is never paired with a worker timestamp.
			runtime.marks.push({ name: pageStartName, thread: "main", t: performance.now() });
		}
	} catch (error) {
		try {
			console.warn("[aevia-lab] harness install failed", error);
		} catch (ignored) {}
	}
})();
`;

type InjectedRuntime = {
	contractVersion?: number;
	enabled?: boolean;
	marks?: unknown;
	counters?: Record<string, number>;
	dropped?: number;
	pageErrors?: Array<{ source?: string; message?: string; t?: number }>;
	__harnessHooked?: boolean;
};

type RawLabRuntime = {
	present: boolean;
	contractVersion: number | null;
	enabled: boolean;
	marks: unknown;
	counters: Record<string, number>;
	dropped: number;
	pageErrors: Array<{ source?: string; message?: string; t?: number }>;
	timelineMarkNames: string[];
};

type PageSideState = {
	crashed: boolean;
	errors: LabPageError[];
};

const pageSideState = new WeakMap<Page, PageSideState>();
const crashedPages = new WeakSet<Page>();

const sideStateOf = (page: Page): PageSideState => {
	let state = pageSideState.get(page);
	if (!state) {
		state = { crashed: false, errors: [] };
		pageSideState.set(page, state);
	}
	return state;
};

export const installLabRuntime = async (page: Page): Promise<void> => {
	await page.addInitScript({ content: LAB_INSTALL_SCRIPT });
	const state = sideStateOf(page);
	page.on("crash", () => {
		state.crashed = true;
		crashedPages.add(page);
		state.errors.push({ source: "crash", message: "page crashed", t: Date.now() });
	});
	page.on("pageerror", (error: Error) => {
		state.errors.push({ source: "pageerror", message: error.message.slice(0, 2000), t: Date.now() });
	});
};

const emptySnapshot = (url: string): LabPageSnapshot => ({
	present: false,
	enabled: false,
	contractVersion: null,
	marks: [],
	counters: {},
	dropped: 0,
	pageErrors: [],
	sentinel: false,
	crashed: false,
	timelineMarkNames: [],
	timelineMismatch: false,
	url,
	capturedAt: new Date().toISOString(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isLabThread = (value: unknown): value is LabThread => value === "main" || value === "worker";

const sanitizeMarks = (raw: unknown): LabMark[] => {
	if (!Array.isArray(raw)) return [];
	const marks: LabMark[] = [];
	for (const entry of raw.slice(-MARK_READ_LIMIT)) {
		if (!isRecord(entry)) continue;
		if (typeof entry.name !== "string" || !entry.name.startsWith(TIMELINE_MARK_PREFIX)) continue;
		if (!isLabThread(entry.thread)) continue;
		if (typeof entry.t !== "number" || !Number.isFinite(entry.t)) continue;
		const mark: LabMark = { name: entry.name, thread: entry.thread, t: entry.t };
		if (isRecord(entry.detail)) {
			const detail: LabMarkDetail = {};
			for (const [key, value] of Object.entries(entry.detail)) {
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
					detail[key] = value;
				}
			}
			if (Object.keys(detail).length > 0) mark.detail = detail;
		}
		marks.push(mark);
	}
	return marks;
};

const sanitizeErrors = (raw: unknown): LabPageError[] => {
	if (!Array.isArray(raw)) return [];
	const errors: LabPageError[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const source = entry.source;
		const message = entry.message;
		if (typeof message !== "string" || message.length === 0) continue;
		errors.push({
			source:
				source === "console.error" ||
				source === "pageerror" ||
				source === "unhandledrejection" ||
				source === "crash" ||
				source === "harness"
					? source
					: "console.error",
			message: message.slice(0, 2000),
			t: typeof entry.t === "number" && Number.isFinite(entry.t) ? entry.t : 0,
		});
	}
	return errors;
};

const readRawRuntime = async (page: Page): Promise<RawLabRuntime> => {
	const raw = await page.evaluate((): RawLabRuntime => {
		const runtime = (window as unknown as { __AEVIA_LAB__?: InjectedRuntime }).__AEVIA_LAB__;
		const timelineMarkNames: string[] = [];
		try {
			for (const entry of performance.getEntriesByType("mark")) {
				if (entry.name.startsWith("aevia.")) timelineMarkNames.push(entry.name);
			}
		} catch {
			// performance timeline is optional
		}
		if (!runtime || typeof runtime !== "object") {
			return {
				present: false,
				contractVersion: null,
				enabled: false,
				marks: [],
				counters: {},
				dropped: 0,
				pageErrors: [],
				timelineMarkNames,
			};
		}
		return {
			present: true,
			contractVersion: typeof runtime.contractVersion === "number" ? runtime.contractVersion : null,
			enabled: runtime.enabled === true,
			marks: Array.isArray(runtime.marks) ? runtime.marks.slice(-20000) : [],
			counters:
				runtime.counters && typeof runtime.counters === "object"
					? Object.fromEntries(
							Object.entries(runtime.counters).filter(
								(entry): entry is [string, number] =>
									typeof entry[1] === "number" && Number.isFinite(entry[1])
							)
						)
					: {},
			dropped: typeof runtime.dropped === "number" ? runtime.dropped : 0,
			pageErrors: Array.isArray(runtime.pageErrors) ? runtime.pageErrors : [],
			timelineMarkNames,
		};
	});
	return raw;
};

/** Reads the current lab runtime plus the performance-timeline cross-check. */
export const readLabRuntime = async (page: Page): Promise<LabPageSnapshot> => {
	const state = sideStateOf(page);
	let url = "";
	try {
		url = page.url();
	} catch {
		// page might be closed
	}
	try {
		const raw = await readRawRuntime(page);
		const marks = sanitizeMarks(raw.marks);
		const timelineNames = new Set(raw.timelineMarkNames);
		const productMarks = marks.filter((mark) => mark.name !== HARNESS_PAGE_START_MARK);
		const timelineMismatch =
			productMarks.length > 0 && !productMarks.some((mark) => timelineNames.has(mark.name));
		const pageErrors = [...sanitizeErrors(raw.pageErrors), ...state.errors];
		return {
			present: raw.present,
			enabled: raw.enabled,
			contractVersion: raw.contractVersion,
			marks,
			counters: raw.counters,
			dropped: raw.dropped,
			pageErrors,
			sentinel: marks.some((mark) => mark.name === LAB_MARKS.sentinel && mark.thread === "main"),
			crashed: state.crashed || crashedPages.has(page),
			timelineMarkNames: raw.timelineMarkNames,
			timelineMismatch,
			url,
			capturedAt: new Date().toISOString(),
		};
	} catch {
		return {
			...emptySnapshot(url),
			crashed: state.crashed || crashedPages.has(page),
			pageErrors: [...state.errors],
			capturedAt: new Date().toISOString(),
		};
	}
};

/**
 * Clears the collected marks/counters/errors and re-establishes the
 * harness-owned page-start mark. Used by suites that open a page for a fixed
 * measurement window instead of relying on document-start collection.
 */
export const resetLabRuntime = async (page: Page): Promise<void> => {
	try {
		await page.evaluate((pageStartName: string) => {
			const runtime = (window as unknown as { __AEVIA_LAB__?: InjectedRuntime }).__AEVIA_LAB__;
			if (!runtime || typeof runtime !== "object") return;
			runtime.marks = [{ name: pageStartName, thread: "main", t: performance.now() }];
			runtime.counters = {};
			runtime.dropped = 0;
			runtime.pageErrors = [];
		}, HARNESS_PAGE_START_MARK);
	} catch {
		// page closed before reset
	}
	const state = sideStateOf(page);
	state.errors = [];
	state.crashed = false;
};

export const waitForLabSentinel = async (page: Page, timeoutMs = 15_000): Promise<LabPageSnapshot> => {
	const deadline = Date.now() + timeoutMs;
	let snapshot = await readLabRuntime(page);
	while (!snapshot.sentinel && Date.now() < deadline) {
		await page.waitForTimeout(100);
		snapshot = await readLabRuntime(page);
	}
	return snapshot;
};

// ---------------------------------------------------------------------------
// Per-case collection scopes
// ---------------------------------------------------------------------------

type LabScope = {
	pages: Page[];
	snapshots: Map<Page, LabPageSnapshot | null>;
};

const scopeStack: LabScope[] = [];

const noteSnapshot = (snapshot: LabPageSnapshot): void => {
	instrumentationAccumulator.runtimeSeen ||= snapshot.present;
	instrumentationAccumulator.enabledSeen ||= snapshot.enabled;
	if (instrumentationAccumulator.contractVersion === null && typeof snapshot.contractVersion === "number") {
		instrumentationAccumulator.contractVersion = snapshot.contractVersion;
	}
	for (const mark of snapshot.marks) instrumentationAccumulator.markNames.add(mark.name);
};

const instrumentationAccumulator: {
	runtimeSeen: boolean;
	enabledSeen: boolean;
	contractVersion: number | null;
	markNames: Set<string>;
} = {
	runtimeSeen: false,
	enabledSeen: false,
	contractVersion: null,
	markNames: new Set<string>(),
};

export const resetLabAccumulator = (): void => {
	instrumentationAccumulator.runtimeSeen = false;
	instrumentationAccumulator.enabledSeen = false;
	instrumentationAccumulator.contractVersion = null;
	instrumentationAccumulator.markNames.clear();
};

export const labInstrumentationSummary = (requiredMarks: string[]): LabInstrumentationSummary => ({
	enabled: instrumentationAccumulator.runtimeSeen && instrumentationAccumulator.enabledSeen,
	contractVersion: instrumentationAccumulator.contractVersion,
	missingMarks: requiredMarks.filter((name) => !instrumentationAccumulator.markNames.has(name)).sort(),
});

export const beginLabScope = (): void => {
	scopeStack.push({ pages: [], snapshots: new Map() });
};

export const endLabScope = async (): Promise<void> => {
	const scope = scopeStack.pop();
	if (!scope) return;
	const contexts = new Set(scope.pages.map(page => page.context()));
	const outcomes = await Promise.allSettled([...contexts].map(context => withDeadline(context.close(), 5000, "sample page cleanup")));
	const timedOut = outcomes.find(outcome => outcome.status === "rejected" && String(outcome.reason).includes("host deadline"));
	if (timedOut?.status === "rejected") throw timedOut.reason;
};

export const trackLabPage = (page: Page): void => {
	for (const scope of scopeStack) {
		if (!scope.pages.includes(page)) {
			scope.pages.push(page);
			scope.snapshots.set(page, null);
		}
	}
};

/** Snapshot a page into every active scope; call before closing the page. */
export const captureLabSnapshot = async (page: Page): Promise<LabPageSnapshot> => {
	const snapshot = await readLabRuntime(page);
	for (const scope of scopeStack) {
		if (scope.pages.includes(page)) scope.snapshots.set(page, snapshot);
	}
	noteSnapshot(snapshot);
	return snapshot;
};

/** Returns every tracked page snapshot for the innermost active scope. */
export const collectLabSnapshots = async (): Promise<LabPageSnapshot[]> => {
	const scope = scopeStack[scopeStack.length - 1];
	if (!scope) return [];
	const collected: LabPageSnapshot[] = [];
	for (const page of scope.pages) {
		let snapshot = scope.snapshots.get(page) ?? null;
		if (!snapshot) {
			// Page is still open at collection time; read it without closing.
			snapshot = await readLabRuntime(page);
			scope.snapshots.set(page, snapshot);
			noteSnapshot(snapshot);
		}
		collected.push(snapshot);
	}
	return collected;
};
