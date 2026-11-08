# Aevia 协同白板项目实现手册

---

## 0. 当前快照

```yaml
project_name: Aevia
repository_name: collaborative-whiteboard
domain: real-time collaborative whiteboard
monorepo: npm workspaces
frontend: apps/frontend, Vue 3 + TypeScript + Vite + Pinia + Canvas
backend: apps/go-backend, Go 1.24, net/http, coder/websocket, modernc sqlite
shared_protocol: packages/shared, TypeScript types and page normalization helpers
primary_dev_command: npm run dev:go
go_backend_port_default: 4647
go_backend_db_default: data/whiteboard-go.sqlite
document_updated_for: Go backend as the only current backend
```

如果本文与源码冲突，以源码为准。本文尽量写“实现事实”，但项目仍在演进，改代码前应重新打开对应文件确认。

### 0.1 一句话

Aevia 是一个以 `Command` 日志为正式数据、以 Canvas 重放为视觉结果的多人协同白板。前端负责编辑体验、渲染和协同状态接入；Go 后端负责房间准入、WebSocket 会话、按房间串行化操作、SQLite 持久化、页面快照流、二进制热路径、限流和降级保护。

### 0.2 现行入口

最重要的文件：

| 区域 | 文件 |
|---|---|
| 前端组合根 | `apps/frontend/src/views/RoomView.vue` |
| 前端命令状态 | `apps/frontend/src/store/commandStore.ts` |
| 前端绘制输入 | `apps/frontend/src/controllers/roomPointerController.ts` |
| 前端协同连接 | `apps/frontend/src/service/roomCollabTransport.ts` |
| 前端远端消息处理 | `apps/frontend/src/service/collabCommandHandlers.ts` |
| 前端 Worker 桥 | `apps/frontend/src/service/renderWorkerBridge.ts` |
| 前端 Worker | `apps/frontend/src/workers/canvasWorker.ts` |
| Go 进程入口 | `apps/go-backend/cmd/aevia-go-backend/main.go` |
| Go HTTP 路由 | `apps/go-backend/internal/gateway/server.go` |
| Go WebSocket | `apps/go-backend/internal/gateway/ws_handler.go` |
| Go WS 消息解码 | `apps/go-backend/internal/gateway/ws_messages.go` |
| Go 房间 actor | `apps/go-backend/internal/room/actor.go` |
| Go 房间事件 | `apps/go-backend/internal/room/events.go` |
| Go 持久化写入 | `apps/go-backend/internal/room/persistence.go`、`internal/storage/writer.go` |
| Go 快照和流 | `internal/room/snapshot_builder.go`、`internal/room/stream_send.go` |
| Go 点索引 | `internal/room/index.go` |
| Go 领域模型 | `internal/domain/types.go` |
| 二进制协议 | `internal/protocol/realtime.go`、`internal/protocol/render_chunk.go` |
| 前端共享类型 | `packages/shared/src/types/collab.ts` |

旧 `apps/backend` 是 Node 版本遗留目录，本文不再按现行后端解释它。以后清理旧目录时，不应再以旧 Node 后端补写文档。

---

## 1. 用户能做什么，以及每个功能在哪里实现

### 1.1 创建和加入房间

用户在 `HomeView.vue` 输入或生成六位房间号。前端通过 `VITE_API_URL` 调 Go 后端：

- `GET /generate-room-id`：后端查询 SQLite，生成未占用的六位房间号。
- `GET /check-room?roomId=...`：检查房间是否存在。
- `POST /create-room`：创建房间，初始化 `total_page=1`。
- `POST /join-room`：校验房间、密码和用户名，签发 session token。

Go 实现位于 `internal/gateway/room_handlers.go`。`createRoom` 会先用 `auth.HashPassword` 处理房间密码，再调用 `storage.Store.CreateRoom`。`joinRoom` 读取房间，调用 `auth.VerifyPassword`，然后用 `TokenService.Sign` 生成 token。返回字段同时有 `sessionToken` 和 `token`，这是为了兼容前端已有调用。

前端把 token、过期时间、userId、username 等存入 `userStore.ts`，持久化在 sessionStorage。`/room` 路由不从 URL 拿房间号，房间身份主要依赖 session token。

### 1.2 邀请链接

房间内点击分享时，前端通过 `sessionApi.ts` 调：

- `GET /generate-share-token`：需要 Bearer session token。
- `GET /get-token-info?token=...`：邀请页读取房间名、房间号、是否需要密码。

Go 的 invite token 和 session token 都由 `internal/auth/token.go` 实现，区别在 claims 里的 `tokenType`。`get-token-info` 只接受 `invite` 类型 token；`/ws` 和 protected HTTP 只接受 `session` 类型 token。

### 1.3 绘制

绘制从 `RoomView.vue` 的主 canvas 事件开始：

```text
pointerdown -> roomPointerController.startDrawing
pointermove -> roomPointerController.draw
pointerup/cancel -> roomPointerController.stopDrawing
```

`roomPointerController.ts` 会把浏览器 pointer 事件转成白板点：

1. 用 `interactionController.getCoordinates` 算出 canvas 内像素坐标和压力。
2. 用 `strokeInputSampler` 合并 coalesced pointer events，并按像素间距采样。
3. 用 `simplifyStrokeSamples` 做轻量简化。
4. 用 `useLamportStore().getNextLamport()` 给每个点分配 Lamport。
5. 把像素坐标除以当前 logical canvas width/height，变成 `0..1` 的归一化 `Point`。
6. 本地立即增量渲染。
7. 通过 `localCommandService` 和 `roomCollabTransport` 发 WebSocket。

第一次真正落笔不是在 pointerdown 立刻提交完整命令，而是有一个 `pendingStrokeStart`。如果只有一个点，会在 force flush 时提交；如果后续点到达，就在第一帧 `commitPendingStrokeStart` 中发 `cmd-start`。这样可以更稳地处理触控笔起笔压力。

### 1.4 实时协同

前端 `roomCollabTransport.ts` 建立 WebSocket：

```text
wsBase = VITE_WS_URL 或 ws://127.0.0.1:4646/ws
url = /ws?pageId=<currentPageId>[&lastRoomSeq=<lastRoomSeq>]
subprotocol = session token
binaryType = arraybuffer
```

Go 后端 `ws_handler.go` 从 `Sec-WebSocket-Protocol` 取 token，校验 token、房间、房间创建时间，再用 `room.Registry.Get` 找到或创建房间 actor。连接被封装成 `wsClient`，包含：

- `conn`：coder/websocket 连接。
- `claims`：userId、userName、roomId、roomCreatedAt。
- `pageID`：当前页。
- `send`：该客户端的出站 channel。
- `events`：WS 事件限流器。
- `limits`：点数、批量命令数量等 payload 限制。

每个连接有一个读循环和一个写循环。读循环把 JSON 或二进制帧转交给 actor；写循环从 `send` channel 取 `Outbound`，发送 JSON、预编码 text 或 binary，并每 25 秒 ping。

### 1.5 远端光标和框选

`mouseMove` 在前端默认走二进制帧，只发送 pageId、x、y。服务端收到后补上可信的 userId/userName，再广播给其他客户端。前端 `collabPresenceHandlers.ts` 更新 `remoteCursors`。Overlay canvas 在 `roomCanvasOverlay.ts` 里绘制远端光标、框选矩形、拖拽和缩放预览。

`box-selection` 仍走 JSON，内容包含选择框或空值。Go actor 把用户身份覆盖成 token 内身份，避免客户端伪造其他用户。

### 1.6 撤销、重做、删除、清屏

前端 `roomCommandController.ts` 调 `localCommandService.ts`。本地先改 store 或生成 clear 命令，再通过 WebSocket 发：

