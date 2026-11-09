# Testing and Benchmark Guide

Read this before modifying tests, benchmark scripts, reports, baselines, budgets, or performance instrumentation.
For command selection and evidence interpretation, also read [the aevia-testing skill](../../aevia-testing/SKILL.md).

## Test Layout

Root:

- `vitest.config.ts`: Vitest project definitions.
- `tests/run-system.ts`: managed `quick`, `ci`, and `full` profiles plus the legacy interactive benchmark runner. Managed runs own a UUID report directory and manifest.
- `tests/report/contract.ts`: run manifest, step, and artifact contracts.
- `tests/report/provenance.ts`: Git revision and dirty-source fingerprint.
- `tests/report/aggregate.ts`: fail-closed aggregation of only manifest-listed artifacts.
- `tests/report/aggregate.spec.ts`: regression tests for missing, stale, skipped, duplicated, and denominator-mismatched evidence.
- `tests/catalog/external-cases.ts`: stable external case IDs, capability labels, observable oracles, and PR-required membership.
- `tests/report/external-case-catalog.spec.ts`: validates catalog uniqueness and the explicit PR-required case set.
- `tests/catalog/feature-obligations.json`: current backend HTTP route, WebSocket event, scene-operation, frontend route, and built-in tool inventory with explicit obligation states.
- `apps/backend/internal/gateway/surface_catalog_test.go`: Go AST parity checks for backend surfaces and public 501 contracts for reserved V2 routes.
- `tests/report/feature-obligations.spec.ts`: TypeScript AST parity checks for frontend routes/tools, validates evidence references, and verifies catalog shape.
- `tests/browser-launch.ts`: selected Playwright browser and Chromium executable resolution.
- `.github/workflows/quick.yml`: push/PR commit and PR-title lint, changed-file ESLint/gofmt, and task-dependent quick checks.
- `.github/workflows/ci.yml`: Linux/Chromium core on push/PR; OS/browser matrix is scheduled or manually dispatched. It does not run performance gates.
- `tests/reports/`: generated report outputs.

Frontend:

- `apps/frontend/tests/bench/render-core.bench.ts`: existing Vitest micro benchmark.
- `apps/frontend/tests/bench/dirty-replay.bench.ts`: 10k/100k fixed-region, long-stroke, and dense-hotspot SceneEngine queries.
- `apps/frontend/tests/browser/scene-dirty-render.browser.spec.ts`: real Canvas byte comparison between dirty and full replay.
- `apps/frontend/tests/browser/room-pagination.browser.spec.ts`: pagination browser spec.
- `apps/frontend/tests/browser/worker-init-stream.browser.spec.ts`: tests worker initialization when canvas transfer is available; otherwise it tests the mounted main-thread 2D fallback. The worker path is not covered on browsers without canvas transfer.
- `apps/frontend/tests/e2e/README.md`: notes that the E2E files are AI-generated and test-only.
- `apps/frontend/tests/e2e/external/`: current external E2E and benchmark harness.

## External E2E Harness

Important files:

- `external/runner.ts`: main entry; launches the selected Playwright browser, dispatches suites, writes reports, applies legacy regression rules, and attaches run/source identity.
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

The stable IDs, capability labels, current observable oracles, known limitations, and PR-required subset live in `tests/catalog/external-cases.ts`. `runner.ts`, `suites.ts`, and the managed evidence plan consume IDs from that catalog. It currently seeds the existing external suites; it is not yet the complete product-feature catalogue or proof of 99% behavior coverage. The feature-obligation catalog currently inventories public backend surfaces plus frontend routes/tool IDs, but not all UI/worker behaviors or scenario obligations; its run report must be read for the recorded scope and unresolved IDs.

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

Managed root scripts:

```powershell
npm run test:doctor
npm run test:quick
npm run test:ci
npm run test:full
npm run test:replay -- --run-id=<uuid>
npm run test:report -- --manifest=<run-manifest.json>
npm run test:perf
```

