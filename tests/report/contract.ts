export type RunStatus = "running" | "passed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";
export type ArtifactKind = "vitest" | "go-test" | "coverage" | "go-coverage" | "package-list" | "external" | "feature-catalog";

export type RunStep = {
	id: string;
	title: string;
	status: StepStatus;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	exitCode?: number | null;
	logPath?: string;
	error?: string;
};

export type ExpectedArtifact = {
	id: string;
	stepId: string;
	kind: ArtifactKind;
	path: string;
	expectedCases?: string[];
	expectedSources?: string[];
};

export type RunManifest = {
	schemaVersion: 1;
	runId: string;
	profile: string;
	status: RunStatus;
	source: {
		revision: string | null;
		dirtyPatchSha256: string;
		trackedChanges?: string[];
		untrackedFiles?: string[];
	};
	startedAt: string;
	finishedAt?: string;
	expectedSteps: string[];
	steps: RunStep[];
	expectedArtifacts: ExpectedArtifact[];
};
