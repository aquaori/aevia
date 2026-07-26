// Regenerates apps/frontend/tests/e2e/external/budgets.json from the committed
// performance baseline.
//
// budgets.json previously shipped as {"cases": {}}, so the budget regression gate
// evaluated nothing while the changelog advertised it as a feature. Budgets are
// absolute ceilings (a hard "never slower than this"), complementing the
// baseline-relative drift checks in tests/e2e/external/baseline.ts.
//
// Run after re-baselining:
//   node scripts/regen-budgets.mjs
//   node scripts/regen-budgets.mjs --headroom=0.5
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const externalDir = path.join(repoRoot, "apps", "frontend", "tests", "e2e", "external");
const baselinePath = path.join(externalDir, "baselines", "performance-external.baseline.json");
const budgetsPath = path.join(externalDir, "budgets.json");

const argValue = (name, fallback) => {
	const prefix = `--${name}=`;
	const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

// Fraction of slack above the recorded median before a budget fails.
const headroom = argValue("headroom", 1);

const METRIC_PREFIXES = [
	["full-render-", ["firstNonBlankMsMedian", "visuallyStableMsMedian"]],
	["incremental-remote-first-pixel", ["remoteFirstPixelMsMedian"]],
	["local-realtime-first-pixel", ["inputToFirstPixelMsMedian"]],
];

const metricsFor = (caseId) =>
	METRIC_PREFIXES.find(([prefix]) => caseId.startsWith(prefix))?.[1] ?? [];

if (!fs.existsSync(baselinePath)) {
	console.error(`No baseline at ${path.relative(repoRoot, baselinePath)}.`);
	console.error("Record one first with benchmark:external:set-baseline.");
	process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
const cases = {};

for (const [key, entry] of Object.entries(baseline.cases ?? {})) {
	const rules = {};
	for (const metric of metricsFor(entry.id ?? "")) {
		const value = entry.metrics?.[metric];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			rules[metric] = { max: Math.round(value * (1 + headroom) * 10) / 10 };
		}
	}
	if (Object.keys(rules).length > 0) {
		cases[key] = { metrics: rules };
	}
}

const percent = Math.round(headroom * 100);
fs.writeFileSync(
	budgetsPath,
	`${JSON.stringify(
		{
			version: 1,
			note: `Absolute ceilings derived from performance-external.baseline.json with ${percent}% headroom. Regenerate with scripts/regen-budgets.mjs after re-baselining.`,
			cases,
		},
		null,
		2
	)}\n`
);

console.log(
	`Wrote ${Object.keys(cases).length} budget cases to ${path.relative(repoRoot, budgetsPath)} (${percent}% headroom).`
);
