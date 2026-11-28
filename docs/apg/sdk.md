# APG SDK reference (apiVersion 1)

The SDK surface is the single global `apg` object available to `main.js`. Its TypeScript
declaration is `packages/plugin-sdk/index.d.ts`; the runtime implementation is the frozen
object created by the bootstrap string in `apps/frontend/src/service/apgSandbox.ts`.

Guest code runs in QuickJS inside a dedicated module worker, not in the page. Only JSON
crosses the boundary: no DOM, `window`, `fetch`, timers, `require`, filesystem, clipboard,
`localStorage`, engine objects, or functions from the host.

## API

| Member | Signature | Behavior |
| --- | --- | --- |
| `apg.registerCommand` | `(id: string, handler: (input?) => void) => void` | Registers a command during evaluation. Max 64 commands; duplicate id or non-function handler throws. |
| `apg.onActivate` | `(handler) => void` | Runs after registration and before the first command. Must be synchronous. |
| `apg.onDeactivate` | `(handler) => void` | Runs when the worker is revoked, before disposal. Must be synchronous. |
| `apg.readScene` | `() => SceneSnapshot \| null` | Returns a bounded snapshot (at most 512 atoms, `truncated` when more exist) when the manifest has `scene.read`; otherwise `null`. Reads the worker Render IR delta path, or the main-thread fallback engine when OffscreenCanvas is unavailable. |
| `apg.readSharedState` | `() => SharedState \| null` | Returns `{revision, schemaVersion, value}` when the manifest has `storage.shared`; otherwise `null`. |
| `apg.readResource` | `() => Json \| null` | Returns the parsed command `resource` for a `system` plugin whose running command declares one; otherwise `null`. |
| `apg.writeSharedState` | `(value: Json) => void` | Queues a `storage.shared` effect. At most one per invocation. |
| `apg.preview` | `(text: string) => void` | Queues a `ui.preview` effect; the string is limited to 4096 characters. |
| `apg.mutate` | `(request: MutateRequest \| MutateRequest[]) => void` | Queues a `scene.write` effect: 1-8 native elements sharing one history group. A `shape.create` is a shape; `text.create` / `sticky.create` place a native caption or note (`box` normalised 0..1, text up to 200 characters). At most one mutation effect per invocation. |
| `apg.download` | `(file: {name, mime, text}) => void` | Queues a `ui.download` effect. `name` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `mime` is `application/json`, `text/plain` or `text/csv`; `text` is at most 64 KiB. |

Handlers are **synchronous**. Returning a Promise throws
`Async guest handlers are not supported in API 1`. Long or blocking code is stopped by the
execution deadline and counted as a failed invocation.

## Data model

Only JSON values are exchanged. The declaration in `packages/plugin-sdk/index.d.ts`:

```ts
type Shape = "rectangle" | "rounded-rectangle" | "ellipse" | "line" | "arrow";

interface ShapeRequest {
  kind: "shape.create";
  shape: Shape;
  start: { x: number; y: number };  // normalized 0..1, exact two keys
  end: { x: number; y: number };
  color: string;                    // #RRGGBB
  size: number;                     // 0.1..30
  opacity?: number;                 // 0..1
  fillColor?: string;               // #RRGGBB
}

interface SceneSnapshot {
  revision: number;
  truncated: boolean;
  items: Array<{
    elementId: string;
    primitive: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  }>;
}

interface SharedState { revision: number; value: Json }
```

`SceneSnapshot` is detached metadata only. The host caps it at **512 items** and sets
`truncated: true` when the render frame has more (`RoomView.vue`). Plugins must not assume
they see the whole room.

## Effect authorization

`authorizeApgEffects` (`apps/frontend/src/service/apgRuntime.ts:60`) is the capability
broker. It runs on the host before any effect is applied.

Preconditions for every effect: the worker's result is a JSON array of at most 16 objects,
each with exactly the keys `kind` and `value`.

| Effect | Required manifest permission | Required scope | Other checks |
| --- | --- | --- | --- |
| `ui.preview` | `ui.preview` | any | value is a string of at most 4096 chars |
| `ui.download` | `ui.download` | any | value is exactly `{name, mime, text}`: safe file name, allowlisted mime, inert text ≤ 64 KiB |
| `scene.write` | `scene.write` | `system` | `canEdit()` true; at most one such effect per invocation; value is a valid `ShapeRequest` |
| `storage.shared` | `storage.shared` | `system` | `canEdit()` true; at most one such effect per invocation; serialized value ≤ 16384 bytes |