`test:ci` owns one report directory, a source revision and dirty-file hash, an isolated database and service pair, exact expected artifacts, and a terminal result even after a failed step. It runs Go package inventory, Go tests with cross-package coverage, frontend/shared tests with coverage, browser component tests, and the CI-required correctness-full external cases. Coverage validation checks the complete discovered source/package inventory, not just a nonzero aggregate. Managed browser tests receive a per-run free API port. `test:quick` also runs the backend surface AST contract and records a run-scoped feature-catalog snapshot. `test:full` adds `go test -race ./...` and a 30-second bounded scene-validator fuzz smoke to `test:ci`; race needs a working host CGO toolchain. Those steps are configured, not automatically proven to pass: inspect the current run's manifest/report. Mutation, broader scenario coverage and repeated-run stability gates remain future work.

For pre-commit checks, follow `.codex/AGENTS.md` as well as this reference. `test:ci` does not substitute for the separate changed-file ESLint/gofmt step in `quick.yml`; `scripts/ci-changed.mjs` compares commits, not uncommitted edits. If a Go test reads a shared fixture outside the Go module, use `go test -count=1` for the affected package after changing that fixture so stale cached results cannot conceal a mismatch. On hosted failure, inspect the failing run's complete `backend/go-tests.jsonl` and report, not only the last console lines; expected error logs may belong to passing fault-injection tests.

Current coverage output is measurement, not a percentage threshold gate. The managed frontend/shared report is bound to an explicit executable-source inventory, and Go coverage must match the exact package inventory from the same run. The requested 99% per-module targets are not achieved. The earlier 50.7% Go figure used a different aggregation scope from the managed `-coverpkg=./...` profile; do not compare those values as a trend until the metric definitions are aligned.

`vitest.config.ts` canonicalizes `process.cwd()` with `realpathSync`. Keep its Vite root aligned with the Vitest process cwd: the common Windows workspace spelling under `Desktop\\code` is a junction to `D:\\code`; mixed roots have caused module-resolution and dependency-optimization failures. Managed Vitest subprocesses use the canonical root. Browser selection is `AEVIA_TEST_BROWSER=chromium|firefox|webkit`.

The legacy interactive benchmark runner and workspace-level `benchmark:external:*` commands are not part of managed CI evidence. They still write their own reports and can be used for local diagnosis, but collection calibration and thresholds are not validated. Do not compare their values as trusted performance evidence until calibration is complete.

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
- Blank-region assertions in convergence cases use **canvas readback** (`captureCanvasSample`), not full-page screenshots: screenshots include UI overlays (remote cursor, hover) that can keep a genuinely empty canvas region above the non-blank threshold and cause flaky timeouts. The same applies to `correctness-smoke`'s undo-target blank check and the multipage isolation leak checks; visible-screenshot checks remain for "the expected region has content" only.

## Benchmark Database Hygiene

Performance runs can seed millions of points. Use a dedicated throwaway database and reset it between comparable runs; never remove the user's development database. Managed boundary steps use isolated services and reset their own database. The standalone external `runner.ts` does not reset its backend database.

The root command is `npm run benchmark:backend`, backed by `scripts/benchmark-backend.mjs`; its default removes the benchmark database and SQLite sidecars before starting, `-- --keep-db` retains them, and `-- --clean` only removes them. The removal target is computed under `<repo>/data` using the basename of `GO_BENCH_DB_PATH`, `GO_BACKEND_DB_PATH`, or `DB_PATH`; the launched backend uses the configured path. Inspect both resolved paths before running and use a dedicated basename, because an existing file under `<repo>/data` may be removed. Do not assume `--clean` is read-only.

## Baseline Comparability

`baselines/performance-external.baseline.json` carries a `conditions` block
recording the exact command, matrix setting, run/warmup counts and scales it was
produced with. Absolute timings depend on host, browser build and viewport, so
only compare a run against a baseline produced the same way on the same machine.
Baseline changes and `node scripts/regen-budgets.mjs` need an independently justified and authorized reason; never use them to make a failing run pass.

