# Aevia P0 全链路性能剖析汇总报告（2026-11-26）

> 对应计划阶段：**P0 全链路剖析收尾**（[aevia-roadmap-2026-11.md](./aevia-roadmap-2026-11.md)）。  
> 源码基准：`feat/improve-test-coverage`（HEAD `734f8de` + 本轮剖析适配与基准补充，`sourceDrift=False`）。  
> 采集环境：Windows (`win32`)、AMD Ryzen 9 5900HX、Node `v24.15.0`、Playwright Chromium `147.0.7727.15`、1280×720、`dpr=1`、隔离 SQLite 与独立本地端口。  
> **说明**：所有正式端到端指标均取 `1` 次预热 + `5` 次正式样本的中位数与 `[min..max]`；`cpu` / `timeline` / `memory` 为独立诊断窗口；不同进程时钟仅在同一时钟域内做差，跨进程排队只报误差区间。

---

## 1. 证据索引（Run IDs）

| 覆盖范围 | Run ID | 样本配置 | 状态 |
|---|---|---|---|
| 核心 8 场景（10k/50k/100k 进房、3 路渲染、双端密集绘制） | `b711e630-100d-4d6e-a87d-b21dcaf49fe3` | `core × all`（baseline/spans n=5；cpu/timeline/memory n=1） | `join-50k` 1 次本地连接超时；`join-100k` 修复门禁遮罩等待后于下表重采 |
| `join-100k` 门禁等待修复后复采 | `4c01c277-dec0-43eb-b8e1-1616db6cfb8c` | `baseline + spans`（n=5） | 全部通过，0 错误 |
| `clear-undo-large`（1 万点清屏/刷新/撤销/全画布对比） | `d4e7da41-147a-4ee5-9890-c297a502044d` | `baseline + spans`（n=5） | 全部通过，0 错误 |
| `delta-reconnect`（断线增量重连） | `ce3e95b1-0a0f-4ab1-a25a-3cf849b5d6b5` | `baseline + spans`（n=5） | 全部通过，0 错误 |
| `pending-refresh-recovery`（IndexedDB 断线刷新恢复） | `db22e789-ef1f-4828-a8d2-b0945fff4599` | `baseline + spans`（n=5） | 全部通过，0 错误 |
| `tools-matrix`（全工具链路端到端） | `e137c99d-72e1-4713-9028-de7c02f3700c` | `baseline + spans`（n=5） | 全部通过，0 错误 |
| `join-100k-active`（门禁后并发编辑适配） | `daf2db58-6aa9-4792-9e73-8091da084334` | `baseline + spans`（n=5） | 全部通过，0 错误 |
| `join-gate`（门禁阻断本地 + 保留远端操作） | `e76d2d20-97d2-4ece-96fc-1af8399a945d` | `smoke`（baseline/spans n=1） | 通过 |
| `account-room-flow`（注册/建房/设置/踢出） | `c51443a3-7f4d-47a4-8621-8dd11e5bc243` | `smoke`（baseline/spans n=1） | 通过 |

---

## 2. 关键用户体验指标（Baseline，n=5 中位数 `[min..max]`）

### 2.1 进房加载与门禁

| 场景 | 首个非空像素 (ms) | 视觉稳定 (ms) | 稳定确认 (ms) | 对比参考差值 | 备注 |
|---|---:|---:|---:|---:|---|
| `join-10k` | 254.45 `[225.32..317.66]` | 255.15 `[226.07..324.06]` | 759.54 `[733.25..826.53]` | 0.00 | 1 万点 |
| `join-50k` | 511.71 `[497.25..548.32]` | 621.98 `[593.55..660.65]` | 1126.31 `[1099.91..1162.28]` | 0.00 | n=4（1 次 ETIMEDOUT） |
| `join-100k` | 586.88 `[544.14..648.89]` | 1054.50 `[934.26..1157.26]` | 1560.07 `[1434.90..1663.47]` | 0.00 | `4c01c277`（修复遮罩等待后 n=5） |
| `join-100k-active` | 600.77 `[589.73..689.71]` | 980.55 `[977.83..1078.79]` | 1486.24 `[1478.72..1586.26]` | 0.00 | `gateReadyMs` 2215.89 `[1684.94..2237.17]`；门禁后 5 笔 0 拒绝 |

### 2.2 隔离渲染路径（45,600 图元，1280×720）

| 场景 | Setup (ms) | Render (ms) | Readback (ms) | 候选/渲染图元 | 最大预乘差异 |
|---|---:|---:|---:|---:|---:|
| `render-direct` | 78.80 `[78.10..81.40]` | 77.50 `[74.90..81.70]` | 178.00 `[170.90..181.00]` | 46,512 / 46,512 | 0.67（4 px） |
| `render-dirty` | 85.10 `[81.60..91.30]` | 24.30 `[23.20..28.70]` | 63.30 `[58.20..73.60]` | 11,628 / 11,628 | 0.67（4 px） |
| `render-fallback` | 79.80 `[76.20..82.30]` | 85.90 `[84.40..90.80]` | 174.10 `[168.60..188.70]` | 46,512 / 46,512 | 0.67（4 px） |