- `undo-cmd`：把目标命令 `isDeleted` 设为 true。
- `redo-cmd`：把目标命令 `isDeleted` 设为 false。
- `delete-cmd`：从命令集合移除。
- `push-cmd` 且 command type 为 `clear`：清掉页面旧命令，保留清屏命令本身。

Go actor 对 `undo/redo` 是更新命令 JSON 并持久化，对 `delete` 是删除命令记录，对 `clear` 是按 page 删除 commands 表中的记录。广播后前端根据脏区或场景刷新重绘。

### 1.7 选择、拖拽和缩放

选择工具也是 `roomPointerController` 处理，但分支完全不同：

1. `currentTool === "cursor"` 时，pointerdown 调 `interactionController.beginCursorInteraction`。
2. 如果命中选择框控制柄，进入 `dragging` 或 `resizing`。
3. 如果命中空白，进入 `box-selecting`。
4. 拖拽前可能需要 `hydrateCommandPoints`，因为 Offscreen 模式下命令点可能只在 worker scene 中，前端 store 里的 `points` 被置空以降低内存。
5. pointermove 期间只做本地预览和 worker 同步。
6. pointerup 时发送 `cmd-batch-stop`，包含每个命令的新 points 和 box。

Go 后端 `batch_events.go` 处理 `cmd-batch-move`、`cmd-batch-update`、`cmd-batch-stop`。当前前端最终变换主要发送 `cmd-batch-stop`，服务端会替换命令点集并持久化。

### 1.8 多页面

页面编号在代码里是从 0 开始。共享 helper `statePageToProtocol` 和 `protocolPageToState` 目前都保持 0-based，只做整数化和非负保护。

前端 `RoomPagination.vue` 显示上一页/下一页/总览，`roomPageService.ts` 负责：

- `goToPage(index)`：切页并发送 `page-change`。
- `addPageAndOpenLast()`：发送 `cmd-page-add`。
- `requestCurrentPageResync()`：当前页重新请求。

Go actor 收到 `page-change` 后调用 `SnapshotBuilder.PageChange`。它根据客户端传来的 `clientLoadedPageIds` 和配置里的 `PageCacheRadius` 算：

```text
next window = current page +- radius
load = next - previous
unload = previous - next
```

然后发送 `page-change-meta`、render 二进制点块、commands JSON 块和 `page-change-complete`。前端用 requestId、snapshotVersion 丢弃过期或串流错位的数据。

### 1.9 页面总览和在线成员

页面总览是 HTTP：

- 前端 `pageOverviewService.ts` 调 `GET /get-page-review`。
- Go `page_review_handler.go` 需要 session token。
- actor 的 `State.PageReview()` 遍历在线 `Clients`，按 pageId 统计协作者数量，再返回 totalPage 和每页 collaboratorCount。

成员列表走 WebSocket：

- 前端打开成员面板时发送 `get-member-list`。
- actor 返回当前 `OnlineMembers()`。
- `OnlineMembers()` 按 userId 去重，输出 `[userId, userName]` 列表。

---

## 2. 仓库结构和运行方式

### 2.1 目录

```text
collaborative-whiteboard/
  apps/
    frontend/
      src/
        components/      房间 UI 组件
        controllers/     用户动作编排
        service/         协同、渲染、分页、会话 API
        states/          room 内部响应式状态工厂
        store/           Pinia store
        utils/           类型、几何、事件总线
        views/           Home / Invite / Room
        workers/         canvasWorker
      tests/             browser、bench、external e2e
    go-backend/
      cmd/aevia-go-backend/main.go
      internal/
        auth/            token 和密码
        config/          env 配置
        domain/          Room/Command/Point
        gateway/         HTTP/WS 边界
        protocol/        二进制协议
        room/            actor、状态、快照、广播
        storage/         SQLite store、writer、migration
    backend/             Node 后端遗留目录，非本文现行后端
  packages/shared/       前端共享类型和协议 helper
  scripts/               dev、benchmark 启动脚本
  tests/                 系统测试编排和报告聚合
```

### 2.2 常用命令

```bash
npm run dev:go
```

同时启动 Go 后端和前端。脚本会检测本机局域网 IP，把 `VITE_API_URL` 和 `VITE_WS_URL` 注入前端。默认：

- Go 后端端口：`4647`
- Go SQLite：`data/whiteboard-go.sqlite`

只启动 Go 后端：

```bash
npm run dev:go-backend
```

只启动接 Go 后端的前端：

```bash
npm run dev:frontend:go
```

验证：

```bash
npm run build:frontend
go test ./...   # 在 apps/go-backend 下运行
npm run test:unit
npm run test:integration
npm run test:e2e:smoke
```

根 `package.json` 的 workspaces 仍只有 `apps/frontend`、`apps/backend`、`packages/shared`。这是迁移遗留状态，不代表 Node 后端仍是现行后端。涉及 Go 后端验证时应直接进入 `apps/go-backend` 运行 `go test ./...`，或使用 `dev:go` 相关脚本。

---

## 3. 核心数据模型

### 3.1 Point

前端共享定义在 `packages/shared/src/types/collab.ts`，Go 定义在 `internal/domain/types.go`。

```ts
interface Point {
  x: number;
  y: number;
  p: number;
  lamport: number;
}
```

- `x/y` 是归一化坐标，不是像素。
- `p` 是压力。
- `lamport` 是逻辑时间。

前端绘制时先得到像素坐标，再除以 logical canvas 宽高。渲染时再乘回当前画布尺寸。这样同一条命令可以适配不同 DPR 和窗口尺寸。

### 3.2 Command

```ts
interface Command {
  id: string;
  type: "path" | "clear";
  tool?: "pen" | "eraser";
  color?: string;
  size?: number;
  points?: Point[];
  timestamp: number;
  userId: string;
  roomId: string;
  pageId: number;
  isDeleted: boolean;
  lamport: number;
  box: { minX; minY; maxX; maxY; width; height };
}
```

`path` 表示一条笔迹或橡皮轨迹。`clear` 表示清屏命令。`isDeleted` 用于撤销/重做。`box` 是归一化 AABB，用于选择命中和脏区刷新。

Go 后端没有用强 struct 固定完整 Command 字段，而是 `CommandData`：

```go
type CommandData struct {
    fields map[string]any
    points []Point
}
```

这样做的效果是：Go 可以保留前端 Command JSON 中暂时不认识的字段，同时把 `points` 单独解析成强类型切片，方便追加、展平、排序和二进制编码。

### 3.3 FlatPoint

FlatPoint 是渲染和后端索引使用的展开点：

```ts
interface FlatPoint extends Point {
  cmdId: string;
  pageId: number;
  userId: string;
  tool: "pen" | "eraser";
  color: string;
  size: number;
  isDeleted: boolean;
}
```

Go 版多一个内部字段 `PointIndex`，不进 JSON，用于同一命令内排序：

```go
type FlatPoint struct {
    X, Y, P, Lamport float64
    CmdID string
    PageID int
    UserID string
    Tool string
    Color string
    Size float64
    IsDeleted bool
    PointIndex int `json:"-"`
}
```

`domain.FlattenCommandRange(cmd, startIndex)` 会从命令 points 中生成 FlatPoint，附上 tool/color/size/user/page/deleted。`PagePointIndex` 在 append 场景只展平新增点，避免每个 `cmd-update` 都重建整条命令的点索引。

### 3.4 顺序规则

FlatPoint 排序在 Go 中是：

```text
lamport asc
cmdId asc
pointIndex asc
```

前端 `commandStore` 排 Command 时是：

```text
command.lamport asc
command.id lowercase asc
```

