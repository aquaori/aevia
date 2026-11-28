# APG acceptance matrix (APG-01 … APG-08)

Scope: Aevia-Plugin as implemented in the working tree on branch `feat/aevia-plugin`
(2026-11-28). Status vocabulary:

- **Verified** — implemented and covered by an automated test or a recorded Lab run cited below.
- **Partially verified** — implemented; some paths are tested, others are named as gaps.
- **Unverified** — no evidence in the tree; do not present as working.

The eight items below follow the delivery plan's numbering: 01 infrastructure and package
contract, 02 CLI and deployment management, 03 backend plugin management, 04 editor
extension points, 05 SDK and sandbox runtime, 06 collaboration compatibility, 07 official
plugin migration, 08 test and developer toolchain.

## Evidence base

| Evidence | Result |
| --- | --- |
| `npx vitest run --project shared-unit --project frontend-unit --project frontend-module --project harness-unit` | 86 files / 496 tests pass (adding `--project frontend-browser` makes it 536) |
| `npx vitest run --project frontend-browser` | 7 files / 40 tests pass (includes the APG contribution rendering test) |
| `cd apps/backend && GOMAXPROCS=2 GOFLAGS=-p=1 go test ./... -count=1` | 11 packages ok |
| `go vet ./...` | clean |
| `npm run build` (`build:backend` + `build:frontend`, i.e. Go binary + `vue-tsc -b && vite build`) | succeeds; the frontend emits `apgSandbox.worker-*.js` and `emscripten-module-*.wasm` |
| `npm run lab:obligations:check` | passes (181 obligations; 27 selected test targets for the changed sources) |
| Lab run `0cf2a1dd-fb2c-4cac-a00e-a1348550bb94` (tree as of 2026-11-28 04:59; only doc prose changed afterwards) | `case:apg-official-business` passed, `Result: passed; 0 evidence issue(s)`, measurement valid; the case installs seven signed official plugins, places native text and a sticky note through the note template, presses undo/redo on the native template bundle and asserts the peer loses then regains the shapes, runs the user-scoped export command and asserts a real browser download (`aevia-scene.json` whose JSON counts at least two elements and the native shape primitive), selects the `Marker` plugin preset and the contributed `#DB2777` palette swatch, paints both strokes and checks peer sync plus the sampled ink colour; earlier `dcf270cd`, `89a469f6`, `695f713b`, `ef9b69f6`, `c29b2d6c`, `905256f0`, `0f38a761`, `1cc34bc3`, `417b2f48`, `f79abb47`, `83a44159`, `fccdda50`, `1b0a8d22`, `168d9c55`, `a04f826a`, `162ed02f`, `a9b80f7e`, `8e675a74`, `94b8a0d5`, `d4941044`, `36d27bab`, `b02599bc`, `193d3308`, `a045caab`, `f2ed6aeb`, `4491839f`, `0fb3e558`, `a27f084f`, `564e26d3`, `803798e2`, `95f741f6`, `f883dc21` and `105b8c14` passed earlier revisions of the same case |
| Lab run `105b8c14-3e5a-40c9-8421-e188cbfb6051` (earlier tree) | same case passed; kept as the first full green two-browser run |
| Lab run `d1b9b5a4-dd79-4e5c-9f39-e3bd33ce1f7c` (whole-app smoke profile on the same tree) | `npx tsx tests/run-system.ts --profile=smoke --yes` passed: backend feature inventory, quick frontend/shared regression, correctness smoke E2E, `Result: passed; 0 evidence issue(s)`. This is the regression check that the APG changes did not break the non-plugin product. |
| Lab run `13b1c317-818e-4ef5-b2ad-cb929de2fbe2` (whole-app `--profile=full`) | 9 of 10 steps passed: production build, Go static analysis, Go package inventory, Go tests and coverage, frontend/shared coverage, canvas blank-oracle sensitivity, browser component tests, external correctness E2E (72.4 s). The `go-race` step failed to compile `runtime/cgo`: the installed gcc is a Cygwin compiler and Go refuses it (`#error "don't use the cygwin compiler to build native Windows programs; use MinGW instead"`). `go test -race ./internal/domain` — a package APG never touches — fails identically, so this is an environment limitation, not a regression. `go-fuzz` and `source-check` were skipped by the runner after that failure. **Do not claim the full profile passes on this machine.** |
| Cross-language corpus `tests/fixtures/apg/manifests.json` | 31 cases + 1 recorded divergence (includes the `ui.download` user-scope accept case); Go `TestManifestCorpus` and the frontend contract spec agree |

