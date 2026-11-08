# Aevia Lab Runner 测试门禁改造计划

## 0. 一句话方案

在**不搬动现有目录结构**的前提下，把 `tests/run-system.ts`（编排）+ 外部 E2E harness（采集）+ `tests/report/aggregate.ts`（fail-closed 聚合）扩成一套 **lab runner**：新增 `single / smoke / ci / nightly` 四种模式；引入**运行时埋点契约**（`performance.mark` + 现有 `EditorPlugin` 钩子 + 8 处显式埋点）与外部观测做**双源对拍**；新增**三级采集门禁**（case 无效立即报错 / 场景全无效中断整轮 / 无效轮次不记录基线）；升级受管 HTML 报告为**单页可视化 + 一键重跑**（配套本地 `lab-serve`）。原 6 个 vitest project 与 4 个 external suite 的**结构、目录、命令语义全部保留**。

**实施纪律（新增硬约束）**：全程只在新建的本地特性分支上提交，**不 push、不动远端、不改 main**。

------

## 1. 目标与验收标准

| #      | 可验收结果                                                   |
| ------ | ------------------------------------------------------------ |
| G1     | `npm run test:single -- --since=HEAD~1`、`test:smoke`、`test:ci`、`test:nightly` 四条命令可跑，写同一套 manifest/report，退出码语义统一 |
| G2     | 性能 case 同时产出 `external*` 与 `instrumented*` 两套指标，报告标注 `measurementSource`，偏差超容差即判该 case 无效 |
| G3     | 任一 case 采集无效 → 控制台红色 `[lab][invalid-case]` 并计入失败；某场景**全部** case 无效 → 立即中断、不写 baseline/history/latest 指针、退出码 3 |
| G4     | `tests/reports/summary/runs/<uuid>/test-report.html` 单页展示全部结果、埋点有效性、场景/case 明细、截图产物，并带「重跑整轮 / 该场景 / 该用例」按钮 |
| G5     | `npm run lab:serve` 可打开 run 索引、执行重跑并实时回显进度；纯 `file://` 打开时降级为只读（按钮禁用） |
| G6     | 新增模块级测试清单把「61 个前端源文件 / 3 个 Go 包无测试」变成机器可校验的债务清单，nightly 对**新增**未覆盖项失败 |
| G7     | 埋点契约可守护：`src/instrumentation/` 之外不出现裸 `performance.mark`，契约与名字表不一致时 `test:quick` 直接失败 |
| **G8** | **全部改动位于本地分支 `feat/lab-runner`；`git log --oneline main..HEAD` 有提交、分支工作区干净、`git remote -v` 与远端引用未变、从未执行 push** |

**非目标**：不重写 SceneEngine/渲染管线；不改后端数据模型与网络协议；不做静态代码插桩（Vite 插件改写源码）；不做 IM 机器人集成（只留 `perf-request.json` 钩子）；不在 GitHub 托管 runner 上跑性能门禁。

------

## 2. 现状事实（方案依据）

- **编排**：run-system.ts 1155 行，两套引擎并存：受管证据路径 `runEvidenceProfile`（:965）与 legacy 交互路径（standard/nightly/custom 走这里，不写 manifest、不聚合）。受管 profile 仅 `quick`（:759）/`ci`（:780）/`full`（:833），步骤集中在 `managedEvidencePlan`（:723）。服务由 `startExternalServices` 起隔离 Go 后端 + Vite，DB 在 `tests/.tmp/aevia-system-<pid>.sqlite`，端口自动分配，run 目录 `tests/reports/summary/runs/<uuid>`。
- **聚合**：aggregate.ts `buildAggregate`（:369）严格 fail-closed：步骤恰好一次且 passed、7 种 artifact kind 逐类校验、coverage 源文件集合必须完全相等、external 必须与 manifest 的 runId/revision/dirtySha 三项一致。现有 HTML 只有 25 行模板（:426），**无脚本、无内嵌数据**。
- **采集**：应用内部**零埋点**（全仓无 `performance.mark`）。首帧/视觉稳定靠 ui-driver.ts rAF 轮询 + canvas 读回（96px 缩采样、minNonBlankRatio 0.0015、stableFrames 2、maxDiffRatio 0.0001），rAF 量化 ≈16.7ms；远端/本地首像素靠 ROI 轮询（suites.ts :1120-1175）。
- **缺口**：CLI **无 case 级过滤**（config.ts 最小粒度 `--case-set`）；`CaseSample.qualityStatus` 已存在但**无效样本不改变 case 状态**，无法做门禁；baseline/history 仅在显式 flag 下写（runner.ts :146-153、:189-194）。
- **测试资产**：35 个测试文件；`feature-obligations.json` 76 条中 34 uncovered + 7 partial；CI 9 组合只跑 `test:doctor` + `test:ci`，**无 cron、不跑性能**。

