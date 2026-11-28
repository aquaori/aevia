# APG performance

**Status: partly measured.** APG has no dedicated performance case or baseline, but two
existing first-pixel cases have been run with the official plugins installed and with
`AEVIA_TEST_APG=off` on the same machine and build; the numbers and artifacts are in
"APG on vs off" below. Everything else in this document is still the protocol for measuring
the feature fairly, and the gaps are listed under "Not measured".

## What APG can cost

Per browser session:

- one `GET /api/apg/catalog` on room open and every 15 s while the room is open;
- catalog JSON containing every enabled manifest and every program (`main.js` text);
- one module worker plus a QuickJS runtime per active executable plugin (max 8);
- catalog-driven re-parsing and reconciliation on every changed snapshot;
- one scene snapshot read per command invocation when `scene.read` is declared;
- one HTTP GET/PUT per shared-state read/write;
- native scene commands that are the same size class as ordinary drawing commands.

Per server request:

- `GET /api/apg/catalog` re-reads `APG_DIR`, opens and validates every package, verifies
  signatures, and recomputes digests. Cost grows with the number and size of packages
  (up to 256 plugins, 1 MiB each). There is no cache.

These are structural facts from the code, not measurements.

## How to measure fairly

Fix these before comparing "APG off" and "APG on":

1. **Same build.** Use one frontend build and one backend binary for both arms. Do not
   compare a dev server against a production build.
2. **Same device and browser.** Record OS, CPU, browser version, and whether the browser
   is headless. Do not mix machines.
3. **Same scene and seed.** Use the same room, page count, element count and point density.
   APG changes rendering only through the shapes it creates; make the output identical in
   both arms or the comparison measures drawing, not plugin overhead.
4. **Same arm definition.** "Off" means `AEVIA_TEST_APG=off` for the fixture and an empty
   `APG_DIR` (or no enabled plugins) for a manual run, with the frontend still built with
   APG code. Do not compare against a build with the feature removed.
5. **Warm up first.** Discard the first run: wasm module instantiation, dependency
   prebundling and catalog parsing are cold-path costs.
6. **Repeat.** At least 5 runs per arm, alternating arms to avoid drift; report median and
   spread, not a single sample.
7. **Separate the questions.** Measure idle overhead (worker + polling), command latency
   (click → native command applied), and sustained drawing cost separately. A single
   number hides which one regressed.

## Suggested protocol

### A. Idle overhead

Open the same room in both arms and leave it idle. Record:

- catalog request count, latency and response bytes over 5 minutes (browser network panel
  or a proxy log);
- JS heap and worker count after warmup;
- main-thread long tasks and frame rate with no drawing.

The catalog request count should be roughly one per 15 s plus refreshes; a much higher
rate indicates repeated remounts rather than APG polling.

### B. Command latency

For each official executable plugin, run its command 20+ times from a warm room.
Record click → preview-visible time and click → remote peer showing the native shape.
Use the browser performance timeline to split worker activation (first command only) from
steady-state invocation. Do not average activation into steady-state runs.

### C. Sustained drawing with plugins installed

Run the existing external performance suite in both arms:

```bash
npm run benchmark:external --workspace @collaborative-whiteboard/frontend
```

The suite's case set and metrics are defined in
`apps/frontend/tests/e2e/external/` and `tests/catalog/external-cases.ts`. Note that the
APG case (`apg-official-business`) belongs to `runCorrectnessFull`, not to the performance
suite, so installing APG does not by itself add a performance case — you are measuring
whether the presence of enabled plugins changes the existing drawing metrics.

### D. Shared-state contention

With two editors, issue concurrent increments from both sides and record success rate and
the number of `409` responses. CAS means losing writers fail rather than queue; that is a
correctness property, but the retry cost (user re-runs the command) is a UX performance
question worth recording.

## Harness facts to rely on

- The real multi-client APG path is exercised by
  `case:apg-official-business`; its `metrics` output contains `diffRatio` and
  `replayDiffRatio` (pixel differences), not timings. These are correctness oracles, not
  performance numbers.
- `tests/run-system.ts --profile=single --only=case:apg-official-business --yes` runs that
  case alone; `single` never records a baseline or history entry
  (`tests/run-system.ts:1639`), so it cannot be used to set a performance baseline.
- Lab performance cases live in the external performance suite and use the metric
  contracts in `apps/frontend/tests/e2e/external/lab/contracts.ts`. There is no APG
  variant of those cases yet.

## APG on vs off (measured 2026-11-28)

Two arms on the same machine, same build, same headless Chromium, same Lab profiles
(`--profile=single`, 3 runs + 1 warmup per environment, four environments per case):

- **on** — all six official signed plugins that existed when the arm was measured (`brushes`, `palette`, `scene-inspector`,
  `scene-export`, `shape-template`, `shared-counter`) installed and enabled, no command is
  run, so the catalog is polled and the runtime is idle;
