# Aevia V5 扩展容量验证、文档收口与门禁验收报告 (2026-11-26)

## 1. 隔离边界容量评测 (`tests/run-system.ts` custom boundary, GPU on / CPU high / headless Chromium 147)

Run ID: `0ff1eb34-df60-4982-8ad3-3ecc5c41015b`（100k）及扩展档 `2026-11-25T21-31-54-079Z`（`100k / 250k / 500k`，报告位于 `apps/frontend/tests/e2e/external/reports/latest/2026-11-25T21-31-54-079Z/performance-external-boundary-external-results.json`）。

| 用例 | 实测规模 | 结果 | 关键观测指标 |
|---|---|---|---|
| `boundary-full-render-until-crash` | `100,000` / `250,000` / `500,000` 点 | `passed` (`lastSurvivedScale=500000`, `crashType=none`) | `100k`: `roomLoadMs=2236.68 ms`, `peakJsHeapMb=18.57 MB` (`postGc=15.46 MB`)<br>`250k`: `roomLoadMs=4097.28 ms`, `peakJsHeapMb=31.46 MB` (`postGc=25.25 MB`)<br>`500k`: `roomLoadMs=8435.85 ms`, `peakJsHeapMb=46.63 MB` (`postGc=41.64 MB`) |
| `boundary-same-page-heap-growth` | 3 轮同页累计 `300,000` 点 (`100k/round`) | `passed` (`crashType=none`) | `postGcHeapMb`: `15.46 -> 22.17 -> 28.83 MB`（`heapGrowthMb=+13.37 MB`），`peakJsHeapMb=31.99 MB` |
| `boundary-incremental-redraw-freeze` | `concurrency=5` | `passed` (`softFreeze=false`, `crashType=none`) | `dispatchMs=142.57 ms`, `firstScreenshotChangeMs=138.58 ms`, `peakJsHeapMb=11.88 MB` |

> 说明：100w/200w/500w 超大规模、Edge/Firefox/移动端真机及生产反向代理（COOP/COEP + TLS + 公网弱网）未在本次 Windows 本机 Chromium 147 环境中执行，属于受管 CI 或线下真机需独立补充验证的覆盖差异。

## 2. 项目文档与义务台账同步

- 已更新：
  - `.agents/skills/aevia-project-guide/references/backend.md`：补充 `PagePointIndex` 乱序待定分片队列、`CausalDiagnostics` 与 `initSnapshotCache` 说明。
  - `.agents/skills/aevia-project-guide/references/frontend.md`：补充 `PageHistoryCache`（跨刷新断点续传）、`WorkerTaskScheduler`、`SettledPrefixCache`、结构化 `renderIRItemsEqual` 与 session 状态机契约。
  - `docs/aevia-v3-stability-addendum.md` & `docs/aevia-roadmap-2026-11.md`（未改动 `docs/aevia-v3.md`）。
- 义务检查：
  - `npm run lab:inventory:check`：160 项模块义务全部合规（`covered` 159，`excluded` 1，`uncovered` 0）。
  - `npx tsx scripts/ci-check-obligations.mjs --base=origin/main --head=HEAD`：通过（新增未覆盖 0 项，历史测试债务 0 项）。

## 3. 最终全量门禁结果（最终代码修改后实测）

- **静态检查与构建**：
  - `ESLint`（全部变更及新增 TS 文件）：0 error, 0 warning。
  - `gofmt -l` / `gofmt -d`：新增/改动 Go 文件无格式偏差（仅 4 个 CRLF 检出文件在工作区与 LF 基准间存在换行符差异）。
  - `npm run build` (`build:backend` + `vue-tsc -b && vite build`)：通过（0 类型/编译错误）。
  - `npm run test:doctor`：Node `24.15.0`、Go `go1.26.5 windows/amd64`、Chromium `1217` 全部 `PASS`。
- **`npm run test:quick` (`Run 41b040eb-7b59-4fd6-a243-9fa1b93affe4`, `BypassSandbox: true`)**：
  - `Backend feature inventory`：passed (1.4s, 91 feature surfaces)
  - `Quick frontend and shared regression`：passed (15.4s)
  - `Source identity check`：passed (0.5s)
  - `validity`: `valid` (`0 evidence issue(s)`).
- **`npm run test:ci` (`Run 7d777312-7bdd-4846-ba7c-3ea44c3452fd`, `BypassSandbox: true`)**：
  - `Production build`：passed (`11035 ms`)
  - `Go static analysis` (`go vet ./...`)：passed (`733 ms`)
  - `Go package inventory`：passed (9/9 packages, `607 ms`)
  - `Go tests and coverage`：passed (9/9 packages, `6700 ms`, `3638/4591` lines covered)
  - `Frontend and shared coverage tests`：passed (`415/415`, `16499 ms`)
  - `Canvas blank oracle sensitivity`：passed (`3/3`, `2938 ms`)
  - `Browser component tests`：passed (`37/37` in Chromium, `11462 ms`)
  - `External correctness E2E`：passed (`5/5`: `harness-health`, `correctness-smoke`, `concurrent-crossing-visual-consistency`, `late-joiner-visual-consistency`, `protocol-multipage-isolation`; lab gate `valid`, `24004 ms`)
  - `Source identity check`：passed (`524 ms`)
  - `validity`: `valid`, `failures: []`, `0 evidence issue(s)`.

## 4. 环境覆盖边界说明

- 本机验证环境为 Windows (`win32 x64`, AMD Ryzen 9 5900HX, Chromium 147 headless, Go 1.26.5, Node 24.15.0)。其中 `apps/backend/internal/gateway` 网络监听测试与 Playwright Chromium 浏览器/外部 E2E 测试在 Windows 沙箱网络/进程策略下需 `BypassSandbox: true` 运行；Linux (`ubuntu-24.04`) 容器环境、Firefox/WebKit 浏览器矩阵及 100w+ 规模 nightly 任务尚未在此本地终端覆盖，应在推送至托管 CI 时进一步确认。
