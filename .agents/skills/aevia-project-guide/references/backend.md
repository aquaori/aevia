# Backend Guide

`apps/backend` is the backend: a Go server. Root `dev`, `start` and
`build:backend` all run it. The Express implementation that used to live here was
removed once the Go server reached full parity; see git history if you need it.

Read this for room actors, sequencing, backpressure, delta replay, binary
protocol, SQLite persistence, or gateway/auth behaviour.

## Layout

```text
cmd/aevia-backend/main.go      process wiring, graceful shutdown, pprof
internal/config                environment parsing and validation
internal/gateway               HTTP handlers, WS upgrade, limits, CORS
internal/room                  per-room actor, state, snapshots, pressure
internal/protocol              binary realtime frames and render chunks
internal/storage               SQLite schema, batched writer, WAL maintenance
internal/domain                Command/Point types and ordering
internal/console               startup panel and log handler
```

## Concurrency Model

One `room.Actor` goroutine owns all mutable state for a room. Everything reaches
it through channels:

- `inbox` — reliable messages (commands, joins, page changes). Full inbox returns
  `ErrActorBusy`, surfaced to the client as `op-rejected SERVER_BUSY`.
- `realtime` — droppable messages (`mouseMove`, `mouseLeave`, `box-selection`).
  When full, the newest event per `clientID:type` is merged instead of queued.
- `writeFailures` — asynchronous persistence failures, which flip the room to
  read-only.

Actor lifecycle rules that matter:

- An actor evicts itself after `actorIdleTimeout` (10 min) with no clients and no
  queued work.
- `NewActor` takes a `release` callback. It runs from the actor goroutine before
  `done` closes, so the registry drops its reference before any caller can see a
  stopped actor.
- `Join`, `Snapshot` and `PageReview` select on `done` and return
  `ErrActorStopped` rather than blocking. `Registry.Get` replaces a stopped actor.
- Never add a request/reply method that waits only on its reply channel; it will
  hang forever if the actor exits first.

## Sequencing and Durability

- `state.RoomSeq` is the room's authoritative counter, allocated in `persist*`
  and stamped on the command plus `rooms.durable_seq`.
- `mutationOptions.Barrier` selects durability: `true` blocks the actor until the
  transaction commits, `false` batches. Non-barrier failures arrive later via
  `Store.SetAsyncFailureHandler` → `Actor.NotifyWriteFailure` → read-only plus a
  `resync.required` broadcast.
- The writer performs group commit: a waited write drains everything already
  queued into its own transaction, so barrier writes still amortise.
- `enqueue` is bounded (`enqueueTimeout`); a stalled disk fails the write rather
  than freezing the room.

## Delta Replay

`DeltaBuffer` retains recent events per room (TTL plus byte cap). A client
reconnecting with `?lastRoomSeq=N` resumes from `N` instead of re-downloading the
page; `handleJoin` falls back to a full init when the buffer cannot cover the gap.
The client sends `lastRoomSeq` by default (`VITE_ENABLE_DELTA_REPLAY=0` disables).

Replay emits `delta-replay-meta`, then the original event envelopes, then
`delta-replay-complete`. The client treats `delta-replay-meta` as its
connection-established signal, so any new resume path must keep sending it.

Join distinguishes current, contiguous retained delta, and snapshot recovery against the authoritative room sequence. `handleJoin` enqueues the resume stream while the actor owns room ordering. Stream enqueue failure aborts the connection independently of the outbound queue; never send a success terminal after a failed frame. Duplicate immutable writes are acknowledged only when the trusted user and operation match and the original durable sequence is available. Scene writes use barrier persistence, so their `ack.accepted` follows commit; a read-only rejection carries the command ID so the client can discard the rejected local write.

## Limits and Trust

- Payload limits apply to JSON and binary inputs. Legacy realtime frames use `validateIncomingBinary`; negotiated V2 append frames are decoded by `internal/protocol/scene_append.go` and enter the normal JSON validation, rate-limit and actor path. Legacy `cmd-update` remains a rejected V1 write, not the V2 drawing path.
- `clientIPResolver` ignores `X-Forwarded-For` unless `TRUST_PROXY_HEADERS=1`, and
  honours `TRUSTED_PROXIES` as the trust boundary. Per-IP limits are meaningless
  without this.
- `keyedBuckets` evicts idle keys and caps its key count; unbounded limiter maps
  are a memory-exhaustion vector.
- `/join-room` is gated on a per-IP failure budget: only a wrong password spends
  a token (`notePasswordFailure`), so a shared NAT address cannot lock out honest
  users while guessing is still cut off.
- `/debug/metrics` requires `METRICS_TOKEN`, or a loopback caller.
- `JWT_SECRET` is mandatory when `APP_ENV`/`NODE_ENV` is production; `config.Load`
  returns an error rather than falling back to `DevJWTSecret`.

`internal/gateway/scene_validation.go` is the V2 write boundary. It validates the root schema, trusted identity, envelope equality, operation kind, recipe, matrix, box, points, erasure intervals, text patches, and clear order key before the room actor persists anything. Unsupported versions return `UPGRADE_REQUIRED`; unsupported recipes return `UNSUPPORTED_RECIPE`. Keep geometry, text layout, hit testing, and clipping out of Go—the backend only validates, sequences, persists, and broadcasts explicit operation results.

