# Protocol and Coupling Guide

Read this before changing command shape, shared types, message semantics, binary frames, page normalization, render chunk encoding, or any cross-client/backend behavior.

## Shared Package

- `packages/shared/src/types/collab.ts`: canonical shared collaboration domain types.
- `packages/shared/src/protocol/collabProtocol.ts`: canonical protocol/page normalization helpers.
- `packages/shared/src/index.ts`: exports.
- `packages/shared/cjs/index.cjs`: CommonJS bridge.
- `packages/shared/cjs/protocol/collabProtocol.cjs`: CommonJS protocol helper mirror.
- `apps/backend/src/shared/collabProtocol.js`: backend require bridge.

If shared protocol behavior changes, keep TypeScript and committed CJS compatibility files aligned.

## Core Domain Types

Main concepts:

- `Point`: normalized point with pressure and Lamport timestamp.
- `FlatPoint`: expanded render-stream point with command metadata.
- `Command`: whiteboard command entity.
- `RemoteCursor`: collaborator cursor.
- `AabbBox`: command bounds.
- `QueuePoint`: dirty-point queue logic.

Important command fields include:

```text
id, type, tool, color, size, points, timestamp, userId, roomId, pageId, isDeleted, lamport, box
```

## Coupling Rules

Protocol/page normalization:

- `packages/shared/src/protocol/collabProtocol.ts`
- `packages/shared/cjs/protocol/collabProtocol.cjs`
- `apps/frontend/src/service/collabProtocol.ts`
- backend callers through `apps/backend/src/shared/collabProtocol.js`

Binary real-time transport:

- `apps/frontend/src/service/realtimeBinary.ts`
- `apps/backend/src/websocket/realtimeBinary.js`

Binary init/page-change render chunks:

- `apps/backend/src/websocket/renderChunkBinary.js`
- `apps/frontend/src/workers/canvasWorker.ts`

Page-change streaming:

- `apps/backend/src/services/roomService.js`
- `apps/backend/src/websocket/messageHandler.js`
- `apps/frontend/src/service/collabCommandHandlers.ts`
- `apps/frontend/src/service/roomPageService.ts`
- `apps/frontend/src/store/commandStore.ts`

Rendering:

- worker path and main-thread fallback path must stay coherent.
- inspect `canvas.ts`, `canvasRuntime.ts`, `renderWorkerBridge.ts`, `canvasWorker.ts`, `strokeRasterizer.ts`, and `dirtyRedraw.ts`.

## Verification

For shared/protocol changes, prefer:

```powershell
cmd /c npm run build --workspace @collaborative-whiteboard/frontend
cmd /c npm run test:unit
cmd /c npm run test:integration
```

For binary/render/page stream changes, add an external smoke if services and browser dependencies are available:

```powershell
cmd /c npm run test:e2e:smoke
```