Historical provenance: re-baselined on 2026-10-31 from run `928f2f5b` (one of three
successful nightly runs at `982f752` on the Windows dev host; it was the candidate
closest to the cross-run median), with budgets regenerated at 100% headroom. On a
noisy host the baseline comparison stays advisory: a fresh validation matrix run
stayed inside every budget, but 4 of 40 baseline deltas exceeded the 20%+8ms
tolerance in the CPU-throttled environments. If the actual `self-hosted,
aevia-nightly` runner is a different machine, re-baseline there before trusting
nightly regression output.

## Lab Runner Modes

`tests/run-system.ts` owns both the legacy interactive profiles and the managed lab profiles.
Lab profiles always write a v2 run manifest, fail-closed evidence, and a lab report.

| Profile | Command | Intent | Performance |
| --- | --- | --- | --- |
| `single` | `npm run test:single -- --only=file:<path>` / `--since=<git-ref>` | 单点：只跑刚改动的测试目标，不写基线/历史/latest | off |
| `smoke` | `npm run test:smoke` | catalog-check + 四个 vitest project + correctness-smoke external | off |
| `ci` | `npm run test:ci` | 与旧 CI 证据链一致（build/vet/go test/coverage/browser/correctness-full）+ 采集门禁 | `--perf=request` 可选，只产 `perf-request.json` |
| `full` | `npm run test:full` | ci 核心 + Go race + 30 秒 scene-validator fuzz；以当次报告为准 | off |
| `nightly` | `npm run test:nightly` | ci 全量 + 性能（standard/resilience 各一轮 + boundary full-render 每个 scale 各自独立重置库并重启后端，heap-growth/redraw-freeze 各一轮）+ race/fuzz + 模块债务清单 | on |

Nightly probes `go test -race` once while building the plan: hosts without a usable CGO toolchain omit that step with a
printed note instead of failing the run (the failure is an environment problem, not a product regression).
`AEVIA_NIGHTLY_BOUNDARY_SCALES=100000,250000` shortens the boundary ladder for a local smoke of the nightly shape. The hosted Linux job caps it at `100000,250000,500000,1000000` because 2M/5M scales need the dedicated large runner.

GitHub nightly uses the fixed Windows performance runner when configured. Otherwise it runs standard/resilience and boundary observations in separate hosted Linux jobs with `AEVIA_LAB_DIAGNOSTIC=1`: each job has its own report, the run is not recorded to history and cannot establish a performance qualification across changing hosts. Boundary progress, service errors, memory and cgroup OOM counters are streamed to the Actions log so a runner shutdown does not erase all diagnostic evidence. A sudden shutdown can still prevent the affected job's final report from being uploaded. The matrix correctness job publishes one combined index linking to the nine run-scoped reports.

`single` selectors: `case:<external-case-id>[,<id>]`、`file:<path>`、`test:<substring>`、`go:<pkg>[#TestName]`；
`--since=<ref>` 会用 `git diff --name-only <ref>...HEAD` 加未跟踪文件，经 `tests/lab/resolve-only.ts` 映射到 owner test。
重跑入口：`--rerun-of=<runId> --scope=run|scenario|case --ids=<csv>`，由 `scripts/lab-serve.mjs` 调用。

## Run Manifest v2 and Measurement Validity

`tests/report/contract.ts` schemaVersion 2 adds `mode`, `validity {status:"valid"|"degraded"|"invalid", aborted, reasons[]}`,
`recorded`, `rerun`, `measurement`, and three artifact kinds: `lab-gate`, `lab-inventory`, `perf-request`.

Validity codes are defined in `VALIDITY_CODES` (MISSING_MARK, EXTERNAL_DISAGREEMENT, PAGE_CONSOLE_ERROR, LAB_RUNTIME_MISSING, ...).
They describe **measurement** failures; a product failure stays an ordinary failed test. The rules:

