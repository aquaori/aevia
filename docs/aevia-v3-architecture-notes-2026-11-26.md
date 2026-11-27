# Aevia V3 增量物化、Watermarks 与生命周期状态机说明 (2026-11-26)

## 1. 结构化 RenderIR 增量 Diff (`apps/frontend/src/scene/renderIR.ts`)

- 将 `diffRenderIR` 中的全量 `JSON.stringify` 比较和 `previous.items.map(id).join("\0")` 串接替换为零额外序列化分配的结构化等价判定：
  - 新增导出函数 `renderIRItemsEqual`，按引用短路后逐字段精确比较 `id`、`opacity`、`handle`（`id`/`generation`/`epoch`）、6 维仿射 `matrix`、`erasedIntervals`、`eraseMasks` 及各 `primitive`（`dot` / `quadratic` / `shape` / `glyph` / `bitmap`）字段。
  - 通过单趟线性比较判断 `orderChanged`，仅在真实变化项上计算前后 `dirtyBounds` 与 `structuredClone` `upserted`。
- 实测微基准 (`npm run test:bench`, `RenderIR diff frames (64 items)`):
  - 优化前：~`5.45 ms`（`JSON.stringify` + 字符串拼接）。
  - 优化后：`mean = 0.4342 ms`（`hz = 2303.07`，`p75 = 0.4342 ms`，`p99 = 0.9913 ms`，1152 samples），提速约 **12.6x**（**-92.0%**）。

## 2. 因果缺失诊断与 V2 黄金夹具冻结 (`sceneCore.ts`, `sceneProtocol.spec.ts`, `sceneCore.spec.ts`)

- `SceneCore.getPendingDiagnostics()` 暴露待定增量追加计数（`pendingAppendOps`）、待定文本补丁计数（`pendingTextOps`）、隔离元素列表（`quarantinedIds`）及诊断原因（`missing-create-path` / `missing-create-text` / `missing-range-path`）。
- 在 `packages/shared/src/protocol/sceneProtocol.spec.ts` 与 `apps/frontend/src/scene/sceneCore.spec.ts` 中冻结全部 9 类 V2 规范操作（`element.create`、`element.append`、`element.transform`、`element.style`、`element.erase`、`element.delete`、`text.patch`、`history.toggle`、`page.clear`）的协议校验、`sceneOperationOrderKey` 确定性排序、`SceneCore -> RenderIR -> diffRenderIR -> applyRenderIRDelta -> encodeRenderIR/decodeRenderIR` 往返夹具。

## 3. Session 生命周期状态机与单调 Watermarks 契约 (`apps/frontend/src/service/whiteboardSession.ts`)

- 定义并导出显式合法迁移表 `VALID_LIFECYCLE_TRANSITIONS` 与校验函数 `canTransitionLifecyclePhase(from, to)`，约束 `SessionLifecyclePhase`（`idle` / `mounting` / `ready` / `connecting` / `connected` / `disconnecting` / `destroying` / `destroyed`）迁移拓扑（`destroyed` 为终态）。
- 导出 `areConsistencyWatermarksMonotonic(previous, next)`，验证同一 `epoch` 下 `roomSeq`、`submittedDispatchSeq`、`processedDispatchSeq`、`sceneRevision` 与 `presentedRevision` 的单调非递减约束，以及 `processedDispatchSeq <= submittedDispatchSeq` 与 `presentedRevision <= sceneRevision` 不变量。

## 4. 本阶段验证结果

- `npx vitest run packages/shared/src/protocol/sceneProtocol.spec.ts apps/frontend/src/scene/sceneCore.spec.ts apps/frontend/src/service/whiteboardSession.spec.ts apps/frontend/src/service/renderWorkerBridge.unit.spec.ts`：4 files, 37 tests 全部通过。
- `npm run build:frontend` (`vue-tsc -b && vite build`)：构建通过（0 类型错误）。
- `npm run test:bench`：全部 micro-bench 通过。
