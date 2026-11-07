# Lab Runner acceptance notes

## Commit and CI checks

Install the root dependencies with `npm install`; the `prepare` script installs the Husky hooks. Commit messages use conventional types such as `feat(lab): 增加报告入口`; Chinese descriptions are accepted. The pre-commit hook runs ESLint on staged JS/TS/Vue files without rewriting them, checks staged Go formatting, and selects the quick Vitest and Go suites for relevant changes. Tests read the working tree, so partial staging does not guarantee that the test ran on the staged snapshot. A 90-second overall timeout fails the hook.

The `Aevia quick checks` workflow checks new commit messages after the `4c07a06` adoption baseline, checks the PR title, and validates changed files. The existing correctness workflow runs Linux/Chromium for PRs and main; its full browser/OS matrix is scheduled or manual. The Windows performance lane is restricted to main and serialized. These workflow changes need a real GitHub run before their remote behavior can be considered verified. Local hooks can be bypassed; branch protection must require the remote checks after they have been validated.

The existing Go, Vitest unit/module/browser, and external suites remain in place.

## Evidence contract

- Nightly standard performance declares all 20 environment/scale case keys before execution. Missing, empty, duplicate, or additional keys fail aggregation.
- External/gate case identity includes suite, case ID, environment, and scale. Reports consume manifest-listed files, including nested boundary directories; unexpected report copies do not become evidence.
- Go coverage unions repeated source intervals across package tests. The historical d2198bf9 profile is 2085/3133 statements (66.55%), not 3029/25125.
- Source checks compare per-file hashes, including untracked files. History and baseline inputs are not excluded. Automatic history publication happens only after the complete recorded nightly and source-check pass; single, rerun, dirty, and failed runs cannot import history.
- Automatic history lives in ignored `tests/reports/lab-history/` so accepted runs do not dirty the next checkout. Its input files are still hashed through source-check. The Windows workflow caches this data; checked-in legacy history remains available via explicit `--history-file` and is not rewritten.
- Manual history/baseline imports require valid, clean, nonempty passing reports. Managed reports also require a successful recorded terminal manifest and source-check.
- Dirty runs produce diagnostic reports without advancing latest. Neither degraded nor invalid evidence may publish latest.

## Measurement and boundary semantics

- Full render requires a main-thread first-paint settlement and an explicit worker init-stream-final settlement. Init stream receipt is not a substitute for paint completion.
- Standard full-render seeding waits for server acceptance of each operation before opening the observer; a fixed delay is not a seeding barrier.
- The independent external observer requires a 500ms pixel quiet window, with a staged-paint browser counterexample in CI/nightly. Collection waits for required final worker settlements before closing the page; it does not replace missing marks with external timing.
- Pixel sampling continues until collection ends. External stability is the last observed pixel change, while stabilityConfirmedMs includes the quiet confirmation window; confirmation delay is not rendering time.
- Measurement contract 3 promotes validated instrumented timings into the primary metrics used by budgets, baselines, and learning. Independent witness values remain in externalMetrics. Cases without timing spans keep their explicitly external metrics.
- Standard full-render, incremental, and local latency are separate scenarios. Abort checks occur after the complete selected matrix has run; invalid cases stream stderr immediately.
- Gate cases expose contractKind: span, external, sentinel, or none. Sentinel-only collection is not proof that a timing span was validated. Unknown contracts fail.
- Blank-region checks use full ROI resolution, detect even faint nonwhite pixels, and require zero residual pixels.
- Sampled measurements have a host-side deadline even if a renderer/CDP command stalls. Sample pages are closed between attempts, cleanup is bounded, and step logs are written while the child is still running.
- Boundary full render waits for the final stream settlement and nonblank canvas. Heap growth keeps one page alive across three injection rounds and waits for the last operation's worker acknowledgement.
- Heap metrics explicitly cover the page main isolate, not worker/GPU/whole-process memory. Boundary survival remains an exploratory observation rather than a product capacity SLA.
- Network recovery verifies a fresh request fails offline, the application /ws connection closes, and a new application connection opens. Vite HMR sockets are excluded. CDP injection errors cannot silently pass.
- Performance execution success is reported separately from performance qualification. Conditions fingerprint host, CPU, actual GPU renderer/driver features, browser/Node versions, viewport, throttle, sample counts, and the harness/measurement contract. Legacy or foreign conditions are inconclusive and their history is excluded. Budgets are bound to their generating baseline signature; comparable budget violations fail immediately (except explicit diagnostic-only mode). Full qualification also requires matching baseline/budget checks and normal learned results. Existing baseline/budget data is retained unchanged.

## Selection, rerun, and operation

- Go single mode writes JSON evidence. Performance and boundary selectors route to their owning suite; each selected boundary case gets isolated services and a unique database.
- case:<id>|<environment>|<scale> preserves a specific matrix cell. Scenario reruns expand the originating report's scenario index. Saved single selections support whole-run reruns.
- Reruns execute current source and do not represent historical source replay. Checkpoint/from-step resume is not implemented.
- Race capability probing is separate from deterministic plan construction and records the actual error. Linux CI quality nightly requires the race step even when probing fails; local unsupported toolchains can omit it explicitly.
- Loopback control servers validate Host, WebSocket Origin, tokens, and malformed report paths. Rerun jobs use a direct Node executable with argv, without a shell. Repeated cancellation is idempotent.
- A locked temporary Windows executable may be retained with a warning; this cannot prevent a terminal report. Every service generation uses a unique SQLite filename.
- Fuzzing uses the supported GOCACHE environment variable with a workspace-local cache under tests/.tmp/go-fuzz-cache. It does not require write access to the user's global Go fuzz cache; the first compilation may take longer.

## Remaining acceptance work

Full default boundary scales, actual CI-host race execution, host-specific performance calibration, E2E coverage union, and checkpoint restoration require separate evidence. The module/feature inventories remain test debt and do not imply complete product coverage. Do not describe these as verified or claim 95% overall completion from passing smoke alone.

## Current acceptance blocker

Default full-render boundary run `24787c84-fb33-49fb-9324-3264f04aba8e` reaches 250k, then fails collection at 500k. Its `BoundaryObserver500000-failed-load/lab-snapshot.json` records a responsive page, no page errors, 366 retained marks, zero dropped instrumentation marks, 176 render metadata messages and 167 render binary messages, followed by init-complete without final render completion. This is incomplete product streaming, not proof of a renderer capacity limit. `room/actor.go:sendOutbound` can drop a message when its bounded queue is full; `room/stream_send.go` ignores the returned failure while continuing the stream. The configured connection queue has 256 messages. The backend repair is deferred rather than masking this outcome with a larger collection tolerance.

Boundary setup now runs one scale at a time; timeouts without an observed product crash are inconclusive collection failures. Failures retain raw page diagnostics and per-service logs. Known harness failures use COLLECTION_FAILED and cannot be certified as valid measurement collection.

## Host decision (2026-11-05)

`test:nightly -- --lane=performance` runs on `[self-hosted, windows, aevia-nightly]`; `--lane=quality` runs on Linux and includes correctness, race, fuzz, and inventories without performance comparisons. The default `--lane=all` retains the complete local plan. Both lanes own separate manifests/reports; do not combine timings across hosts. No runner installation, schedule registration, publication, or remote push is performed by these local changes.

The Windows development host still needs controlled power/thermal/background-load conditions during calibration. The fingerprint detects changes in recorded conditions, not every transient source of noise. Browser builds and runner account/session must match the baseline; low cloud GPU power alone does not make a measurement invalid.
