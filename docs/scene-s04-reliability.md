# S04 协同可靠性记录

## 本期实现

- 切页快照与同时到达的实时操作按操作 ID 合并，页面窗口对重复 ID 去重；适用于新加载页和缓存页。
- 初始化的恢复序号等待 Worker 处理屏障；无效二进制块、未解决依赖或屏障超时不推进序号。迟到的旧连接和旧初始化结果不更新当前连接。
- Scene 写入当前使用等待 SQLite 提交的 barrier；服务端 `ack.accepted` 发出之前写入已成功。可重试的不可变操作保持原 ID，服务端检查相同用户和内容后返回原序号。
- 数据库只读时拒绝消息带操作 ID，客户端可从本地回滚并移除待重试项；写入失败发出只读恢复提示。

## 检查与边界

- `collabCommandHandlers.spec.ts`、`commandStore.spec.ts` 覆盖切页快照与实时操作交错及 ID 去重。
- `renderWorkerBridge.unit.spec.ts` 和 `roomCollabTransport.spec.ts` 覆盖 Worker 屏障与连接变更时的恢复序号；它们是局部逻辑检查，不是完整多端故障矩阵。
- `persistence_test.go` 覆盖只读拒绝携带 ID；`storage/writer_test.go` 覆盖等待和异步写入失败、SQLite 写满后不推进持久序号、锁释放后存储层可重试；`gateway/server_test.go` 含重启后的持久化和相同操作重试检查。
- 大场景单次诊断及 run ID 见 `scene-s04-capacity.md`。现有测试目录的 `covered` 表示有测试归属，不代表模块全部行为已覆盖。
- 离线操作队列只在当前页面进程内，刷新或浏览器崩溃后不保证保留；不属于持久离线编辑。磁盘满、锁竞争、跨设备及复杂乱序仍未形成完整的端到端故障覆盖，不能据此声明所有故障已认证。
