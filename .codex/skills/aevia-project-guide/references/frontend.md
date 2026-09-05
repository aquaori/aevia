# Frontend Guide

Read this for Vue room behavior, canvas interaction, command state, rendering, page switching, UI controls, and frontend build/test changes.

## Start Here

- `apps/frontend/src/views/RoomView.vue`: composition root for the whiteboard room.
- `apps/frontend/src/main.ts`: app creation, Pinia, router, dev error hooks.
- `apps/frontend/src/router/index.ts`: `/`, `/invite/:token`, `/room`.

## State and Stores

- `apps/frontend/src/store/userStore.ts`: persisted token/user identity in `sessionStorage`.
- `apps/frontend/src/store/commandStore.ts`: page-bucketed commands, command map, pending updates, history pointer, loaded page window.
- `apps/frontend/src/store/lamportStore.ts`: Lamport clock plus dirty-point collision/redraw support.
- `apps/frontend/src/states/roomSessionState.ts`: token/session/reconnect flags.
- `apps/frontend/src/states/roomUiState.ts`: dialogs, menus, fullscreen, toolbar visibility.
- `apps/frontend/src/states/roomEditorState.ts`: tool, color, page, total pages, cursors, members.
- `apps/frontend/src/states/roomInteractionState.ts`: drawing, selection, drag, resize, transform transient state.

Important: do not bypass `commandStore` for command ordering/folding behavior.

## Controllers

- Pointer/drawing behavior: `controllers/roomPointerController.ts`, `controllers/interactionController.ts`.
- Command actions: `controllers/roomCommandController.ts`, `service/localCommandService.ts`.
- Tool/color/size controls: `controllers/roomToolController.ts`, `components/RoomToolbar.vue`.
- Page navigation: `service/roomPageService.ts`, `components/RoomPagination.vue`, `components/RoomPageOverview.vue`.
- Lifecycle: `controllers/roomLifecycleController.ts`.
- Keyboard shortcuts: `controllers/roomKeyboardController.ts`.

## Services

- `service/roomCollabTransport.ts`: WebSocket connection, reconnect, raw/binary intake.
- `service/collabMessageDispatcher.ts`: routes incoming messages.
- `service/collabCommandHandlers.ts`: incoming command stream handling.
- `service/collabPresenceHandlers.ts`: cursors/member updates.
- `service/localCommandService.ts`: local command creation/history/transport emission.
- `service/realtimeBinary.ts`: frontend binary `mouseMove` and `cmd-update`.
- `service/sessionApi.ts`: HTTP session calls.
- `service/pageOverviewService.ts`: page overview API.

## Rendering

Canonical scene core:

- `scene/sceneEngine.ts`: immutable-operation folding, incremental primitive compilation, history, clear, transforms, erasure, hit testing, ordering, spatial queries, and rendering.
- `scene/renderOrderIndex.ts`: block-ordered atom references used by full replay.
- `scene/spatialGridIndex.ts`: 32×32 coarse grid over bounded geometry chunks.
- `scene/dirtyRegionSet.ts`: up to eight disjoint regions, full-render thresholds, and enter/exit hysteresis.
- `scene/primitiveRenderer.ts`: the only Canvas2D recipe executor for stroke, shape, glyph, and bitmap atoms.
- `scene/toolRegistry.ts`: declarative built-in tools and their public primitive mappings.

Preferred worker path:

- `service/renderWorkerBridge.ts`
- `workers/canvasWorker.ts`
- `service/strokeRasterizer.ts`

Main-thread/fallback and scheduling:

- `service/canvas.ts`
- `service/canvasRuntime.ts`
- `utils/dirtyRedraw.ts`
- `service/dirtyPointBus.ts`
- `service/dirtyRenderQueue.ts`
- `service/commandDirtyRect.ts`

Worker and fallback paths both use `SceneEngine`; do not add a second tool-specific renderer or command scan. Dirty-rect changes should usually inspect `sceneEngine.ts`, `spatialGridIndex.ts`, `dirtyRegionSet.ts`, `dirtyRenderQueue.ts`, `canvasWorker.ts`, and `canvas.ts` together.

