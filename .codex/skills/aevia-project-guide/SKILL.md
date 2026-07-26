---
name: aevia-project-guide
description: Project-specific knowledge loader for the Aevia collaborative whiteboard repository. Use when working in this repo on frontend whiteboard behavior, backend room/WebSocket/session logic, shared protocol/types, tests, external E2E benchmarks, performance reports, or when updating project guidance itself. It helps Codex load only the relevant project manual, file map, coupling notes, and verification commands instead of reading broad repository context up front.
---

# Aevia Project Guide

Use this skill as the narrow entry point for project knowledge. Do not load every reference by default. Select the smallest relevant reference for the user's task, then inspect the listed source files directly.

## Quick Workflow

1. Classify the task topic.
2. Read the matching reference file below.
3. Use `scripts/context.ps1` when you want a concise topic-to-files map without loading a reference.
4. Inspect only the files named by the reference or script first.
5. Run the task-shaped verification command from the reference.
6. If you learn durable project knowledge, update the matching reference and `references/index.md`.

## Topic Map

- Project overview, architecture, repo shape, package commands: `references/overview.md`
- Frontend whiteboard behavior, rendering, command state, page switching, UI composition: `references/frontend.md`
- Backend (Go): HTTP/WS gateway, room actors, backpressure, delta replay, storage writer: `references/backend.md`
- Shared protocol/types and cross-file coupling: `references/protocol.md`
- Tests, external E2E harness, benchmark runner, reports, baselines: `references/testing-benchmarks.md`
- Updating or extending this skill as the project evolves: `references/update-skill.md`

## Lightweight Query Script

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .codex\skills\aevia-project-guide\scripts\context.ps1 -Topic benchmark
```

Supported topics:

```text
overview, frontend, backend, protocol, benchmark, tests, rendering, websocket, page, auth, skill
```

The script prints JSON containing reference files, source files to inspect first, useful search commands, and verification commands.

## Loading Rules

- Prefer `references/testing-benchmarks.md` for benchmark/test tasks before searching the repo.
- Prefer `references/frontend.md` for `RoomView`, canvas, rendering, command store, pointer, toolbar, page UI, or worker tasks.
- Prefer `references/backend.md` for room APIs, session tokens, WebSocket fan-out, SQLite, init/page-change streams, or backend config tasks.
- Prefer `references/protocol.md` before changing command shape, binary transport, page normalization, render chunk format, or shared types.
- Read `references/update-skill.md` before editing this skill.

## Project-Specific Cautions

- `apps/backend` is a Go server and the only backend; root `dev`/`start`/`build:backend` run it.
- The backend is Go; frontend and shared are TypeScript.
- Root `build` compiles the Go backend and typechecks the frontend; `test:ci` also runs `go vet` and `go test`.
- Root test scripts are task-specific and benchmark-heavy; choose the smallest relevant check.
- Keep AGENTS.md light. Put implementation details in this skill's references instead.
