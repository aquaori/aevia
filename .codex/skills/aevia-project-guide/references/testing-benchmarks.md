# Testing and Benchmark Guide

Read this before modifying tests, benchmark scripts, reports, baselines, budgets, or performance instrumentation.

## Test Layout

Root:

- `vitest.config.ts`: Vitest project definitions.
- `tests/run-system.ts`: interactive profile runner; reads Vitest JSON reports on failure and starts one isolated frontend/backend pair before external steps. The direct external runner still expects caller-provided services.
- `tests/report/aggregate.ts`: aggregates Vitest and external reports.
- `tests/reports/`: generated report outputs.

Frontend:

- `apps/frontend/tests/bench/render-core.bench.ts`: existing Vitest micro benchmark.
- `apps/frontend/tests/bench/dirty-replay.bench.ts`: 10k/100k fixed-region, long-stroke, and dense-hotspot SceneEngine queries.
- `apps/frontend/tests/browser/scene-dirty-render.browser.spec.ts`: real Canvas byte comparison between dirty and full replay.
- `apps/frontend/tests/browser/room-pagination.browser.spec.ts`: pagination browser spec.
- `apps/frontend/tests/e2e/README.md`: notes that the E2E files are AI-generated and test-only.
- `apps/frontend/tests/e2e/external/`: current external E2E and benchmark harness.

## External E2E Harness

Important files:

- `external/runner.ts`: main entry; launches Chrome via Playwright, dispatches suites, writes reports, applies regressions.
- `external/config.ts`: CLI/env parsing and defaults.
- `external/suites.ts`: test case definitions and sampled performance cases.
- `external/protocol-driver.ts`: API/WebSocket protocol driver.
- `external/ui-driver.ts`: Playwright UI operations.
- `external/canvas-observer.ts`: canvas screenshots, ROI checks, pixel comparison.
- `external/performance-observer.ts`: reads browser performance metrics.
- `external/baseline.ts`: baseline and budget regression logic.
- `external/learning.ts`: history-based regression learning.
- `external/reporter.ts`: JSON/HTML report writing.
- `external/types.ts`: harness types.
- `external/budgets.json`: budget thresholds.
- `external/baselines/*.baseline.json`: stored baselines.
- `external/history/*.history.jsonl`: learned history.
- `external/reports/latest/`: generated reports.

## Supported Suites

From `runner.ts`:

- `harness-health`
- `correctness-smoke`
- `correctness-full`
- `performance-external`

Performance case IDs in `suites.ts` include:

- `full-render-*`
- `incremental-remote-first-pixel`
- `local-realtime-first-pixel`

Correctness/harness case IDs include:

- `harness-health`
- `correctness-smoke`
- `concurrent-crossing-visual-consistency`
- `late-joiner-visual-consistency`
- `protocol-multipage-isolation`

## CLI Defaults

External harness defaults from `config.ts`:

- suite: `correctness-smoke`
- mode: `headless`
- reporter: `both`
- frontend URL: `http://localhost:5173`
- API URL: `http://localhost:4646`
- WS URL: `ws://localhost:4646/ws`
- performance scales: `10000,50000,100000`
- performance runs: `3`
- performance warmup: `1`
- performance matrix: on for `performance-external`

## Common Commands

Root scripts:

```powershell
cmd /c npm run test:unit
cmd /c npm run test:integration
cmd /c npm run test:browser
cmd /c npm run test:bench
cmd /c npm run test:e2e:smoke
cmd /c npm run test:benchmark
cmd /c npm run test:report
```

The root `test:benchmark` command is self-contained and routes through `tests/run-system.ts`, so it owns an isolated frontend/backend pair. Workspace-level `benchmark:external:*` commands intentionally remain raw runners for callers that already provide `VITE_FRONTEND_URL`, `VITE_API_URL`, and `VITE_WS_URL`. Root benchmark CLI overrides such as `--matrix=false --runs=1 --warmup=0 --scales=1000` are forwarded to the external runner.

