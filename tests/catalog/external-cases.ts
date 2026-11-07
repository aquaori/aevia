export type ExternalCaseDefinition = {
	id: string;
	capability: string;
	oracle: string;
	ciRequired: boolean;
	knownLimitations?: string[];
};

export const EXTERNAL_CASES = {
	harnessHealth: {
		id: "harness-health",
		capability: "public websocket delivery to a rendered canvas",
		oracle: "a remote stroke changes pixels in the expected region after room creation and websocket connection",
		ciRequired: true,
	},
	correctnessSmoke: {
		id: "correctness-smoke",
		capability: "bidirectional drawing, history controls, and page navigation",
		oracle: "both clients observe drawing; undo removes only the target stroke on both clients, redo restores it, and returning from a new page restores the prior page while excluding the new page content",
		ciRequired: true,
	},
	concurrentCrossing: {
		id: "concurrent-crossing-visual-consistency",
		capability: "concurrent multi-client drawing",
		oracle: "independently captured client canvases remain within the reviewed pixel-diff threshold after concurrent crossing strokes",
		ciRequired: true,
	},
	lateJoiner: {
		id: "late-joiner-visual-consistency",
		capability: "initial state replay to a later room participant",
		oracle: "the late participant canvas converges with the existing participant canvas after replay",
		ciRequired: true,
	},
	multipageIsolation: {
		id: "protocol-multipage-isolation",
		capability: "page-specific operation replay and page navigation",
		oracle: "the expected page region is nonblank while the other page's region remains blank, then the checks reverse after navigation",
		ciRequired: true,
	},
	networkRecovery: {
		id: "resilience-network-recovery",
		capability: "reconnection after network interruption",
		oracle: "the public client returns to the expected connected state and recovers the fixture after interruption",
		ciRequired: false,
	},
	fullRenderPerformance: {
		id: "full-render",
		capability: "late-join full-scene initialization performance",
		oracle: "external browser observations record first visible content and visual settling for each configured scene scale",
		ciRequired: false,
	},
	remoteFirstPixelPerformance: {
		id: "incremental-remote-first-pixel",
		capability: "remote incremental rendering latency",
		oracle: "a public websocket stroke changes pixels in the target observer region and records elapsed time and observed frames",
		ciRequired: false,
	},
	localFirstPixelPerformance: {
		id: "local-realtime-first-pixel",
		capability: "local interaction-to-visible-pixel latency",
		oracle: "a Playwright pointer stroke changes pixels in the target region and records elapsed time and observed frames",
		ciRequired: false,
	},
	fullRenderBoundary: {
		id: "boundary-full-render-until-crash",
		capability: "large-scene rendering boundary",
		oracle: "the browser completes the configured large-scene trial without a page crash",
		ciRequired: false,
	},
	heapGrowthBoundary: {
		id: "boundary-same-page-heap-growth",
		capability: "same-page memory growth boundary",
		oracle: "external browser heap observations stay within the case's declared boundary",
		ciRequired: false,
	},
	redrawFreezeBoundary: {
		id: "boundary-incremental-redraw-freeze",
		capability: "incremental redraw responsiveness boundary",
		oracle: "the browser completes the configured redraw trial without exceeding its freeze limit",
		ciRequired: false,
	},
	undoRedoConvergence: {
		id: "undo-redo-convergence",
		capability: "multi-client history toggle convergence",
		oracle:
			"after two undo and two redo operations on one client, both client canvases stay pixel-identical at every step and the undone regions really become blank",
		ciRequired: false,
	},
	lateJoinerUndoConsistency: {
		id: "late-joiner-undo-consistency",
		capability: "initial state replay after a history toggle",
		oracle:
			"a client joining after an undo sees the same canvas as the original client: the undone stroke is absent and the retained stroke is present",
		ciRequired: false,
	},
} as const satisfies Record<string, ExternalCaseDefinition>;

export const CI_REQUIRED_EXTERNAL_CASE_IDS = Object.values(EXTERNAL_CASES)
	.filter((testCase) => testCase.ciRequired)
	.map((testCase) => testCase.id);

/**
 * Everything the full correctness suite runs: the CI-required set plus deeper
 * convergence cases that are too slow for every PR but belong to the nightly gate.
 */
export const CORRECTNESS_FULL_EXTERNAL_CASE_IDS = [
	...CI_REQUIRED_EXTERNAL_CASE_IDS,
	EXTERNAL_CASES.undoRedoConvergence.id,
	EXTERNAL_CASES.lateJoinerUndoConsistency.id,
];

export const validateExternalCaseCatalog = () => {
	const errors: string[] = [];
	const ids = Object.values(EXTERNAL_CASES).map((testCase) => testCase.id);
	const duplicateIDs = ids.filter((id, index) => ids.indexOf(id) !== index);
	if (duplicateIDs.length > 0) {
		errors.push(`duplicate case ids: ${[...new Set(duplicateIDs)].join(", ")}`);
	}
	for (const testCase of Object.values(EXTERNAL_CASES)) {
		if (!testCase.capability.trim()) errors.push(`${testCase.id}: missing capability`);
		if (!testCase.oracle.trim()) errors.push(`${testCase.id}: missing observable oracle`);
	}
	if (CI_REQUIRED_EXTERNAL_CASE_IDS.length === 0) errors.push("CI case list must not be empty");
	return errors;
};