- one invalid case → printed as `[lab][invalid-case]`, case becomes failed, run continues (collect every problem);
- one scenario whose every case is invalid → the run aborts, the report is still written, `validity.aborted=true`, and nothing is recorded;
- `recorded=false` (single mode, rerun, dirty nightly) never moves `tests/reports/summary/latest.json`;
- baseline/history are only written for valid, clean-tree runs (`apps/frontend/tests/e2e/external/runner.ts`).

Exit codes: `0` passed, `1` test/gate failure, `2` harness or usage error, `3` measurement aborted, `130` interrupted.

`source-check` re-hashes the working tree at the end of a managed run. When it moved it now names the files that became
dirty, became clean, or changed in place, plus a hint: editing files while a run executes is indistinguishable from a
reproducibility bug otherwise. The run also warns at start when the tree is already dirty. The tracked evidence files the
run itself appends to (`apps/frontend/tests/e2e/external/history/` and `baselines/`) are excluded from the drift verdict
and reported as "generated evidence changed by the run (ignored)".

## Runtime Instrumentation Contract

`apps/frontend/src/instrumentation/labMarks.ts` owns `window.__AEVIA_LAB__`
(`{contractVersion, enabled, marks[], counters, dropped}`) and `labMark/labCounter/labSpanStart/labSpanEnd/mergeWorkerMarks`.
It is disabled unless the harness injects `window.__AEVIA_LAB__.enabled = true` **before application scripts run**
(`page.addInitScript`), so production behaviour is unchanged; disabled calls cost one boolean check.

Mark vocabulary (single source: `labMarkNames.ts`): `aevia.init.meta`, `aevia.init.first-chunk`,
`aevia.init.render-complete`, `aevia.init.commands-complete`, `aevia.worker.first-paint`, `aevia.page.change`,
`aevia.delta.meta`, `aevia.delta.complete`, `aevia.ws.open/message/send`, `aevia.pointer.down`,
`aevia.local.paint-done`, `aevia.frame.commit`, plus session/render events mapped through `labPlugin.ts`.

