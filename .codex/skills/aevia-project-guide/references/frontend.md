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
- `service/realtimeBinary.ts`: cursor/legacy realtime frames and negotiated V2 append encoding.
- `service/sessionApi.ts`: HTTP session calls.
- `service/pageOverviewService.ts`: page overview API.

## Rendering

Canonical scene core:

- `scene/sceneCore.ts`: browser-independent operation folding, primitive compilation, history, transforms, erasure, hit testing and spatial queries. Text measurement is injected by the host.
- `scene/sceneEngine.ts`: Canvas adapter over `SceneCore`, used by the worker and fallback paths; it supplies browser text measurement and retains the existing rendering API.
- `scene/renderIR.ts`: detached ordered render frames and revision-checked full-to-delta reconstruction, with old/new dirty bounds. `scene/canvasIRRenderer.ts` consumes these render items; the live adapter feeds it visible items without cloning the entire scene on every redraw. `scene/renderIRCodec.ts` frames full/delta payloads with version, length, little-endian header and corruption check; the payload remains JSON and is not yet the worker transport.
- Render IR atom handles carry an engine epoch and generation, survive index compaction, and cannot resolve after a reset/recreation. Handle resolution is currently linear; do not use it as a hot-path spatial index.
- `scene/renderOrderIndex.ts`: block-ordered atom references used by full replay.
- `scene/spatialGridIndex.ts`: 32×32 coarse grid over bounded geometry chunks.
- `scene/dirtyRegionSet.ts`: up to eight disjoint regions, full-render thresholds, and enter/exit hysteresis.
- `scene/primitiveRenderer.ts`: the only Canvas2D recipe executor for stroke, shape, glyph, and bitmap atoms.
- `scene/toolRegistry.ts`: declarative built-in tools and their public primitive mappings.
- `scene/stickerAssets.ts`: versioned built-in sticker keys; new operations retain the legacy Emoji value so old rooms and clients remain readable. Backend asset validation must stay in sync.

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

The render worker bridge forwards queued legacy stroke increments in a microtask rather than depending on animation frames, settles pending queries when the worker fails, is disposed, or its scene is replaced, and rejects old scene-epoch replies. If worker creation or canvas transfer fails before transfer succeeds, the session uses the main-thread Canvas context. If an active worker fails after canvas transfer, the room replaces the canvas, restarts the worker and requests a full snapshot; in-memory unconfirmed operations are replayed only after initialization is confirmed. Failed recovery remains explicitly retryable and pending operations are not durable across a browser reload.

`WhiteboardSession.getConsistencyWatermarks()` samples the transport's contiguous recovery `roomSeq` and the worker's separate submitted/processed dispatch sequence, materialized scene revision, and last conservatively drawn revision. Dispatch processing may only mean an operation was buffered during initialization; it does not imply scene application or painting. Sampling crosses threads and is not an atomic snapshot. A null presented revision means no complete eligible Canvas draw has been recorded, not that the scene is empty; drawing means Canvas commands ran, not that browser compositing was observed.

New drawing writes are immutable `element.create`/`element.append` scene operations. Stroke rendering compiles midpoint-based quadratic atoms once as points enter the scene, and `isComplete` commits the stable tail atom. `cmd-start/update/stop` remains only in V1 read/rejection compatibility code and must not be used for a new write path.

SceneEngine buffers missing append ranges and text dependencies, and requests page resync on conflicting ranges or excessive unresolved dependencies. Hydrated render-stream points use float32 geometry; compare them to authoritative operation points at float32 precision. The transport advances its recovery cursor only through the contiguous prefix accepted into local command state and retries unconfirmed immutable writes by their original IDs. Pending writes are held in memory, not in a durable offline log; do not claim reload/crash-safe offline editing.

Selection transforms are preview matrices until pointer-up, then one multi-target `element.transform` is appended. Erasure stores masks for partial-width strokes, legacy quantized atom intervals, or whole-object targets; neither feature may rewrite historical point arrays. Undo/redo appends `history.toggle`.

The worker must not mirror complete point geometry in `sceneCommands`; SceneEngine owns compiled geometry and point hydration. The backend render-point stream projects both legacy path points and V2 path create/append points; V2 command chunks still carry the authoritative operations and non-path semantics. SceneEngine adopts hydrated V2 geometry without compiling the points twice. Live remote commands and locally submitted operations during initialization are merged with the completed command snapshot rather than overwritten.

Init and page-resync render chunks are painted progressively as soon as each clear-watermark-filtered chunk is ingested. `canvasWorker.ts` clears the previous pixels only when the first valid chunk is ready, draws newly compiled atom refs in stream order, and finalizes stroke tails at render-stream completion; V2 command chunks then fold progressively into the same SceneEngine. Do not delay first paint until both streams finish. The initialized command window is finalized after both streams and the overall completion signal; the recovery cursor advances only after the worker confirms its queued snapshot processing. Invalid binary chunks or unresolved dependencies fail that confirmation. Page-change snapshots merge live operations and deduplicate IDs before updating the loaded window. When switching to a cached page, replay its stored Scene operations as well as newly streamed operations after the command window is updated; the render-point stream alone cannot restore undo, transforms, or text. Forced current-page resync sends an empty `clientLoadedPageIds` window so the backend actually returns authoritative commands instead of a flat-only cache delta.

`RoomTextEditor.vue` places the editor over the canvas and keeps font controls local while editing. `roomPointerController.ts` appends a style operation on confirmation and a versioned text-box style operation after a resize; toolbar clicks must not emit one network operation per click. Double-click editing reconstructs the current text from scene operations. New text uses measured glyph advances and a versioned layout descriptor; legacy text keeps its original layout. Rejected scene pushes with a returned `cmdId` are rolled back locally and rebuild the Worker scene rather than forcing an unscoped page replay.

Raw pointer input is normalized by `strokeInputSampler.ts`: coalesced browser events are resampled at a fixed spatial interval, speed and pressure are filtered by elapsed time, and each animation-frame batch is simplified with pressure-aware error bounds. `roomPointerController.ts` must use the same resulting points for local rendering and transport; renderers must consume stored pressure without deriving a second velocity factor from point distance. Backpressure changes simplification tolerance through `collabPressurePolicy.ts`, not the base sampling interval.

Mouse stroke start is deferred until two normalized movement samples are available so their speed-derived pressure can backfill the first point before `element.create`, local paint, and persistence. A no-movement tap is committed on pointer-up, while pen input keeps its physical initial pressure. Do not eagerly paint or send a provisional mouse start point because canvas pixels cannot be narrowed afterward without redraw.

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
