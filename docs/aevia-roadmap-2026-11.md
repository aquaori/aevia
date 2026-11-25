# Aevia 工作规划与排期（2026-11-26 起）

> 基线分支：`feat/improve-test-coverage`（基于 `main` `435ec87` + `734f8de`，继承工作区既有测试补充改动）。  
> 基准输入：[V3 架构 RFC](./aevia-v3-refract.md)、[第一轮稳定性走查](./aevia-stability-audit-2026-11-16.md)、[S00～S08 总结](./aevia-s00-s08-summary.md)、[性能剖析 README](../tests/profile/README.md)。  
> **排除范围**：RSEC（Rust/WASM 场景内核）、WebGPU 异构渲染，以及仅依赖它们的子项（共享 WASM Memory Ring、GPU 上传/切换调度、服务于渲染策略的复杂度 Hint）。

---

## 1. 目标与原则

1. **先把性能剖析收尾并产出血肉清晰的阶段报告**，再用证据驱动 P1 热点优化，避免盲目调参或重写。
2. **所有 V3 演进均在 TypeScript + Canvas 2D + Go 架构上推进**；保留 `RenderIR` / `SceneCorePort` 边界，不破坏将来接入 RSEC/WebGPU 的扩展性。
3. **尊重已有实现，不做重复建设**：源码已包含 `SceneCore`（无 Canvas 依赖）、`RenderIR`、`elementCheckpoints`、`WorkerTaskScheduler`（前景/背景两通道）、`PendingSceneStore`（IndexedDB 待确认恢复）、`sceneBatchRing`（SPSC SAB Ring + transferable 回退）及首屏门禁（`initialSceneReady`）。后续工作基于这些资产补齐缺口。
4. **独立 Oracle 与真实工作量口径**：像素对照、持久 ACK、参考客户端重放、跨进程耗时边界明确分离；不篡改基线或降级断言。

---

## 2. 分阶段路线图与排期

| 阶段 | 日历窗口（参考） | 核心目标 | 退出条件 |
|---|---|---|---|
| **P0 剖析收尾** | 11/26 – 12/09 | 跑通 `clear-undo-large`；适配首屏门禁后的测试口径；补齐关键场景、模块/函数覆盖与跨进程关联；生成合并剖析报告与优化排序 | `test:profile` 关键场景稳定采样，输出阶段报告（含 run ID、中位数/范围、关键路径上界） |
| **P1 热点优化** | 12/10 – 12/31 | 修正 H60 呈现水位；按 P0 报告排序优化 H01 密集绘制积压与大房间进房（10 万点）等大骨头 | 隔离实验 + 同口径 A/B（5+ 样本）证明关键路径收益且像素/持久化 oracle 一致 |
| **P2 第二轮走查** | 01/04 – 01/15 | 消化第一轮“待组合验收”项（H43–H59、H09、H13–H29）与 R01–R10 矩阵复验；核查 H57（DELETE 预检）、H02/H03/H04/H05 | 自动化组合用例通过；真机/线上差异项形成明确清单与本地可行范围内验证证据 |
| **V1 历史 Checkpoint** | 01/18 – 02/05 | 服务端按页/清屏水位持久化语义快照或增量片段；后台补载跨刷新/断点续传（H08）；评估前端 checkpoint 策略（H35） | 大历史进房 Go 侧解码/重建耗时明显下降；撤销清屏/断线补载联测通过 |
| **V2 帧预算调度 S3** | 02/15 – 03/05 | 任务分类与投递语义（`reliable` / `latest-wins` / `replaceable`）；`WorkerTaskScheduler` 演进为带配额公平与老化；`SceneCore` 协作式安全点 + staging 原子发布 revision；`FramePlan` 合并中间帧 | 10k/100k 历史重算期间持续输入的最坏服务时延可控；不暴露半状态；调度模拟器 property tests 通过 |
| **V3 增量物化与水位** | 03/08 – 03/19 | 统一 `RoomSeq / SceneRevision / PresentedRevision / dispatchSeq` 四个水位；增量计算 `RenderIRDelta`（取代整帧 `JSON.stringify` diff）；严格 Pending 依赖语义；统一 `SceneHost/Worker` 状态机 | 任意 trace 可追踪操作接收/物化/呈现状态；9 类 V2 操作 golden fixture 固化 |
| **V4 数据面与后端** | 03/22 – 04/02 | 服务端因果依赖超时与恢复（H49/H50 源头）；Actor 与慢快照构造进一步解耦及背压公平；按剖析证据决定是否投入二进制批量操作传输 | 缺失创建记录的合法乱序与永久缺失边界明确；高负载下正常交互与管理通知不阻塞 |
| **V5 容量与收口** | 04/05 – 04/16 | 25w/50w/100w 点隔离容量评估（H10）；跨浏览器一致性矩阵；更新 `aevia-project-guide` 与 V3 能力矩阵；完整门禁（`quick` + `doctor` + `ci`） | 明确容量与设备边界文档；受管源码与功能/模块义务清单全部合规 |

---

## 3. 明确排除事项

- **RSEC（Rust/WASM）**：`crates/rsec`、WASM ABI、TS/Rust 差分。
- **WebGPU**：`RendererHost` 多后端热切换、WebGPU stroke/pipeline/atlas、Auto 渲染策略、S3-08 GPU 调度、服务端 `renderComplexity` 渲染策略 Hint。
- **共享 WASM Memory Ring**：依赖 RSEC，排除；现有 SPSC SAB Ring 维持现状及回退机制。
- **轨迹预测（H37）**：用户已否决移除，不重引。
- **完整离线创作（BACK-13）、多实例集群（BACK-07）、插件 Host（PROD-06）**：独立产品路线，不纳入本排期。

---

## 4. 执行状态记录（2026-11-26）

- **P0 剖析收尾**：已完成（[aevia-p0-profile-report-2026-11-26.md](./aevia-p0-profile-report-2026-11-26.md)）。
- **P1 热点优化**：已完成（[aevia-p1-perf-report-2026-11-26.md](./aevia-p1-perf-report-2026-11-26.md)）。
- **P2 第二轮走查**：已完成（[aevia-p2-stability-report-2026-11-26.md](./aevia-p2-stability-report-2026-11-26.md)）。
- **V1 历史 Checkpoint**：已完成（[aevia-v1-checkpoint-report-2026-11-26.md](./aevia-v1-checkpoint-report-2026-11-26.md)）。
- **V2 帧预算调度 S3**：已完成（`taskTypes.ts`、`workerTaskScheduler.ts`、`canvasWorker.ts` 与 PRNG 属性测试）。
- **V3 增量物化与水位**：已完成（[aevia-v3-architecture-notes-2026-11-26.md](./aevia-v3-architecture-notes-2026-11-26.md)）。
- **V4 数据面与后端**：已完成（[aevia-v4-backend-reliability-report-2026-11-26.md](./aevia-v4-backend-reliability-report-2026-11-26.md)）。
- **V5 容量与收口**：已完成（[aevia-v5-capacity-and-gates-report-2026-11-26.md](./aevia-v5-capacity-and-gates-report-2026-11-26.md)）。
