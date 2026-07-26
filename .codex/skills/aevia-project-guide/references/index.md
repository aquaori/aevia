# Aevia Project Knowledge Index

This directory is the durable project manual for Codex. Keep it focused and split by task area so future sessions load only what they need.

## References

- `overview.md`: repo layout, mental model, package scripts, environment defaults, common footguns.
- `frontend.md`: Vue room composition, command state, rendering paths, canvas worker, page and pointer workflows.
- `backend.md`: legacy Express/WS server, room APIs, session validation, SQLite persistence, init/page-change streaming.
- `go-backend.md`: primary Go backend — room actors, sequencing/durability, delta replay, limits and trust, render chunks.
- `protocol.md`: shared command types, binary formats, cross-file coupling rules.
- `testing-benchmarks.md`: Vitest projects, external E2E harness, benchmark suites, reports, baselines, verification commands.
- `update-skill.md`: how to update this skill when the project changes.

## Update Rule

When code changes create new durable knowledge, update the smallest matching reference. If a new topic appears, add one new reference and list it here plus in `../SKILL.md`.
