# APG handoff verification report (2026-11-28)

This is the end-to-end report for the Aevia-Plugin (APG) work in this tree. It states what
was verified, with which commands, on which environment, and what is still missing. Per-item
detail lives in [`acceptance.md`](./acceptance.md); design and usage live in
[`README.md`](./README.md), [`package-spec.md`](./package-spec.md), [`sdk.md`](./sdk.md),
[`development.md`](./development.md) and [`deployment.md`](./deployment.md).

## Repository state

| Item | Value |
| --- | --- |
| Branch | `feat/aevia-plugin` |
| HEAD | `9b335b9` (`perf: optimize drawing hotspots and upgrade sustained profiling suite`) |
| Work tree | APG work is uncommitted on top of that commit: tracked modifications plus new APG files (package manager, CLI, gateway handlers, frontend runtime, official plugins, tests, docs) |
| Merge / push | none performed; the branch was not merged into the main branch and nothing was pushed |
| Environment | Windows, Node v24.15.0, go1.26.5, AMD Ryzen 9 5900HX, 32.9 GB RAM; Playwright-driven headless Chromium and the repo's own Lab Runner |

## Verification matrix (current tree)

| Check | Command | Result |
| --- | --- | --- |
| TypeScript unit/module/harness | `npx vitest run --project shared-unit --project frontend-unit --project frontend-module --project harness-unit` | 86 files / 496 tests pass |
| Docs integrity (`apg-docs.spec.ts`) | `npx vitest run --project harness-unit tests/report/apg-docs.spec.ts` | 3 tests pass (links, inline source paths, official plugins listed) |
| Browser component tests | `npx vitest run --project frontend-browser` | 7 files / 40 tests pass |
| Go packages | `cd apps/backend && $env:GOMAXPROCS="2"; $env:GOFLAGS="-p=1"; go test ./... -count=1` | 11 packages ok |
| Go vet | `go vet ./...` | clean |
| Obligation catalogs | `npm run lab:obligations:check` | passes |
| Production build | `npm run build` | Go backend builds; frontend `vue-tsc -b && vite build` succeeds and emits the QuickJS worker and wasm assets |
| Two-browser APG case | `npx tsx tests/run-system.ts --profile=single --yes "--only=case:apg-official-business"` | passed, `0 evidence issue(s)`, Lab measurement valid |
| Latest green Lab run | `tests/reports/summary/runs/9da09cf2-00b1-41b7-8edd-eb6e5f6dfdcc/` | `case:apg-official-business` |
| Catalog load benchmark | `go test ./internal/apg -run '^$' -bench BenchmarkLoadCatalogOfficialPlugins -benchtime 50x -count 3` | ≈2.1 ms per trust-verified seven-plugin load (was ≈1.8–2.0 ms with six) |
| Package fuzz | `go test ./internal/apg -run '^$' -fuzz FuzzReadPackageBundle -fuzztime 20s` | 5,610 execs, 11 interesting inputs, no panic |
| APG on/off first pixel | `tests/run-system.ts --profile=single ... case:local-realtime-first-pixel` | no difference beyond run-to-run noise (measured with the six plugins that existed at the time; see [`performance.md`](./performance.md)) |
| Whole-app smoke profile | `npx tsx tests/run-system.ts --profile=smoke --yes` | passed (backend feature inventory, quick frontend/shared regression, correctness smoke E2E); run `d1b9b5a4-dd79-4e5c-9f39-e3bd33ce1f7c` |
| Whole-app full profile | `npx tsx tests/run-system.ts --profile=full --yes` | 9/10 steps pass; `go-race` cannot build locally (Cygwin gcc rejected by Go) — fails for untouched packages too, so it is an environment limitation; run `13b1c317-818e-4ef5-b2ad-cb929de2fbe2` |

The Lab case runs two browsers in one room against a real backend and asserts, in order: seven
Ed25519-signed official plugins installed through the real CLI under
`APG_TRUST_POLICY=require-signed`; shared counter write (A) then read (B) through the room
CAS; the native two-shape template visible on the peer with matching canvas pixels; one undo
removing both shapes on the peer and redo restoring them; a native sticky note plus caption placed
by the note template and counted by the inspector; a real browser download produced by the user-scoped export plugin via
`Alt+Shift+4`; the `Marker` preset stroke and a contributed palette swatch both reaching the
peer canvas (ink colour sampled from changed pixels); catalog disable revoking a command,
re-enable bringing it back in an already open room without a reload, disable again; and a late
joiner replaying the canvas and reading the counter while the template plugin is off.

Old-versus-current: earlier in this work the same case failed on a missing Lab measurement
contract, on a `PUT` CORS preflight rejection, on the QuickJS wasm being served as
`index.html`, and on a plugin manifest that omitted `ui.preview`. All four were fixed in code
or data; the runs listed in `acceptance.md` are the post-fix evidence, and
`105b8c14-3e5a-40c9-8421-e188cbfb6051` is kept as the first fully green two-browser run.
Single-unit and Go results quoted above are from the current tree, not from older revisions.

## Item status

| ID | Item | Status |
| --- | --- | --- |
| APG-01 | Infrastructure and package contract | Verified |
| APG-02 | CLI and deployment management | Partially verified (POSIX PID probing compile-checked only; no CI matrix for Windows rename/lock) |
| APG-03 | Backend plugin management | Partially verified (no 256-plugin or many-room polling cost measurement; no frontend 409 retry UX by design) |
| APG-04 | Editor extension points | Partially verified (no dynamic toolbar section / context menu / pointer-gesture contribution) |
| APG-05 | SDK and sandbox runtime | Partially verified (no event subscription or cancellation API; synchronous handlers; mock host is not a sandbox) |
| APG-06 | Collaboration compatibility | Partially verified (no image assets, no generic semantic components, no server-side multi-op transaction) |
| APG-07 | Official plugin migration | Partially verified (declarative presets are new, not migrated native tools) |
| APG-08 | Test and developer toolchain | Partially verified (no dedicated APG performance case; `apg init` only, no watch/dev server) |