这个模型可以准确表述为“中心化服务端协调下的 CRDT-inspired 确定性命令日志”。它不是完整 CRDT，因为移动、缩放、删除、持久化和冲突拒绝都依赖中心 actor 的顺序和判断。

---

## 4. 前端实现

### 4.1 RoomView 是手工依赖注入容器

`RoomView.vue` 不是普通页面组件。它创建所有 room 级对象，并把它们用闭包连起来：

1. 创建 session/ui/editor/interaction state。
2. 取 `commandStore` 和 `userStore`。
3. 创建 `canvasRuntime`，它需要调用 `workerBridge`。
4. 创建 `workerBridge`，它回调 `commandStore.updateLastSortedPoints` 和 `renderWithPoints`。
5. 创建 editor、collab、localCommand、command、page、tool、panel、header、keyboard controller。
6. 创建 pointer controller。
7. 创建 overlay renderer。
8. 创建 whiteboardSession 并 provide。
9. mount 时初始化生命周期，unmount 时销毁。

源码里有一些“先声明函数，函数体引用稍后初始化对象”的闭包，例如 `renderCanvas` 会引用 `workerBridge`。这不是 bug，实际执行发生在对象初始化完成之后。改初始化顺序时要看调用时机，而不是只看文本顺序。

### 4.2 room state

`states/` 里的文件不是全局 store，而是 RoomView 每次进入房间时创建的局部响应状态。

`roomSessionState.ts`：

- username、roomId、roomName。
- token、sessionExpiresAt。
- showNamePrompt、newName。
- onlineCount。
- reconnectFailed、reconnectFailureMessage。

`roomUiState.ts`：

- activeMenu。
- 快捷键弹窗、页面总览、成员列表。
- fullscreen。
- eraser cursor、size preview。
- toolbar collapsed，本地 localStorage 持久化。

`roomEditorState.ts`：

- currentTool。
- currentColor。
- currentSize。
- userId。
- currentPageId、totalPages。
- memberList。
- remoteCursors。

`roomInteractionState.ts`：

- isDrawing、activePointerId、currentDrawingId。
- selectionRect、remoteSelectionRects。
- selectedCommandIds、transformingCmdIds。
- dragging/resizing 过程中的 initialCmdsState、initialGroupBox、transformAnim。
- pointerHotState。

`pointerHotState` 是普通可变对象，保存当前路径点、待发送点、最近发送位置等高频数据。它故意不做 Vue 深响应，避免 pointermove 触发大量响应式开销。

### 4.3 commandStore

`commandStore.ts` 是前端命令状态 owner。核心结构：

```text
pageCommands: shallowRef<Map<number, Command[]>>
loadedPageIds: Ref<number[]>
commandMap: Map<string, Command>
pendingUpdates: Ref<Map<string, Point[]>>
currentCommandIndex: Ref<number>
lastSortedPoints: shallowRef<FlatPoint[]>
pendingRenderCallbacks: Map<string, callback>
```

为什么同时有 pageCommands 和 commandMap：

- `pageCommands` 按页面保存有序数组，配合页面窗口加载/卸载。
- `commandMap` 用于通过 cmdId 快速找命令，选择、更新、删除、undo 都依赖它。

插入命令：

1. 如果命令带 points，先 `markRaw`，避免 Vue 深代理大量点。
2. 如果 commandMap 已有 id，直接忽略。
3. 如果当前已经有 loadedPageIds，且命令 pageId 不在窗口内，忽略。
4. 在对应 page bucket 内按 Lamport/id 二分插入。
5. 更新 pageCommands 的 Map 引用，触发浅响应。
6. commandMap 写入同一个命令对象。

页面窗口替换：

- `replaceLoadedPageWindow(pageIds, commands)`：初始化时清空旧窗口，按 pageIds 建空桶，塞入 command，并把 command.points 置为 undefined。
- `applyLoadedPageDelta({ loadedPageIds, loadPageIds, unloadPageIds, commands })`：翻页时卸载旧页桶、创建新页桶、插入新页命令。

注意：初始化/翻页加载来的 command 会 `stripCommandPoints`。点主要通过 render 二进制块进入 worker；需要编辑某些命令时再从 worker hydrate points。

### 4.4 本地绘制链路

本地画一笔的真实过程：

```text
pointerdown
  -> start sampler
  -> 记录 pendingStrokeStart
  -> 不一定立刻提交命令

requestAnimationFrame
  -> commitPendingStrokeStart
  -> 生成 Command
  -> pushCommand(cmd, "start")
  -> 本地增量绘制第一个点

pointermove
  -> 读取 coalesced events
  -> sampler add
  -> rAF flushStrokeSamples
  -> 简化样本
  -> 每个样本生成 Point 和 Lamport
  -> renderIncrementalCommand
  -> 按压力策略决定是否发送 cmd-update

pointerup
  -> force flush
  -> 计算 command box
  -> pushCommand({ id, points: pendingPoints, box }, "stop")
  -> finishIncrementalCommand
```

`collabPressurePolicy.ts` 控制高频同步策略。服务端在压力升高时会广播 `server-pressure`，前端 `applyServerPressurePolicy` 调整 cursor 和 cmd-update 的最小间隔、点数阈值、简化容忍度等。

### 4.5 localCommandService

`localCommandService.ts` 是本地命令创建和发送的封装。它把局部 UI 动作翻译成协议消息：

- `pushCommand(..., "start")` 发 `cmd-start`。
- `pushCommand(..., "update")` 发 `cmd-update`。
- `pushCommand(..., "stop")` 发 `cmd-stop`。
- 普通一次性命令发 `push-cmd`。
- undo/redo/delete/clear/page add 分别发对应消息。

它也负责乐观更新：本地先插入命令、更新 index 或请求渲染，再等待服务端广播/ack。如果服务端返回 `op-rejected`，`collabCommandHandlers` 会撤销本地绘制状态、清除 pendingUpdates、必要时 resync 当前页。

### 4.6 WebSocket transport

`roomCollabTransport.ts` 负责连接生命周期，而不是具体业务消息语义。

连接前：

- 如果 token 快过期，先 `renewRoomSession`。
- 监听浏览器 online/offline。
- 如果开启 `VITE_ENABLE_DELTA_REPLAY=1` 且有 lastRoomSeq，重连 URL 带 `lastRoomSeq`。

发送：

- page-change 和 command 发送前会通过 shared helper 标准化 pageId。
- `mouseMove` 走 `encodeMouseMoveBinary`。
- `cmd-update` 走 `encodeCmdUpdateBinary`。
- 其他消息走 JSON `{ type, data }`。

接收：

- string：JSON.parse 后交 dispatcher。特殊处理 `server-pressure`、`server.draining`、render chunk meta。
- ArrayBuffer：先判断是否 realtime binary magic，是就 decode 成业务消息；否则必须依赖前一条 render chunk meta，把二进制点块交给 worker bridge。

重连：

- 最多 5 次。
- 指数退避，带 jitter。
- 浏览器 offline 时只显示重连状态，不盲目连。
- session 过期会清 token、停止重连、提示用户回首页。
- `server.draining` 会停止重连，因为服务端在维护或关闭。

### 4.7 dispatcher 和 command handlers

`collabMessageDispatcher.ts` 只是路由，把消息分给 command handlers 和 presence handlers。

`collabCommandHandlers.ts` 维护两个流状态：

- `initStreamState`
- `pageChangeStreamState`

这两个状态都包含：

- snapshotVersion。
- render chunk 顺序、期望数量、已完成集合。
- commands chunk 顺序、buffer、期望数量。
- pageId、loadedPageIds、totalPages。
- renderReady、commandsReady、completeReceived。

初始化时：

