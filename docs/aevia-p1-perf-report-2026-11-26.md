# Aevia P1 A/B 性能优化对比报告（2026-11-26）

> 对应计划阶段：**P1 证据驱动的热点优化与 A/B 对比**（[aevia-roadmap-2026-11.md](./aevia-roadmap-2026-11.md)）。  
> P0 对照基线：`b711e630-100d-4d6e-a87d-b21dcaf49fe3`（核心套件）与 `4c01c277-dec0-43eb-b8e1-1616db6cfb8c`（`join-100k`）。  
> P1 复测 Run ID：
> - `fdd5c02d-9504-47f9-b385-ead3a3256ab0`（`--set=core --collector=baseline`，含 `join-10k/50k/100k`、`render-direct/dirty/fallback`、`draw-dense`、`draw-dense-ready`，n=5）
> - `838abb0d-76e0-47f2-8eb4-e7f697afb5ad`（`--case=decision --collector=spans`，最终 P1 代码下 `join-100k`、`draw-dense`、`draw-dense-ready`，baseline + spans 各 n=5）
> - `aaf01656-6df2-4fc7-b333-a975922a916c`（最终 P1 代码下 `render-dirty --collector=baseline`，n=5）
> 全部跑测 `sourceDrift=false`、`error=0`。

---

## 1. 实施改动清单

1. **P1-4（H60 度量修复）`presentedRevision` 追踪收敛（[`canvasWorker.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/workers/canvasWorker.ts)）**
   - 引入 `unpaintedSceneState` 与 `commitPresentedRevision()`，移除 `presentedRevision === previousRevision` / `pendingSceneBaseRevision` 严等导致单次跳过即永久卡死的问题。
   - 当离屏页操作（`operation.pageId !== currentPageId`）、空脏区（`!dirty`）、`renderDirtyRect` / `renderDirtyRegions`、或延迟 `rAF` `flushSceneRender` 安全完成且无 `pendingSceneDirty` / 变换中对象 / 未决依赖 / 隔离元素时，推进 `presentedRevision` 至 `sceneEngine.getSceneRevision()`；`sync-scene(..., false)` 与 `begin-init-stream` 明确清空 `presentedRevision = null`。
   - 修复 `handleWorkerMessage` 中任意非绘消息（含 `get-render-watermarks`）提前 `flushSceneRender()` 破坏 rAF 合并的问题，以及 `sceneTaskInProgress` 期间 `flushSceneRender(true)` 被静默跳过的问题。
   - 在 [`canvasWorker.unit.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/workers/canvasWorker.unit.spec.ts) 新增 H60 回归测试，覆盖跨页 op、延迟 rAF flush 合并与 `sync-scene` + `rerender-scene`。

2. **P1-1（H01 核心）已定型前缀位图缓存与增量推进（[`sceneEngine.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/scene/sceneEngine.ts)、[`sceneCore.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/scene/sceneCore.ts)）**
   - 在 `SceneCore` 关键变更点（`storeAtom`、`element.delete`、`history.toggle`、`applyCreate` 合并、`rebuildTextAtoms`、`applyElementMatrix`、`applyElementStyle`、`applyEraseTarget`、`applyPageClear`、`rebuildV2ElementsSteps`、`rebuildLegacyElement`、`compactIndexesSteps`、`reset`、`setPage`）触发轻量受保护钩子 `onPrefixMayInvalidate`。
   - 在 `SceneEngine` 实现离屏 `SettledPrefixCache`（阈值 512 图元，尾留余量 `PREFIX_TAIL_MARGIN=256`，增量推进上限 `PREFIX_ADVANCE_TAIL_LIMIT=1024`）：
     - `renderFull` / `renderFullSteps` 在渲染完前 `N - 256` 图元时以 `drawImage` 快照前缀底图（< 1 ms，零额外重绘），既缓存定型前缀又保护活跃尾部不被双端交错 Lamport 击穿；
     - `renderDirtyRegions` 使用活跃尾图元计数参与 `shouldRenderFull` 判断，按脏区设备像素子矩形精确拷贝前缀像素后，仅光栅化 `atom.order > prefixMaxOrder` 的尾图元（叠加 `pen` / `highlighter` `multiply` / `eraser` `destination-out`）；
     - 尾图元积累至 1024 时通过 `advancePrefixCache()` 仅向现有 `prefixCache.canvas` 增量追加最新定型区间（~1–2 ms），大场景意外击穿时分片 `stepPrefixCacheRebuildWithTailMargin()`（每次 ≤ 512 图元）避免单帧长阻塞。
   - 在 [`scene-dirty-render.browser.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/tests/browser/scene-dirty-render.browser.spec.ts) 新增真实 Chromium Canvas2D 像素对照测试（> 800 图元，覆盖高光 `multiply`、橡皮擦 `destination-out`、交错尾插与前缀撤销失效，`maxPremultipliedDiff <= 2`）。

3. **P1-2 10 万点进房主线程收敛路径优化（[`collabCommandHandlers.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/collabCommandHandlers.ts)、[`commandStore.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/store/commandStore.ts)、[`renderWorkerBridge.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/renderWorkerBridge.ts)）**
   - `tryFinalizeInitCommands` 取消中间 `[id, cmd]` 二元组数组分配。
   - `commandStore.replaceLoadedPageWindow` 在构建后单遍顺带填充 `commandMap`（替代二次遍历 `rebuildCommandMap`），且 `sortAndFoldBucket` 先线性检测有序性，对已按序到达的服务端快照跳过 `O(N log N)` 重排序。
   - `renderWorkerBridge` 将 `cloneSceneOperation` 的 `JSON.parse(JSON.stringify(...))` 替换为 `structuredClone(toRaw(...))`（保留代理回退），并在 `setInitSceneOperations` 中使用 `prepareInitCommandForWorker` 直接解除 Vue Proxy 交给 `postMessage` 原生跨线程克隆。

