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

When changing rendering, keep worker and fallback paths coherent. Dirty-rect changes should usually inspect `commandDirtyRect.ts`, `dirtyRenderQueue.ts`, `canvasWorker.ts`, and `dirtyRedraw.ts` together.

Stroke rendering uses midpoint-based quadratic segments with state carried across incremental batches. Every live `cmdId` must be finalized on `cmd-stop` so the pending tail is committed; keep `strokeRasterizer.ts`, `canvas.ts`, `canvasWorker.ts`, `renderWorkerBridge.ts`, pointer stop handling, and remote command-stop handling aligned.

Raw pointer input is normalized by `strokeInputSampler.ts`: coalesced browser events are resampled at a fixed spatial interval, speed and pressure are filtered by elapsed time, and each animation-frame batch is simplified with pressure-aware error bounds. `roomPointerController.ts` must use the same resulting points for local rendering and transport; renderers must consume stored pressure without deriving a second velocity factor from point distance. Backpressure changes simplification tolerance through `collabPressurePolicy.ts`, not the base sampling interval.

Mouse stroke start is deferred until two normalized movement samples are available so their speed-derived pressure can backfill the first point before `cmd-start`, local paint, and persistence. A no-movement tap is committed on pointer-up, while pen input keeps its physical initial pressure. Do not eagerly paint or send a provisional mouse start point because canvas pixels cannot be narrowed afterward without redraw.

Mouse speed simulation uses idle-aware asymmetric damping: accelerating/thinning responds faster than decelerating/thickening, and a long pause must not be included as movement time or filter elapsed time when drawing resumes. Width growth is also capped below width shrink per normalized sample. Keep pen pressure on its separate physical-pressure path.

During a local stroke, `pointerHotState.currentPathPoints` and the inserted command must share the authoritative point buffer until stop; otherwise worker state sync can replace complete incremental geometry with only the start point. On OffscreenCanvas stop, clear main-thread points before metadata sync and preserve `points: undefined` across cloning so it means “do not replace worker geometry”; flush pending increments before finalizing the worker stroke.

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
