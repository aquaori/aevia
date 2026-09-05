# Protocol and Coupling Guide

Read this before changing command shape, shared types, message semantics, binary frames, page normalization, render chunk encoding, or any cross-client/backend behavior.

## Shared Package

- `packages/shared/src/types/collab.ts`: canonical shared collaboration domain types.
- `packages/shared/src/protocol/collabProtocol.ts`: canonical protocol/page normalization helpers.
- `packages/shared/src/types/scene.ts`: `SceneOperationEnvelopeV2`, public recipes, tools, transforms, erase targets, text patches, and render keys.
- `packages/shared/src/protocol/sceneProtocol.ts`: schema constants, supported recipes, and deterministic render-order comparison.
- `packages/shared/src/index.ts`: exports.

The shared package is ESM-only. The committed CommonJS bridge went away with
the Express backend, so there is no second copy to keep in sync.

## Core Domain Types

Main concepts:

- `Point`: normalized point with pressure and Lamport timestamp.
- `FlatPoint`: expanded render-stream point with command metadata.
- `Command`: whiteboard command entity.
- `RemoteCursor`: collaborator cursor.
- `AabbBox`: command bounds.
- `QueuePoint`: dirty-point queue logic.
- `SceneOperationEnvelopeV2`: immutable product operation; all new board writes use `Command.type = "scene-op"` and `schemaVersion = 2`.

Important command fields include:

```text
id, type, tool, color, size, points, timestamp, userId, roomId, pageId, isDeleted, lamport, box
```

## Ordering Invariant

Lamport ties are broken by a byte-wise command-id comparison. Every participant
must derive the same order, so use the shared helpers instead of writing a
comparison inline:

- `packages/shared/src/protocol/collabProtocol.ts`: `compareCommandIds`, `compareCommandOrder`
- `apps/backend/internal/domain/types.go`: `CompareFlatPoint`

Never use `localeCompare` or `toLocaleLowerCase` here — both are locale-sensitive
and would let two clients order the same pair differently.

Scene atoms use `(lamport, opId byte order, sourceIndex, subIndex)`. Use `compareRenderOrder`/`sceneOperationOrderKey`; do not derive a tool-specific z-index. Points, glyphs, shapes, and plugin recipes share this order.

## V2 Mutation Rules

- New writes are `element.create`, `element.append`, `element.transform`, `element.erase`, `element.delete`, `element.style`, `text.patch`, `history.toggle`, or `page.clear`.
- Transform, erase, delete, clear, undo, and redo append operations; they never replace stored commands or points.
- The Go gateway requires matching command/operation IDs, identity, room/page, Lamport value, recipe capability, numeric ranges, and `schemaVersion: 2`.
- V1 path commands remain readable through the SceneEngine adapter. V1 mutation messages are rejected with `UPGRADE_REQUIRED`.
- A protocol-only client must take its trusted `userId` from WebSocket `init-meta`; `/join-room` does not expose the token's user ID.

## Coupling Rules

Protocol/page normalization:

- `packages/shared/src/protocol/collabProtocol.ts`
- `apps/frontend/src/service/collabProtocol.ts`
- Go backend: `apps/backend/internal/domain`, `internal/protocol`

Binary real-time transport:

- `apps/frontend/src/service/realtimeBinary.ts`
- `apps/backend/internal/protocol/realtime.go`

Binary init/page-change render chunks:

- `apps/backend/internal/protocol/render_chunk.go`
- `apps/frontend/src/workers/canvasWorker.ts`

Page-change streaming:

- `apps/backend/internal/room/` (actor, state, snapshot builder, stream send)
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