### 2.3 协作、恢复与工具链路

| 场景 | 核心体验指标（中位数 `[min..max]`） | 持久确认 / 一致性 |
|---|---|---|
| `draw-dense` | 停笔至画面稳定 238.23 ms `[221.06..306.92]`；最后 ACK 在停笔后 22.94 ms；WS 发送→ACK **1.93 ms** | 571 ops，差值 0.00 |
| `draw-dense-ready` | 停笔至画面稳定 282.17 ms `[229.12..317.87]`；最后 ACK 4.47 ms；WS 发送→ACK **1.93 ms** | 596 ops，差值 0.00 |
| `clear-undo-large` | 松手清屏双端空白 466.21 ms `[448.63..483.88]`；刷新后撤销恢复双端可见 2191.39 ms `[2109.13..2354.21]` | 全画布差值 ≤ 0.002 |
| `delta-reconnect` | 恢复联网至 WS 重开 15.13 ms；至远端笔迹可见 **137.08 ms** `[128.93..137.96]` | 观察到 `delta-replay-meta/complete` |
| `pending-refresh-recovery` | 重载至恢复操作 ACK **58.68 ms** `[54.17..67.24]`；至像素可见 774.70 ms `[739.78..994.62]` | 原 `opId` 恢复，差值 0.00 |
| `tools-matrix` | 钢笔 83.4 ms / 铅笔+荧光+图形 1277.2 ms / 擦除+拖拽 210.1 ms / 文字+便签+历史 2546.2 ms | 35 ops，全画布差值 0.00 |

---

## 3. 阶段 / 函数级分布与跨进程归因（Spans & CPU & Microbench）

### 3.1 `draw-dense`（4.82 秒双端密集交错绘制）

- **Go 后端与 SQLite（非瓶颈）**：`writer.applyBatch` 累计 649.5 ms / 593 批（均值 ~1.10 ms/批，最长 71.1 ms）；`actor.reliable.wait` 累计 648.1 ms / 594 次（最长 59.5 ms）；WS 发送→ACK 中位数 **2.06 ms**，发送→远端消息中位数 **2.35 ms**。
- **主线程 `target 0`（轻量）**：`localCommandService.pushCommand` 47.9 ms / 299 次（0.16 ms/次）；`roomCollabTransport.send` 44.7 ms / 481 次；`handlePushCommand` 25.5 ms / 294 次；`flushSceneBatch` 22.1 ms / 650 次。
- **Render Worker `target 1`（最大瓶颈）**：
  - `canvasWorker.flushSceneRender`：**1920.0 ms** / 212 次（单次最长 **59.7 ms**）
  - `sceneEngine.renderDirtyRegions`：**1918.8 ms** / 117 次（单次最长 **59.7 ms**）
  - `canvasIRRenderer.renderIRItems`：**1827.7 ms** / 611 次（单次最长 **39.3 ms**）
  - `sceneCore.queryDirtyCandidates`：167.4 ms / 129 次（1.3 ms/次）
  - `canvasWorker.runSlice`：228.5 ms / 586 次
  - **跨进程排队结果**：`matchedWorkerOperations` 1006 次，`worstQueueLowerBoundMs` 中位数 **66.06 ms** `[55.76..80.34]`（上界 71.88 ms）。
  - **根因机制**：双端并发时 Lamport 时序交错，`renderNewPenAtomsOnTop` 频繁退回到 `flushSceneRender -> renderDirtyRegions`，每次重绘都会清空脏区并从头重绘局部 11,628～46,512 个静态背景图元（4.82 秒内触发 117 次重绘，耗掉约 1.92 秒 Worker 时间）。

### 3.2 `join-100k`（10 万点进房）

- **Go 侧**：`ws_handler.go:writeOutbound` 累计 **1477.7 ms** / 995 次写（单次最长 120.4 ms；Go CPU 中 `runtime.memmove` 34.08%、`encoding/json.appendCompact` 9.50%）；`sendRenderStream` 47.8 ms；`snapshot_builder.go:build` 10.4 ms。
- **前端主线程 `target 0`**：`collabCommandHandlers.handleInitComplete` 单次 **71.29 ms**（最长同步长任务）。
- **Render Worker `target 1`**：
  - 流式点绘制 `renderAtomRefs` / `renderIRItems`：**299.0 ms** / 198 chunks（分块渲染）
  - 初始化收尾分片 `canvasWorker.runSlice`：**259.1 ms** / 55 slices（其中 `endBulkLoad` 17.7 ms，其余主要为 `renderFullSceneSteps()` 对 10 万点再做一次全量离屏重绘对齐）。