The Lab case installs seven Ed25519-signed official plugins through the real CLI under
`APG_TRUST_POLICY=require-signed`, runs two browsers in one room, writes and reads the shared
counter through CAS, observes the native template shape on the peer, checks pixel equality,
runs the scene inspector, downloads the scene through the user-scoped export plugin, disables
the template plugin and waits for its command to vanish, re-enables it to prove a live catalog
reaches an open room, disables it again,
then has a late joiner replay the canvas and read the counter with the plugin disabled.

What the Lab case does **not** exercise: rollback, update, uninstall visibility in the
browser, concurrent 409 retries, or a 256-plugin catalog (the catalog limit itself is covered
by a Go test that builds 256 packages, loads them, and asserts the 257th is rejected). The keyboard shortcut path *is*
covered: the export step presses `Alt+Shift+4` on the page instead of clicking the button.

## Status summary

| ID | Item | Status | Primary evidence |
| --- | --- | --- | --- |
| APG-01 | Infrastructure and package contract | Verified | `internal/apg/catalog_test.go`, `manifest_corpus_test.go`, `package_test.go`, `service/apgCatalog.unit.spec.ts`, `apgManifestContract.unit.spec.ts` |
| APG-02 | CLI and deployment management | Partially verified | `cmd/apg/main_test.go` (`TestAPGOfficialPackageLifecycle`, `TestAPGUpdateRequiresReauthorization`, `TestAPGCLIDefaultsToRequireSigned`, `TestAPGLockRecordsOwnerAndRejectsConcurrentWriter`, `TestAPGDeadOwnerLockIsReclaimed`, `TestAPGStaleLockWithoutOwnerIsReclaimed`, `TestAPGFreshLockWithoutOwnerIsNotStolen`); POSIX `processAlive` compiled but not exercised in CI |
| APG-03 | Backend plugin management | Partially verified | `gateway/apg_handler_test.go`, `gateway/apg_business_test.go`, `storage/apg_state_test.go` (role+CAS single statement, concurrency, restart, schema downgrade guard), `apgStateNotice.unit.spec.ts` (notice filtering), Lab case |
| APG-04 | Editor extension points | Partially verified | `apgCatalog.unit.spec.ts` (contribution index, preset→native selection), `apg-contributions.browser.spec.ts`, Lab case (preset stroke reaches the peer canvas, palette colour sampled from the ink pixels); no dynamic toolbar/menu/gesture contribution |
| APG-05 | SDK and sandbox runtime | Partially verified | `apgSandbox.unit.spec.ts` (isolation, interruption, phase whitelist, disposal, 8-worker cap); `packages/plugin-sdk/mock` + its spec for author-side testing |
| APG-06 | Collaboration compatibility | Partially verified | `apgSandbox.unit.spec.ts` (forged effects, host IDs, native replay, shape bundle sharing one history group), Lab case; no image assets or generic scene components |
| APG-07 | Official plugin migration | Partially verified | CLI lifecycle test for all seven packages, Lab case for three executable plugins (counter, template, export); declarative presets are new, not migrations |
| APG-08 | Test and developer toolchain | Partially verified | The suites above, `tests/catalog/*-obligations.json`, Node mock host, `docs/apg/*`, measured APG on/off drawing latency (`performance.md`); still no dedicated APG performance case |

## APG-01 — Infrastructure and package contract

Implemented surfaces:

- `apps/backend/internal/apg/package.go`: ZIP entry safety (`safeEntryName`), per-entry and
  expanded size caps, V1/V2 entry rules, canonical digest over sorted entries with 8-byte
  length prefixes, signature parsing.
- `apps/backend/internal/apg/catalog.go`: manifest shape, duplicate-JSON-key detection,
  id/version/scope/permission/contribution validation, scope-vs-capability rules
  (`scene.write`, `storage.shared` and `brushes` are system-only), explicit
  `apiVersion === 1` for V2, catalog loading.
- `apps/backend/internal/apg/package.go` signing: Ed25519 over the canonical digest, strict
  trust-store parsing, `require-signed` default in `internal/config` and the CLI, and an
  explicit error for signing a V1 manifest.
- `apps/frontend/src/service/apgCatalog.ts`: browser-side mirror of the structural rules so a
  malformed catalog is rejected before any plugin code runs.

