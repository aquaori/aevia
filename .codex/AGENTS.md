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

## 开发分支与提交门禁

本节在 `AGENTS.md`、`.codex/AGENTS.md`、`.agents/rules/agents.md` 三处保持完全一致；详细说明见 `docs/git-workflow.md`。

- **开工前**：先 `git status --short` 检查暂存区、工作区与未跟踪文件。有未提交改动时先向用户说明并征求处理方式；未经同意不得提交、推送、丢弃、覆盖或 stash 这些改动。
- **分支划分**：一条分支对应一个需求，而不是一个周期或一个阶段。线性需求（后续周期依赖前一周期）只在一条分支上推进，周期与阶段用提交表达；相互独立的需求各自开分支以便并行。已有任务的后续修复继续在原开发分支上进行。
- **起分支**：确认工作区干净后切回 `main`，从 `origin/main` 快进拉取，再从更新后的 `main` 建分支；无法安全切换或快进时说明原因并询问用户，不做强制覆盖。
- **命名**：使用 `feat/`、`bugfix/`、`perf/`、`chore/`、`docs/` 前缀；不使用 `codex/` 等不符合约定的前缀。禁止直接推送受保护的 `main`，禁止强制推送或改写他人历史。
- **合并方法**：`perf/*` 与跨多周期的 `feat/*` 用 Rebase and merge（保留提交粒度，便于 bisect）；`bugfix/*`、`docs/*`、`chore/*` 以及整理过的小改动用 Squash and merge；不使用 Create a merge commit。
- **合并后**：rebase 与 squash 都会在 `main` 上生成新 SHA，整条分支合完后执行 `git fetch origin` 与 `git reset --hard origin/main` 再继续下一周期，避免下个 PR 重复展示已合并内容；只合一部分时从需求分支切出 `feat/<需求>-cycle1` 之类的短分支，合完删除，需求分支保持不动。
- **周期标签**：每轮合并后在 `main` 上打 `req/<需求>/c<N>` 注释标签并推送，分支删除后仍可据此定位改动与执行 bisect。
- **分支寿命**：活跃（30 天内有提交）正常使用，可跨多个 PR；≥30 天无提交且未合并的沉寂分支只做标记，由用户决定去留；已合并或已与 `main` 同步的分支打标签后删除。不要开启 GitHub 的 "Automatically delete head branches"。
- **查看状态**：`npm run branch:status`（可加 `--merged`、`--stale`、`--json`）列出最后提交时间、相对 `origin/main` 的领先/落后、本地与远端是否一致、是否已合并（含 squash 合并）、worktree 占用与状态；该脚本只读。
- **提交信息**：遵循 `commitlint.config.cjs` 的 Conventional Commits：`type(scope): subject`，`scope` 可省略，首行 ≤100 字符；type 限 `feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`ci`、`chore`、`revert`；`bugfix/` 分支的提交 type 用 `fix`。
- **提交前门禁**：先审完整 diff，再完成与仓库工作流对应的本地检查：
  - 快速工作流 `.github/workflows/quick.yml`：对相对 `main` 的本分支改动与未提交改动运行 ESLint，检查改动 Go 文件的 `gofmt`，运行 `npm run lab:inventory:check` 与 `npx tsx scripts/ci-check-obligations.mjs --base=origin/main --head=HEAD`，并按需执行 `npm run test:quick:suite`、`npm run build:frontend`、`npm run test:go`、`npm run test:go:vet`。`scripts/ci-changed.mjs` 只比较已提交的 `HEAD`，不能证明未提交修改已被检查。
  - 正确性工作流 `.github/workflows/ci.yml`：运行 `npm run test:doctor` 与 `npm run test:ci`，检查该次运行自己的 manifest 与报告。本机缺少 Linux、其他浏览器等环境时，如实说明与托管 CI 的覆盖差异，不把本机通过说成线上已通过。
  - 测试、共享 fixture 或跨语言协议数据变化时用 `go test -count=1` 避免缓存掩盖失败，并核对协议两端的校验与测试假设。
- **不得作弊**：所有必需检查通过后再提交；不得为了通过而降低断言、忽略失败、复用旧报告或擅自跳过 hooks。用户明确要求跳过某项检查时记录未验证范围。针对问题先做最小验证，完整门禁在最终代码上跑一次，代码再变只重跑受影响检查。
- **PR**：默认由用户自己创建；只有明确授权时才创建，标题同样遵循 commitlint，目标分支为 `main`。推送后查看对应提交的线上检查结果，失败时读取完整日志与产物定位根因，不凭日志末尾猜测，也不把本机结果冒充线上结果。
- **GitHub 规则**：`main` 的 Ruleset 关闭 Merge commit（只留 Squash 与 Rebase）、保持 Block force pushes 与 Restrict deletions、关闭 "Require branches to be up to date before merging"、不要开启 "Automatically delete head branches"。

## Working Style

- Make surgical changes that trace directly to the user request.
- Prefer the smallest relevant reference and source files before broad repo searches.
- Do not add speculative abstractions or cleanup unrelated code.
- Match existing package and file style.
- If durable project knowledge changes, update the matching `aevia-project-guide` reference instead of expanding this file.

## Safety Notes

- `apps/backend` is a Go server and the only backend; root `dev`/`start`/`build:backend` run it.
- The backend is Go; frontend and shared are TypeScript.
- Root `build` compiles the Go backend and typechecks the frontend; `test:ci` also runs `go vet` and `go test`.
- Root tests are benchmark-heavy; choose the smallest task-shaped verification command.
