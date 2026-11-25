# Aevia V3 稳定性走查补充

本文补充 `aevia-v3.md` 中因第一轮稳定性修改而过时的状态；该文档的其他内容仍需结合当前源码阅读。

## 主线程与 Worker 的共享 Ring

`sceneBatchRing.ts` 已实现有限容量、单生产者和单消费者的共享 Ring。白板主线程可将批量场景消息写入 Ring，再用消息通知 Worker 按顺序读取。该通道依赖 `SharedArrayBuffer` 和网页跨源隔离：开发服务器已设置所需响应头，生产部署请参照 `aevia-shared-memory-deployment.md`。

浏览器不满足隔离条件、Ring 写满，或某些直接编解码能力不可用时，代码会使用普通字节缓冲区或 transferable 消息。JSON 序列化、编码及解码仍可能产生分配或复制，因此不能称为端到端零拷贝。Ring 不自动解决绘制开销或浏览器端消息积压。

## 未确认操作的本地恢复

`pendingSceneStore.ts` 为待确认的场景操作提供 IndexedDB 持久化，按房间实例与用户隔离；记录完成本地事务后才发送，重连时按原顺序重试，收到确认或拒绝后清理。存储不可用时会提示并退回内存队列。

这不是完整离线编辑：当前不支持断网后继续创作，也不能保证本地事务提交之前突然崩溃的操作得以保留。真实断线、崩溃及不同设备的组合仍需要验收。

## 未实施的方向

Rust/WASM 场景内核和 WebGPU 渲染仍未实施，是否投入需要后续单独评估。当前渲染仍使用 Canvas 2D。功能和性能测试结果及其适用范围见 `aevia-stability-audit-2026-11-16.md` 和第一轮走查台账。

## 2026-11-26 P0～V5 演进补充

自上述走查之后，在保持 Canvas 2D + Go 架构（排除 RSEC / WebGPU）的基础上完成了多轮实现与验证，详情见各阶段报告（`aevia-p0-profile-report-2026-11-26.md`、`aevia-p1-perf-report-2026-11-26.md`、`aevia-p2-stability-report-2026-11-26.md`、`aevia-v1-checkpoint-report-2026-11-26.md`、`aevia-v3-architecture-notes-2026-11-26.md`、`aevia-v4-backend-reliability-report-2026-11-26.md`）：

- **呈现水位与增量前缀缓存（P1）**：修正了 `canvasWorker.ts` 的 `presentedRevision` / `unpaintedSceneState` 更新与 rAF 节流语义（H60）；在 `SceneCore` 中实现 `SettledPrefixCache`（含 `stepPrefixCacheRebuildWithTailMargin`）以及单趟 `commandStore` / `structuredClone` 进房优化，大幅降低密集绘制及 10 万点入房主线程毛刺。
- **持久化检查点与跨刷新增量历史（V1）**：后端 `SnapshotBuilder` 增加 Bounded LRU `initSnapshotCache` 避免重复 join 读库与分块编码；前端 `PageHistoryCache` 通过 IndexedDB 持久化 `[roomId, roomCreatedAt, userId]\0<pageId>` 作用域的清屏前历史分片与游标（不支持或禁用的浏览器仍优雅退回）。
- **公平调度与帧预算（V2）**：`WorkerTaskScheduler` 按 `reliable-ordered`、`latest-wins`、`replaceable`、`background` 分类调度，配合 epoch 取消、突发/老化配额与 `stagedRebuildActive` 原子发布门禁。
- **结构化增量物化与状态机契约（V3）**：`diffRenderIR` 使用结构化 `renderIRItemsEqual` 替代整帧 `JSON.stringify`；`whiteboardSession.ts` 显式导出 `VALID_LIFECYCLE_TRANSITIONS` 与 `areConsistencyWatermarksMonotonic`；固化 9 类 V2 操作黄金夹具。
- **后端因果依赖与孤儿诊断（V4）**：`PagePointIndex` 为先于 `element.create` 到达的实时 `element.append` 维护有界 `pendingFragments` 等待队列并在创世操作到达后补投影，结合 `State.CausalDiagnostics()` / `Actor.CausalDiagnostics()` 暴露待定孤儿与边界。

