# APG future work

This file records the three capabilities that are **not implemented** in the working tree on
branch `feat/aevia-plugin`. Each one is a cross-cutting change, not a missing branch in an
existing switch, so none of them can be shipped as a partial slice without regressing scene
replay, cross-client rendering, or the collab protocol.

Everything below is a design note for whoever picks the work up. It lists the real files and
functions that must change, the invariants that must survive, and the tests that must exist
before the item can be called done. Nothing here is claimed as working.

The implemented surface is described in [README.md](README.md), the package contract in
[package-spec.md](package-spec.md), the guest API in [sdk.md](sdk.md), and the current
verification status in [acceptance.md](acceptance.md) and [report.md](report.md).

## 1. Image assets rendered inside the scene

### Why it is not a small change

Plugin output today is native scene operations. A `bitmap` render atom is **not** an image:
`apps/frontend/src/scene/sceneCore.ts:1339` (`storeBitmapAtom`) stores a *grapheme string* in
`BitmapAtom.value`, resolved from the built-in sticker table
(`apps/frontend/src/scene/stickerAssets.ts:10`, `resolveStickerAsset`), and
`apps/frontend/src/scene/primitiveRenderer.ts:352` draws it with `ctx.fillText`. The asset
descriptor is `{ key, version: 1 }` (`packages/shared/src/types/scene.ts`), validated on the
server against four built-in sticker keys in `apps/backend/internal/gateway/scene_validation.go`
(`element.create` branch). Any attempt to smuggle an APG digest into `asset.key` makes
`SceneCore.applyOperationSteps` (`sceneCore.ts:510`) set `needsResync` and reject the
operation, and any peer that does not have the bytes would diverge.

So "show an image from a plugin package" actually means: a new scene descriptor variant, server
validation for it, a render-atom variant that carries bytes or a resource handle, decode and
cache management, worker and main-thread rendering, prefix-cache invalidation, and a
deterministic fallback when the bytes are missing.

### Required changes

| Layer | File | Change |
| --- | --- | --- |
| Shared types | `packages/shared/src/types/scene.ts` | Add an APG asset descriptor (`pluginId`, package digest, asset path, content hash, mime, intrinsic size, optional fallback descriptor). Keep the existing sticker `{key, version}` variant untouched. |
| Protocol validation | `apps/backend/internal/gateway/scene_validation.go` | Accept the new variant only for `system`-scoped plugins currently enabled in the catalog, with a path under `assets/`, an allowlisted image mime, and a size cap. Reject unknown digests. |
| Package format | `apps/backend/internal/apg/{catalog,package}.go` | Allow image assets under `assets/` with per-file and total caps (today only `assets/**.json` is accepted for command resources). Archive them content-addressed. |
| Scene fold | `apps/frontend/src/scene/sceneCore.ts` | Materialize the new descriptor into an image atom; never block on network. Unknown/unloaded asset becomes a deterministic placeholder **and is not** `needsResync`. |
| Render IR | `apps/frontend/src/scene/renderIR.ts`, `renderIRCodec.ts` | New atom variant carrying a resource reference plus intrinsic size; keep codec versioning and prefix-cache keys honest. |
| Renderer | `apps/frontend/src/scene/primitiveRenderer.ts`, `canvasIRRenderer.ts` | `drawImage` path with per-atom `drawImage` bounds, no `fillText` fallback confusion. |
| Worker + fallback | `apps/frontend/src/workers/canvasWorker.ts`, `apps/frontend/src/service/canvas.ts`, `renderWorkerBridge.ts` | Same atom in both renderers; async decode must not stall the frame loop. |
| Cache | prefix cache + dirty-region bookkeeping | Invalidate when an asset transitions from placeholder to decoded. |
| Loader | new `apps/frontend/src/service/apgAssetCache.ts` | Fetch `/api/apg/asset/{digest}/{path}`, verify digest, decode once, bounded LRU, deterministic eviction behaviour. |

### Invariants

- History replay must render the same picture **without** the plugin being installed or enabled.
  That forces the bytes to be addressable from the scene operation itself (digest + path), not
  from the plugin's runtime.
- Viewer and owner must agree pixel-for-pixel, so the placeholder must be deterministic.
- No per-frame network or ZIP access: one resolve per asset per room, then cached.
- Assets referenced by history must survive uninstall; the archive is never pruned
  (`archivePackage` in `apps/backend/cmd/apg/main.go`).

