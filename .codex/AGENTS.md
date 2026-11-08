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

## 开发分支与提交前门禁

- 每次开始新的开发需求，先用 `git status --short` 检查暂存区、工作区和未跟踪文件。若有未提交改动，先向用户说明并征求处理方式；只有用户同意，才提交或推送这些改动。不得擅自丢弃、覆盖、暂存或混入本次任务。
- 确认工作区干净后，切回 `main`，从 `origin/main` 快进拉取最新代码，再从更新后的 `main` 创建新的开发分支。如果无法安全切换或快进，先说明原因并询问用户，不要强制覆盖。已有任务的后续修复按用户指定的开发分支继续。
- 分支名使用有实际意义的前缀，如 `feat/`、`bugfix/`、`perf/`、`chore/`、`docs/`；不要使用 `codex/` 等不符合本项目约定的前缀。禁止直接推送受保护的 `main`，也不要强制推送或改写他人历史。
- 提交遵循 `commitlint.config.cjs` 的 Conventional Commits：`type(scope): subject`，`scope` 可省略，首行最多 100 字符。允许的 type 为 `feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`ci`、`chore`、`revert`；例如 `fix: handle incomplete init streams`。注意分支前缀 `bugfix/` 对应的提交 type 是 `fix`。
- 开发结束后先检查完整 diff，再在**提交前**完成与当前仓库工作流对应的本地检查：
  - 快速检查工作流当前是 `.github/workflows/quick.yml`（不是 `check.yml`）：对所有本分支相对 `main` 和当前未提交的新增或修改文件运行 ESLint，并检查改动 Go 文件的 `gofmt`；按工作流执行 `npm run test:quick:suite`、`npm run build:frontend`、`npm run test:go` 和 `npm run test:go:vet` 中适用的步骤。`scripts/ci-changed.mjs` 只比较已提交的 `HEAD`，不能单独证明尚未提交的修改已检查。
  - 正确性工作流是 `.github/workflows/ci.yml`：运行 `npm run test:doctor` 和 `npm run test:ci`，检查该次运行自己的 manifest 和报告，确保步骤通过且没有证据缺项。前端、后端及共享协议的变更均按此验证；需要 Linux、其他浏览器或操作系统的专属环境时，明确说明本机与托管 CI 的覆盖差异，不把本地通过说成线上已通过。
  - 测试、共享 fixture 或跨语言协议数据有变化时，避免 Go 测试缓存掩盖失败；在 `apps/backend` 下针对受影响包使用 `go test -count=1`。核对相关两端的校验和测试假设，不只检查一端。
- 所有必需检查通过后再提交；不得为了通过而降低断言、忽略失败、复用旧报告或擅自跳过 hooks。若用户明确要求停止或跳过某项检查，记录未验证范围；否则环境不可用或检查失败时，应先解决或如实报告，不能声称门禁通过。为避免无意义的重复，针对问题先做最小验证，完整门禁在最终代码上运行一次；代码再次改变时只重跑受影响检查。
- 默认由用户自行创建 PR。只有用户明确授权时才创建 PR；届时 PR 标题同样遵循 commitlint，确认目标分支是 `main`。推送开发分支后查看对应提交的线上检查结果，发现失败时读取完整日志与该次产物定位根因，不凭日志末尾猜测，也不把本机结果冒充线上结果。

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
