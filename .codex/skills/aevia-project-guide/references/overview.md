# Overview

## Mental Model

Aevia is a monorepo for a real-time collaborative whiteboard. The frontend is the editor engine; `apps/go-backend` is the authoritative server (global `roomSeq`, sorted point index, chunked snapshots, page windows, backpressure, SQLite persistence); `packages/shared` holds cross-package protocol/types. `apps/backend` is the superseded Express implementation.

Critical axes:

- command-stream drawing model
- Lamport ordering
- page-window hydration
- binary WebSocket hot paths
- chunked init/page-change render streams
- dirty-rect rendering through worker or fallback paths

## Repo Layout

```text
apps/frontend       Vue 3 + TypeScript + Vite whiteboard client
apps/go-backend     Go server (primary): gateway, room actors, protocol, storage
apps/backend        Legacy Express + ws + SQLite server, runtime JavaScript
packages/shared     shared TypeScript types/protocol helpers plus committed CJS bridge files
tests               root report aggregation and generated report outputs
scripts/dev-go.mjs  root concurrent dev launcher (Go backend + frontend)
scripts/dev.mjs     legacy launcher (Express backend + frontend)
scripts/go.mjs      go build/vet/test/start wrapper used by npm scripts
.codex/AGENTS.md    lightweight agent entry point
.codex/skills/aevia-project-guide project knowledge skill
```

## Root Scripts

From root `package.json`:

```text
npm run dev             start Go backend + frontend through scripts/dev-go.mjs
npm run dev:legacy      start legacy Express backend + frontend
npm run dev:frontend    start frontend workspace dev server
npm run dev:backend     start the Go backend alone
npm run build           compile Go backend, then frontend build
npm run build:frontend  frontend typecheck/build
npm run build:backend   go build ./... in apps/go-backend
npm run test:go         go test ./... in apps/go-backend
npm run test:go:vet     go vet ./... in apps/go-backend
npm run test:unit       Vitest unit projects -> tests/reports/vitest/unit.json
npm run test:integration Vitest integration/module projects
npm run test:browser    Vitest browser project
npm run test:bench      Vitest micro bench project
npm run test:e2e:smoke  frontend external correctness-smoke suite
npm run test:benchmark  frontend external performance-external suite
npm run test:report     aggregate reports
```

Use the smallest relevant command. Do not assume `npm run test` is cheap; it chains build, Vitest, E2E smoke, benchmark, and report aggregation.

## Environment Defaults

Frontend defaults:

- API: `http://127.0.0.1:4646`
- WS: `ws://127.0.0.1:4646/ws`

External E2E defaults:

- `VITE_FRONTEND_URL=http://localhost:5173`
- `VITE_API_URL=http://localhost:4646`
- `VITE_WS_URL=ws://localhost:4646/ws`

Go backend defaults from `apps/go-backend/internal/config/config.go` (the legacy Express defaults in `apps/backend/src/config/index.js` are similar):

- `PORT=4646`
- `HOST=0.0.0.0`
- `DEFAULT_ROOM_ID=123123`
- `DB_PATH=<repo>/data/whiteboard-go.sqlite` (legacy Express backend uses `data/whiteboard.sqlite`)
- `INIT_PRELOAD_PAGE_COUNT=2`
- `PAGE_CACHE_RADIUS=1`
- `INIT_COMMAND_CHUNK_SIZE=100`
- `INIT_FLAT_POINT_CHUNK_SIZE=2000`
- `PAGE_CHANGE_DEBOUNCE_MS=80`

## Footguns

- Only the backend workspace's `dev:reset` deletes the dev SQLite DB files; plain `dev`/`start` do not. There is no `predev` hook.
- The primary backend is Go; the legacy backend is JavaScript; frontend/shared are TypeScript.
- The Go backend and legacy backend use different database files, so room data is not shared between them.
- Root `build` compiles the Go backend and typechecks the frontend; `test:ci` also runs `go vet` and `go test`.
- Shared CJS files are committed compatibility files. Keep them aligned when changing shared protocol behavior.
- `apps/frontend/tests/e2e/README.md` says that directory is AI-generated and test-only.