### Tests required

- SceneCore fold: descriptor with a known digest produces an image atom; unknown digest
  produces the placeholder and does not set `needsResync`.
- Render IR round-trip and prefix-cache invalidation on decode.
- Worker and main-thread fallback render the same pixels (reuse
  `apps/frontend/tests/e2e/external/canvas-observer.ts`).
- Multi-client Lab case: insert image, second client matches pixels, late joiner matches after
  the plugin is disabled.
- Asset endpoint: 404 for a missing digest, 200 + immutable cache for a present one, budget
  behaviour unchanged.

## 2. Semantic scene components

### Why it is not a field

A component needs an identity that survives edits, a schema version, an upgrade/migration
story, and a fallback that renders when the plugin is absent. The current protocol has no
generic component type: `Scene Operation V2` carries `element.create/append/transform/style/
erase/delete`, `text.patch`, `history.toggle`, `page.clear`, and unknown kinds are rejected by
`apps/backend/internal/gateway/scene_validation.go`. Adding a `pluginType` string to an element
would give identity but not migration, atomic upgrade, or fallback.

### Minimum honest slice

1. A component element whose descriptor carries `{ componentId, schemaVersion, pluginId,
   packageDigest, data }` plus a **native fallback descriptor** that already renders as
   ordinary shapes.
2. Server validation that the plugin is enabled and `system`-scoped at *write* time, and that
   `data` stays under a size cap.
3. SceneCore materializes the fallback when the component type is unknown, so a room joined by
   a peer without the plugin still renders.
4. An explicit upgrade path: a new operation that rewrites `data` + `schemaVersion` for a
   component, wrapped in one history group; no silent on-read migration.

### Tests required

- Fallback rendering with the plugin absent and with an incompatible `schemaVersion`.
- Undo/redo of a component insert and of an upgrade, once each.
- Reconnect replay produces the same pixels as the live edit.
- Cross-client: two clients, one with the plugin disabled client-side (user-scope is not
  applicable here; the test is the deployer disabling the package).

## 3. Server-side atomic multi-operation commit

### Why the bundle is not a transaction

`compileApgSceneMutations` (`apps/frontend/src/service/apgSceneCompiler.ts`) emits 1–8 native
`element.create` operations that share one `historyGroupId`, and `RoomView.vue` pushes them one
by one through `roomCommandController.pushCommand`. One undo removes the whole group, but the
server sees N independent commands: a disconnect mid-bundle can persist a prefix, and the
renderer may show a partial template.

### Required changes

| Layer | File | Change |
| --- | --- | --- |
| WS protocol | `apps/backend/internal/gateway/ws_messages.go` | New client message carrying an ordered operation list, bounded in count and bytes. |
| Room actor | `apps/backend/internal/room/events.go` (the `Event` switch), `persistence.go` (`persistCommand`) | Validate the whole list, then persist and broadcast it atomically, with one server sequence and one history group. |
| Ack/replay | room snapshot + delta replay | A batch is one replay unit; a client must never observe a prefix after reconnect. |
| Client submit | `apps/frontend/src/service/localCommandService.ts` (today `pushCommand` takes a single `Partial<Command>`), `roomCommandController.ts` | A batch submit path with its own optimistic state and rollback. |
| APG | `apgSession`/`RoomView.vue` mutate handler | Send one batch instead of N commands; keep per-effect caps. |

### Tests required

- Server: a batch with an invalid member is rejected entirely, including when the valid prefix
  was already validated.
- Crash/reconnect test: kill the socket mid-batch, reconnect, assert the room contains either
  the whole bundle or none of it.
- Lab: two clients, batch insert, one undo removes the whole group on both.
- Compatibility: an old client that does not know the new message must be rejected cleanly
  rather than desyncing.

## Why these are not in the current delivery

Each of them rewrites a protocol-adjacent layer that every other test in this repository
depends on (`Scene Operation V2`, `Render IR`, replay). Shipping a half-wired version would
break the invariants the rest of APG already relies on: plugin output must stay replayable
without the plugin, and the two render paths must agree. The rest of the system — packaging,
signing, catalog, sandbox, capability broker, contributions, shared state, official plugins,
CLI lifecycle, and the multi-client Lab case — is implemented and covered by the tests listed
in [acceptance.md](acceptance.md).
