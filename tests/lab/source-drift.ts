// File role: explain why a managed run's source identity drifted between manifest start and source-check.
//
// The run manifest hashes the working tree (tracked diff + untracked files) when the run starts and
// re-checks it at the end. A mismatch is a hard failure, but the old message only printed two hashes,
// which made "my editor wrote a file mid-run" indistinguishable from a real reproducibility bug.

export type SourceIdentityLike = {
	revision: string | null;
	dirtyPatchSha256: string;
	trackedChanges?: string[];
	untrackedFiles?: string[];
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
};

const sorted = (values: string[] | undefined) => [...new Set(values ?? [])].sort();

export const describeSourceDrift = (before: SourceIdentityLike, after: SourceIdentityLike): SourceDrift => {
	const beforeTracked = new Set(sorted(before.trackedChanges));
	const afterTracked = new Set(sorted(after.trackedChanges));
	const beforeUntracked = new Set(sorted(before.untrackedFiles));
	const afterUntracked = new Set(sorted(after.untrackedFiles));
	const trackedAdded = [...afterTracked].filter((item) => !beforeTracked.has(item));
	const trackedRemoved = [...beforeTracked].filter((item) => !afterTracked.has(item));
	const untrackedAdded = [...afterUntracked].filter((item) => !beforeUntracked.has(item));
	const untrackedRemoved = [...beforeUntracked].filter((item) => !afterUntracked.has(item));
	const fingerprintChanged = before.dirtyPatchSha256 !== after.dirtyPatchSha256;
	const fileSetsEqual =
		trackedAdded.length === 0 && trackedRemoved.length === 0 && untrackedAdded.length === 0 && untrackedRemoved.length === 0;
	return {
		revisionChanged: before.revision !== after.revision,
		fingerprintChanged,
		trackedAdded,
		trackedRemoved,
		untrackedAdded,
		untrackedRemoved,
		inPlaceContentChanged: fingerprintChanged && fileSetsEqual ? sorted(before.trackedChanges) : [],
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
	if (lines.length > 0) {
		lines.push(
			"hint: a managed run hashes the working tree at start and re-checks it at the end — do not edit, format, stage or check out files while it runs; use a second worktree for parallel edits"
		);
	}
	return lines;
};
