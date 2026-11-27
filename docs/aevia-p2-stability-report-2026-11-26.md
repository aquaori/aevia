# Aevia P2 第二轮稳定性走查与组合验收报告（2026-11-26）

> 对应计划阶段：**P2 第二轮稳定性复查与组合回归**（[aevia-roadmap-2026-11.md](./aevia-roadmap-2026-11.md)）。  
> 台账来源：`Aevia_全仓走查台账_第一轮修复中_04.xlsx`（H01–H60、R01–R10）。

---

## 1. 组合与回归自动化核实矩阵

| 台账范围 | 覆盖重点 | 自动化验证证据 | 状态 |
|---|---|---|---|
| **H03 / H49 / H50** | 缺失 `element.create` 依赖隔离 + 后续补齐收拢（path 追加 + `text.patch`） | [`sceneCore.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/scene/sceneCore.spec.ts)（新增 H49/H50 隔离与迟到创建收敛用例） | 本地通过 |
| **H04 / H05 / H48 / H53** | 双端清屏、清屏后立即继续绘制、新端入房过滤、撤销清屏并重放恢复 | [`clear-undo-large`](file:///d:/code/web/collaborative-whiteboard/tests/profile/run.ts)（P0 `d4e7da41` n=5 `replayDifference <= 0.002`）；[`stability_combination_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/stability_combination_test.go) (`TestMultiClientClearUndoAndImmediateDrawConverge`)；[`scene_validation_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/scene_validation_test.go) | 本地通过 |
| **H09** | 发送未 ACK 断线 / IndexedDB 持久恢复 / 重连后原 `opId` 落盘且不重复 | [`pending-refresh-recovery`](file:///d:/code/web/collaborative-whiteboard/tests/profile/run.ts)（P0 `db22e789` n=5 0 error）；[`pending-scene-recovery.browser.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/tests/browser/pending-scene-recovery.browser.spec.ts) | 本地通过 |
| **H13–H29 / R01 / R06** | 擦除拖动、局部重绘与前缀缓存等效、双线图形、铅笔纹理、撤销残留、文本/便签 IME 与边框缩放 | [`scene-dirty-render.browser.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/tests/browser/scene-dirty-render.browser.spec.ts)（22/22 通过）；`tools-matrix`（P0 `e137c99d` n=5 0 error）；[`room-text-editor.browser.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/tests/browser/room-text-editor.browser.spec.ts)（7/7 通过） | 本地通过 |
| **H43 / H44 / H45 / H46 / H52 / H54** | 成员踢出会话失效、跨用户 historyGroup 防碰撞、排队期撤权、房删并发与同号重建零泄露、角色变更同步与重启重连 | [`account_handlers_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/account_handlers_test.go)；[`registry_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/room/registry_test.go)；[`stability_combination_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/stability_combination_test.go) (`TestDeleteRoomAndRecreateSameIDKeepsCleanStateAndRevokesOldTokens`)；`account-room-flow` | 本地通过 |
| **H51 / H59** | 发送队列背压下 `page-history` 可靠投递；旧版 `page-change-done` 结束依赖检查暂停 | [`snapshot_builder_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/room/snapshot_builder_test.go)；[`collabCommandHandlers.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/service/collabCommandHandlers.spec.ts)（21/21 通过） | 本地通过 |
| **H55 / H58** | 多人同时文本编辑 + 远端撤销/删除 + IME 组合期延迟刷新 + 收敛哈希 | [`sceneCore.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/scene/sceneCore.spec.ts)（新增 H55/H58 收敛用例）；[`room-text-editor.browser.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/tests/browser/room-text-editor.browser.spec.ts)（新增 IME 远端撤销/删除组合用例） | 本地通过 |
| **H56 / H60** | 热路径列表物化消减；Worker `presentedRevision` 水位修复 | P1 报告 [`aevia-p1-perf-report-2026-11-26.md`](./aevia-p1-perf-report-2026-11-26.md)；[`canvasWorker.unit.spec.ts`](file:///d:/code/web/collaborative-whiteboard/apps/frontend/src/workers/canvasWorker.unit.spec.ts)（2/2 通过） | 本地通过 |
| **H57（CORS DELETE）** | 网关源码对 `OPTIONS /v2/rooms/{roomId}` + `Access-Control-Request-Method: DELETE` 的预检响应头校验 | [`middleware.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/middleware.go)（显式返回 `GET, POST, PATCH, DELETE, OPTIONS`）；[`middleware_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/middleware_test.go)（新增 `DELETE` 预检断言） | 源码中间件已确认；线上反代/Ingress 需部署侧核查 |

---

## 2. 本轮新增与运行结果

- **后端 Go**（`go test -count=1 ./internal/gateway ./internal/room ./internal/storage ./internal/domain`）：4 个核心包全部 `ok`（含新增 [`stability_combination_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/stability_combination_test.go) 与 [`middleware_test.go`](file:///d:/code/web/collaborative-whiteboard/apps/backend/internal/gateway/middleware_test.go) 断言）。
- **前端单元与集成**（`vitest run`）：`sceneCore.spec.ts` 12/12、`pendingSceneStore.spec.ts` 1/1、`roomCollabTransport.spec.ts` 10/10、`collabCommandHandlers.spec.ts` 21/21、`roomComponents.spec.ts` 5/5 全部通过。
- **浏览器专项**（Playwright Chromium）：`scene-dirty-render.browser.spec.ts` 22/22、`room-text-editor.browser.spec.ts` 7/7 以及全套 `test:browser` 均通过。

---

## 3. 本机覆盖边界与无法替代真机的差异声明

- **未在本次本地运行覆盖的环境**：真实手机端/触控笔硬件输入与弱网（R02/R06/R08）、Microsoft Edge DevTools Performance 面板历史崩溃环境（H02）、以及线上生产反代对 `OPTIONS` `DELETE` 的覆盖改写（H57）。
- **COOP/COEP 共享内存（H34）**：仓库内单元/Vite 已覆盖回退与配置路径，线上托管响应头未作修改。
- **R04（高密度积压）**：将在后续 **V2（S3 公平调度）**、**V3（增量物化与水位）**、**V4（服务端因果/快照解耦）** 中从根本架构进一步消除剩余偶发毛刺并补齐端到端门禁。