------

## 3. 总体设计

```
                 ┌──────────────── tests/run-system.ts（编排器，扩展）────────────────┐
模式 single/smoke/ci/nightly ──► 步骤计划 ──► 服务隔离 ──► 步骤执行 ──► manifest v2
                 └───────┬────────────────────┬──────────────────┬─────────────────┘
                         │                    │                  │
            vitest / go test（结构不变）  external harness    lab gate（新增）
                         │                    │                  │
                         └──────────────► tests/report/aggregate.ts（fail-closed，扩展）
                                                │
                                   lab-report.json + test-report.html（重写）
                                                │
                                      scripts/lab-serve.mjs（新）──► 一键重跑 ──► run-system
```

新增目录（纯加法）：`apps/frontend/src/instrumentation/`、`apps/frontend/tests/e2e/external/lab/`、`tests/lab/`、`scripts/lab-serve.mjs`、`scripts/lab-inventory.mjs`。

------

## 4. 工作流 A：模式与编排（要求 4）

在 run-system.ts 受管 profile 联合类型（:38）加入 `single | smoke | nightly`，复用 `runEvidenceProfile`/`managedEvidencePlan`，**不改 legacy 路径**。

| 模式 | profile   | 步骤                                                         | 外部套件         | 性能                                              | 门禁                     | 记录                                      |
| ---- | --------- | ------------------------------------------------------------ | ---------------- | ------------------------------------------------- | ------------------------ | ----------------------------------------- |
| 单点 | `single`  | `--only`/`--since` 解析出的最小集合（vitest 单文件 / `go test -run` / external `--case-ids`） | 0~1 case         | 关                                                | 仅有效性                 | 仅报告，不写 baseline/history/latest      |
| 冒烟 | `smoke`   | catalog-check → 4 个 vitest project → correctness-smoke → source-check | smoke            | 关                                                | 全量有效性               | 报告 + latest                             |
| CI   | `ci`      | 保持现状 9 步（build/vet/list/go-test/vitest+coverage/browser/correctness-full/source-check）+ 新增 gate 步骤 | correctness-full | 可选 `--perf=request`（只产 `perf-request.json`） | 全量 + 证据 fail-closed  | 报告 + latest                             |
| 夜间 | `nightly` | ci 全部 + correctness-full 全 case + performance-external（4 环境矩阵 × all case-set）+ 清单回归 + go-race/fuzz | full + perf      | 开                                                | 全量 + 断路器 + 覆盖回归 | valid 且工作区干净时更新 baseline/history |

新增 CLI：`--only=<selector>`（可重复）、`--since=<git-ref>`、`--perf=off|request|on`、`--rerun-of=<runId>`、`--scope=run|scenario|case`、`--ids=a,b`。selector 解析（新增 `tests/lab/resolve-only.ts`）：`case:<id>` → external `--case-ids`；`file:<path>` → vitest 单文件；`test:<子串>` → `-t`；`go:<pkg>[#Test]` → `go test -run`；`since:<ref>` → `git diff --name-only <ref>...HEAD` 经 `module-obligations` 映射到 ownerTest/ownerExternal 并集（实现「我刚开发了什么」）。

`package.json` 新增：`test:smoke`、`test:nightly`、`test:single`、`lab:serve`、`lab:inventory`；`test:ci` 名称不变（仅多一道 gate）。新增 `.github/workflows/nightly.yml`：`cron "0 18 * * *"`（北京时间 02:00）+ `workflow_dispatch`，`runs-on: [self-hosted, aevia-nightly]`，上传 run 目录；现有 `ci.yml` 不动。

------

## 5. 工作流 B：采集口径改造（要求 2）

### B1. 运行时 API（新增 `apps/frontend/src/instrumentation/labMarks.ts`）