**Never compute a duration across threads.** worker marks carry worker-local time; cross-thread spans are settled on the
main thread at the moment it receives the worker message (`lab:marks` batches are merged by `renderWorkerBridge.ts`).
Witness agreement is deliberately bounded, not exact: `|instrumented - external| <= absoluteFloor + band * min(a, b)`
(defaults: 25/40/34 ms floors for first paint / visually stable / interaction, band 2.0, all overridable with
`AEVIA_LAB_WITNESS_*`). External observers quantise through rAF and ROI polling, so absolute-only agreement would reject
honest measurements; the band still catches a source that collapses to ~0 or drifts by an order of magnitude.
Cross-source witness is only applied where both sources observe the same event: for full render, `visuallyStableMs`
(main-thread receipt of the worker's last render-complete vs the external stable-frame oracle) is compared, while
`firstNonBlankMs` is tracked but not witness-compared because the external observer waits for a non-blank *threshold*
across progressively arriving chunks and the instrumented mark is the literal first worker paint. Cases whose main-side
settlement mark does not exist yet (remote incremental paint, page isolation) are sentinel-only and documented in
`external/lab/contracts.ts` instead of being faked.
`tests/lab/instrumentation-guard.spec.ts` fails if `performance.mark(` appears outside `src/instrumentation/` or if the
name table drifts (duplicates, missing `aevia.` prefix).

## Module Test-Debt Inventory

`tests/catalog/module-obligations.json` lists every frontend source module and every Go source file exactly once with
`state: covered|partial|uncovered|excluded`. `scripts/lab-inventory.mjs` regenerates it (`--check` fails on a stale
catalog, `--out <path>` writes a run-scoped snapshot). `tests/report/module-obligations.spec.ts` enforces:
complete coverage of the source tree, honest owners (frontend spec files / same-package Go test files), excluded entries
with a reason, and catalog freshness. Nightly records the snapshot as `lab-inventory` evidence; new uncovered files fail
the evidence check instead of silently growing debt.

## Unified Lab Report and Rerun

`tests/report/aggregate.ts` now finishes every managed run by calling
`writeLabReport({runDir, manifest, aggregate})` from `tests/report/lab-report.ts`. That writes:

- `runDir/lab-report.json` — one durable model: `run` (mode/profile/validity/recorded/source/rerun), `steps`, `artifacts`,
  `gate`, `instrumentation`, `suites {unit, integration, browser, go, e2e, performance}`, `measurements`
  (external vs instrumented vs witness delta vs baseline/budget/learned), `coverage`, `obligations`, `failures`, `logs`,
  `gallery`, `cases` and `rerun` (case/scenario index used by the rerun API).
- `runDir/lab-report.html` and `runDir/test-report.html` — the same single-page report (inline CSS/JS, no external
  resources, embedded `#lab-data` JSON): verdict header, KPI cards, gate panel (invalid cases, scenario verdicts,
  instrumentation state, witness deltas), nine tabs with search, performance table, screenshot gallery, log tail, and
  rerun buttons.

`npm run lab:serve` (`scripts/lab-serve.mjs`, no dependencies, binds `127.0.0.1:4790`, `LAB_PORT` overrides) serves the
run index at `/`, reports under `/runs/:id/...`, and the API `/api/{health,runs,runs/:id,jobs,jobs/:id,rerun}`.
The served HTML is injected with `window.__LAB_SERVE__ = true` plus a per-process token; a button POSTs
`{runId, scope: "run"|"scenario"|"case", ids}` to `/api/rerun` with that token. One job runs at a time (409 otherwise).
Rerun spawns `tsx tests/run-system.ts --profile=<manifest.profile> --rerun-of=<runId> --scope=... --ids=... --yes`;
a case-scoped rerun on a core profile runs through `single` mode, and the report's `rerunOf` block records the link.
Opening the HTML straight from disk keeps every button disabled with a "需 npm run lab:serve" hint.

## Live Console (temporary pipeline page)

Every managed mode except `ci` starts a temporary loopback console at run start and prints its URL
(`[lab-live] console: http://127.0.0.1:<port>/?token=...`). It is not the report page: it is a live
pipeline view served from the runner process itself.

- HTTP + WebSocket on `127.0.0.1` only (random port). The WebSocket and the cancel message require a
  per-process random token, so another local page cannot drive the run.
- Streams: step status/durations, the current step's log tail, and E2E case results parsed from the
  external runner's `✓/✕ [..] <case> passed|failed` lines. A connected viewer also makes the run
  cancellable from the browser (kills the step process, stops services, exits `130` with status
  `cancelled`).
- On finish it pushes `done {status, validity, recorded, reportUrl, reportPath, exitCode}`, where
  `reportUrl` points at the report served from the same console (`/report/<runId>/test-report.html`).
  The server stays alive for the grace period only when a viewer is connected; otherwise it closes
  immediately so scripted local runs do not hang. `file://` report links are never used.
- Flags: `--live=on|off` (default: on for every mode except `ci`), `--live-open` (best-effort browser
  launch), `--live-port`, `--live-grace-ms` (default 30000). Env equivalents: `AEVIA_LIVE`,
  `AEVIA_LIVE_OPEN`, `AEVIA_LIVE_PORT`, `AEVIA_LIVE_GRACE_MS`. `npm run test:ci` therefore prints no
  console URL; set `AEVIA_LIVE=on` only when debugging a CI-shaped run locally.
- Protocol/security checks live in `tests/lab/live-console.spec.ts` (buffered WebSocket frames,
  token rejection, report traversal, cancellation forwarding).

## Verification

For benchmark harness script changes, use the smallest direct run that exercises the changed path. If local frontend/backend are not running, start them carefully with an isolated database; normal `dev:backend` uses its configured database and does not itself reset it.

For report aggregation changes:

```powershell
npm run test:quick
```

To inspect a report, pass the exact manifest path:

```powershell
npm run test:report -- --manifest=tests/reports/summary/runs/<uuid>/run-manifest.json
```
