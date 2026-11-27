# Aevia V4 后端因果依赖与快照/背压可靠性报告 (2026-11-26)

## 1. H49/H50 后端因果依赖修复与诊断 (`apps/backend/internal/room/`)

### 根因定位
- `PagePointIndex.upsertScenePathFragment` 在实时通过 `State.UpsertCommand` 写入时，若收到 `element.append` 时尚未建立 `scenePathStyles[elementId]`，会直接提前返回并丢弃该分片；当滞后的 `element.create` 随后到达时，此前丢弃的 `append` 无法补投影到 `PagePointIndex`，导致新加入用户的 `init-render` 漏点，且后端对未闭环的 `element.append` / `text.patch` 缺乏诊断可见性。

### 改动详情
- `apps/backend/internal/room/index.go`：
  - 在 `PagePointIndex` 中新增有界等待队列 `pendingFragments`（上限常量 `maxPendingOrphansPerElement = 512`、`maxPendingOrphanFragments = 2048`）及溢出统计 `quarantinedFragments`。
  - 当实时 `element.append` 先于 `element.create` 到达时将其去重挂入等待队列而非静默丢弃；当匹配的 `element.create` 到达时，按 `(Lamport, OperationID, SourceStart)` 排序回放并投影至索引，不破坏合法的离线乱序恢复语义。
  - 更新 `Remove`、`ClearPage`（即使目标页尚未生成点块也清理对应待定孤儿）与 `ClearAll`，并导出 `PendingFragmentCount()`、`DroppedOrphanCount()`、`QuarantinedElementIDs()`。
- `apps/backend/internal/room/state.go` & `messages.go` & `actor.go`：
  - 新增 `State.CausalDiagnostics()` 与 `Actor.CausalDiagnostics()`（经 actor reliable mailbox 查询），统一汇总 `PendingPathFragments`、缺少匹配 `element.create` 的 `PendingTextOps`、`DroppedOrphans` 及排序后的 `OrphanElementIDs`。

## 2. 慢快照解耦、慢客户端背压隔离与二进制批量评估

### 慢快照与背压隔离核查 (`apps/backend/internal/room/actor.go`)
- `handleJoin` 在缓存未命中时通过 `pinSnapshot()` 获取受并发上限 (`snapshotSlots` cap 4) 保护的 SQLite 只读视图，并拷贝 immutable 命令快照与 `ClearBefore` 水位后在独立 goroutine 中调用 `initDetached` 与 `sendInitStream`；发送通道经 `live` 队列转发 live 广播。当慢读端阻塞 `live` 队列时，`broadcastExcept` 非阻塞发送失败后累加 `metrics.SlowClients` 并调用 `client.Abort()` 触发 `Done` 关闭，释放入房发送 goroutine，避免阻塞同房健康客户端。
- 注意：`handlePageChange`（`actor.go`）仍在触发异步读取后从 SQLite 读出命令再 `NewState` + `PageChange`；V1 的 `initSnapshotCache` 已消除了 join 热路径重复读库与编解码开销（冷建 ~61–76 ms -> 命中 ~346–390 ns）。

### 二进制批量压缩评估（是否继续扩展）
- 结合 `apps/backend/internal/protocol/scene_append.go` (`SceneAppendMagic = 0x41563250`) 与 P1/V1/V3 基准数据：
  - 实时高频路径 `element.append` 已走 32-byte/point 大端二进制编码；
  - 首屏快照构建经 V1 `initSnapshotCache` 缓存命中后降至亚微秒级（~346–390 ns），不再受序列化 CPU 支配；
  - P1 复测中 `join-100k` 的主线程 bottleneck 与 `draw-dense-ready` 的微队列已大幅下降（`-56%` / `worstQueueLowerBoundMs 55.09 -> 0.00 ms`），前端 `RenderIR diff` 也降至 `0.4342 ms`。
  - **结论**：当前阶段无需为全量 JSON/op 新增额外批量二进制封包协议，推迟至后续 500k+ 网络带宽成为主瓶颈时再按需启用，保持现有线协议稳定。

## 3. 新增验证与后端全量结果

- 新增测试文件与用例：
  - `apps/backend/internal/room/causal_backpressure_test.go`：
    - `TestPagePointIndexProjectsOutOfOrderAppendWhenCreateArrivesLater`
    - `TestPagePointIndexCapsOrphanPendingFragmentsAndCleansOnClear`
    - `TestStateCausalDiagnosticsTracksOrphanTextPatchWithoutCreate`
    - `TestActorSlowReaderIsolationAndCausalDiagnosticsUnderLiveTraffic`
  - `apps/backend/internal/gateway/stability_combination_test.go`：
    - `TestOutOfOrderSceneOpsProjectAfterLateCreateAndSurviveReconnect`（真实 WebSocket 先推 `element.append` 后推 `element.create`，重连核对 `init-meta.chunkSummary.pointCount == 2`）
- 验证命令与结果（均在最终改动后运行）：
  - `go test -count=1 ./internal/room ./internal/storage ./internal/domain ./internal/protocol`：全部通过。
  - `go test -count=1 ./internal/gateway`（`BypassSandbox: true`）：全部通过（`2.227s`）。
  - `go vet ./...`：0 警告通过。