Evidence: `TestReadPackageAcceptsStrictManifest`, `TestReadPackageRequiresAPGExtension`,
`TestReadPackageRejectsExtraZipEntryAndUnknownField`,
`TestReadPackageRejectsContractViolations`, `TestReadPackageEnforcesSizeLimits`,
`TestReadPackageRejectsUnsafeArchiveMembers` (parent/nested traversal, absolute path, backslash
path, directory entry, duplicate `manifest.json`, each pinned to an `invalid package entry` or
`duplicate package entry` reason rather than "some error"),
`TestValidateManifestJSONRejectsDuplicateKeysCaseInsensitively`,
`TestValidateManifestJSONBrushNumericBounds`, `TestManifestCorpus`,
`TestSignedPackageTamperIsRejected`, `TestV1PackageCannotBeSigned`; frontend
`apgManifestContract.unit.spec.ts` (all 31 corpus cases) and `apgCatalog.unit.spec.ts`.

`FuzzReadPackageBundle` runs its seed corpus on every `go test` and survived a 20 s fuzz
session (5,610 executions, 11 interesting inputs, no panic); it asserts "no panic on arbitrary
bytes", not acceptance semantics.

Gaps: the corpus covers representative documents,
not every field combination. Do not claim exhaustive validation. `VerifyTrust` is fail-closed
for an empty policy string (`trust policy is required`), so the low-level function cannot be
used to silently accept unsigned packages; `TestVerifyTrustRequiresExplicitPolicy` pins it.

## APG-02 — CLI and deployment management

Implemented surfaces: `apps/backend/cmd/apg/main.go` — `pack`, `keygen`, `sign`, `validate`,
`verify`, `list`, `install`, `update`, `rollback`, `enable`, `disable`, `uninstall`, `state`
(list/clear room-scoped shared state); `apps/backend/cmd/apg/state.go`; `.apg-lock`
directory lock; staging plus atomic rename; rollback slot; archive copy for asset-bearing
packages; `ReauthorizationChanges` in `internal/apg/reauth.go` wired into `install`/`update`
so an enabled package cannot silently gain scope, permissions, contributions or a new signer.

Evidence: `TestAPGOfficialPackageLifecycle` covers pack → reject unsigned install → sign →
verify → install → enable for all seven official plugins, an update that adds a permission
(rejected while enabled, applied after disable), rollback rejection while enabled, rollback
restoring the previous catalog revision, and uninstall leaving archived assets readable.
`TestAPGUpdateRequiresReauthorization` pins the rejection messages, and
`TestAPGFailedInstallLeavesNoResidue` proves a rejected install leaves `list` empty and no
`.apg` file in the directory. The lifecycle test also asserts the exact `list` table
(`id<TAB>version<TAB>scope<TAB>enabled`, sorted) for all seven plugins and that a disabled
package is reported as `disabled` instead of disappearing.
`TestAPGStateCommandListsAndClearsRoomState` covers the state subcommand: filtered listing,
the `--confirm` guard, the room-id guard, an actual purge that leaves the row readable as
revision 0 afterward, and a missing database path being reported instead of created.

Gaps: lock recovery is tested for owner/dead-PID/age cases but
POSIX PID probing is only compile-checked on Windows;
Windows rename/lock behavior is exercised only by the local Lab run, not by a CI matrix.

## APG-03 — Backend plugin management

Implemented surfaces: `GET /api/apg/catalog` (no session, `Cache-Control: no-store`, `503`
when the trust store or catalog is invalid), per-request `LoadCatalogWithTrust`, catalog
`revision` derived from enabled package digests and signers; `GET`/`PUT
/api/apg/state/{id}?digest=…` re-checking session, catalog id + digest, system scope,
`storage.shared`, room role, body size, revision range and JSON validity; `409` on CAS
conflict; `apg.state.changed` WebSocket invalidation hint; `GET /api/apg/asset/{digest}/{name}`
serving archived `assets/*.json` with inert content headers.

Evidence: `TestAPGCatalogEndpointReloadsAndFailsClosed`,
`TestAPGSharedStateAuthorizationAndCAS`, `TestAPGStateWriteRequiresRoomRole`,
`TestAPGStateConcurrentWritersHaveSingleWinner` (8 concurrent writers per round: exactly one
winner, the rest `ErrAPGStateConflict`), `TestAPGStateSurvivesRestartAndKeepsRevision` (value
and revision survive reopen, a stale pre-restart revision loses),
`TestAPGArchivedResourceIsInert` (which also asserts that removing the package revokes both
`GET` and `PUT` on the very next request); `WriteAPGStateAuthorized` performs the role check and the
revision CAS in a single SQL statement; the Lab case observes live catalog revocation, live
re-enable (a disabled command reappears in an already open room without a reload, then
disappears again), and cross-client state.