1. `init-meta` 设置 userId、roomId、roomName、onlineCount、memberList、totalPages。
2. 清空当前 loaded page window。
3. `beginInitRenderStream(pageId)`。
4. render meta + binary chunk 逐块进入 worker。
5. commands chunk 按 chunkIndex 缓冲，顺序齐了再 append。
6. render done 后 `finishInitRenderStream`。
7. commands done 后 `replaceLoadedPageWindow`。
8. complete + renderReady + commandsReady 后清理 stream state。

翻页时类似，但额外校验 requestId。旧请求的块即使晚到，也会被丢掉。

### 4.8 渲染路径

主内容 canvas 和 overlay canvas 分离：

- 主 canvas：正式白板内容。
- overlay canvas：远端光标、选择框、拖拽缩放预览。

主内容渲染优先走 Worker + OffscreenCanvas：

- `canvasRuntime` 管 viewport、resize、dirty rect 调度。
- `renderWorkerBridge` 负责主线程和 worker 消息。
- `canvasWorker.ts` 保存 worker scene，接收命令、FlatPoint、dirty rect、viewport。

如果浏览器不支持 OffscreenCanvas，退回主线程：

- `canvas.ts` 暴露 canvasRef、ctx、renderWithPoints、renderIncrementPoint。
- `strokeRasterizer.ts` 统一笔锋算法。

渲染有几种模式：

- 本地/远端新增点：`renderIncrementalCommand`。
- 单点命令：`renderSinglePointCommand`。
- 初始化/翻页：二进制 FlatPoint 流直接绘制。
- undo/delete/变换：dirty rect 或 scene refresh。
- resize/visibility restore：rerender scene。

### 4.9 脏区

`commandDirtyRect.ts` 根据 command.box 计算像素脏区。`dirtyRenderQueue.ts` 合并脏区。`canvasRuntime.requestDirtyRender` 会让 worker 做局部重绘；fallback 下主线程也有 `dirtyRedraw.ts`。

脏区不是只画矩形内的点。正确思路是：

1. 找到与脏区相交的命令或点段。
2. 清除脏区加 padding 的区域。
3. 在 clip 内重放受影响片段。

这样撤销一条历史笔迹、删除命令或变换时，不必全屏重放。

---

## 5. Go 后端实现

### 5.1 main.go 启动过程

`cmd/aevia-go-backend/main.go` 做的事非常直接：

1. `config.Load()` 读取环境变量。
2. 创建 slog logger，使用 `internal/console` 的彩色 handler。
3. `auth.ConfigureHashPool` 设置密码 hash 并发池。
4. `storage.Open(cfg)` 打开 SQLite。
5. `EnsureDefaultRoom` 确保默认房间存在。
6. `room.NewRegistry(store, cfg)` 创建房间 actor registry。
7. `gateway.NewServer(cfg, store, registry)` 创建 HTTP/WS server。
8. 配置 `http.Server` timeout 和 header 限制。
9. 可选启动 pprof server。
10. `net.Listen` 后 `Serve`。
11. 收到 SIGINT/SIGTERM 后：
    - `server.BeginDraining()`
    - 关闭 pprof 和 HTTP server
    - `registry.Shutdown`
    - `store.Flush`
    - `store.Close`

服务停止不是直接杀连接，而是先让所有 actor 广播 `server.draining`，前端收到后停止重连。

### 5.2 配置

`internal/config/config.go` 定义所有重要限额：

- 端口和 DB：`HOST`、`PORT`、`DB_PATH`。
- token：`JWT_SECRET`、`SESSION_TOKEN_TTL`、`INVITE_TOKEN_TTL`。
- 初始化：`INIT_PRELOAD_PAGE_COUNT`、`INIT_COMMAND_CHUNK_SIZE`、`INIT_FLAT_POINT_CHUNK_SIZE`。
- 翻页缓存：`PAGE_CACHE_RADIUS`。
- WS payload：`WS_MAX_PAYLOAD_BYTES`、`WS_JSON_MAX_BYTES`、`WS_MAX_POINTS_PER_COMMAND`、`WS_MAX_POINTS_PER_UPDATE`、`WS_MAX_BATCH_COMMANDS`。
- 出站队列：`CONNECTION_SEND_BYTES`、`CONNECTION_SEND_MESSAGES`。
- actor 队列：`ROOM_RELIABLE_QUEUE`、`ROOM_REALTIME_QUEUE`。
- DB writer：`DB_BATCH_SIZE`、`DB_BATCH_WINDOW_MS`。
- HTTP：`MAX_HTTP_BODY_BYTES`、`ALLOWED_ORIGINS`。
- 连接数：`MAX_CONNECTIONS`、`MAX_CONNECTIONS_PER_IP`、`MAX_CONNECTIONS_PER_ROOM`。
- 限流：HTTP、WS realtime、WS reliable 各自 rate/burst。
- 密码 hash：`HASH_POOL_SIZE`、`HASH_QUEUE_TIMEOUT_MS`。
- WAL：checkpoint interval/bytes/truncate bytes。
- `PPROF_ADDR`。

这些配置都带默认值和上下限。非法环境变量不会让服务启动失败，而是回退默认值。

### 5.3 HTTP gateway

`internal/gateway/server.go` 注册路由：

```text
GET  /health/live
GET  /health/ready
GET  /debug/metrics
POST /create-room
GET  /check-room
GET  /generate-room-id
POST /join-room
GET  /generate-share-token
GET  /get-token-info
GET  /get-page-review
POST /renew-room-session
GET  /ws
```

还注册了 v2 placeholders，表示未来 API 位置，但当前未实现。

路由外层包裹：

```text
withCORS(limitHTTPRate(limitBody(mux)))
```

`withSession` 从 Authorization Bearer 取 token，验证 `session` 类型 claims，然后把 claims 塞进 request context。

### 5.4 密码和 token

`internal/auth/password.go` 使用 Argon2id 格式存储密码 hash。`HashPassword` 受 hash pool 限制，避免大量并发创建/加入房间把 CPU 打满。空密码也会 hash，校验时用同一套逻辑。

`internal/auth/token.go` 自己实现了简洁 JWT：

- header/payload 使用 base64url。
- 签名使用 HMAC。
- claims 包含 userId、userName、roomId、roomName、roomCreatedAt、tokenType、passwordRequired、exp 等。
- `Verify(token, tokenType)` 会校验签名、过期时间和 tokenType。

### 5.5 WebSocket 准入

`gateway.websocket` 的准入顺序：

1. 如果 server draining，返回 503。
2. 校验 Origin。
3. 从 `Sec-WebSocket-Protocol` 取 session token。
4. 验 token。
5. 从 SQLite 读房间，确认 `RoomCreatedAt` 与 token claims 一致。这样同 ID 房间删除重建后，旧 token 失效。
6. 从 registry 获取 actor。
7. 按 IP、全局、房间申请连接额度。
8. `websocket.Accept`，禁用压缩。
9. `conn.SetReadLimit(WSMaxPayloadBytes)`。
10. 创建 `wsClient`。
11. `actor.Join`。
12. `room.SendInitStream` 给新客户端发初始化流。
13. `client.run` 进入读写循环。

连接关闭时会 `actor.Leave`，并释放连接计数。

### 5.6 wsClient 读写循环

`readPump`：

- `websocket.MessageBinary` -> `handleBinaryClientMessage`。
- `websocket.MessageText` -> `handleTextClientMessage`。

二进制只接受 realtime magic。当前二进制客户端输入包括：

- mouseMove。
- cmd-update。

JSON 消息会先反序列化为：

```go
type incomingMessage struct {
    Type string
    Data map[string]any
}
```

然后做 WS event limiter 和 payload limit。`page-change` 特殊走 `actor.PageChange`，其他走 `actor.Event`。