- **off** — `AEVIA_TEST_APG=off`, so no packages exist and no fixture is provisioned.

`case:local-realtime-first-pixel` (input → first pixel, median of 3 runs):

| Environment | APG on (ms) | APG off (ms) |
| --- | --- | --- |
| gpu_cpuHigh | 9.86 | 11.60 |
| gpu_cpuLow | 59.55 | 59.51 |
| noGpu_cpuHigh | 11.61 | 10.46 |
| noGpu_cpuLow | 52.68 | 52.07 |

The `on` column is a re-measurement with all six plugins that existed then enabled (`note-template` was added afterwards, making the current catalog seven)
(`tests/reports/summary/runs/90e6f91b-20e1-49ee-a9ca-6a439487c8cc`); the earlier five-plugin
numbers were 12.34 / 50.97 / 11.15 / 53.50, i.e. the same picture. Two environments had one
invalid sample of three (validity still `valid`), which is part of the noise below.

`case:incremental-remote-first-pixel` (remote stroke → first pixel), two independent runs per
arm:

| Environment | on run 1 | on run 2 | off run 1 | off run 2 |
| --- | --- | --- | --- | --- |
| gpu_cpuHigh | 7.27 | 8.05 | 6.38 | 7.47 |
| gpu_cpuLow | 23.07 | 24.01 | 22.26 | 26.75 |
| noGpu_cpuHigh | 19.02 | 16.19 | 7.78 | 15.72 |
| noGpu_cpuLow | 25.10 | 25.31 | 25.70 | 41.34 |

Reading: the differences are inside run-to-run noise. The `noGpu_cpuHigh` cell looked like an
11 ms regression in the first pair and then measured 16.19 vs 15.72 in the repeat, so it is
noise, not an APG cost. Run-to-run spread for the same arm reaches roughly 2x
(`noGpu_cpuLow` off: 25.70 → 41.34). These runs therefore support one claim only: **an idle
An idle APG catalog did not produce a measurable change in these two
drawing latencies.** They do not show a speedup, and they say nothing about activated
plugin execution.

Artifacts (`tests/reports/summary/runs/<id>/lab-report.json`):

- local first pixel — on `90e6f91b-20e1-49ee-a9ca-6a439487c8cc` (six plugins) and
  `ed866038-2920-46fd-ad51-77de9ef0dbd1` (five plugins), off `9575b1ba-3b85-4ba7-8c99-a86fcbd39c39`;
- remote first pixel — on `3b6398df-4e32-490f-9fee-22658a24db71`, `36ddcb12-43f8-4332-b77a-5b9f1f04bee7`; off `ded3db7c-7a3c-434b-b6c5-1f8d94799921`, `250598ef-1a9c-4d1a-bce7-46af6c4c0c2d`.

## Server-side catalog cost (measured 2026-11-28)

`BenchmarkLoadCatalogOfficialPlugins` (`apps/backend/internal/apg/catalog_bench_test.go`)
packs and signs the seven official plugins once, then measures a full
`LoadCatalogWithTrust(dir, store, TrustRequireSigned)` — the same work
`GET /api/apg/catalog` does on every request, with no cache: ZIP parse, manifest validation,
digest recomputation and Ed25519 verification.

```bash
cd apps/backend
GOMAXPROCS=2 GOFLAGS=-p=1 go test ./internal/apg -run '^$'   -bench BenchmarkLoadCatalogOfficialPlugins -benchtime 50x -count 3
```

AMD Ryzen 9 5900HX, Windows, `GOMAXPROCS=2`, 50 iterations per run, three runs:
**2.12 ms, 2.13 ms, 2.13 ms per catalog load** (round 25, seven plugins; with six plugins the
same benchmark measured 2.00 / 1.86 / 1.84 ms). The benchmark fails if the fixture is not
exactly seven plugins, so it cannot silently measure a different set.

This bounds the per-request server cost for a seven-plugin deployment; it is not evidence about
256 plugins or about memory. The frontend polls the catalog every 15 s per open room, so under
normal polling this cost is negligible, but a deployment with many rooms does pay it per
room-refresh and per page load.

## Not measured

- Catalog request latency and payload size for a full 256-plugin catalog.
- Cost of validating and verifying 256 signed packages per request (seven plugins are measured
  above; scaling is untested).
- Per-worker memory of QuickJS contexts across many plugins.
- Activation time of representative programs (the largest official program is small).
- Effect of 15 s polling on long-lived rooms and on server CPU under many rooms.
- Cost of a command that actually runs a plugin program (activation, RPC wake-up, effects).
- Behavior at the 8-worker cap and the 512-item scene snapshot cap.

The idle-overhead comparison above is the only measured claim; do not extend it to plugin
execution, catalog cost at scale, or memory. Any new figure must be stored with the build,
device, scene and repeat count recorded.