Concurrency note: the conflict classification depends on SQLite waiting for the competing
writer. `DB_BUSY_TIMEOUT_MS` defaults to 15000; with a zero busy timeout, concurrent writes
surface as `SQLITE_BUSY` (a `500`) instead of a `409`, so deployments must not set it to 0.

Each public APG endpoint has its own per-client token budget on top of the global HTTP
limiter: 40 catalog reads with a 2/s refill and 120 asset reads with a 10/s refill, both
returning `429` with `Retry-After: 1` once spent; room shared state is authenticated but gets
its own pair too (60 reads with a 20/s refill, 12 writes with a 4/s refill), so a plugin write
loop cannot hammer CAS queries and `apg.state.changed` broadcasts for the whole room. These
budgets bound how fast one client can make the server re-scan the package directory, stream
archived assets or touch room state. `TestAPGPublicEndpointsBudgetEachClient` proves a throttled
client does not consume another client's budget, and
`TestAPGStateWritesAreBudgetedPerClient` proves the same for shared-state writes (conflicts are
counted, then the client is throttled).

The catalog size limit is enforced where the directory is scanned and tested at its boundary:
`TestLoadCatalogEnforcesPluginLimit` builds 256 packages, asserts all 256 load in id order, then
adds a 257th and asserts `catalog exceeds 256 enabled plugins`.

A lost CAS is surfaced as an actionable message rather than a generic failure:
`describeApgCommandError` maps `409` to "共享状态已被其他成员修改，请重试", `403` to a revoked
permission, `429` to throttling, and host refusals (role, revoked context, worker budget) to
their own text.

Gaps: no measurement of per-request catalog cost at 256 plugins (only the load-time limit is
tested) or with many rooms polling every 15 s; the frontend still has no automatic retry after a
`409` (by design), so the retry itself is manual and the conflict toast is not asserted end to
end.

Shared-state rows carry the `stateSchemaVersion` of the signed manifest that wrote them. The
version is never taken from the request, and a write whose schema is older than the stored one
is rejected (409 `APG state schema conflict`), so a rollback cannot reinterpret newer data.
Evidence: `TestAPGStateSchemaVersionGuardsAgainstDowngrade` plus the four manifest-corpus
`stateSchemaVersion` cases shared by the Go validator and the frontend parser.

The browser side filters the invalidation hint through
`apps/frontend/src/service/apgStateNotice.ts` (`acceptApgStateNotice`): a notice is accepted only
for an enabled, system-scope, `storage.shared` plugin whose digest still matches the catalog and
whose revision is newer than the revision this client already saw; duplicates, out-of-order
notices, replaced digests and user-scope plugins are ignored. `apgStateNotice.unit.spec.ts`
covers each rejection and the monotonic accept. The hint only clears derived preview UI — the
next command re-reads the authoritative value — so a forged notice cannot grant any write.

## APG-04 — Editor extension points

Implemented surfaces:

- `buildApgContributionIndex(catalog, isEnabled)` in `apps/frontend/src/service/apgCatalog.ts`
  produces one read-only snapshot of brushes, palettes, commands and shortcut bindings.
  Duplicate chords resolve to `null` instead of picking a winner, and disabled or removed
  plugins disappear because the index is rebuilt from the catalog on every change.
- `apps/frontend/src/views/RoomView.vue` derives palettes, brushes and shortcuts from that
  index, runs commands through `runApgCommand`, cleans up on room/page/reconnect/role change,
  and disposes runtimes on unmount.
- `apps/frontend/src/components/ApgPanel.vue`: host-rendered text panel with command buttons,
  shortcut labels, plain-text preview and per-user toggles for `user` scope plugins only.
- Declarative brushes and palettes feed the native tool input path (`RoomToolbar.vue`,
  `roomEditorController`, `roomPointerController`, `roomEditorState`); no guest callback runs
  inside `pointermove` or the draw loop.