## Defects found and fixed during this handoff

1. QuickJS wasm loaded as `index.html` in Vite dev (`Incorrect response MIME type`): the
   `@jitl/quickjs-wasmfile-release-sync` variant resolved its wasm relative to the prebundled
   module. Fixed in `apps/frontend/src/service/apgSandbox.ts` by pinning the wasm URL through
   Vite's asset pipeline, with a Node/vitest branch that keeps the built-in loader.
2. `Access-Control-Allow-Methods` lacked `PUT`, so every shared-state write failed its CORS
   preflight (`apps/backend/internal/gateway/middleware.go`).
3. The Lab case had no measurement contract (`MISSING_CONTRACT`), so a passing business case
   was still aborted (`apps/frontend/tests/e2e/external/lab/contracts.ts`).
4. `waitForNonBlankCanvas` required an options object that the APG case did not pass
   (`TypeError: Cannot read properties of undefined (reading 'timeoutMs')`).
5. `WorkerGlobalScope` broke the production typecheck under `lib.dom`; replaced with a
   `self` check.
6. Contribution index applied global enablement only to commands, so a deployment-disabled
   user plugin could still render brushes/palettes from a stored preference. Fixed with a hard
   filter plus a namespacing test.
7. `aevia.scene-export` omitted `ui.preview` from its permissions, so its own preview effect was
   denied and the command failed. Fixed in the manifest; the broker rejection was correct.
8. `apg.state.changed` was handled on the binary WebSocket branch instead of the JSON branch.
9. Plugin manifests and the frontend disagreed on defaults: V2 `apiVersion` was silently
   defaulted and is now required; `docs/apg/package-spec.md` said "optional, defaults to 1"
   and was corrected.
10. Trust policy defaulted to `allow-unsigned`; the secure default (`require-signed`) now
    applies in `config.Load` and the CLI, with an explicit error when signing a V1 manifest.
11. Update could silently widen an enabled package (scope, permissions, contributions, signer);
    `ReauthorizationChanges` now rejects that until the operator disables the package.
12. Role check and revision CAS were two steps; they are now one SQL statement
    (`WriteAPGStateAuthorized`), so a demotion racing a write cannot win.
13. Shared state had no schema version: a rollback could reinterpret newer data. Manifests now
    carry `stateSchemaVersion`, stored per row, and older-schema writes get `409`.
14. Public APG endpoints had no per-client budget; catalog, assets and shared state now each
    have their own bucket with `429` + `Retry-After`.
15. `apg list` output was never asserted, and the CLI lifecycle test claimed "six official
    plugins" while installing five (the export plugin was missing). Both fixed.
16. Stale CLI locks required manual deletion; locks now record their owner and are reclaimed
    when that process is gone, with tests for owner, dead PID, fresh and stale lock cases.
17. Docs made claims the code did not support (performance "not measured" beside measured
    tables; "keyboard shortcut not exercised" after the Lab case pressed one; corpus size 24
    vs 31; build command narrower than the real one). All corrected.

## Remaining gaps

Each of the three unimplemented capabilities has a file-level design note in
[future-work.md](future-work.md): the exact functions and protocol layers it must change, the
invariants it must preserve, and the tests that must exist before it can be called done., with impact

- **Image assets** — plugin assets are JSON consumed by guest code; there is no image pipeline
  (no `drawImage` path in the bitmap atom, no async load/cache, no worker or prefix-cache
  integration, no persisted asset reference in scene operations). A plugin therefore cannot
  place a bitmap on the canvas that peers render without the plugin installed. Closing this
  touches scene types, backend validation, `SceneCore`, Render IR and both render paths.
- **Generic semantic scene components** — no component type/schema/version, no missing-plugin
  fallback beyond "the native shapes are already in the scene".
- **Server-side multi-op transaction** — a bundle is one history group (undo-level
  atomicity), not one server commit; the WS protocol has no batch op type.
- Smaller, already documented: the 256-plugin catalog is now Go-tested at the limit (256
  packages load, the 257th is rejected) but its request latency is still unmeasured, and larger
  scenes remain enforced-in-code only (the 8-worker cap now has a unit test, and a 20 s fuzz run of
  `ReadPackageBundle` found no panic); the frontend has no 409 retry UX;
  palette preference is `localStorage` only, now scoped per account with same-origin cross-tab
  adoption, but with no server-side sync across browsers; COOP/COEP is
  configured for Vite dev/preview, not for an arbitrary production static host; POSIX PID
  probing is compile-checked on Windows only; `apg init` is the only scaffolding command.
- The Go race detector is unavailable on this machine: Go rejects the installed Cygwin gcc, so
  `go test -race` fails while compiling `runtime/cgo` even for packages APG never modified
  (`go test -race ./internal/domain` fails identically). The `--profile=full` run therefore stops
  at `go-race` with 9/10 steps passing. Re-run that step on a MinGW or Linux host before
  claiming race coverage.

## Do not claim

- Any throughput, memory or speedup figure beyond the measured tables in `performance.md`.
- That the sandbox is a formally audited security boundary; it is a QuickJS guest in a worker
  with no DOM/network/host globals, exercised against a set of probes.
- That plugin output is atomic at the server, or that images/generic components work.
- That the branch was merged, pushed, or that CI matrices beyond the recorded local runs exist.
