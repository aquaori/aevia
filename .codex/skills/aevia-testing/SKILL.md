---
name: aevia-testing
description: Operate and extend Aevia's managed tests, inspect run evidence, diagnose CI failures, and handle the legacy local benchmark without overstating its validity.
---

# Aevia Testing

Use this skill when running or changing Aevia tests, E2E suites, coverage, reports, CI, or performance measurements. Read [the project testing reference](../aevia-project-guide/references/testing-benchmarks.md) for current file ownership and implementation details.

## Commands

- `npm run test:doctor`: verify Node, Git, Go, dependencies, and the selected Playwright browser.
- `npm run test:quick`: run the backend HTTP/WS/scene surface inventory contract, explicit V2 rejection checks, shared/frontend unit and module suites, and report-contract tests. The backend catalog is not a complete product-feature inventory; this is not full regression evidence.
- `npm run test:ci`: run build, Go vet/tests/coverage, frontend/shared coverage tests, browser component tests, and the existing full correctness E2E suite in managed isolation.
- `npm run test:full`: currently uses the same profile as `test:ci`; it is not yet a broader fuzz, mutation, or device matrix.
- `npm run test:replay -- --run-id=<uuid>`: rerun a managed profile only when the current source revision and dirty-file fingerprint exactly match the recorded run. This reruns the profile; it does not replay a captured random seed or an individual operation sequence.
- `npm run test:report -- --manifest=<path>`: aggregate only the explicitly named run manifest. In PowerShell, use `npm.cmd run test:report -- --manifest=<path>` so the npm shim forwards the option. Never use `latest` or a historical report as evidence for another run.
- `npm run test:perf`: run the existing local external benchmark harness. Its collection and thresholds are not yet calibrated to the new evidence contract; do not use it as a CI gate or claim a verified performance regression from it.

Set `AEVIA_TEST_BROWSER` to `chromium`, `firefox`, or `webkit` to select the browser for managed CI and component tests. Chromium may use `AEVIA_CHROMIUM_EXECUTABLE` when a Playwright-downloaded binary is unavailable. Run `test:doctor` before attributing browser startup failures to product code.

## Evidence Rules

- A managed run is usable only when its own `run-manifest.json` and generated `test-report.json` have the same run ID and source identity, every required step passes once, and every listed artifact validates.
- Read files only from the run directory named by that manifest. A missing, empty, duplicated, stale, or malformed artifact is a failed evidence check, not a pass and not a reason to reuse prior output.
- Keep product failures distinct from setup or harness failures in the diagnosis. Preserve the first failure; a manual diagnostic rerun does not erase it.
- Coverage artifacts bind an explicit frontend/shared source-file inventory and the current Go package inventory; omitted or unexpected files/packages invalidate the run. Frontend reports expose and validate statement, branch, function, and line coverage. The requested 99% per-module thresholds, complete feature catalogue, mutation gates, and calibrated performance limits are not yet enforced by this implementation.
- The current run-scoped `feature-obligations` artifact inventories backend HTTP routes, WebSocket event types, accepted scene-operation kinds, frontend routes, and built-in tool IDs. It does not enumerate all UI/worker behaviors or scenarios. Read its `scope`, state counts, and unresolved IDs before drawing conclusions; `obligation_verified` proves only its named oracle, while `partial`, `uncovered`, and `rejection_contract_verified` do not mean the product behavior is fully covered.
- Performance output must name its measurement source and limitations. Do not edit baselines, budgets, scenario expectations, or exclusions to make a failing run pass without an independently reviewed reason.

## Changing Tests

For a behavior change, add an independently asserted regression case before relying on the broad suite. Register backend HTTP/WS/scene surfaces and frontend routes/tool IDs with their oracle/status in `tests/catalog/feature-obligations.json`; Go and TypeScript AST checks require parity with those source entry points. Add frontend UI/worker behavior obligations as that inventory expands. Register external case IDs, capability labels, observable oracles, and known limitations in `tests/catalog/external-cases.ts`; both the managed runner and external suites consume IDs from this catalog. Keep additions and removals deliberate, and add catalog tests under `tests/report/`. Add harness-contract tests there when changing manifests, artifact formats, aggregation, or failure handling.

Do not add business-code hooks, debug endpoints, private store reads, or private renderer globals to collect E2E or performance data. Test-only browser instrumentation may observe public DOM/canvas pixels, browser performance APIs, CDP events, network traffic, and the test-owned process tree. If the measurement cannot be calibrated, keep it diagnostic and non-gating.