Evidence: `apgCatalog.unit.spec.ts` "derives one contribution index and refuses ambiguous
shortcuts" (ambiguous chord → `null`, disabled user plugin disappears, all-disabled → empty
commands); `apgCatalog.unit.spec.ts` "maps a preset to a native tool selection and refuses
stale presets" (declared colour/size/opacity become the native selection, undeclared fields
stay at host defaults, a revoked or edited preset is not applied);
`apps/frontend/tests/browser/apg-contributions.browser.spec.ts` mounts the real
`RoomToolbar` in Chromium and asserts the contributed brush button renders and dispatches its
preset, that Studio palette swatches render with the declared colours, that clicking a swatch
dispatches `setColor`, that the user toggle dispatches `toggleApgPalette`, and that a disabled
palette hides its swatches; Lab case shows the system command appearing, executing and
disappearing after disable, and the `Alt+Shift+4` shortcut triggering the export command (key
press → command → real download, not a panel click); `frontend-browser` suite covers the room
shell.

The Lab case selects the contributed `Marker` preset in the real toolbar, paints a stroke with
the real pointer path and requires the peer canvas to change inside the stroke ROI, so a
declarative preset is proven to reach native ink and sync. It also opens the colour menu, clicks
the contributed `#DB2777` swatch, paints with the default pen and reads the mean colour of the
pixels that changed inside a baseline-diff ROI (`measureInk` in `canvas-observer.ts`), so the
user-scope palette is proven to reach the native colour path and not just toolbar state. Gaps:
the two presets are not compared against each other visually; shortcut chords are
non-configurable (`Alt+Shift+0..9`); there is no dynamic toolbar
section, context menu, custom panel or pointer-gesture contribution beyond the command panel;
contributed ids are namespaced per plugin, and `apgCatalog.unit.spec.ts` "keeps contributed ids
namespaced per plugin" fixes that policy: the same plain brush or palette id in two plugins stays
two separate contributions, and a stored user preference cannot resurrect a plugin the deployment
disabled.

## APG-05 — SDK and sandbox runtime

Implemented surfaces: `apps/frontend/src/service/apgSandbox.ts` (QuickJS WASM, frozen `apg`
global, prototype-free hook table, phase whitelist, 16 MiB memory, 256 KiB stack, 150 ms
deadline, 512 KiB input, 64 KiB result, 16 effects, 64 commands, 128 KiB program),
`apgSandbox.worker.ts` (module worker, busy rejection, replacement/disposal), `apgRuntime.ts`
(8 workers, 1.5 s command / 5 s load timeouts, effect authorization, context-key invalidation,
deactivate-then-terminate disposal), `apgSceneSnapshot.ts` (detached, validated scene metadata
capped at 512 items with an explicit `truncated` flag; `RoomView` feeds it from the worker's
incremental Render IR delta when OffscreenCanvas is active, and from the main-thread fallback
engine otherwise, so plugins can read the scene on both render paths), `packages/plugin-sdk/index.d.ts` (guest API plus manifest
contract types), `packages/plugin-sdk/mock` (Node dev host that runs a `main.js` against the
guest API and records previews, downloads, writes and mutations).

Evidence: `apgSandbox.unit.spec.ts` — "does not expose browser, network, process or host
APIs", "interrupts infinite guest execution and releases the context", "refuses programs,
inputs and results beyond the message budget", "rejects unknown
phases and unregistered command ids at the host bridge", "runs a real guest with a mock host
and disposes on revocation", "refuses a ninth concurrent worker instead of silently dropping
one" (eight workers open, the ninth `run` rejects with `APG active worker limit` and no extra
worker is created), "lets a user-scoped export hand inert text to the host but never a
path or a type"; `packages/plugin-sdk/mock/index.spec.ts` runs the three executable
official programs in Node (counter increments and revision growth, inspector unique-element
count and truncated suffix, template mutation and invalid-template rejection, scene export
download and empty-scene guard, duplicate and unknown command rejection);
`apgSceneSnapshot.unit.spec.ts` covers the cap, the `truncated` flag, dropping incomplete
atoms, rejecting a non-Render-IR frame, and the scene-source choice (worker frame →
main-thread fallback → explicit failure, never an invented empty scene).

Evidence for tooling: `apg init` (`apps/backend/cmd/apg/scaffold.go`) generates a package whose
manifest is accepted by the real validator; `TestAPGInitScaffoldsAPackablePackage` scaffolds a
user and a system plugin, packs the generated tree and re-reads it, and
`TestAPGInitRefusesToOverwriteOrMisuseTheScaffold` proves it refuses a non-empty directory and
rejects ids/scopes the manifest validator rejects. The Node mock host is covered above.

