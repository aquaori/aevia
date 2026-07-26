# Collaborative Whiteboard / Aevia - Codex Entry Guide

This file is intentionally small. Do not turn it into a project implementation manual.

## Load Project Knowledge On Demand

Use the local skill `.codex/skills/aevia-project-guide` when a task needs project-specific implementation details, file maps, coupling rules, or verification commands.

Prefer targeted loading:

- Benchmark, E2E, report, baseline, or test harness work: read `aevia-project-guide/references/testing-benchmarks.md`.
- Frontend whiteboard, canvas, rendering, command state, page UI, pointer, or Vue work: read `aevia-project-guide/references/frontend.md`.
- Backend HTTP, WebSocket, session, SQLite, init stream, or page-window work: read `aevia-project-guide/references/backend.md`.
- Shared types, command shape, binary transport, page normalization, or cross-file coupling: read `aevia-project-guide/references/protocol.md`.
- Repository scripts, package layout, environment defaults, or high-level mental model: read `aevia-project-guide/references/overview.md`.
- Updating the project skill itself: read `aevia-project-guide/references/update-skill.md`.

For a quick topic map, run from repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .codex\skills\aevia-project-guide\scripts\context.ps1 -Topic benchmark
```

## Working Style

- Make surgical changes that trace directly to the user request.
- Prefer the smallest relevant reference and source files before broad repo searches.
- Do not add speculative abstractions or cleanup unrelated code.
- Match existing package and file style.
- If durable project knowledge changes, update the matching `aevia-project-guide` reference instead of expanding this file.

## Safety Notes

- Backend `dev` resets the local SQLite DB through `apps/backend/src/scripts/resetDevDb.js`.
- Backend code is runtime JavaScript; frontend/shared are TypeScript.
- Root `build` mainly validates frontend; backend build is currently a placeholder.
- Root tests are benchmark-heavy; choose the smallest task-shaped verification command.
