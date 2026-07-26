# Legacy Backend Guide (Express)

> **This is the legacy backend.** `apps/go-backend` is the primary one — see
> `go-backend.md`. Root `dev`/`start`/`build:backend` run the Go backend; this one
> is reachable via `dev:legacy` / `start:legacy` and is kept for the existing HTTP
> integration tests.
>
> It does not implement `roomSeq`, delta replay, server pressure, or
> `resync.required`, so the current frontend silently loses those capabilities when
> pointed at it.

Read this for the legacy Express APIs, WebSocket validation/fan-out, room sessions, SQLite persistence, init streams, page-change streams, and backend configuration.

## Entry Points

- `apps/backend/src/index.js`: HTTP server, WebSocket server, upgrade validation, init stream delivery, online count, close handling.
- `apps/backend/src/app.js`: Express app and route registration.
- `apps/backend/src/config/index.js`: runtime defaults and tunables.

The backend is runtime JavaScript, not TypeScript.

## HTTP Layer

- `controllers/roomController.js`: room creation, room existence, join, share token, page overview.
- `middleware/sessionAuth.js`: bearer token middleware for protected routes.
- `services/authService.js`: JWT sign/verify helpers.
- `services/passwordService.js`: room password hashing/verification.

Routes registered by `app.js`:

```text
POST /create-room
GET  /check-room
GET  /generate-room-id
POST /join-room
GET  /generate-share-token
GET  /get-page-review
GET  /get-token-info
POST /renew-room-session
```

## WebSocket Layer

- `websocket/messageHandler.js`: central command router, validation, persistence, fan-out.
- `websocket/realtimeBinary.js`: backend binary encode/decode for `mouseMove` and `cmd-update`.
- `websocket/renderChunkBinary.js`: compact init/page-change flat-point render chunks.

Upgrade validation in `index.js` checks:

- path is `/ws`
- token comes from `Sec-WebSocket-Protocol`
- JWT verifies
- room exists
- token room creation timestamp matches current room
- token is not older than server start freshness rules

## Persistence and Room Service

- `services/sqliteService.js`: creates SQLite schema.
- `services/roomService.js`: most important backend file for rooms, commands, page windows, flat-point queues, chunk creation, snapshot versioning, and page review.

Main tables:

- `rooms`
- `commands`

`roomFlatQueues` are in-memory derived render streams sorted by Lamport, command ID, and point index. They power current-page render snapshots and snapshot versioning.

## Init and Page-Change Streams

The server streams initialization rather than dumping one large payload. The sequence is conceptually:

```text
init-meta
init-render-meta
init-render-chunk-meta + binary render chunk(s)
init-render-done
init-commands-meta
init-commands-chunk(s)
init-commands-done
init-complete
```

For page changes, inspect `roomService.js`, `messageHandler.js`, frontend `roomPageService.ts`, `collabCommandHandlers.ts`, and `commandStore.ts` together.

## Dangerous Command

The backend workspace's `dev:reset` script deletes the dev SQLite DB files before starting:

- `${DB_PATH}`
- `${DB_PATH}-wal`
- `${DB_PATH}-shm`

Only `dev:reset` does this. Plain `dev` and `start` leave the database alone — there is no `predev` hook (an earlier version of this guide claimed there was).

## Verification

Backend build is a placeholder, so choose task-shaped checks:

```powershell
cmd /c npm run test:unit
cmd /c npm run test:integration
```

For HTTP/WS behavior, run the app only after considering DB reset side effects. Prefer a focused external smoke when services are already running:

```powershell
cmd /c npm run test:e2e:smoke
```