Violations throw `APG capability denied`, and the whole invocation is discarded. A guest
that calls `apg.mutate()` without holding `scene.write` is not stopped inside the VM; it is
stopped here, before the host mutates anything.

`canEdit()` is false while the initial scene is still loading, while reconnecting, when
the page history is not ready, or when the signed-in user's role is `viewer`
(`apgCanEdit` in `apps/frontend/src/views/RoomView.vue`).

## Guest resource limits

| Limit | Value | Where enforced |
| --- | --- | --- |
| Program size (`main.js`) | 128 KiB | `createApgSandbox`, also `ReadPackageBundle` |
| Guest memory | 16 MiB | `runtime.setMemoryLimit` |
| Guest stack | 256 KiB | `runtime.setMaxStackSize` |
| Execution deadline | 150 ms, reset for activation, program evaluation and each invocation | `setInterruptHandler` |
| Invocation input | 512 KiB | `APG_MAX_INPUT` |
| Invocation result | 64 KiB | guest string check and host re-check (`APG_MAX_RESULT`) |
| Effects per invocation | 16 | guest bootstrap and authorization |
| Commands per plugin | 64 | guest bootstrap |
| Active plugin workers per page | 8 | `createApgRuntime` |
| RPC timeout | 1.5 s without program, 5 s with program | `createApgWorker` |

The 150 ms deadline is a wall-clock check performed when QuickJS reaches an interrupt
check; it bounds normal runaway loops but is not a hard real-time guarantee for every
possible guest program. There is no CPU accounting or per-plugin quota beyond this.

## Native scene compilation

`compileApgSceneMutations` (`apps/frontend/src/service/apgSceneCompiler.ts`) converts 1..8
`ShapeRequest`s into partial `Command`s. `compileApgSceneMutation` is the single-shape
wrapper and rejects arrays. The compiler deliberately accepts narrow shapes and supplies
everything else itself:

- Supported `shape` values: `rectangle`, `rounded-rectangle`, `ellipse`, `line`, `arrow`.
- `start` and `end` must be objects with exactly `x` and `y`, both finite and in `0..1`.
- `color` and `fillColor` must match `#RRGGBB` (the runtime accepts either case; the
  compiler normalizes nothing).
- `size` must be in `0.1..30`, `opacity` in `0..1`.
- Unknown keys, `kind` other than `shape.create`, non-finite numbers, and a degenerate
  box (`< 0.001` in both axes) are rejected (`APG invalid native shape`, `APG empty shape`).
- The host allocates every element id and Lamport value; the guest cannot choose identity,
  clock, layer, history group or asset references.
- A bundle (max `MAX_APG_SHAPE_BUNDLE = 8`) gets **one** host-generated `historyGroupId`, so
  a single undo removes the whole template. Bundles longer than 8, or a mixed valid/invalid
  bundle, are rejected before anything is committed (`APG invalid native shape bundle`).
- The result is a `SceneOperationEnvelopeV2` with `kind: "element.create"`, complete
  payload, `elementKind: "shape"`, `recipeId: "shape"`, `toolId`/`shapeKind` equal to the
  requested shape, normalized start/end, a computed box, and style
  `{color, size, strokePattern: "solid", opacity?, fillColor?}`.
- `validateSceneOperation` from the shared package must accept it, otherwise
  `APG native operation rejected`.

Each returned command has `type: "scene-op"`, a fresh timestamp, `isDeleted: false`, the
room/page/actor from the host context, and the scene operation attached. They enter the
normal command pipeline (`pushCommand`) one by one, so peers, persistence and late joiners
treat them as ordinary drawings. The bundle is **not** a server-side transaction: if the
second `pushCommand` fails locally, the first operation stays; undo still removes the
applied subset because they share a history group.

## Shared state and revisions

Shared state is one JSON value per `(room, pluginId)`, stored in SQLite
(`apg_room_state`). Reads return `{revision: 0, value: null}` when the row is absent.

Read path:

1. The runtime calls `host.readSharedState(plugin)` only if the manifest has
   `storage.shared`.
