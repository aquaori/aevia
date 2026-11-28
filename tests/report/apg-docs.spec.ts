// Docs are a deliverable of APG, so their integrity is checked like code: every relative
// link must resolve, and every official plugin shipped in `plugins/official` must be listed in
// the two documents an operator reads first. Without this, a renamed file or a plugin added in
// code but missing from the docs silently rots.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..");
const docsDir = join(repoRoot, "docs", "apg");
const officialDir = join(repoRoot, "plugins", "official");

const docFiles = () => readdirSync(docsDir).filter((name) => name.endsWith(".md"));
const officialPluginIds = () =>
	readdirSync(officialDir)
		.filter((name) => statSync(join(officialDir, name)).isDirectory())
		.map((name) => {
			const manifest = JSON.parse(readFileSync(join(officialDir, name, "manifest.json"), "utf8"));
			return manifest.id as string;
		});

const relativeLinks = (markdown: string) => {
	const links: string[] = [];
	const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
	for (const match of markdown.matchAll(pattern)) {
		const target = match[1]!;
		if (/^(https?:|mailto:|#)/.test(target)) continue;
		links.push(target.split("#")[0]!);
	}
	return links;
};

describe("APG documentation", () => {
	it("has no broken relative links", () => {
		const broken: string[] = [];
		for (const file of docFiles()) {
			const source = readFileSync(join(docsDir, file), "utf8");
			for (const link of relativeLinks(source)) {
				if (!link) continue;
				const target = resolve(docsDir, link);
				try {
					statSync(target);
				} catch {
					broken.push(`${file} -> ${link}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("links to source paths that exist", () => {
		const missing: string[] = [];
		for (const file of docFiles()) {
			// future-work.md deliberately names files that do not exist yet; those are the
			// design targets, not claims about the current tree.
			if (file === "future-work.md") continue;
			const source = readFileSync(join(docsDir, file), "utf8");
			// Inline code that looks like a repo path with a file extension, e.g.
			// `apps/backend/internal/apg/catalog.go` or `apps/frontend/src/x.ts:12`.
			for (const match of source.matchAll(/`((?:apps|packages|tests|plugins|scripts)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?`/g)) {
				const path = match[1]!;
				try {
					statSync(join(repoRoot, path));
				} catch {
					missing.push(`${file} -> ${path}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("lists every shipped official plugin in the operator-facing documents", () => {
		const ids = officialPluginIds();
		expect(ids.length).toBeGreaterThan(0);
		for (const doc of ["development.md", "acceptance.md"]) {
			const source = readFileSync(join(docsDir, doc), "utf8");
			// Documents may use the full plugin id or the short row name (`shape-template`).
			const absent = ids.filter((id) => !source.includes(id) && !source.includes(id.split(".")[1] ?? id));
			expect({ doc, absent }).toEqual({ doc, absent: [] });
		}
	});
});