`PagePointIndex` indexes legacy paths and V2 path create/append samples via `domain.ScenePathFragmentFromCommand`. During startup it first collects create metadata, then indexes fragments; for live out-of-order `element.append` arrivals before `element.create`, it queues bounded pending fragments per element and projects them once `element.create` lands, while `State.CausalDiagnostics()` / `Actor.CausalDiagnostics()` report pending path/text orphans without breaking reconnect ordering. V2 command chunks remain necessary for transforms, erasures, history and other semantics. Do not duplicate client scene geometry or spatial indexing in Go.

`State.ClearBefore` is the effective per-page clear watermark. Both materialized snapshots and `SendLiveInitStream`'s direct index stream must apply it to render points and command chunks: keep the effective `page.clear` marker and operations after it, but never return commands or points before it. When `history.toggle` disables that clear group, the watermark disappears and a forced current-page reload may return the restored history again. Filtering only render points is insufficient because a client could otherwise replay pre-clear V2 commands during init or resync.

Path appends after a clear must also be filtered when their path was created before the clear: the hidden create is absent from the snapshot and those appends would otherwise remain unresolved. Apply the same rule when counting and streaming commands; undoing the clear restores the history.

S05 account sessions and room sessions are distinct: `storage/accounts.go` stores hashed account-session tokens, while `auth.Claims` identifies the account or guest in a room. `gateway/account_handlers.go`, `account_room_handlers.go`, `room_management.go`, `transfer_handlers.go`, and `invite_handlers.go` own account, membership, transfer and invitation HTTP flows; `storage/membership.go` and `transfers.go` persist their state. Room and guest roles are checked on the WebSocket write path, and account membership changes notify online clients. Keep stable account IDs for history ownership and same-room device replacement. `history.toggle` is authorized against the original author's history group in the room actor.

Room HTTP session middleware checks the current room instance and live account/guest membership, including revocation. The actor rechecks access when admitting a network join because a previously authorized request can wait in the actor queue. Permission notifications use a separate priority queue so saturation of the normal reliable inbox cannot silently lose a kick, ban or role update. The room's history-group ownership index rejects new cross-user group collisions and refuses toggles of existing mixed-owner groups; it is rebuilt from stored commands and updated on replacement or removal.

Network clients obtain a room grant from `/v2/rooms/{roomId}/admission`, then exchange it for a 30-second single-use `/ws-ticket` before each WebSocket connection. Ticket consumption is stored in SQLite and room membership is rechecked at connection. Account refresh rotates the persistent account token; it is distinct from room grant renewal. Member and guest management changes are recorded transactionally in `room_member_audit` and available to the owner.

For network clients, the actor pins a SQLite WAL read view at its durable room sequence; a bounded snapshot executor builds initialization and page streams off the actor while subsequent events wait in a bounded per-client queue. Keep render metadata paired with its binary frame and abort slow clients rather than blocking the room. A saturated executor or failed read aborts that client; pinned read transactions must be closed before sending. This is not an independently benchmarked latency guarantee.

Initial joins pin the database sequence, then copy command references and clear watermarks while the actor owns its state; filtering and maximum Lamport calculation happen outside the actor. Stored commands must remain immutable: writes replace them with new snapshots, allowing initialization to rebuild its index without decoding the same records again. The detached initialization state uses the captured watermarks rather than rebuilding history ownership or clear state from a filtered subset. After client initialization, `load-page-history` streams the current page's pre-clear commands from another pinned view in small batches; these are not applied to the active scene while the clear remains enabled. Page-change snapshot construction still reads full history.

The initial join's `initDetached` builder reuses captured immutable commands; do not mutate them or use this builder on actor-owned mutable state. Other snapshot builders copy commands so later live mutations cannot change a stream. `SnapshotBuilder` also maintains a bounded LRU `initSnapshotCache` (`snapshot_cache.go`, keyed by room/page/totalPage/seq/preload/clear signature) so `Actor.handleJoin` can serve repeated joins without re-pinning SQLite or rebuilding chunks.

`chunkCommands` retains each command's JSON produced for the byte limit; initialization and page-change streams reuse it on the wire. Cached bytes live only for the snapshot/queued outbound messages. Preserve byte-identical JSON and the command-count/byte boundaries if changing this path.

Detached initial snapshots prepare and send render chunks first; their command chunks are encoded afterward. Consequently `init-meta.chunkSummary.totalCommandChunks` can be absent, and `init-commands-meta.totalChunks` carries the authoritative count. Do not emit `init-complete` before both streams finish; ordinary `Init` and page-change builders remain eager.

## Render Chunks

`protocol.EncodeRenderChunk` returns an error instead of silently narrowing the
per-chunk command index into its `uint16` field. `config.MaxRenderChunkPoints`
keeps `INIT_FLAT_POINT_CHUNK_SIZE` inside the indexable range, since a chunk can
never hold more distinct commands than points. Callers in `stream_send.go` attempt
`resync.required` and abort the stream on encode failure rather than shipping
mis-attributed points; the abort must work even if the outbound queue is full.

## Session Epoch

`storage.Store.SessionEpoch` persists the cutoff for stale session tokens in
`server_state`. It is deliberately *not* process start time: that logged every
user out on each deploy and made replicas reject each other's tokens. Use
`BumpSessionEpoch` to force global re-authentication.

## Verification

```powershell
cmd /c npm run test:go:vet
cmd /c npm run test:go
```

`internal/gateway/server_test.go` holds the HTTP contract tests (httptest
against `Server.Routes()`): room creation/join, password rejection, invite
tokens, protected-route auth, and the failure-only join throttle.

Both commands run from the repo root and wrap `go vet ./...` / `go test ./...` in
`apps/backend`. `npm run test:ci` includes them.