`writePump`：

- `Outbound.Binary` 直接发 binary。
- `Outbound.Text` 发 text。
- `Outbound.JSON` marshal 后发 text。
- 每 25 秒 ping。
- 如果收到 `Outbound{Close: true}`，用 TryAgainLater close。

### 5.7 房间 actor 模型

每个房间一个 `room.Actor`。这是 Go 后端的核心。

Actor 内部字段：

```go
roomID
store
cfg
inbox              reliable 消息 channel
realtime           高频消息 channel
realtimeWake
pendingRealtime    realtime 满了之后按 client+type 合并
done
state
builder
metrics
draining
pressureLevel
pressureLastSent
pressureLastMetrics
```

Actor 创建时从 SQLite 读取房间和所有 commands：

```text
store.GetRoom
store.ListCommands
NewState(roomData, commands)
NewPagePointIndex(commands)
go actor.loop()
```

actor.loop 是单线程事件循环：

```text
select:
  msg := <-inbox       -> handle reliable
  msg := <-realtime    -> handle realtime
  <-realtimeWake       -> flushMergedRealtime
  <-idleTimer.C        -> 无客户端则退出
```

可靠消息 channel 满了会拒绝并返回 `room actor busy`。高频 realtime channel 满了不会立刻拒绝，而是合并到 `pendingRealtime`，key 是 `clientID:type`，下一次 wake 再处理最后一条。这样光标类消息在压力下会丢中间态，保留最新态。

### 5.8 State

`room.State`：

```go
type State struct {
    Room     domain.Room
    Commands map[string]domain.Command
    Index    *PagePointIndex
    Clients  map[ClientID]ClientInfo
    RoomSeq  uint64
    ReadOnly bool
    Deltas   *DeltaBuffer
}
```

`RoomSeq` 是服务端房间序列号。每次持久化 mutation 会递增。它用于：

- snapshotVersion。
- op ack。
- delta replay。
- 前端 lastRoomSeq。

`Commands` 是 actor 内存里的权威命令 map。`Index` 是按页组织的 FlatPoint 索引。`Clients` 是当前 WS 连接。

### 5.9 事件处理

`events.go` 的 `handleClientEvent` 是消息分发中心：

| 消息 | 处理 |
|---|---|
| `push-cmd`、`cmd-start` | `handleCommandCreate` |
| `cmd-update` | `handleCommandUpdate` |
| `cmd-stop` | `handleCommandStop` |
| `undo-cmd`、`redo-cmd` | `handleUndoRedo` |
| `delete-cmd` | `handleDelete` |
| `cmd-batch-move` | `handleBatchMove` |
| `cmd-batch-update`、`cmd-batch-stop` | `handleBatchUpdate` |
| `cmd-page-add` | `handlePageAdd` |
| `mouseMove`、`mouseLeave`、`box-selection` | 补可信身份后广播 |
| `get-member-list` | 只回当前客户端 |

非实时写操作在 server draining 或 store degraded 时会被拒绝。

命令创建：

1. 从 `msg.Data["cmd"]` 解出 domain.Command。
2. 用 token identity 覆盖 userId/roomId。
3. clear 命令走 `persistClear`。
4. 其他命令走 `persistCommand`。
5. 根据 `cmd-start` 设置 `pushType=start`，否则 normal。
6. `recordAndBroadcast` 给其他客户端广播。
7. `ack` 给发送者。

命令 update：

1. 找 existing command。
2. `validateAppend` 检查目标存在、点数限制、append 合法性。
3. clone existing，把新 points append。
4. `persistCommand`，但 `Barrier=false`，允许 DB writer 批量异步落盘。
5. 如果原消息是二进制，优先复用原 frame 广播，减少 JSON 编解码。
6. 如果 JSON，广播 `push-cmd` + `pushType=update`。

命令 stop：

1. 追加最后 points。
2. 如果 nested cmd 带 box，更新 box。
3. `persistCommand` 且 `Barrier=true`，确保落盘完成后再 ack。
4. 广播 `pushType=stop`。

撤销/重做：

- clone command。
- 设置 `isDeleted`。
- barrier 持久化。
- 广播原消息类型，并附上最新 command snapshot。

删除：

- 从 State.Commands 和 Index 移除。
- SQLite 删除。
- 广播 `delete-cmd`。

加页：

- `TotalPage++`。
- SQLite 更新 rooms.total_page 和 durable_seq。
- 广播 `cmd-page-add`。

### 5.10 服务端排序和点索引

`PagePointIndex` 是 Go 后端初始化/翻页速度的关键。它按 page 保存一组有序块：

```go
type PagePointIndex struct {
    version  int
    pages    map[int]*pagePointBlocks
    locators map[string]commandPointLocator
}

type pagePointBlocks struct {
    blocks [][]domain.FlatPoint
}
```

每个 block 目标大小 2000 点。插入点时：

1. 对要插入的 FlatPoint 排序。
2. 找到应该插入的 block。
3. 在 block 内二分插入。
4. 如果 block 超过 4000，切成左右两个 block。

删除命令时：

1. 优先用 locators 找到 page。
2. 遍历该页 blocks，过滤 cmdId。
3. 移除空 block。
4. 合并过小 block。

append 优化：

如果同一 command 仍在同一 page，之前未删除，tool 没变，并且 pointCount 增加，则 `Upsert` 不会 remove+rebuild，而是 `FlattenCommandRange(cmd, oldPointCount)` 只插入新增点。

这个索引直接服务：

- `PagePoints(pageIDs)`：生成 FlatPoint 快照。
- `PagePointCount(pageIDs)`：计算 chunk 数。
- `ForEachPagePointChunk`：流式遍历点块，避免为单页一次性 flatten 全部点。

### 5.11 快照和初始化流

`SnapshotBuilder.Init(state, pageID)`：

1. 规范化 current page。
2. `initPageIDs(current, totalPage, InitPreloadPageCount)` 计算初始 loaded pages。
3. renderPageIDs 只包含当前页。
4. commandPageIDs 包含预加载窗口。
5. 从 `state.Index.PagePoints(renderPageIDs)` 取当前页 FlatPoint。
6. 从 `state.Commands` 取窗口内 Command。
7. 按配置 chunk。
8. 生成 `InitStream{SnapshotVersion, Meta, RenderChunks, CommandChunks}`。

实际发送有两条路径：

- `SendInitStream`：使用已经 build 好的 InitStream。
- `SnapshotBuilder.SendLiveInitStream`：直接从 index 和 state 流式发送，避免先构建所有 render chunks。

初始化消息顺序：

```text
init-meta
init-render-meta
repeat:
  init-render-chunk-meta
  binary render chunk
init-render-done
init-commands-meta
repeat:
  init-commands-chunk
init-commands-done
init-complete
```

render 先于 commands。用户可以先看到画面，之后再水合可编辑命令。

### 5.12 翻页流

`SnapshotBuilder.PageChange(state, req)`：

1. 目标页优先用 `NextPageID`，否则 `PageID`。
2. `previous = sanitizePageIDs(req.ClientLoadedPageIDs)`。
3. `next = adjacentPageIDs(current, totalPage, PageCacheRadius)`。
4. `load, unload = diffPageIDs(previous, next)`。
5. renderPageIDs 仍只渲染当前页。
6. commandPageIDs 只发 load 页面。

发送顺序：

```text
page-change-meta
page-change-render-meta
repeat:
  page-change-render-chunk-meta
  binary render chunk
page-change-render-done
page-change-commands-meta
repeat:
  page-change-commands-chunk
page-change-commands-done
page-change-complete
```

前端 pageChangeStreamState 只有 requestId 和 snapshotVersion 都匹配才处理。

