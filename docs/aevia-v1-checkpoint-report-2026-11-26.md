# Aevia V1 检查点、服务端初始化缓存与可续传历史报告（2026-11-26）

> 对应计划阶段：**V1 历史检查点与可恢复增量机制**（[aevia-roadmap-2026-11.md](./aevia-roadmap-2026-11.md)）。

---

## 1. 服务端持久化快照 / 编译态检查点缓存

- **实现位置**：[`snapshot_cache.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/room/snapshot_cache.go)、[`snapshot_builder.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/room/snapshot_builder.go)、[`actor.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/room/actor.go)。
- **机制**：`initSnapshotCache` 以 `(roomID, pageID, totalPage, roomSeq, preloadPages, clearSig)` 为键进行容量受限 LRU 缓存，同 `(roomID, pageID)` 的新版本写入立即驱逐旧序号；命中时在 `Actor.handleJoin` 中直接复用预编译的 `RenderChunks` 与 pre-encoded `CommandChunks`（仅按当前室温/房态补充 `maxLamport` 与每连接 `InitMeta`），无需再锁读 SQLite snapshot、全量复制 `Commands` map 或重建 `PagePointIndex`。
- **测试与基准**（`go test ./internal/room -run '^$' -bench '^BenchmarkProfileSnapshotBuild' -benchtime=150ms -count=3`）：
  - `10k`：`cold_build` ~**6.37 ms** / `3.14 MB` → `checkpoint_hit` **474.9–510.0 ns** / `368 B`（3 allocs）
  - `50k`：`cold_build` ~**30.3 ms** / `15.65 MB` → `checkpoint_hit` **357.3–374.0 ns** / `368 B`
  - `100k`：`cold_build` **60.9–75.7 ms** / `31.3 MB`（44k allocs）→ `checkpoint_hit` **345.6–390.3 ns** / `368 B`（**>150,000x 吞吐提升**）
  - 单元测试 `TestSnapshotCheckpointCacheHitsAndInvalidatesOnSeqOrClearChange` 验证命中一致与序号推进后自动失效。

---

## 2. 跨页面刷新可续传的 `page-history` 协议闭环（H08）

- **实现位置**：[`pageHistoryCache.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/pageHistoryCache.ts)、[`roomCollabTransport.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/roomCollabTransport.ts)。
- **机制**：
  - 使用 IndexedDB 数据库 `"aevia-page-history"`（store `"fragments"`），按 `[roomId, roomCreatedAt, userId]\0<pageId>` 作用域隔离保存 `{ snapshotVersion, cursor, commands }`，确保删除重建同名房间或切换账号绝不串页/串库。
  - `page-history-chunk` 增量写入进度；页面刷新销毁内存重建 `roomCollabTransport` 后，`requestPageHistory` 先从 `PageHistoryCache` 恢复断点和已接收分片再发送 `load-page-history`。
  - 服务端若返回 `resumed: true` 则仅拉取游标之后剩余片段并合并提交；若因期间发生清屏/撤回/写入导致 `resumed: false`，立即清空过时缓存并全量重新拉取；完成后自动清理缓存。
- **验证**：[`pageHistoryCache.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/pageHistoryCache.spec.ts)（2/2 通过）与 [`roomCollabTransport.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/roomCollabTransport.spec.ts)（11/11 通过，覆盖无 IndexedDB 回退与跨传输实例重建续传）。

---

## 3. 前端 `elementCheckpoints` 收益与代价评估（H35）

- 在 [`render-core.bench.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/tests/bench/render-core.bench.ts) 增补 `SceneCore history toggle checkpoint (512 ops vs cold rebuild)`：
  - 64 元素撤回切换均值 **2.39 ms**；512 ops 含检查点保存与尾部连续切换均值 **3.80 ms** (`263.08 ops/s`, p99 `10.04 ms`)；内存上每个检查点复制单元素原子片段且随 `reset()` / `rebuildV2ElementsSteps()` 清理。
- 评估结论：`elementCheckpoints` 对超长单个交互元素的尾部局部撤回有效，而页面级高频重绘瓶颈已由 **P1 的 `SettledPrefixCache`** 覆盖；保留现有失效守卫并在 V3 进一步统一增量 Delta 输出。