```
window.__AEVIA_LAB__ = { contractVersion: 1, enabled: boolean, marks: LabMark[], counters: Record<string, number>, dropped: number };
labEnabled() / labMark(name, detail?) / labCounter(name, delta?) / labSpanStart(name) / labSpanEnd(name)
// 启用时 performance.mark(`aevia.${name}`, {detail}) + 入环形缓冲（上限 4096，溢出计 dropped）；默认关闭，关闭时只做一次布尔检查
```

名字集中于 `labMarkNames.ts`（单一事实源），格式 `aevia.<domain>.<event>[.<phase>]`。

### B2. 插件化接入（优先不改业务代码）

新增 `labPlugin.ts`，实现项目已有的 `EditorPlugin` 接口，挂到 whiteboardSession.ts 事件总线，把现成钩子映射成 mark：`session:before-init`、`session:ready`、`collab:connected`、`page:changed`、`render:before/after`。仅 `labEnabled()` 时由 main.ts 注册。

### B3. 显式埋点（钩子覆盖不到的热点，共 8 处，均包在 `if (labEnabled())` 后）

| 文件                                   | 事件                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `service/roomCollabTransport.ts`       | `ws.open` / `ws.message.<type>` / `ws.send.<type>`           |
| `service/collabCommandHandlers.ts`     | `init.meta` / `init.first-chunk` / `init.render-complete` / `init.commands-complete` / `page.change` / `delta.meta` / `delta.complete` |
| `service/renderWorkerBridge.ts`        | `worker.ack.<msgType>`、接收 `lab:marks` 批次                |
| `workers/canvasWorker.ts`              | `worker.first-paint` / `worker.render-complete`（批次回传）  |
| `service/dirtyRenderQueue.ts`          | `frame.commit`                                               |
| `controllers/roomPointerController.ts` | `pointer.down` / `local.paint-done` / `net.flush`            |

### B4. 线程规则

worker 与 main 时间轴不同源：**禁止跨线程算 duration**。worker 只产自己的 span；跨线程跨度（如 init 首帧）在 main 侧以「收到 worker 消息时刻」结算，worker 相对时间仅作 detail。`lab:marks` 作为 bridge 消息类型新增，rAF 合批。

### B5. Harness 采集与契约（新增 `external/lab/`）

- `install.ts`：`installLabRuntime(page)` 用 `addInitScript` 在应用脚本前注入；`readLab(page)` 读缓冲 + `performance.getEntriesByName` 交叉校验。

- `contracts.ts`：`LAB_CONTRACTS: Record<caseId,{version:1, requiredSpans:{name,thread,maxMs?}[], witnessToleranceMs?}>`：
  - `full-render`：`init.meta → init.render-complete`（main）、`worker.first-paint`（worker；主线程回退时由 `frame.commit` 兜底）
  - `incremental-remote-first-pixel`：`ws.message → worker.ack.frame`
  - `local-realtime-first-pixel`：`pointer.down → worker.ack.frame`、`pointer.down → ws.send.cmd-update`
  - `page-change`：`page.change → init.first-chunk`；`delta-replay`：`delta.meta → delta.complete`
  
- `evaluate.ts`：第 6 节判定码。

### B6. 混合度量与双源对拍

每个采样 case 结束收集一次，`CaseResult` 增加 `instrumented*` 与 `witnessDeltaMs`；主指标策略 `measurementPolicy:"prefer-instrumented"`。偏差超容差（初始：首帧 25ms、稳定态 40ms、交互 12ms，可按 case 覆盖）→ `EXTERNAL_DISAGREEMENT`，该 case 无效。这同时验证「外部观误差被收敛」与「埋点没被改坏」。

### B7. 防「AI 改坏埋点」（要求 3 的根因治理）

1. `tests/lab/instrumentation-guard.spec.ts`：`src/` 内 `performance.mark(` 只允许出现在 `src/instrumentation/`；契约引用的名字必须存在于 `labMarkNames.ts`；每个 required span 的 start/end 名字必须在源码中被引用。
2. harness-health 新增 **sentinel**：加载页面 → 断言 `__AEVIA_LAB__.enabled === true` 且 5s 内读到 `aevia.lab.sentinel`；失败即 `LAB_RUNTIME_MISSING`，整轮中断（不进入后续场景）。
3. 每轮把契约快照写 `runDir/lab/contracts.json`，报告展示契约版本/缺失 mark。