New drawing writes are immutable `element.create`/`element.append` scene operations. Stroke rendering compiles midpoint-based quadratic atoms once as points enter the scene, and `isComplete` commits the stable tail atom. `cmd-start/update/stop` remains only in V1 read/rejection compatibility code and must not be used for a new write path.

Selection transforms are preview matrices until pointer-up, then one multi-target `element.transform` is appended. Erasure stores explicit quantized atom intervals (or whole-object targets); neither feature may rewrite historical point arrays. Undo/redo appends `history.toggle`.

The worker must not mirror complete point geometry in `sceneCommands`; SceneEngine owns compiled geometry and point hydration. Init command streams carry V2 operations because the backend render-point stream contains only legacy path points. Live commands arriving before init commands complete are merged into the snapshot rather than overwritten.

Init and page-resync render chunks are painted progressively as soon as each clear-watermark-filtered chunk is ingested. `canvasWorker.ts` clears the previous pixels only when the first valid chunk is ready, draws newly compiled atom refs in stream order, and finalizes stroke tails at render-stream completion; V2 command chunks then fold progressively into the same SceneEngine. Do not delay first paint until both streams finish. Forced current-page resync sends an empty `clientLoadedPageIds` window so the backend actually returns authoritative commands instead of a flat-only cache delta.

`RoomTextEditor.vue` keeps font controls local while editing. `roomPointerController.ts` appends at most one immutable `element.style` operation when the editor is confirmed; toolbar clicks must not emit one network operation per click. Rejected scene pushes with a returned `cmdId` are rolled back locally and rebuild the Worker scene rather than forcing an unscoped page replay.

Raw pointer input is normalized by `strokeInputSampler.ts`: coalesced browser events are resampled at a fixed spatial interval, speed and pressure are filtered by elapsed time, and each animation-frame batch is simplified with pressure-aware error bounds. `roomPointerController.ts` must use the same resulting points for local rendering and transport; renderers must consume stored pressure without deriving a second velocity factor from point distance. Backpressure changes simplification tolerance through `collabPressurePolicy.ts`, not the base sampling interval.

Mouse stroke start is deferred until two normalized movement samples are available so their speed-derived pressure can backfill the first point before `cmd-start`, local paint, and persistence. A no-movement tap is committed on pointer-up, while pen input keeps its physical initial pressure. Do not eagerly paint or send a provisional mouse start point because canvas pixels cannot be narrowed afterward without redraw.

Mouse speed simulation uses idle-aware asymmetric damping: accelerating/thinning responds faster than decelerating/thickening, and a long pause must not be included as movement time or filter elapsed time when drawing resumes. Width growth is also capped below width shrink per normalized sample. Keep pen pressure on its separate physical-pressure path.

For legacy V1 hydration, preserve `points: undefined` across worker metadata cloning so it means “do not replace SceneEngine geometry”. New V2 commands keep geometry in their immutable operation payload and do not use the old incremental-command mutation path.

## UI Components

- `RoomHeader.vue`: header.
- `RoomConnectionOverlays.vue`: reconnecting/failure overlays.
- `RoomMemberList.vue`: member panel.
- `RoomPageOverview.vue`: page overview dialog.
- `RoomPagination.vue`: page controls.
- `RoomShortcutsDialog.vue`: shortcuts modal.
- `RoomSizePreview.vue`: brush/eraser preview.
- `RoomToolbar.vue`: main tool surface.

## Verification

For frontend logic or type changes:

```powershell
cmd /c npm run build --workspace @collaborative-whiteboard/frontend
```

For focused unit behavior, inspect `vitest.config.ts` and use the smallest matching root script:

```powershell
cmd /c npm run test:unit
cmd /c npm run test:browser
```

For user-visible canvas behavior, prefer an external E2E smoke only when local services and Chrome/Playwright are available:

```powershell
cmd /c npm run test:e2e:smoke
```