`vitest.config.ts` canonicalizes `process.cwd()` with `realpathSync`. Keep this when changing the config: the common Windows workspace path under `Desktop\\code` is a directory junction to `D:\\code`, and mixing the junction path with Vite's real path produces `/@fs/D:/...` module-not-found failures when `npm run test` starts from the C-drive spelling.

Root `npm run test` allocates local ports, injects `VITE_FRONTEND_URL`/`VITE_API_URL`/`VITE_WS_URL`, and uses a per-run SQLite file for external suites. Override the automatic ports with `AEVIA_TEST_FRONTEND_PORT` and `AEVIA_TEST_BACKEND_PORT` only when a fixed port is required. It stops only the services it started and removes that run's database on completion or interruption.

Frontend external harness:

```powershell
cmd /c npm run test:e2e:health --workspace @collaborative-whiteboard/frontend
cmd /c npm run test:e2e:smoke:ci --workspace @collaborative-whiteboard/frontend
cmd /c npm run benchmark:external:ci --workspace @collaborative-whiteboard/frontend
cmd /c npm run benchmark:external:headed --workspace @collaborative-whiteboard/frontend
cmd /c npm run benchmark:external:set-baseline --workspace @collaborative-whiteboard/frontend -- --baseline-source=<report-json>
cmd /c npm run benchmark:external:import-history --workspace @collaborative-whiteboard/frontend -- --baseline-source=<report-json>
```

Focused direct runner example:

```powershell
cmd /c npx tsx tests/e2e/external/runner.ts --suite=performance-external --mode=headless --runs=1 --warmup=0 --scales=10000 --report-dir=tests/e2e/external/reports/debug
```

Run direct runner commands from `apps/frontend`, because `config.ts` builds paths from `process.cwd()`.

## Modification Guidance

- For suite membership or case behavior, start with `suites.ts`.
- For CLI flags, defaults, report paths, or env handling, start with `config.ts`.
- For browser launch/matrix/report lifecycle, start with `runner.ts`.
- For baselines/regression thresholds, inspect `baseline.ts`, `budgets.json`, and relevant `baselines/*.baseline.json`.
- For screenshots and pixel assertions, inspect `canvas-observer.ts`.
- For API/WebSocket synthetic users, inspect `protocol-driver.ts`.
- For real UI pointer behavior, inspect `ui-driver.ts`.
- Keep report output changes aligned with `tests/report/aggregate.ts` if root summary generation consumes them.
- Protocol-driver V2 commands must use the trusted `userId` received in `init-meta`, not a locally invented join-response fallback, or strict gateway validation will reject them.
- Scene correctness lives primarily in `src/scene/sceneEngine.spec.ts`: arrival-order convergence, point/glyph interleaving, transform and erase history, page clear, RGA siblings, exact hit testing, and grid locality.

## Benchmark Database Hygiene

Every performance case seeds its history through the protocol driver, so the
backend database grows with each run: a full matrix at `--scales=...,100000`
adds millions of points. Past roughly 200 MB the backend starts returning
`HTTP 500` on `create-room` and `ETIMEDOUT`, which surfaces as unrelated-looking
case failures.

Reset the database before each measured run, and point the backend at a
throwaway file rather than the dev one:

```powershell
$env:DB_PATH = "<repo>\data\whiteboard-bench.sqlite"
Remove-Item "<repo>\data\whiteboard-bench.sqlite*" -Force
```

`npm run benchmark:go` does this automatically (and `-- --clean` reclaims the
space without running a benchmark). The standalone `runner.ts` does not, so a
before/after comparison must reset between the two sides or the second run is
measured against a slower backend.

## Baseline Comparability

`baselines/performance-external.baseline.json` carries a `conditions` block
recording the exact command, matrix setting, run/warmup counts and scales it was
produced with. Absolute timings depend on host, browser build and viewport, so
only compare a run against a baseline produced the same way on the same machine.
Re-baseline with `benchmark:external:set-baseline`, then regenerate budgets with
`node scripts/regen-budgets.mjs`.

## Verification

For benchmark harness script changes, use the smallest direct run that exercises the changed path. If local frontend/backend are not running, start them carefully and remember backend dev resets the DB.

For report aggregation changes:

```powershell
cmd /c npm run test:report
```