------

## 6. 工作流 C：门禁与中断（要求 3）

### C1. 判定码（新增 `tests/lab/gate.ts`，纯函数、可单测）

`MISSING_MARK` / `UNPAIRED_MARK` / `NEGATIVE_DURATION` / `DURATION_OUT_OF_RANGE` / `SAMPLE_COUNT_MISMATCH` / `INVALID_SAMPLE_RATIO`（≥1/3 样本非 valid）/ `EXTERNAL_DISAGREEMENT` / `PAGE_CONSOLE_ERROR` / `WORKER_CRASH` / `EMPTY_METRICS` / `NAN_METRIC` / `UNEXPECTED_CASE_SET`。

### C2. 三级门禁与行为

| 级别     | 触发                                     | 行为                                                         | 控制台                                                       | 退出码 |
| -------- | ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------ |
| case     | 任一码命中                               | case 状态改 `failed`、`failureType="harness"`，继续跑（收集全部问题） | `[lab][invalid-case] scenario=… case=… codes=… detail=…`（TTY 红色） | —      |
| scenario | `invalid === attempted && attempted > 0` | **立即中断**：不再执行剩余步骤，`validity=invalid/aborted`，写报告但 `recorded=false` | `[lab][scenario] attempted=N valid=0 invalid=N` + `[lab][abort]` | 3      |
| run      | 证据 fail-closed 或产品测试失败          | 正常失败，**不中断**（继续收集证据）                         | 现有 `[test-report]` + `[lab]` 汇总                          | 1      |
| 告警     | `invalid/attempted ≥ 25%` 未全灭         | 不中断，标 `validity=degraded`，nightly 计入趋势             | `[lab][warn]`                                                | —      |

关键修正：**只有「采集失败」中断，「产品测试失败」不中断**（否则一个真实 bug 会吞掉全部证据）；阈值不设「有一个 case 失败就中断」。

### C3. 「不记录」的三层拆分

| 产物                                           | 是否写                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ |
| run 目录、manifest、报告、日志、截图           | 总是写（否则无法排查）                                       |
| `tests/reports/summary/latest.json` 指针       | 仅 `validity=valid` 且聚合通过                               |
| `history/*.jsonl`、`baselines/*.baseline.json` | 仅 valid + 聚合通过 + 工作区干净（`dirtyPatchSha256 === sha256("")`）+ 非重跑轮次 |

### C4. 与 fail-closed 聚合整合（唯一破坏性改动）

- contract.ts：`RunManifest.schemaVersion` 1→**2**，新增 `mode`、`validity{status,aborted,reasons[]}`、`recorded`、`rerunOf?`、`measurement`；`ArtifactKind` 增 `lab-gate`/`lab-inventory`/`perf-request`。
- aggregate.ts：`AggregateReport.schemaVersion`→2；校验 `lab-gate`（status valid、无 aborted、gate case 集合 == external case 集合）；external 额外校验 `validity.status==="valid"`；v1 manifest 读入给明确错误「legacy run manifest, re-run with current runner」。
- 同步更新：`aggregate.spec.ts`（12 条）、`feature-obligations.spec.ts`（3 条）、`external-case-catalog.spec.ts`；`surface_catalog_test.go` 不改 JSON 计数则不受影响。

------

## 7. 工作流 D：可视化报告与一键重跑（要求 5）

### D1. 统一模型（新增 `tests/report/lab-report.ts`）

`runDir/lab-report.json`（schemaVersion 2）：`run{mode,profile,status,validity,recorded,source,rerunOf}`、`gate{cases[],scenarios[],aborted}`、`instrumentation{enabled,contractVersion,cases[{caseKey,spans[],missing[],witness[]}]}`、`steps[]`、`suites{unit,integration,browser,go,e2e,performance}`（vitest json 的 `testResults[].name` 提供 **case→文件** 映射）、`measurements[{caseKey,env,scale,metric,value,source,baseline,budget,learnedBand,deltaPercent,verdict}]`、`coverage`、`obligations`、`artifactsIndex`、`failures`、`logs`。

### D2. 页面（重写 `reportHtml` → `tests/report/lab-html.ts`）