- **孤立内存**：100k 进房 `page-0` JS 堆 `2.5 MB → 12.6 MB`（`37.8 MB` total）；45k 渲染测试 `38.9–56.2 MB`。

### 3.3 微基准补充（Go & Vitest）

- **Go `BenchmarkProfileSnapshotBuild`**：10k / 50k / 100k 分别约 **6.7 ms**（3.1 MB）/ **29.9 ms**（15.7 MB）/ **65.5 ms**（31.3 MB）。
- **Go `BenchmarkProfilePageIndex`**：100k 构建 ~22.3 ms（77.4 MB）、读取 ~4.06 ms（16.0 MB）。
- **Go `BenchmarkProfileSQLiteTransaction`**：batch-1/16/64 分别约 **0.12 / 0.67 / 2.36 ms**。
- **Vitest `render-core.bench.ts` & `dirty-replay.bench.ts`**：
  - `SceneCore tail append 64 ops`：**0.87 ms**；`history toggle on 64 elements`：**2.52 ms**
  - `RenderIR encode (64 items / ~1024 atoms)`：**9.77 ms**；`decode`：**9.08 ms**；`diffRenderIR`：**5.45 ms**（`JSON.stringify` 整帧比较热点，将在 V3 消除）
  - `queryDirtyCandidates`：100k 稀疏 0.0007 ms、单长笔迹 0.043 ms、100k 中心密集热点 **11.85 ms**。

### 3.4 未归因与度量边界

- 浏览器合成层提交与 GPU 光栅化异步耗时无法仅凭 Worker `markWorkerRenderComplete` 分离，依赖外部像素观测（`visuallyStableMs` 约含浏览器 rAF 与 500 ms 稳定观察窗口起点）。
- `presentedRevision` 在高密度或某些局部更新路径存在长期滞后问题（H60），导致无法作为 P1-1 优化前后的呈现水位观测锚点，需在 P1 优先修复并加测。
- 本机无真实手机/移动网络数据及 Edge DevTools Performance 崩溃复现，移动端无线网络与低端 CPU 占比仍以本机桌面为下界参考。

---

## 4. P1 优化排序与理论收益上界

| 排序 | 目标 | 关键路径占比 / 理论上界 | 计划方案与成功条件 |
|---:|---|---|---|
| **1** | **P1-4（前置度量）修复 H60 `presentedRevision` 滞后** | 度量前置（不改性能） | 区分“已修改但未绘状态”与“已脏区刷新状态”，确保有效绘制后 `presentedRevision` 追平 `sceneRevision`；新增 Worker 单元测试覆盖 |
| **2** | **P1-1（H01 核心）双端密集绘制积压** | Worker `renderDirtyRegions` 占 4.82 s 输入窗的 **~40%（1.92 s）**；移除背景重绘后该步理论上界可降至 **< 50 ms**，队列排队下界（66 ms）预计显著回落 | **① 已定型前缀离屏位图缓存（Settled Prefix Cache）**：当序索引中稳定前缀超过阈值（如 ≥ 2048 图元）时，在 `renderFull` / 收尾阶段快照稳定前缀像素；脏区重绘时直接 `drawImage` 拷贝脏区背景并仅重绘 `order > prefixMaxOrder` 的尾部活跃图元；对早于水位的插入/擦除/变换/撤回/清屏自动失效。<br>**② 合并中间呈现帧**：`handleWorkerMessage` 中不再因任意消息提前冲刷 `flushSceneRender`，统一按帧合成最新 `sceneRevision`。<br>**③ 口径**：同口径 5 样本与 `b711e630` / `4c01c277` 对照，`difference <= 0.005` 且脏区像素与 `renderFull` 误差 ≤ 2 |
| **3** | **P1-2（100k 进房）首屏稳定与主线程长任务** | 100k `visuallyStableMs` ~1055 ms（Go `writeOutbound` ~1.48 s/2 端，Worker 流式 299 ms + 收尾全量 259 ms，主线程 `handleInitComplete` 71 ms） | **① 流式收尾与前缀缓存联动**：避免无必要重复全量重建，同时首屏结束后顺便建立前缀缓存服务后续编辑。<br>**② Go 侧初始化命令分片与主线程批处理**：评估合并命令归一化/插入（减少 `handleInitComplete` 71 ms 长任务）及减小 `writeOutbound` 小包次数（须保持首屏渐进流与兼容） |
| **4** | **P1-3（可选）增量物化与候选排序** | 当前 `queryDirtyCandidates` 在 `draw-dense` 总计仅 167 ms（占 Worker 重绘 < 9%），`orderDirtyCandidates` ~3.3 ms | 仅在 P1-1 优化后若查询占比升至新瓶颈时再介入；不重复已否决的 SoA 实验 |
