// File role: explain why a managed run's source identity drifted between manifest start and source-check.
//
// The run manifest hashes the working tree (tracked diff + untracked files) when the run starts and
// re-checks it at the end. A mismatch is a hard failure, but the old message only printed two hashes,
// which made "my editor wrote a file mid-run" indistinguishable from a real reproducibility bug.
//
// Some tracked files are *run output*: the performance history and baseline JSONL/JSON files are
// deliberately committed, and a clean nightly import appends to them while the run is executing.
// Those paths are excluded from the drift verdict; everything else must stay byte-identical.

export type SourceIdentityLike = {
	revision: string | null;
	dirtyPatchSha256: string;
	trackedChanges?: string[];
	untrackedFiles?: string[];
};

export type SourceDriftOptions = {
	/** Return true for paths the run itself is allowed to rewrite (generated evidence). */
	isIgnoredPath?: (filePath: string) => boolean;
};

export type SourceDrift = {
	revisionChanged: boolean;
	fingerprintChanged: boolean;
	trackedAdded: string[];
	trackedRemoved: string[];
	untrackedAdded: string[];
	untrackedRemoved: string[];
	/** Same file sets but a different fingerprint: the content changed in place. */
	inPlaceContentChanged: string[];
	/** Generated evidence paths that changed but did not count as drift. */
	ignoredGeneratedPaths: string[];
};

/** Tracked test evidence that a managed run is allowed to append to (history/baselines). */
export const isGeneratedEvidencePath = (filePath: string) =>
	/\/tests\/e2e\/external\/(history|baselines)\//.test(filePath.replaceAll("\\", "/"));

const sorted = (values: string[] | undefined) => [...new Set(values ?? [])].sort();

export const describeSourceDrift = (
	before: SourceIdentityLike,
	after: SourceIdentityLike,
	options: SourceDriftOptions = {}
): SourceDrift => {
	const ignored = options.isIgnoredPath ?? (() => false);
	const beforeTracked = new Set(sorted(before.trackedChanges));
	const afterTracked = new Set(sorted(after.trackedChanges));
	const beforeUntracked = new Set(sorted(before.untrackedFiles));
	const afterUntracked = new Set(sorted(after.untrackedFiles));
	const trackedAddedRaw = [...afterTracked].filter((item) => !beforeTracked.has(item));
	const trackedRemovedRaw = [...beforeTracked].filter((item) => !afterTracked.has(item));
	const untrackedAddedRaw = [...afterUntracked].filter((item) => !beforeUntracked.has(item));
	const untrackedRemovedRaw = [...beforeUntracked].filter((item) => !afterUntracked.has(item));
	const ignoredGeneratedPaths = sorted([
		...trackedAddedRaw,
		...trackedRemovedRaw,
		...untrackedAddedRaw,
		...untrackedRemovedRaw,
	].filter((item) => ignored(item)));
	const trackedAdded = trackedAddedRaw.filter((item) => !ignored(item));
	const trackedRemoved = trackedRemovedRaw.filter((item) => !ignored(item));
	const untrackedAdded = untrackedAddedRaw.filter((item) => !ignored(item));
	const untrackedRemoved = untrackedRemovedRaw.filter((item) => !ignored(item));

	const rawFileSetsEqual =
		trackedAddedRaw.length === 0 && trackedRemovedRaw.length === 0 && untrackedAddedRaw.length === 0 && untrackedRemovedRaw.length === 0;
	const fingerprintMoved = before.dirtyPatchSha256 !== after.dirtyPatchSha256;
	// With identical file sets the aggregate hash can only move because some tracked file's content
	// changed in place; only the non-generated candidates count as drift.
	const inPlaceCandidates = fingerprintMoved && rawFileSetsEqual ? sorted(before.trackedChanges) : [];
	const inPlaceContentChanged = inPlaceCandidates.filter((item) => !ignored(item));
	const ignoredContentPaths = inPlaceCandidates.filter((item) => ignored(item));
	const filteredFileSetsEqual =
		trackedAdded.length === 0 && trackedRemoved.length === 0 && untrackedAdded.length === 0 && untrackedRemoved.length === 0;
	const fingerprintChanged = !filteredFileSetsEqual || (fingerprintMoved && inPlaceContentChanged.length > 0);

	return {
		revisionChanged: before.revision !== after.revision,
		fingerprintChanged,
		trackedAdded,
		trackedRemoved,
		untrackedAdded,
		untrackedRemoved,
		inPlaceContentChanged,
		ignoredGeneratedPaths: sorted([...new Set([...ignoredGeneratedPaths, ...ignoredContentPaths])]),
	};
};

export const describeSourceDriftLines = (
	drift: SourceDrift,
	before: SourceIdentityLike
): string[] => {
	const lines: string[] = [];
	if (drift.revisionChanged) lines.push("HEAD changed while the run was executing");
	if (drift.fingerprintChanged) lines.push("the working-tree fingerprint changed while the run was executing");
	if (drift.trackedAdded.length > 0) lines.push(`tracked files became dirty: ${drift.trackedAdded.join(", ")}`);
	if (drift.trackedRemoved.length > 0) lines.push(`tracked files became clean: ${drift.trackedRemoved.join(", ")}`);
	if (drift.untrackedAdded.length > 0) lines.push(`new untracked files: ${drift.untrackedAdded.join(", ")}`);
	if (drift.untrackedRemoved.length > 0) lines.push(`removed untracked files: ${drift.untrackedRemoved.join(", ")}`);
	if (drift.inPlaceContentChanged.length > 0) {
		lines.push(`content changed in place (same dirty file set): ${drift.inPlaceContentChanged.join(", ")}`);
	}
	if (
		drift.fingerprintChanged &&
		drift.trackedAdded.length === 0 &&
		drift.trackedRemoved.length === 0 &&
		drift.untrackedAdded.length === 0 &&
		drift.untrackedRemoved.length === 0 &&
		drift.inPlaceContentChanged.length === 0
	) {
		lines.push(`the tree was already dirty; the changed file could not be identified (${before.trackedChanges?.length ?? 0} tracked / ${before.untrackedFiles?.length ?? 0} untracked at start)`);
	}
	if (drift.ignoredGeneratedPaths.length > 0) {
		lines.push(`generated evidence changed by the run (ignored): ${drift.ignoredGeneratedPaths.join(", ")}`);
	}
	if (drift.revisionChanged || drift.fingerprintChanged) {
		lines.push(
			"hint: a managed run hashes the working tree at start and re-checks it at the end — do not edit, format, stage or check out files while it runs; use a second worktree for parallel edits"
		);
	}
	return lines;
};
