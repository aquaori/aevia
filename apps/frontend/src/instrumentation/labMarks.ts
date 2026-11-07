// File role: lab instrumentation runtime: mark ring buffer, counters, and spans.
//
// The harness owns `window.__AEVIA_LAB__` when it injects it before boot; when
// the object is absent we publish a disabled default so guard/sentinel code can
// always dereference the contract. When lab mode is off every helper performs
// exactly one boolean check and returns without touching the DOM or timeline.
//
// Thread rule: this module never computes durations across threads. Every mark
// carries the timestamp of the thread that produced it (`performance.now()` in
// that thread) and worker marks are merged verbatim when the render worker
// bridge delivers them; cross-thread spans are settled on the main thread at
// message-receive time, not here.

export type LabMarkThread = "main" | "worker";

export type LabMarkDetail = Record<string, string | number | boolean>;

export interface LabMark {
	name: string;
	thread: LabMarkThread;
	t: number;
	detail?: LabMarkDetail;
}

export interface AeviaLabContract {
	contractVersion: number;
	enabled: boolean;
	marks: LabMark[];
	counters: Record<string, number>;
	dropped: number;
}

declare global {
	interface Window {
		__AEVIA_LAB__?: AeviaLabContract;
	}
}

export const labContractVersion = 1;

/** Ring-buffer high-water mark: older marks are evicted and counted as dropped. */
export const LAB_MARK_LIMIT = 4096;

const isWorkerContext = typeof window === "undefined";
const markThread: LabMarkThread = isWorkerContext ? "worker" : "main";

const createLabContract = (enabled: boolean): AeviaLabContract => ({
	contractVersion: labContractVersion,
	enabled,
	marks: [],
	counters: {},
	dropped: 0,
});

const resolveLabContract = (): AeviaLabContract => {
	if (isWorkerContext) return createLabContract(false);

	const injected = window.__AEVIA_LAB__;
	if (injected && typeof injected === "object") {
		try {
			if (!Array.isArray(injected.marks)) injected.marks = [];
			if (!injected.counters || typeof injected.counters !== "object") injected.counters = {};
			if (typeof injected.dropped !== "number") injected.dropped = 0;
			if (typeof injected.contractVersion !== "number") {
				injected.contractVersion = labContractVersion;
			}
			injected.enabled = injected.enabled === true;
		} catch {
			// Frozen harness object: honor it as-is instead of replacing its identity.
		}
		return injected;
	}

	const created = createLabContract(false);
	window.__AEVIA_LAB__ = created;
	return created;
};

const contract = resolveLabContract();
let enabled = contract.enabled;

/** Single boolean gate. Disabled mode must stay allocation-free. */
export const labEnabled = (): boolean => enabled;

/**
 * Worker/bootstrap hook: the main thread tells the render worker whether lab
 * mode is on (workers have no `window` for the harness to inject into).
 */
export const labSetEnabled = (nextEnabled: boolean): void => {
	enabled = nextEnabled === true;
	contract.enabled = enabled;
};

const recordMark = (mark: LabMark): void => {
	try {
		if (contract.marks.length >= LAB_MARK_LIMIT) {
			contract.marks.shift();
			contract.dropped += 1;
		}
		contract.marks.push(mark);
	} catch {
		// The buffer is owned by the harness; never let instrumentation throw.
	}
};

const publishPerformanceMark = (mark: LabMark): void => {
	try {
		const entryName = mark.name.startsWith("aevia.") ? mark.name : `aevia.${mark.name}`;
		performance.mark(entryName, { detail: mark.detail });
	} catch {
		// The performance timeline is optional; the ring buffer is authoritative.
	}
};

export const labMark = (name: string, detail?: LabMarkDetail): void => {
	if (!enabled) return;

	const mark: LabMark = { name, thread: markThread, t: performance.now() };
	if (markThread === "worker") {
		mark.detail = { ...(detail ?? {}), thread: markThread };
	} else if (detail) {
		mark.detail = detail;
	}

	recordMark(mark);
	publishPerformanceMark(mark);
};

export const labCounter = (name: string, delta = 1): void => {
	if (!enabled) return;
	contract.counters[name] = (contract.counters[name] ?? 0) + delta;
};

export const labSpanStart = (name: string): void => {
	if (!enabled) return;
	labMark(`${name}.start`);
};

export const labSpanEnd = (name: string): void => {
	if (!enabled) return;
	labMark(`${name}.end`);
};

/**
 * Merges a batch of worker-produced marks into the main-thread ring buffer.
 * Timestamps stay in the worker's own clock; nothing here does subtraction.
 */
export const mergeWorkerMarks = (marks: LabMark[]): void => {
	if (!enabled || !Array.isArray(marks)) return;
	for (const mark of marks) {
		if (!mark || typeof mark.name !== "string") continue;
		recordMark({
			name: mark.name,
			thread: "worker",
			t: typeof mark.t === "number" ? mark.t : 0,
			detail: mark.detail,
		});
	}
};

/**
 * Internal helper for the render worker: hands pending worker marks to the
 * worker's rAF batcher. The main thread keeps its marks in the ring buffer, so
 * it never drains them.
 */
export const labDrainMarks = (): LabMark[] => {
	if (!enabled) return [];
	try {
		return contract.marks.splice(0, contract.marks.length);
	} catch {
		return [];
	}
};