### 5.13 Delta replay

如果前端开启 `VITE_ENABLE_DELTA_REPLAY=1`，重连 URL 会带 `lastRoomSeq`。actor.Join 时会问 `DeltaBuffer.Since(lastRoomSeq)`：

- 如果能取到最近 30 秒、64MB 范围内的增量，则发送 `delta-replay-meta`、逐条 delta、`delta-replay-complete`。
- 如果没有或过期，则走完整 init stream。

DeltaEvent 由 `recordAndBroadcast` 记录。二进制 update 可以作为 binary delta 保存，JSON 事件保存 type/data。

### 5.14 持久化

SQLite schema 在 `internal/storage/migrations.go`：

- `users`
- `auth_sessions`
- `rooms`
- `room_members`
- `room_role_capabilities`
- `commands`
- `operation_receipts`

当前白板主路径主要用：

- `rooms`
- `commands`
- `operation_receipts`

`commands` 表：

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
room_id TEXT
cmd_id TEXT
page_id INTEGER
type TEXT
payload TEXT
is_deleted INTEGER
revision INTEGER
room_seq INTEGER
created_at INTEGER
updated_at INTEGER
UNIQUE(room_id, cmd_id)
```

payload 是完整 Command JSON。Go actor 内存里也是完整 command。每次 update 会把完整 command payload 写回，所以大笔迹仍有写放大，只是 PagePointIndex 避免了内存点索引的完全重建。

### 5.15 DB writer

`storage.Writer` 是异步批量写队列：

```go
writes chan writeRequest
DBBatchSize
DBBatchWindow
```

写入方式：

- `wait=false`：入队就返回，由后台批量提交。`cmd-update` 用这个。
- `wait=true`：请求带 result channel，writer 会在 flush 后返回错误。`cmd-stop`、clear、delete、page-add 等 barrier 操作用这个。

writer loop：

1. 收集 writeRequest。
2. 到 batch size 或 ticker 或遇到 wait 请求时 flush。
3. `applyBatchWithRetry` 用事务提交。
4. 如果 batch 失败，拆成单条重试，定位失败写入。
5. 非瞬时错误会把 writer 标记 degraded。

actor 每次写前 `ensureWritable` 检查 degraded。如果 DB 不可用，房间进入 read-only，拒绝后续写操作，并广播 `resync.required`。

### 5.16 限流和压力

Go gateway 有三层保护：

1. HTTP keyed token bucket。
2. WS 连接数限制：全局、每 IP、每房间。
3. WS 事件限流：realtime 和 reliable 不同桶。

另外 actor 根据队列、慢客户端、drop/merge 情况计算 pressure。压力变化时广播 `server-pressure`。前端收到后动态放宽采样、降低 cursor 和 update 频率。

### 5.17 关闭和降级

`BeginDraining`：

- Server 设置 draining。
- Registry 通知所有 actor。
- Actor 广播 `server.draining`。
- 前端停止重连，提示维护。

慢客户端：

- `sendOutbound` 如果写不进客户端 send channel，会尝试发 `resync.required` 并 close。
- 这避免一个慢连接阻塞房间广播。

---

## 6. 二进制协议

### 6.1 realtime binary

Go：`internal/protocol/realtime.go`。前端：`apps/frontend/src/service/realtimeBinary.ts`。

Header：

```text
magic   uint32  0x43574252
version byte    1
type    byte
```

frame type：

- `1` mouseMove client。
- `2` mouseMove server。
- `3` command update。

client mouseMove payload：

```text
pageId uint32
x      float32
y      float32
```

server mouseMove payload：

```text
userIdLen   byte
userId      bytes
userNameLen byte
userName    bytes
pageId      uint32
x           float32
y           float32
```

cmd-update payload：

```text
cmdIdLen byte
cmdId    bytes
count    uint16
repeat count:
  x       float32
  y       float32
  p       float32
  lamport float64
```

后端收到二进制 cmd-update 后，如果验证通过，会尽量把原 frame 原样广播给其他客户端。

### 6.2 render chunk binary

Go：`internal/protocol/render_chunk.go`。

Header：

```text
magic           uint32 0x49524348
version         uint16 1
recordSize      uint16 22
snapshotVersion uint32
chunkIndex      uint32
pointCount      uint32
```

每个点 22 字节：

```text
x        float32
y        float32
p        float32
lamport  float64
cmdIndex uint16
```

点块不重复发送每个点的 command 样式。发送二进制块前，服务端先发 chunk meta，其中 `commands` 是字典：

```json
[
  {
    "cmdIndex": 0,
    "cmdId": "...",
    "userId": "...",
    "tool": "pen",
    "color": "#000",
    "size": 3,
    "isDeleted": false
  }
]
```

worker decode 时用 `cmdIndex` 查字典，还原 FlatPoint 样式。

---

## 7. 前后端协议消息

### 7.1 客户端发服务端

| type | data |
|---|---|
| `cmd-start` | `{ cmd, opId? }` |
| `cmd-update` | binary 或 `{ cmdId, points, opId? }` |
| `cmd-stop` | `{ cmdId, points, cmd?, opId? }` |
| `push-cmd` | `{ cmd, opId? }`，普通命令或 clear |
| `undo-cmd` | `{ cmdId, opId? }` |
| `redo-cmd` | `{ cmdId, opId? }` |
| `delete-cmd` | `{ cmdId, opId? }` |
| `cmd-batch-move` | `{ cmdIds, dx, dy, opId? }` |
| `cmd-batch-update` | `{ updates, opId? }` |
| `cmd-batch-stop` | `{ updates, boxes?, opId? }` |
| `cmd-page-add` | `{ opId? }` |
| `page-change` | `{ requestId, prevPageId, nextPageId, pageId, clientLoadedPageIds }` |
| `mouseMove` | binary，pageId/x/y |
| `mouseLeave` | JSON |
| `box-selection` | JSON |
| `get-member-list` | `{ roomId }` |

Go 会用 token 覆盖身份。不要相信客户端 data 里的 userId。

### 7.2 服务端发客户端

| type | 说明 |
|---|---|
| `init-meta` | 会话、房间、在线人数、快照、chunk summary |
| `init-render-meta` | 初始化 render 流开始 |
| `init-render-chunk-meta` + binary | 初始化 FlatPoint 点块 |
| `init-render-done` | 初始化 render 完成 |
| `init-commands-meta` | 初始化 command 流开始 |
| `init-commands-chunk` | Command JSON 块 |
| `init-commands-done` | Command 完成 |
| `init-complete` | 初始化整体完成 |
| `page-change-*` | 翻页流，结构同 init，带 requestId |
| `push-cmd` | 新命令、start/update/stop |
| `undo-cmd`、`redo-cmd` | 软删除状态变化 |
| `delete-cmd` | 命令删除 |
| `cmd-batch-move`、`cmd-batch-update`、`cmd-batch-stop` | 批量变换 |
| `cmd-page-add` | 新页面 |
| `mouseMove` | binary 或 JSON 远端光标 |
| `online-count-change` | 成员进出 |
| `get-member-list` | 成员列表 |
| `op-rejected` | 操作拒绝 |
| `server-pressure` | 服务端压力策略 |
| `server.draining` | 服务端关闭/维护 |
| `resync.required` | 客户端需要重同步 |
| `delta-replay-*` | 可选增量重放 |

### 7.3 op-rejected

服务端拒绝消息：

```json
{
  "type": "op-rejected",
  "data": {
    "opType": "cmd-update",
    "code": "COMMAND_NOT_FOUND",
    "reason": "Target command does not exist.",
    "cmdId": "...",
    "shouldRefresh": true,
    "shouldResync": false
  }
}
```

前端处理策略：

- 如果有 cmdId，清掉 pendingUpdates。
- 如果是本地正在画的 cmd-start 被拒绝，移除本地命令并取消当前 drawing。
- 对 update/stop/batch 类拒绝，通常触发当前页 resync。
- toast 显示 reason 和 code。

---

## 8. 典型链路还原

### 8.1 用户进入房间

```text
Home/Invite
  -> POST /join-room
  -> 保存 session token
  -> router.push("/room")