单文件、内联 CSS/JS、无外部资源，数据以 `<script type="application/json" id="lab-data">` 内嵌。分区：判定头（mode/源码/耗时/validity/recorded）→ KPI 卡 → **门禁面板**（无效 case、中断原因、埋点契约、双源偏差）→ 标签页（总览｜单元/模块｜浏览器｜Go｜E2E｜性能｜覆盖｜证据｜日志）→ 性能表（case×环境×规模，对比 baseline/budget/学习带，来源徽标）→ 产物画廊（相对路径，`file://` 可用）→ 每行「重跑」按钮。

### D3. `scripts/lab-serve.mjs`（零依赖 `node:http`）

| 路由                                            | 说明                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `GET /`                                         | run 索引（时间倒序，标 mode/判定/validity/recorded） |
| `GET /runs/:runId/`、`/runs/:runId/artifacts/*` | 报告页 / 静态产物（`path.resolve` 前缀校验防穿越）   |
| `GET /api/runs`、`/api/runs/:id`                | 列表 / lab-report.json                               |
| `POST /api/rerun` `{runId,scope:"run"           | "scenario"                                           |
| `GET /api/jobs/:jobId`、`/log`；`POST /stop`    | 状态 + 日志尾 + 终止                                 |

安全：只绑 `127.0.0.1`；每次启动生成随机 token 注入被服务页面（静态文件无 token → 按钮禁用并提示「需 npm run lab:serve」）；POST 校验 `X-Lab-Token`；profile/scope 白名单；同时只允许 1 个任务；子进程超时与 `taskkill /t` 清理沿用现有思路。重跑：新 runId + `rerunOf`/`rerunScope`；默认只重跑失败+无效 case；单元测试重跑走 `--only=file:<ownerTest>`（来自 lab-report 的 case→文件映射）。

------

## 8. 工作流 E：测试覆盖补全（要求 1）

### E1. 机器可校验的债务清单

`tests/catalog/module-obligations.json` + `tests/report/module-obligations.spec.ts`：条目 `{id,kind:"frontend"|"go",path,ownerTest?,ownerExternal?,state:"covered"|"partial"|"excluded",reason?}`；断言每个 `apps/frontend/src/**/*.{ts,vue}` 与 `apps/backend/**/*.go`（非 `_test.go`）**恰好出现一次**，`covered/partial` 的 owner 必须真实存在且被项目 glob 命中，`excluded` 必须有 reason，id 唯一。生成辅助 `scripts/lab-inventory.mjs`（只打印候选）。

### E2. 补测波次

**W1（正确性 + 跨端契约，最高优先）**

- `apps/backend/internal/domain/types_test.go` + 新增 `packages/shared/src/protocol/__fixtures__/order-vectors.json`：同一组 golden 向量被 Go 与 shared spec 共同消费，锁死 `CompareFlatPoint` / `compareCommandOrder` / `compareRenderOrder` 等价性（补此前审计发现的 P0 契约风险）。
- Go：`room/{state,pressure,delta_buffer,window}`、`gateway/{middleware,origin,session_tokens,metrics_handler,room_handlers}`、`storage/store`、`console`、`cmd/aevia-backend`；前端 unit：`scene/{renderOrderIndex,eraseGeometry,graphemes,matrix,toolRegistry}`、`store/{lamportStore,userStore}`、`service/{collabPressurePolicy,collabProtocol}`（与 shared 对拍）、`utils/editorEventBus`。

**W2（前端热路径）**

- `service/{collabMessageDispatcher,collabPresenceHandlers,collabCommandHandlers}` 用假 transport/假 Worker 在 happy-dom 下测；`roomPageService`、`pageOverviewService`、`sessionApi`；`tests/browser/worker-init-stream.browser.spec.ts` 覆盖 worker init 流。

**W3（E2E 扩展，nightly 生效）**

- 已在 catalog 但未进 CI 的 7 个 case 纳入 nightly；新增：文本编辑收敛、图形/变换收敛、擦除收敛、撤销重做收敛、断线 delta 重放、页面窗口隔离、`resync.required` 恢复。每例同步 `suites.ts` + `tests/catalog/external-cases.ts`（CI_REQUIRED 保持 5 个）+ `LAB_CONTRACTS`。

### E3. 覆盖回归门禁

`tests/lab/coverage-baseline.json` 记录 unresolved/uncovered 集合；nightly 加 `obligation-regression` 步骤，**只惩罚新增**未覆盖项，不要求立即清零。

------

## 9. 分支与提交策略（新增硬约束）

### 9.0 前置阻塞与处理

当前会话 `ops_bash` 因工作区所有权（`WRITE_OWNER`）失败，无法执行 git。**实施第一步必须先解决**：申请 `danger-full-access` 仅用于 git 只读/分支/提交命令，或修复目录 ACL；在此之前**不修改任何文件**（否则无法满足"不在主分支实施"的约束）。

### 9.1 开工检查（任一不满足即停下询问，不自行 stash/rebase）

1. `git rev-parse --abbrev-ref HEAD` → 必须是 `main`（若当前已是别的分支，先问用户基线）。
2. `git status --porcelain` → 必须为空；有未提交改动时**停下报告**，不 stash、不 commit、不丢弃。
3. `git remote -v` 记录基线，供结束时比对。
4. `git branch --list feat/lab-runner` → 已存在则改用 `feat/lab-runner-2` 或询问，不删除既有分支。

### 9.2 分支创建

`git switch -c feat/lab-runner`（从当前 main 创建）。若创建失败，中止整个计划并报告，不降级到"直接在 main 上改"。

### 9.3 实施期间的禁令（写成执行清单，每阶段自检）

- 禁止：`git push`、`git remote add/set-url`、`git tag`、`git branch -D`、`git checkout main`、`git merge`、`git rebase`、`git reset --hard`、`git clean`。
- 允许：`git add <精确路径>`、`git commit -m`、`git status/diff/log/show`、`git switch --detach`（仅查看时）。
- 每阶段结束断言：`git branch --show-current` == `feat/lab-runner`，且 `git status --porcelain` 干净（阶段内中间状态除外）。
- 不新增/不修改 `.gitignore` 之外会影响他人的配置；`tests/reports/**` 等生成物按现有 gitignore 处理，若需纳入提交只用精确路径 `git add`。

### 9.4 提交切分（对应 P0–P6，每阶段 1–2 个 commit）

提交信息风格先 `git log -20 --pretty=%s` 对齐仓库既有习惯；建议：

1. `test(lab): 升级 run manifest 与聚合契约为 v2`
2. `feat(instrumentation): 新增 lab mark 运行时与编辑器插件`
3. `test(e2e): 采集埋点契约、双源对拍与 health sentinel`
4. `feat(lab): 三级采集门禁与中断语义`
5. `feat(lab): single/smoke/ci/nightly 模式与 nightly workflow`
6. `feat(report): 统一 lab 报告页与本地 lab-serve 重跑服务`
7. `test(coverage): 模块级测试清单与补测波次 W1/W2/W3`

### 9.5 收尾

- 最终交付：分支名、`git log --oneline main..HEAD`、`git diff --stat main..HEAD`、本地 run 报告路径。
- 明确告知"未推送"；给出可选清理命令（不执行）：`git switch main && git branch -D feat/lab-runner`（仅在用户确认后由用户执行）。
- 若期间误操作污染了 main 或远端（理论上不会发生）：立即停止，报告事实与恢复建议，不自行 `reset`/`force`。

------

## 10. 契约/数据流变更汇总

| 位置                                         | 变更                                                         | 破坏面                               |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `tests/report/contract.ts`                   | manifest v2 + LabMode/Validity/rerun + 3 个新 kind           | `--replay`、aggregate、旧 run 不可读 |
| `tests/report/aggregate.ts`                  | schema v2、gate/external-validity 校验                       | 4 个 spec 同步                       |
| `tests/report/lab-report.ts` / `lab-html.ts` | 新模型 + 新页面                                              | 旧 25 行模板替换                     |
| `external/types.ts`                          | `ExternalReport.validity`、`CaseResult.instrumented*`、`measurementSource` | 仅 reporter/baseline 消费，向后兼容  |
| `external/config.ts`                         | `--case-ids`、`--case-keys`                                  | 纯新增                               |
| `run-system.ts`                              | 3 个新 profile + `--only/--since/--perf/--rerun-of`          | 新增；`test:ci` 不变                 |

------

## 11. 失败模式与边界

- **worker 不可用/无 OffscreenCanvas**：worker 专属 span 标 optional，由 `frame.commit` 兜底，不因此判无效。
- **firefox/webkit 缺 longtask/event timing**：这些指标 optional，契约不引用。
- **埋点被误关**：sentinel 在 harness-health 先跑，失败即整轮中断（避免跑完 20 分钟才发现没采集）。
- **性能矩阵超时**：沿用 `caseTimeoutMs`/`seedTimeoutMs`，超时按 harness 失败。
- **DB 膨胀**：nightly 复用受管隔离 DB 与清理，禁止直连开发库。
- **重跑风暴**：单任务串行 + 409，不允许改 profile。
- **报告过大**：内嵌数据只放折叠明细（每 case 最多 50 样本），超 8MB 降级为「摘要内嵌 + 明细 JSON 单独文件」。
- **dirty 工作区**：报告标 dirty SHA，禁止更新 baseline/history。

------

## 12. 实施阶段（含分支动作）

| 阶段    | 内容                                                         | 产出                        | 预估                                        |
| ------- | ------------------------------------------------------------ | --------------------------- | ------------------------------------------- |
| **P-1** | 解决 shell 权限 → 9.1 开工检查 → 创建 `feat/lab-runner` → 记录基线 | 分支就绪、`git status` 干净 | 0.5 天                                      |
| P0      | 契约升级：manifest v2、gate 模型、aggregate 扩展 + 4 个 spec 同步 | 可编译、旧测试全绿          | 1–2 天                                      |
| P1      | 埋点：`src/instrumentation/*` + 8 处显式埋点 + bridge `lab:marks` + guard spec | devtools 可见 mark          | 2–3 天                                      |
| P2      | harness：`lab/install                                        | contracts                   | evaluate`、`--case-ids`、双源对拍、sentinel |
| P3      | 门禁：`tests/lab/gate.ts` + 三级中断 + 退出码 + 不记录规则 + 接线 | 破坏契约可触发中断          | 2 天                                        |
| P4      | 模式：4 个 profile + `--only/--since` + 解析器 + nightly workflow | 4 条命令可用                | 2–3 天                                      |
| P5      | 报告：模型 + 新 HTML + `lab-serve` + 重跑 API                | 页面可开、可重跑            | 3–4 天                                      |
| P6      | 补测 W1/W2/W3 + module-obligations + 覆盖回归门禁            | 未覆盖项可量化              | 5–8 天                                      |

------

## 13. 验收命令

```
# 分支约束
git branch --show-current            # feat/lab-runner
git status --porcelain              # 空
git log --oneline main..HEAD        # 有提交
git remote -v                       # 与 P-1 基线一致（未变）
# 禁止项自检（应为空/无输出）
git log origin/main..HEAD --not --remotes   # 仅本地分支上的提交

# 功能
npm run test:unit
npm run test:quick                   # 含埋点守护/门禁/解析/报告模型 spec
npm run test:single -- --since=HEAD~1
npm run test:smoke
npm run test:ci
npm run lab:serve                    # http://127.0.0.1:4790/ → 重跑失败用例
npm run lab:inventory
```

通过标准：G1–G8 全部可演示；`npm run build` 与 `test:go:vet` 保持通过；负向验收（注释掉某个 required span 名）触发 `[lab][invalid-case]` + `[lab][abort]`、退出码 3、`latest.json` 不更新。

------

## 14. 假设

1. nightly 跑在**自托管固定机器**（`self-hosted, aevia-nightly`）；托管 runner 抖动远大于 20% 回归阈值，故性能门禁不上托管。
2. 埋点只做**前端运行时**；Go 侧继续 pprof，不引入请求级打点。
3. 「场景」= `suite + caseSet`（性能矩阵下跨 4 环境），断路器在**每个环境跑完后**评估。
4. 阈值初值：断路器 100% 无效、告警 25%、样本无效 1/3、双源容差 25/40/12ms，落 `tests/lab/lab.config.json`，先校准一轮再收紧。
5. 报告页原生 JS + 内联 SVG，不引图表库；服务端零依赖。
6. 单点模式不做覆盖率/基线比较，只保证「有效 + 快速」。
7. 当前 shell 权限问题若无法解决，P-1 即阻塞：**不会退化为在 main 上直接改**。