2. The host issues `GET /api/apg/state/{pluginId}?digest=...` with the session token.
   The server requires `system` scope, `storage.shared`, and a catalog entry whose id and
   digest match.
3. The guest receives `{revision, schemaVersion, value}` through `apg.readSharedState()`.

Write path:

1. The guest calls `apg.writeSharedState(value)`, which yields one `storage.shared` effect.
2. The host issues `PUT /api/apg/state/{pluginId}?digest=...` with
   `{revision: <the revision read at step 1>, value}`.
3. The server atomically checks role, revision and value limits in one SQL statement
   (`WriteAPGStateAuthorized`, `apps/backend/internal/storage/apg_state.go:57`).
4. On success the server returns `{revision: expected + 1, value}` and broadcasts an
   `apg.state.changed` invalidation hint to the room. The client accepts the write only if
   the acknowledged revision is exactly `expected + 1`.
5. On conflict (`409`) or any other failure the command fails; the worker is disposed and
   the preview is cleared. There is no automatic retry, so concurrent increments are
   safe but not queued: a losing `increment` must be re-run by the user.

The value must be valid JSON and at most 16384 bytes; revision must be a non-negative
safe integer below 2^53-1. State survives plugin disable, update, rollback and uninstall;
only deleting the room removes it (foreign key cascade).

## Errors

Guest-visible errors are uncaught JS exceptions inside the VM. Host-visible failures are
generic, deliberately small strings:

| Surface | Message |
| --- | --- |
| VM failure or deadline | `APG guest execution failed or exceeded its resource budget` |
| Program > 128 KiB | `APG program too large` |
| Input > 512 KiB | `APG input too large` |
| Result > 64 KiB | `APG result too large` |
| Too many effects / wrong phase | `APG effect limit or invalid phase` |
| Async handler | `Async guest handlers are not supported in API 1` |
| Unregistered command id | `Command not registered` |
| Denied capability | `APG capability denied` |
| Missing resource | `APG resource unavailable` |
| Revoked context | `APG context revoked` / `APG invalid activation or revoked context` |
| Worker failure | `APG sandbox execution failed` / `APG invalid RPC response` |
| Command not runnable | `APG command unavailable` |
| Scene rejection | `APG invalid native shape`, `APG empty shape`, `APG native operation rejected` |

The room UI logs `[APG] Command failed` and shows
`APG 插件执行失败或权限已撤销`; the detail is intentionally not shown to the user.

## Minimal plugin

The template in `plugins/template` is the smallest executable plugin:

```json
{
  "manifestVersion": 2,
  "apiVersion": 1,
  "id": "example.hello",
  "name": "Hello APG",
  "version": "1.0.0",
  "scope": "user",
  "main": "main.js",
  "permissions": ["ui.preview"],
  "contributes": { "commands": [{ "id": "hello", "label": "Hello" }] }
}
```

```js
/// <reference path="../../../../packages/plugin-sdk/index.d.ts" />
// @ts-check
apg.registerCommand("hello", () => apg.preview("Hello Aevia!"));
```

Because the scope is `user`, the plugin has no scene or shared-state access, can be
toggled off by each user, and cannot ship brushes. See `docs/apg/development.md` for the
full pack → sign → install → enable cycle.

## Mock host (development only)

`@aevia/plugin-sdk/mock` runs a `main.js` in Node with the same `apg` surface the QuickJS
guest receives, so a plugin can be tested without a browser, a worker, or a signed package:

```js
import { createApgMockHost } from "@aevia/plugin-sdk/mock";

const host = createApgMockHost({ sharedState: { revision: 0, value: 0 } });
host.load(readFileSync("plugins/official/shared-counter/main.js", "utf8"));
host.runCommand("increment");       // -> { preview: "Counter: 1", writes: [1], mutations: [] }
host.sharedState;                   // -> { revision: 1, value: 1 }
```

`runCommand` throws for an unknown command, resets the per-call `previews` / `writes` /
`mutations` buffers, and records `mutate` requests without validating geometry (the real
compiler does that). Re-registering a command id throws, mirroring the real dispatcher.

This is **not** a sandbox: it has no memory, stack, deadline or message limits, and the
product never runs it. Isolation claims must be backed by `apgSandbox.unit.spec.ts`, not by
this mock. The mock is exercised against the three executable official plugins in
`packages/plugin-sdk/mock/index.spec.ts`.
