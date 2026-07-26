# Overview

## Mental Model

Aevia is a monorepo for a real-time collaborative whiteboard. The frontend is the editor engine; `apps/backend` is a Go authoritative server (global `roomSeq`, sorted point index, chunked snapshots, page windows, backpressure, SQLite persistence); `packages/shared` holds cross-package protocol/types.

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
apps/backend        Go server: gateway, room actors, protocol, storage
packages/shared     shared TypeScript types and protocol helpers
tests               root report aggregation and generated report outputs
scripts/dev.mjs     root concurrent dev launcher (backend + frontend)
scripts/go.mjs      go build/vet/test/start wrapper used by npm scripts
.codex/AGENTS.md    lightweight agent entry point
.codex/skills/aevia-project-guide project knowledge skill
```

## Root Scripts

From root `package.json`:

```text
npm run dev             start backend + frontend through scripts/dev.mjs
npm run dev:frontend    start frontend workspace dev server
npm run dev:backend     start the backend alone
npm run build           compile the Go backend, then build the frontend
npm run build:frontend  frontend typecheck/build
npm run build:backend   go build ./... in apps/backend
npm run test:go         go test ./... in apps/backend
npm run test:go:vet     go vet ./... in apps/backend
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

Backend defaults from `apps/backend/internal/config/config.go`:

- `PORT=4646`
- `HOST=0.0.0.0`
- `DEFAULT_ROOM_ID=123123`
- `DB_PATH=<repo>/data/whiteboard-go.sqlite`
- `INIT_PRELOAD_PAGE_COUNT=2`
- `PAGE_CACHE_RADIUS=1`
- `INIT_COMMAND_CHUNK_SIZE=100`
- `INIT_FLAT_POINT_CHUNK_SIZE=2000`
- `PAGE_CHANGE_DEBOUNCE_MS=80`

## Footguns

- Root `build` compiles the Go backend and typechecks the frontend; `test:ci` also runs `go vet` and `go test`.
- `apps/frontend/tests/e2e/README.md` says that directory is AI-generated and test-only.
