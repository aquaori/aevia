// File role: cross-language contract test for the APG manifest corpus.
// The same corpus (tests/fixtures/apg/manifests.json) is validated by the Go
// package validator and by this browser parser, so the two implementations
// cannot drift without a failing test.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseApgCatalog } from "./apgCatalog";

type Expectation = "accept" | "reject";
interface CorpusCase {
	name: string;
	expect: { go: Expectation; frontend: Expectation };
	manifest?: unknown;
}
interface Corpus {
	schemaVersion: number;
	cases: CorpusCase[];
	divergences: Array<CorpusCase & { rawManifest: string; reason: string }>;
}

const corpus = JSON.parse(
	// Vitest runs with the repository root as cwd for every project.
	readFileSync(path.resolve(process.cwd(), "tests/fixtures/apg/manifests.json"), "utf8")
) as Corpus;
const DIGEST = "a".repeat(64);
const PROGRAM = "// contract fixture\n";

const asCatalog = (manifest: unknown) => {
	const record = manifest as { main?: unknown } | null;
	const program = record && record.main === "main.js" ? PROGRAM : undefined;
	return {
		version: 1,
		revision: DIGEST,
		plugins: [{ manifest, enabled: true, digest: DIGEST, signedBy: "contract", ...(program ? { program } : {}) }],
	};
};

const parses = (manifest: unknown) => parseApgCatalog(asCatalog(manifest)) !== null;

describe("APG manifest contract corpus", () => {
	it("loads a versioned corpus with unique case names", () => {
		expect(corpus.schemaVersion).toBe(1);
		const names = [...corpus.cases, ...corpus.divergences].map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
	});

	it.each(corpus.cases.map((entry) => [entry.name, entry] as const))(
		"frontend expectation for %s",
		(_name, entry) => {
			expect(parses(entry.manifest)).toBe(entry.expect.frontend === "accept");
		}
	);

	it("keeps documented duplicate-key divergence explicit", () => {
		// JSON.parse cannot see the duplicate key, so the browser accepts what the
		// Go walk rejects. Recorded here so the divergence is a decision, not a bug.
		for (const divergence of corpus.divergences) {
			expect(divergence.expect.frontend).toBe("accept");
			expect(divergence.expect.go).toBe("reject");
			expect(parses(JSON.parse(divergence.rawManifest))).toBe(true);
		}
	});

	it("rejects hostile catalog envelopes around a valid manifest", () => {
		const valid = parseApgCatalog(asCatalog(corpus.cases[0]!.manifest));
		expect(valid).not.toBeNull();
		const { plugins } = asCatalog(corpus.cases[0]!.manifest);
		expect(parseApgCatalog({ version: 1, plugins: [{ ...plugins[0], enabled: false }] })).toBeNull();
		expect(parseApgCatalog({ version: 1, plugins: [{ ...plugins[0], extra: 1 }] })).toBeNull();
		expect(parseApgCatalog({ version: 2, plugins })).toBeNull();
		expect(parseApgCatalog({ version: 1, plugins: [plugins[0], plugins[0]] })).toBeNull();
	});
});