Gaps: the scaffolding CLI is `apg init` only (no watch/dev server or test runner); the mock host
is not a sandbox; there is no event subscription or explicit request-cancellation API, guest
handlers are synchronous, and the deadline is an interrupt-check bound rather than hard
preemption. Isolation is asserted for a
set of probed globals, not proven against every QuickJS escape primitive.

## APG-06 — Collaboration compatibility

Implemented surfaces: `authorizeApgEffects` rejects forged or unauthorized effects;
`compileApgSceneMutations` turns one guest request into 1..8 native `element.create`
operations (rectangle, rounded-rectangle, ellipse, line, arrow) with host-assigned ids,
actor, room, page, Lamport values and a **single shared history group**, validates each as a
normal Scene Operation V2 and pushes them through `roomCommandController`; the official
template now ships a two-shape bundle, so a template is one native undo step. Shared state
uses the server CAS described in APG-03; rendered output lives in the ordinary command
table, so replay never executes plugin code.

Evidence: `apgSandbox.unit.spec.ts` "rejects forged and unauthorized effects before host
mutation" (forged `actorId`, out-of-range size, unauthorized keys), "uses host IDs and
replays native geometry without the plugin", and "compiles a shape bundle into one history
group with host-owned identity" (two ops share one group, distinct element ids, 0 and 9
shapes rejected, invalid member rejects the whole bundle, the pair replays through
`SceneCore`); Lab case: peer pixels match within the 0.012 threshold, one undo on the
inserting client removes both template shapes on the peer (the shared history group is real),
redo restores them, the inspector sees the two elements, and the late joiner reproduces the
canvas and the counter after the template plugin was disabled.

Gaps, stated plainly:

- Output is limited to 1..8 native shapes sharing one history group. That is undo-level
  atomicity, not a server transaction: there is no generic semantic scene component, no
  component schema versioning, and no multi-op server-side commit.
- Shared assets are archived `assets/*.json` templates consumed by plugin code; there is no
  image asset pipeline, no `drawImage` path, no per-room asset ACL, and no persisted asset
  reference in scene operations.
- Replay and revocation are verified for the two-element template and the counter; larger
  multi-element scenes, text, images and missing-archive behavior are not covered.
- Undo/redo is asserted only through the Lab case's keyboard path on the template bundle
  (one undo removes both shapes on the peer, redo restores them). Redo of an undone *shared
  state* write is not a concept the system has; state is revisioned, not undoable.

## APG-07 — Official plugin migration

Implemented surfaces: seven packaged official plugins under `plugins/official/` (including `note-template`, which places a native sticky note and text caption as `glyph` elements):

| Plugin | Scope | Contribution | Executable |
| --- | --- | --- | --- |
| `aevia.brushes` | system | declarative brushes Soft Pencil (`pencil`, 5, 0.65) and Marker (`highlighter`, 16, 0.35) | no |
| `aevia.palette` | user | declarative Studio palette (6 colours) | no |
| `aevia.scene-inspector` | user | `Inspect Scene` command, `scene.read` + `ui.preview` | yes |
| `aevia.shape-template` | system | `Insert Card` command reading `assets/card.json`, `scene.write` + `ui.preview` | yes |
| `aevia.shared-counter` | system | `Increment Counter` / `Read Counter`, `storage.shared` + `ui.preview` | yes |
| `aevia.scene-export` | user | `Export Scene` command, `scene.read` + `ui.download` + `ui.preview`, browser download of inert JSON text | yes |

All seven go through the real CLI (pack → sign → verify → install → enable) and the real
catalog/runtime/broker/native-operation path. There is no hard-coded plugin-id special case
in the host.

Evidence: `TestAPGOfficialPackageLifecycle` (the fixture installs all seven) and the Lab case
(counter and template end to end, inspector command, a real browser download produced by the
user-scoped export plugin, disable/revocation, and the `Marker` preset painting a stroke that
reaches the peer canvas).