RoomView mounted
  -> roomLifecycleController.mount
  -> workerBridge.init
  -> roomCollabTransport.connect

Go /ws
  -> token 验证
  -> registry.Get(room)
  -> actor.Join(client, pageId, lastRoomSeq)
  -> SendInitStream

前端
  -> init-meta 设置 room/user/page 状态
  -> render binary chunks 先画出当前页
  -> command chunks 填充 loaded page window
  -> init-complete
```

### 8.2 画一笔

```text
pointerdown
  -> pendingStrokeStart

rAF
  -> cmd-start JSON
  -> 本地插入 command
  -> 本地增量画首点

Go actor
  -> persistCommand barrier? cmd-start path 为非 barrier
  -> State.UpsertCommandAtSeq
  -> PagePointIndex.Upsert
  -> broadcast push-cmd/start
  -> ack accepted

pointermove
  -> 多个 Point
  -> 本地增量画
  -> cmd-update binary

Go actor
  -> append points
  -> SaveCommandAtSeq wait=false
  -> PagePointIndex append 新点
  -> 原 binary frame 广播

pointerup
  -> flush pending points
  -> 计算 box
  -> cmd-stop JSON, wait=true
  -> finish stroke
```

### 8.3 远端收到这笔

```text
push-cmd/start
  -> normalizeCommandFromProtocol
  -> pendingUpdates 如果已有则补入
  -> insertCommand
  -> renderIncrement

binary cmd-update
  -> decodeRealtimeBinaryMessage
  -> pendingRemoteCommandUpdates 按 cmdId 合并
  -> rAF flush
  -> 找到 command 后 append points
  -> renderIncrement

push-cmd/stop
  -> flush 该 cmd pending updates
  -> append stop points
  -> finishIncrementalCommand
  -> Offscreen 下可把 command.points 置空
```

### 8.4 切页

```text
用户点下一页
  -> roomPageService.goToPage
  -> requestId++
  -> send page-change

Go actor
  -> SnapshotBuilder.PageChange
  -> 计算 load/unload/current
  -> send page-change stream

前端
  -> page-change-meta 校验 requestId
  -> applyRemotePageChange(page, total, deferRender)
  -> render binary chunks 画当前页
  -> commands chunks applyLoadedPageDelta
  -> complete 后清理 active request