---

## 2. A/B 实测对比（n=5 中位数 `[min..max]`）

### 2.1 核心场景对比（最终 P1 代码 `838abb0d` & `aaf01656` vs P0 `b711e630` / `4c01c277`）

| 场景 / 指标 | P0 基线 | P1 优化后 | 变化 | 一致性 / 备注 |
|---|---:|---:|---:|---|
| `draw-dense-ready` (spans) `worstQueueLowerBoundMs` | 55.09 ms | **0.00 ms** `[0.00..39.18]` | **-100.0%** | 3/5 样本队列下界为 `0.0 ms` |
| `draw-dense-ready` (spans) `worstQueueUpperBoundMs` | 70.53 ms | **7.79 ms** `[7.25..44.62]` | **-89.0%** | Worker 侧耗时大样本已收敛至 `< 11 ms`（s3–s5） |
| `draw-dense-ready` (baseline) `stableObservationMs` | 282.17 ms | **213.19 ms** `[211.30..234.05]` | **-24.4%** | `difference = 0.00`，`0 errors` |
| `draw-dense` (baseline) `lastAckAfterInputMs` | 22.94 ms | **1.59 ms** `[1.27..1.86]` | **-93.0%** | `acceptedOperations=617`，`difference = 0.00` |
| `draw-dense` (baseline) `stableObservationMs` | 238.23 ms | **211.85 ms** `[204.25..213.29]` | **-11.1%** | 含 200 ms 稳定判定窗口基线 |
| `draw-dense` (spans) `worstQueueLowerBoundMs` | 66.06 ms | **43.03 ms** `[0.05..96.68]` | **-34.9%** | s4/s5 分别为 `0.1/5.3 ms`；个别样本仍在冷建切换区出现峰值 |
| `join-100k` (baseline) `firstNonBlankMs` | 586.88 ms | **534.24 ms** `[531.11..667.97]` | **-9.0%** | `nonBlankRatio=0.69` |
| `join-100k` (baseline) `visuallyStableMs` | 1054.50 ms | **926.03 ms** `[918.90..1066.68]` | **-12.2%** | `finalDifference = 0.00` |
| `join-100k` (spans) `handleInitComplete`（主线程） | 58.71 ms | **24.5–26.5 ms**（s1–s5） | **~-56%** | `flushSceneRender` 调用从 203 次降至 3 次以内 |
| `render-dirty` (baseline) `renderMs`（`aaf01656`） | 24.30 ms | **4.10 ms** `[3.90..4.50]` | **-83.1%** | `renderedAtoms` `11,628 → 51`（仅尾部余量重叠图元）；diff `0.67` (4 px) |
| `render-dirty` (baseline) `readbackMs`（`aaf01656`） | 63.30 ms | **9.50 ms** `[8.70..9.90]` | **-85.0%** | — |

### 2.2 全 core 套件对照（`fdd5c02d` 尾留分段改造前补充对照）

| 场景 | 指标 | P0 基线 | P1（`fdd5c02d`） | 变化 |
|---|---|---:|---:|---:|
| `render-direct` | `renderMs` | 77.50 ms | **2.40 ms** `[2.20..2.50]` | **-96.9%** |
| `render-direct` | `readbackMs` | 178.00 ms | **8.60 ms** `[7.90..9.00]` | **-95.2%** |
| `render-fallback` | `renderMs` | 85.90 ms | **10.90 ms** `[10.10..13.40]` | **-87.3%** |
| `render-fallback` | `readbackMs` | 174.10 ms | **8.50 ms** `[7.90..8.80]` | **-95.1%** |
| `join-50k` | `firstNonBlankMs` | 511.71 ms | **406.28 ms** `[364.20..484.54]` | **-20.6%** |
| `join-10k` | `firstNonBlankMs` | 254.45 ms | **251.93 ms** `[219.12..300.63]` | **-1.0%** |

> 说明：`fdd5c02d` 采集后在 `sceneEngine.ts` 增加了 `splitIndexForTailMargin`、`advancePrefixCache` 与分片重建以消除 ~110 ms 尾部重构毛刺，最终代码的核心路径已由 `838abb0d` 与 `aaf01656` 复测验证（`render-dirty` `renderMs` 保持 4.10 ms，diff 仍为 0.67 / 4 px）；`render-direct/fallback`、微基准、单元及浏览器像素对照亦已通过。

---

## 3. 结论与残留观察

- **P1 目标达成**：`draw-dense-ready` 渲染工作线程瓶颈（原 1,920 ms / `worstQueueLowerBoundMs` 55–66 ms）已通过定型前缀缓存与 rAF 合并消减，Worker 热帧普遍回落至 `2–11 ms`；`join-100k` 主线程长任务从 `58.7 ms` 降至 `25–26 ms`，视觉稳定时间缩短 ~12%。
- **后续在 V2 调度阶段继续收口**：`draw-dense` 个别样本（如无预热空画布冷启动切换进前缀缓存区间时）仍偶现单次 ~43–96 ms 排队毛刺，将在 **V2（S3 公平调度与协同 safepoint）** 通过工作协程切分及帧预算控制彻底封顶。
- **尚未重跑但将在 P2/V5 验证的范围**：本阶段聚焦核心单元、浏览器渲染和 `profile` 核心集；完整全套门禁（含 Go race/fuzz 与前端全包）将在对应阶段收尾统一运行。