Gaps: the declarative brush and palette packages are **new presets**, not a migration of the
existing native tools — the built-in pencil/highlighter/eraser tools remain native and were
not moved behind APG. The Lab case paints with the `Marker` preset and checks that the peer
canvas changes inside the stroke ROI and that a contributed palette swatch reaches the canvas
ink colour, but it does not assert stroke width or compare the two presets. `aevia.palette` is
user-scope and its preference is stored in `localStorage`. A switched-off palette keeps its
entry and toggle (`已停用`) so the user can turn it back on; the swatches are hidden, and global
revocation removes the plugin from the catalog. Cross-tab propagation is unit-tested
(`watchApgPalettePreferences` adopts another tab's switch and ignores unrelated keys or a
disposed listener), but it is not exercised in a browser with two tabs. Preference keys are
scoped to the signed-in account (`<prefix><owner>:<pluginId>`, guests share a `guest` slot), so
two accounts in one browser profile no longer inherit each other's switches; keys written
before the owner was added are ignored, which resets those preferences once.

## APG-08 — Test and developer toolchain

Implemented surfaces: four Vitest projects plus the frontend browser project; Go unit and
gateway tests; the cross-language manifest corpus; the Lab fixture that builds the CLI,
generates a temporary key pair, writes a temporary trust store and installs the seven official
packages; `case:apg-official-business` wired into the CI-required external case list with a
Lab measurement contract; `tests/catalog/feature-obligations.json` and
`tests/catalog/module-obligations.json` covering every APG source file; a Node mock host for
plugin authors (`packages/plugin-sdk/mock`); `apg init` scaffolding; `docs/apg/*`; and
`tests/report/apg-docs.spec.ts`, which fails if a doc link or an inline source path rots or if a
shipped official plugin is missing from the operator-facing documents.

Evidence: the suites in the table above, `TestManifestCorpus`, obligations specs under
`tests/report/`, the measured first-pixel and catalog-load comparisons in `performance.md`
(`BenchmarkLoadCatalogOfficialPlugins`: ≈2.12 ms per trust-verified seven-plugin catalog
load), and the latest green Lab run recorded in the evidence table.

Gaps: there is no dedicated APG performance case; the measured comparison in
`performance.md` reuses the existing local/remote first-pixel cases with the idle enabled
official plugins and found no difference beyond run-to-run noise (latest on-arm run
`90e6f91b-20e1-49ee-a9ca-6a439487c8cc`, measured before `aevia.note-template` was added). Sustained frame rate, memory, and the
cost of an actually-executing plugin are still unmeasured. The acceptance matrix itself and
the E2E regression must be re-run after any further source change.

## Not implemented

Three capabilities are out of scope for this delivery and are **not** claimed anywhere:
image assets rendered inside the scene, semantic scene components with schema migration, and a
server-side atomic multi-operation commit (the current shape bundle shares one history group but
is N independent commands). [future-work.md](future-work.md) specifies each one against the real
files it must touch.

## Unverified claims to avoid

- Any APG throughput or memory figure, any speedup claim, and any latency claim outside the
  measured on/off table in `performance.md`.
- Production static hosting of the QuickJS wasm/worker (COOP/COEP is configured for Vite
  dev/preview only).
- Behavior with 256 enabled plugins beyond loading them: the cap and the 257th-package
  rejection are Go-tested, but not request latency or memory at that size; the 8-worker cap is
  unit-tested for the ninth rejection, not for sustained load. Scenes beyond the 512-item read snapshot are covered only
  by the unit test for the cap and `truncated` flag, not by a browser scenario.
- Concurrent shared-state conflict UX in the frontend (there is no retry loop by design).
- Palette preferences are `localStorage` only, scoped per account on that browser: another
  tab's switch is adopted through a `storage` listener (`watchApgPalettePreferences`), but
  there is no server-side sync across devices, and a cleared profile resets them.
- Cross-platform CLI parity beyond the Windows environment used for the recorded Lab run.
- Migration of existing native tools (pencil, highlighter, eraser, stickers, templates) behind
  APG — only new plugin-owned presets and commands exist so far.

## Reproducing

```powershell
# TypeScript: unit, module and harness projects
npx vitest run --project shared-unit --project frontend-unit --project frontend-module --project harness-unit

# Browser-level component tests
npx vitest run --project frontend-browser

# Go
cd apps/backend
$env:GOMAXPROCS = "2"; $env:GOFLAGS = "-p=1"
go test ./... -count=1
go vet ./...

# Production build (Go backend + frontend typecheck/bundle)
cd ..\.. ; npm run build

# Obligation catalog check (CI gate)
npm run lab:obligations:check

# Real two-browser APG case
npx tsx tests/run-system.ts --profile=single --yes "--only=case:apg-official-business"
```