```

---

## 9. 测试和基准

### 9.1 单测/模块测试

- `packages/shared/src/protocol/collabProtocol.spec.ts`：页面和命令协议 normalization。
- `apps/frontend/src/service/*.spec.ts`：二进制、脏区、worker bridge、笔锋采样。
- `apps/frontend/src/utils/geometry.spec.ts`：几何和 AABB。
- `apps/go-backend/internal/room/index_test.go`：PagePointIndex append/rebuild。
- `apps/go-backend/internal/...`：Go 后端可用 `go test ./...`。

### 9.2 浏览器测试

`apps/frontend/tests/browser/room-pagination.browser.spec.ts` 等使用 Vitest Browser + Playwright，适合验证 Vue 组件和真实 DOM/Canvas 能力。

### 9.3 外部 E2E / Benchmark

`apps/frontend/tests/e2e/external` 是外部黑盒测试 harness：

- `protocol-driver.ts`：通过 HTTP/WS 协议创建房间、加入、发送命令。
- `ui-driver.ts`：驱动真实页面。
- `canvas-observer.ts`：观察 canvas 像素。
- `performance-observer.ts`、`cdp-observer.ts`：性能和 CDP。
- `runner.ts`：suite runner。
- `suites.ts`：case 定义。

性能测试不是只看内部 hook，而是尽量用真实 Canvas 像素变化和浏览器行为判断用户是否真的看到内容。

### 9.4 Go benchmark 脚本

根脚本有：

```bash
npm run benchmark:go
```

它用于 Go 后端相关性能链路。具体跑前应打开 `scripts/benchmark-go.mjs` 看当前参数。

---

## 10. 修改时的耦合规则

### 10.1 改 Command / Point / FlatPoint

至少同步检查：

- `packages/shared/src/types/collab.ts`
- `packages/shared/src/protocol/collabProtocol.ts`
- `apps/frontend/src/utils/type.ts`
- `apps/frontend/src/service/realtimeBinary.ts`
- `apps/frontend/src/service/renderWorkerBridge.ts`
- `apps/frontend/src/workers/canvasWorker.ts`
- `apps/go-backend/internal/domain/types.go`
- `apps/go-backend/internal/protocol/realtime.go`
- `apps/go-backend/internal/protocol/render_chunk.go`
- `apps/go-backend/internal/room/index.go`
- `apps/go-backend/internal/storage/write_ops.go`

### 10.2 改 WebSocket 消息

至少检查：

- 前端发送：`roomCollabTransport.ts`、`localCommandService.ts`、`roomPageService.ts`。
- 前端接收：`collabMessageDispatcher.ts`、`collabCommandHandlers.ts`、`collabPresenceHandlers.ts`。
- Go 边界：`gateway/ws_messages.go`、`gateway/ws_limits.go`。
- Go actor：`room/events.go`、`room/batch_events.go`、`room/sequencing.go`。
- E2E protocol driver。

### 10.3 改初始化/翻页

至少检查：

- `room/snapshot_builder.go`
- `room/stream_send.go`
- `room/window.go`
- `room/index.go`
- `collabCommandHandlers.ts`
- `renderWorkerBridge.ts`
- `canvasWorker.ts`
- `roomPageService.ts`

关键是不破坏：

- requestId。
- snapshotVersion。
- render 与 commands 两阶段。
- binary chunk meta 后紧跟 binary frame 的配对关系。

### 10.4 改渲染

同时验证：

- OffscreenCanvas worker。
- 主线程 fallback。
- 本地增量画。
- 远端增量画。
- 初始化二进制流。
- dirty rect。
- overlay。
- resize 和 DPR。

### 10.5 改持久化

至少检查：

- `storage/migrations.go`
- `storage/write_ops.go`
- `storage/writer.go`
- `room/persistence.go`
- `room/state.go`
- `room/index.go`
- `room/delta_buffer.go`

注意 barrier 语义：不是所有写都等 SQLite。实时 update 主要靠内存 actor 先承接，DB writer 异步批量落盘。

---

## 11. 当前技术债和风险

1. Command 类型在前端 shared、前端 utils、Go domain 中仍有重复表达，协议字段变化要手动同步。
2. Go 后端 commands 表仍保存完整 JSON payload。高频 cmd-update 会重写整条命令，长笔迹下有写放大。
3. PagePointIndex 优化了内存点索引 append，但 SQLite payload 写入仍不是 append-only point log。
4. 用户权限模型仍偏房间级。服务端用 token 覆盖身份，但是否允许用户修改其他人的命令，需要看后续产品规则进一步收紧。
5. `users`、`auth_sessions`、`room_members`、`room_role_capabilities` 已有 schema，但当前房间加入主路径主要还是匿名 userId + room token，并未完整使用账号/角色体系。
6. 二进制 render chunk 的 command index 是 uint16。单个 chunk 的 command 字典如果极端超过 65535 个命令，需要协议升级。
7. Delta replay 依赖短 TTL 和内存 buffer，多实例部署时不能直接跨进程使用。
8. 当前 actor/registry 是单进程内存模型。多实例部署需要 sticky session 或外部 pub/sub 和共享 actor 状态。

---

## 12. 推荐阅读顺序

### 12.1 15 分钟理解项目

1. 本文第 0、1、3、5 节。
2. `apps/frontend/src/views/RoomView.vue`
3. `apps/frontend/src/controllers/roomPointerController.ts`
4. `apps/frontend/src/service/roomCollabTransport.ts`
5. `apps/go-backend/cmd/aevia-go-backend/main.go`
6. `apps/go-backend/internal/room/actor.go`
7. `apps/go-backend/internal/room/events.go`

### 12.2 前端编辑体验

1. `RoomView.vue`
2. `roomInteractionState.ts`
3. `roomPointerController.ts`
4. `interactionController.ts`
5. `localCommandService.ts`
6. `commandStore.ts`

### 12.3 前端渲染

1. `canvasRuntime.ts`
2. `renderWorkerBridge.ts`
3. `canvasWorker.ts`
4. `canvas.ts`
5. `strokeRasterizer.ts`
6. `dirtyRenderQueue.ts`
7. `dirtyRedraw.ts`

### 12.4 Go 后端

1. `main.go`
2. `gateway/server.go`
3. `gateway/ws_handler.go`
4. `room/registry.go`
5. `room/actor.go`
6. `room/events.go`
7. `room/persistence.go`
8. `room/index.go`
9. `storage/writer.go`

### 12.5 协议

1. `packages/shared/src/types/collab.ts`
2. `packages/shared/src/protocol/collabProtocol.ts`
3. `apps/frontend/src/service/realtimeBinary.ts`
4. `apps/go-backend/internal/protocol/realtime.go`
5. `apps/go-backend/internal/protocol/render_chunk.go`
6. `collabCommandHandlers.ts`
7. `room/stream_send.go`

---

## 13. 面试或项目介绍口径

### 13.1 30 秒

Aevia 是一个实时协同白板。前端用 Vue 3、Canvas、Pinia 和 Web Worker 实现绘制、选择、分页和渲染；后端已经重写为 Go，用每个房间一个 actor 的模型串行处理协同操作，用 SQLite 持久化命令日志。系统把笔迹建模为带归一化坐标、Lamport 时间和 AABB 的 Command，通过稳定排序和二进制 FlatPoint 流实现多人一致重放和快速首屏。

### 13.2 2 分钟

项目最核心的实现有三块。

第一是协同数据模型。白板不是同步图片，而是同步 Command。每条笔迹是一个 command，里面有归一化 points、Lamport 时间、pageId、样式和 box。前端和 Go 后端都按 Lamport、cmdId、pointIndex 稳定排序，所以不同客户端即使网络消息到达顺序不同，最终也能按同一顺序重放。

第二是 Go 后端 actor。每个房间对应一个 actor，actor 从 SQLite 载入房间和命令后，所有 WebSocket 写操作都进入这个 actor 的 channel，由它串行修改内存 State、更新 PagePointIndex、写 SQLite，并广播给其他客户端。高频 mouseMove 有独立 realtime channel，满了会合并最新状态；可靠写操作 channel 满了会拒绝，避免拖垮房间。

第三是渲染性能。初始化和翻页时，后端先发当前页 FlatPoint 二进制点块，前端 worker 先把画面画出来，再接收 commands JSON 水合可编辑状态。实时绘制走本地增量渲染和二进制 cmd-update。撤销、删除和变换尽量用 AABB dirty rect 局部重绘。OffscreenCanvas 可用时主画布在 worker 中渲染，不可用时有主线程 fallback。

### 13.3 不要夸大的说法

不要说：

- “这是完整 CRDT。”
- “后端只是转发。”
- “支持无限页面和无限用户。”
- “所有操作都是 O(1)。”
- “已经天然支持多实例部署。”

更准确说法：

- “CRDT-inspired 的确定性命令日志。”
- “Go 后端是准入、排序、持久化、快照和广播中心。”
- “actor 模型适合单进程房间串行化，多实例需要额外 pub/sub 或 sticky session。”
- “PagePointIndex 和二进制流优化了大房间首屏，但 command payload 仍有写放大。”

---

## 14. 给 AI 的任务提示模板

### 14.1 修绘制 bug

```text
请按当前 Go 后端版本理解 Aevia。先读：
- apps/frontend/src/views/RoomView.vue
- apps/frontend/src/controllers/roomPointerController.ts
- apps/frontend/src/service/strokeRasterizer.ts
- apps/frontend/src/service/renderWorkerBridge.ts
- apps/frontend/src/workers/canvasWorker.ts

同时考虑 OffscreenCanvas worker 和主线程 fallback。改动要小，优先写或运行最贴近的测试。
```

### 14.2 改协同消息

```text
这是跨前端和 Go 后端的协议变更。至少核对：
- packages/shared/src/types/collab.ts
- apps/frontend/src/service/roomCollabTransport.ts
- apps/frontend/src/service/collabCommandHandlers.ts
- apps/go-backend/internal/gateway/ws_messages.go
- apps/go-backend/internal/gateway/ws_limits.go
- apps/go-backend/internal/room/events.go
- apps/go-backend/internal/room/sequencing.go

明确消息方向、payload 限制、身份覆盖、actor 处理、持久化、广播、ack/reject 和旧客户端兼容性。
```

### 14.3 优化 Go 后端性能

```text
不要先重构。先说明目标是连接数、cmd-update 吞吐、首屏初始化、翻页、SQLite 写入还是慢客户端隔离。然后读：
- apps/go-backend/internal/room/actor.go
- apps/go-backend/internal/room/index.go
- apps/go-backend/internal/room/stream_send.go
- apps/go-backend/internal/storage/writer.go
- apps/go-backend/internal/room/pressure.go

先找现有 benchmark 或加最小测量，再做小改动。
```

### 14.4 清理旧 Node 后端

```text
目标是移除旧 apps/backend 并让 Go 后端成为唯一后端。先检查：
- package.json workspaces 和 scripts
- scripts/dev*.mjs
- vitest.config.ts
- tests/e2e/external/config.ts
- README.md
- AGENTS.md 和 aevia-skill.md

不要改前端业务逻辑，重点是脚本、测试配置、文档和 CI 路径。
```

---

## 15. 最终心智模型

```text
正式数据:
  page-bucketed Command log

前端输入:
  PointerEvent
    -> sampler/coalesced/simplify
    -> normalized Point + Lamport
    -> local incremental render
    -> WebSocket JSON start/stop 或 binary update

前端状态:
  commandStore:
    pageCommands + commandMap + pendingUpdates + loadedPageIds

前端渲染:
  OffscreenCanvas worker preferred
  main-thread fallback
  overlay canvas for cursors/selection
  dirty rect for correction

Go 后端:
  HTTP gateway
    -> session/invite token
    -> WebSocket accept
    -> room Registry
    -> one Actor per room

Room Actor:
  reliable inbox for writes
  realtime inbox for cursor-like messages
  in-memory State
  PagePointIndex
  SQLite writer
  broadcast and delta buffer

初始化/翻页:
  meta
    -> render FlatPoint binary stream
    -> command JSON stream
    -> complete

一致性:
  Lamport + cmdId + pointIndex deterministic replay
  central Go actor coordinates persistence and broadcast
```

如果只能记住一句话：

> Aevia 的核心不是“Canvas 画线”，而是“前端维护可编辑命令窗口和高性能渲染，Go 后端用房间 actor 串行化协同操作并维护可流式输出的 FlatPoint 索引，最终让所有客户端按同一命令日志确定性重放”。
