<script setup lang="ts">
	import { ref, onMounted, onUnmounted, computed, watch, toRaw, markRaw } from "vue";
	import { useRouter } from "vue-router";
	import { useLamportStore } from "../store/lamportStore";
	import { toast } from "vue-sonner";
	import {
		Pencil,
		Eraser,
		RotateCcw,
		RotateCw,
		Trash2,
		Plus,
		Copy,
		Check,
		Users,
		Keyboard,
		Maximize,
		Minimize,
		Palette,
		Monitor,
		X,
		MousePointer2,
		ChevronLeft,
		ChevronRight,
		LayoutGrid,
		Grip,
	} from "lucide-vue-next";
	import axios from "axios";
	import { v4 as uuidv4 } from "uuid";
	import { useUserStore } from "../store/userStore";
	import { useCommandStore } from "../store/commandStore";
	import { useWorkerStore } from "../store/workerStore";
	import { storeToRefs } from "pinia";
	import { reRenderDirtyRect, bufferDirtyPoint } from "../utils/dirtyRedraw";
	import { getCommandBoundingBox, getGroupBoundingBox } from "../utils/geometry";
	import {
		canvasRef,
		uiCanvasRef,
		ctx,
		uiCtx,
		renderIncrementPoint,
		renderPageContentFromPoints,
	} from "../service/canvas";
	import type { Point, FlatPoint, Command, RemoteCursor, LastWidthInfo } from "../utils/type";

	const workerStore = useWorkerStore();
	const { canvasWorker } = storeToRefs(workerStore);

	// 监听点位添加事件，用于脏矩形合并（DSU 优化）
	window.addEventListener("point-added", ((e: CustomEvent) => {
		const { point } = e.detail;
		bufferDirtyPoint(point);
	}) as any);

	onMounted(() => {
		workerStore.initWorker();
		startUILoop();
		const dpr = window.devicePixelRatio || 1;
		if (canvasRef.value && ctx.value) {
			const width = window.innerWidth;
			const height = window.innerHeight;
			canvasRef.value.width = width * dpr;
			canvasRef.value.height = height * dpr;
			canvasRef.value.style.width = width + "px";
			canvasRef.value.style.height = height + "px";
			ctx.value.scale(dpr, dpr);
			ctx.value.lineCap = "round";
			ctx.value.lineJoin = "round";
		}
		if (uiCanvasRef.value && uiCtx.value) {
			const width = window.innerWidth;
			const height = window.innerHeight;
			uiCanvasRef.value.width = width * dpr;
			uiCanvasRef.value.height = height * dpr;
			uiCanvasRef.value.style.width = width + "px";
			uiCanvasRef.value.style.height = height + "px";
			uiCtx.value.scale(dpr, dpr);
		}
		window.addEventListener("resize", resizeCanvas);
		window.addEventListener("keydown", handleKeydown);
		connectWebSocket();
	});

	onUnmounted(() => {
		if (canvasWorker.value) {
			canvasWorker.value.terminate();
		}
	});

	// 路由钩子，获取URL中的token参数
	const router = useRouter();
	const userStore = useUserStore();

	// --- 断线重连状态 (Reconnection State) ---
	const isIntentionalClose = ref(false);
	const isReconnecting = ref(false);
	const reconnectCount = ref(0);
	const MAX_RECONNECT = 5;
	const RECONNECT_INTERVAL = 1000;
	const reconnectFailed = ref(false);
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const doReconnect = () => {
		if (isIntentionalClose.value) return;
		if (reconnectCount.value >= MAX_RECONNECT) {
			isReconnecting.value = false;
			reconnectFailed.value = true;
			return;
		}

		isReconnecting.value = true;
		reconnectCount.value++;

		if (reconnectTimer) clearTimeout(reconnectTimer);

		reconnectTimer = setTimeout(() => {
			connectWebSocket();
		}, RECONNECT_INTERVAL);
	};

	const retryReconnect = () => {
		reconnectFailed.value = false;
		isReconnecting.value = false;
		reconnectCount.value = 0;
		doReconnect();
	};

	// --- 状态管理 (State) ---

	// 用户名：优先从本地存储获取，没有则为空
	const username = ref(localStorage.getItem("wb_username") || "");
	// 房间ID：优先从路由中获取，如果没有则为空
	const roomId = ref("");
	// 房间名：优先从路由中获取，没有则为空
	const roomName = ref("");
	// token：优先从Pinia中获取，没有则为空
	const token = ref(userStore.token || "");
	// 是否显示名字输入弹窗：如果本地没有用户名，则显示弹窗
	const showNamePrompt = ref(!username.value);
	// 新名字的临时变量
	const newName = ref("");
	// 在线人数
	const onlineCount = ref(0);

	// --- UI状态控制 (UI State) ---
	// 当前激活的菜单 (画笔设置 / 橡皮设置 / 颜色盘 / 更多菜单)
	const activeMenu = ref<"pen" | "eraser" | "color" | "more" | null>(null);
	// 是否显示快捷键指南面板
	const showShortcuts = ref(false);
	// 是否处于全屏模式
	const isFullscreen = ref(false);
	// 是否已复制链接 (用于显示提示动画)
	const hasCopied = ref(false);
	// 是否显示橡皮擦的光标轮廓 (仅在鼠标悬停时显示)
	const showEraserCursor = ref(false);
	// 是否显示笔触大小预览圆点
	const showSizePreview = ref(false);
	// 是否显示页面概览视图
	const showPageOverview = ref(false);

	// --- 协作成员列表状态 ---
	const showMemberList = ref(false);
	const memberList = ref<[string, string][]>([]); // [userId, userName]

	const openMemberList = () => {
		showMemberList.value = true;
		activeMenu.value = null; // 关闭当前的下拉菜单
		if (socket.value && socket.value.readyState === WebSocket.OPEN) {
			socket.value.send(
				JSON.stringify({
					type: "get-member-list",
					data: { roomId: roomId.value },
				})
			);
		}
	};

	// 光标实时坐标 (用于渲染自定义光标)
	const cursorX = ref(0);
	const cursorY = ref(0);
	// 鼠标移动冷却时间 (防止频繁发送鼠标移动事件)
	const mouseMoveCD = ref(false);
	// 工具栏收缩状态
	const isToolbarCollapsed = ref(localStorage.getItem("wb_toolbar_collapsed") === "true");

	watch(isToolbarCollapsed, (val) => {
		localStorage.setItem("wb_toolbar_collapsed", val.toString());
	});

	// --- 画布核心状态 (Canvas State已解耦至 service/canvas.ts) ---

	// 标记是否正在绘画中 (鼠标/手指按下状态)
	const isDrawing = ref(false);
	// 锁定当前的指针ID (防止多指触控冲突)
	const activePointerId = ref<number | null>(null);
	// 当前选中的工具 (画笔 / 橡皮 / 鼠标)
	const currentTool = ref<"pen" | "eraser" | "cursor">("pen");
	// 当前画笔颜色
	const currentColor = ref("#000000");

	// --- 工具尺寸管理 (Tool Size) ---
	// 分开管理画笔和橡皮的粗细，避免切换工具时互相干扰
	const penSize = ref(5); // 默认画笔粗细
	const eraserSize = ref(15); // 默认橡皮粗细
	// 计算属性：当前激活工具对应的粗细，支持 v-model 修改
	const currentSize = computed({
		get: () => (currentTool.value === "eraser" ? eraserSize.value : penSize.value),
		set: (val) => {
			if (currentTool.value === "eraser") eraserSize.value = val;
			else penSize.value = val;
		},
	});

	// 当前正在绘制的命令ID
	const currentDrawingId = ref<string | null>(null);

	// 画布状态标识
	const userId = ref(""); // Mock User ID
	const currentPageId = ref(0); // Mock Page ID
	const totalPages = ref(1); // 总页数

	// WebSocket Instance
	const socket = ref<WebSocket | null>(null);

	// --- 撤销/历史记录系统 (命令模式) ---

	const commandStore = useCommandStore();
	// 统一使用 Store 中的状态，并通过 storeToRefs 保持响应性
	const { commands, lastSortedPoints, pendingUpdates, currentCommandIndex } =
		storeToRefs(commandStore);
	const commandMap = commandStore.commandMap;
	const pendingRenderCallbacks = commandStore.pendingRenderCallbacks;
	const updateLastSortedPoints = commandStore.updateLastSortedPoints;
	const insertCommand = commandStore.insertCommand;
	const clearClearedCommands = commandStore.clearClearedCommands;

	// 当次绘画的临时路径点存储
	let currentPathPoints: Point[] = [];
	// 待发送的点缓存 (用于批处理)
	let pendingPoints: Point[] = [];
	const BATCH_SIZE = 1; // 批处理大小

	const remoteCursors = ref<Map<string, RemoteCursor>>(new Map());
	let uiLoopId: number | null = null;

	// --- 框选与多选状态 ---
	const selectedCommandIds = ref<Set<string>>(new Set());
	// 正在被拖拽/缩放的命令ID集合，这些命令会暂时被提升到UI画布层上，避免主画布被频繁重绘
	const transformingCmdIds = ref<Set<string>>(new Set());

	interface TransformAnimState {
		progress: number; // 0.0 ~ 1.0
		phase: "entering" | "dragging" | "exiting";
		initialBox: {
			minX: number;
			minY: number;
			maxX: number;
			maxY: number;
			width: number;
			height: number;
		} | null;
	}
	const transformAnim = ref<TransformAnimState | null>(null);

	const selectionRect = ref<{ x: number; y: number; w: number; h: number } | null>(null); // 正在拖拽的选框
	const remoteSelectionRects = ref<Map<string, { x: number; y: number; w: number; h: number }>>(
		new Map()
	); // 远程用户的选框
	const dragStartPos = ref<{ x: number; y: number } | null>(null);

	// 拖拽/缩放/框选 模式枚举
	type InteractionMode = "none" | "box-selecting" | "dragging" | "resizing";
	const interactionMode = ref<InteractionMode>("none");

	// 拖拽/缩放相关状态
	type HandleType = "tl" | "tr" | "bl" | "br" | "body" | null;
	const activeTransformHandle = ref<HandleType>(null);
	let lastSentPos = { x: 0, y: 0 }; // 用于计算实时增量

	// 缓存初始状态 (用于批量变换)
	const initialCmdsState = ref<Map<string, Point[]>>(new Map());
	const initialGroupBox = ref<{
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	} | null>(null);

	// 记录所有没画完的点的上一点的lastWidth信息
	const lastWidths: Record<string, LastWidthInfo> = {};

	// 实时绘制所需的变量
	let lastX = 0;
	let lastY = 0;
	let lastWidth = 0;

	// 预设颜色列表
	const colors = [
		"#000000",
		"#ef4444",
		"#f97316",
		"#fbbf24",
		"#84cc16",
		"#22c55e",
		"#06b6d4",
		"#3b82f6",
		"#6366f1",
		"#a855f7",
		"#ec4899",
		"#ffffff",
	];

	// --- 核心逻辑区 ---

	/**
	 * 完整重绘画布 (Re-render)
	 * 遍历命令队列，重新执行绘制
	 */
	const renderCanvas = () => {
		if (!canvasRef.value || !ctx.value || !canvasWorker.value) return;

		// 向 Worker 发送请求，计算排好序的点集
		// 关键点：使用 JSON 序列化进行“深度脱敏”，防止 Vue 3 响应式对象（Proxy/Symbol）
		// 在 postMessage 时触发 DataCloneError。虽然有性能损耗，但在当前架构下是解决阻塞报错的方案。
		const rawCommands = toRaw(commands.value).map((c: Command) => ({
			...c,
			points: c.points ? toRaw(c.points) : [],
		}));

		canvasWorker.value.postMessage({
			type: "flat-points",
			data: JSON.parse(
				JSON.stringify({
					commands: rawCommands,
					pageId: currentPageId.value,
					transformingCmdIds: Array.from(transformingCmdIds.value),
					requestId: "main-canvas",
				})
			),
		});
	};

	// flatPoints 逻辑已全面移至 Web Worker，主线程不再保留同步计算函数

	/**
	 * 调整画布大小 (Resize)
	 */
	const resizeCanvas = () => {
		if (canvasRef.value && ctx.value) {
			const dpr = window.devicePixelRatio || 1;
			const width = window.innerWidth;
			const height = window.innerHeight;

			// 调整物理尺寸
			canvasRef.value.width = width * dpr;
			canvasRef.value.height = height * dpr;
			canvasRef.value.style.width = width + "px";
			canvasRef.value.style.height = height + "px";

			// 调整 UI Canvas 尺寸
			if (uiCanvasRef.value) {
				uiCanvasRef.value.width = width * dpr;
				uiCanvasRef.value.height = height * dpr;
				uiCanvasRef.value.style.width = width + "px";
				uiCanvasRef.value.style.height = height + "px";
			}

			// 设置 Context 基础属性
			ctx.value.scale(dpr, dpr);
			ctx.value.lineCap = "round";
			ctx.value.lineJoin = "round";

			if (uiCtx.value) {
				uiCtx.value.scale(dpr, dpr);
			}

			renderCanvas();
			setTool(currentTool.value);
		}
	};

	/**
	 * 添加新命令到队列 (Non-linear History Management)
	 */
	const pushCommand = (
		cmdPartial: Partial<Command>,
		type: "normal" | "start" | "update" | "stop" = "normal"
	) => {
		if (currentCommandIndex.value >= 0) {
			// 从当前指针之后开始，直接从数组中删除所有属于当前用户的命令
			// 从后往前删除，避免索引变化的问题
			for (let i = commands.value.length - 1; i >= currentCommandIndex.value; i--) {
				const cmd = commands.value[i];
				if (
					cmd &&
					cmd.userId === userId.value &&
					cmd.pageId === currentPageId.value &&
					cmd.isDeleted
				) {
					socket.value?.send(
						JSON.stringify({
							type: "delete-cmd",
							data: {
								cmdId: cmd.id,
							},
						})
					);
					commands.value.splice(i, 1);
				}
			}
		}
		// type 为start时，告诉服务器有一条新的命令将要被执行
		if (type === "start") {
			if (!commands.value.find((cmd: Command) => cmd.id === cmdPartial.id)) {
				insertCommand(cmdPartial as Command);
				currentCommandIndex.value = commands.value.length - 1;
			}
			socket.value?.send(
				JSON.stringify({
					type: "cmd-start",
					data: {
						id: cmdPartial.id,
						cmd: cmdPartial,
						lamport: useLamportStore().lamport,
					},
				})
			);
			console.log("send start command message:", cmdPartial.id);
		} else if (type === "update" && cmdPartial.id && cmdPartial.points) {
			socket.value?.send(
				JSON.stringify({
					type: "cmd-update",
					data: {
						cmdId: cmdPartial.id,
						// cmd: commands.value.find((cmd) => cmd.id === cmdPartial.id),
						points: cmdPartial.points,
						lamport: useLamportStore().getNextLamport(), // 关键：实时点位也必须推动时钟前进
					},
				})
			);
			console.log("send update command message:", cmdPartial.id);
		} else if (type === "stop") {
			socket.value?.send(
				JSON.stringify({
					type: "cmd-stop",
					data: {
						cmdId: cmdPartial.id,
						cmd: cmdPartial,
						lamport: useLamportStore().lamport,
						points: cmdPartial.points || [],
						box: cmdPartial.box || null,
					},
				})
			);
			console.log("send stop command message:", cmdPartial.id);
		} else if (type === "normal") {
			let cmd: Command;
			try {
				cmd = {
					id: uuidv4(),
					type: cmdPartial.type || "path",
					tool: cmdPartial.tool || "pen",
					color: cmdPartial.color || "#000000",
					size: cmdPartial.size || 3,
					points: cmdPartial.points || [],
					timestamp: Date.now(),
					userId: userId.value,
					roomId: roomId.value,
					pageId: currentPageId.value,
					isDeleted: false,
					...cmdPartial,
				} as Command;
			} catch (error: any) {
				console.error("Error creating command:", error);
				toast.error(error.message || "Failed to create command");
				return;
			}
			socket.value?.send(
				JSON.stringify({
					type: "push-cmd",
					data: cmd,
				})
			);
			console.log("send push command message:", cmd.id);
			if (!commands.value.find((cmd: Command) => cmd.id === cmdPartial.id)) {
				insertCommand(cmdPartial as Command);
			}
			// 更新当前命令指针
			currentCommandIndex.value = commands.value.length - 1;
			renderCanvas();
		}
	};

	/**
	 * 撤销操作 (Undo - Soft Delete)
	 * 查找该用户当前页面最后一条 *未删除* 的记录，将其标记为删除
	 */
	const undo = () => {
		const cmds = commands.value;
		for (let i = cmds.length - 1; i >= 0; i--) {
			const c = cmds[i];
			if (!c) continue;
			// 只能撤销自己的操作
			if (c.userId === userId.value && c.pageId === currentPageId.value && !c.isDeleted) {
				// 不能撤回清屏操作
				if (c.type === "clear") {
					toast.error("清屏操作无法撤回");
					return;
				}
				// 更新当前命令指针
				currentCommandIndex.value = i;
				socket.value?.send(
					JSON.stringify({
						type: "undo-cmd",
						data: {
							cmdId: c.id,
						},
					})
				);
				c.isDeleted = true;
				renderCanvas();
				setTool(currentTool.value);
				return;
			}
		}
	};

	/**
	 * 重做操作 (Redo - Restore Soft Delete)
	 * 算法策略：
	 * 查找该用户当前页面 *最后一条可见记录* 之后的 *第一条已删除记录* 进行恢复。
	 * 这种逻辑可以处理 "A画-A撤销-B画-A重做" 的情况，确保重做的是 A 刚才撤销的那一笔，
	 * 且因为顺序没变，A 依然会在 B 的图层下方 (符合真实时间流)。
	 */
	const redo = () => {
		const cmds = commands.value;
		let lastVisibleIndex = -1;

		// 1. 找到最后一条可见记录的位置
		for (let i = cmds.length - 1; i >= 0; i--) {
			const c = cmds[i];
			if (!c) continue;
			if (c.userId === userId.value && c.pageId === currentPageId.value && !c.isDeleted) {
				lastVisibleIndex = i;
				break;
			}
		}

		// 2. 找到此后的第一条已删除记录
		for (let i = lastVisibleIndex + 1; i < cmds.length; i++) {
			const c = cmds[i];
			if (!c) continue;
			if (c.userId === userId.value && c.pageId === currentPageId.value && c.isDeleted) {
				// 更新当前命令指针
				currentCommandIndex.value = i;
				socket.value?.send(
					JSON.stringify({
						type: "redo-cmd",
						data: {
							cmdId: c.id,
						},
					})
				);
				c.isDeleted = false;
				renderCanvas();
				setTool(currentTool.value);
				return;
			}
		}
	};

	const clearCanvas = () => {
		const clearCmd: Command = {
			id: uuidv4(),
			type: "clear",
			timestamp: Date.now(),
			userId: userId.value,
			roomId: Array.isArray(roomId.value) ? (roomId.value[0] ?? "") : roomId.value,
			pageId: currentPageId.value,
			isDeleted: false,
			lamport: useLamportStore().getNextLamport(),
			box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
		};

		// 直接添加到命令数组
		insertCommand(clearCmd);
		currentCommandIndex.value = commands.value.length - 1;
		const userName = Array.isArray(username.value) ? username.value[0] : username.value;
		// 发送清屏命令到服务器
		socket.value?.send(
			JSON.stringify({
				type: "push-cmd",
				data: {
					id: clearCmd.id,
					cmd: clearCmd,
					username: userName,
				},
			})
		);

		// 重新渲染画布
		clearClearedCommands(clearCmd, userName);
		renderCanvas();
		activeMenu.value = null;
		// 更新当前命令指针为最新
		currentCommandIndex.value = commands.value.length === 0 ? 0 : commands.value.length - 1;
	};

	// 已迁移至 store

	// Pointer Events for Drawing (Fixes discontinuity)
	// 统一获取指针坐标和压感数据
	const getCoordinates = (e: PointerEvent) => {
		// 处理触摸和鼠标事件的坐标统一
		const rect = canvasRef.value!.getBoundingClientRect();
		return {
			// 使用 clientX/Y 获取相对于视口的坐标
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
			// 获取压感
			pressure: e.pressure || 0.5,
		};
	};

	const startDrawing = (e: PointerEvent) => {
		if (!canvasRef.value) return;
		if (isDrawing.value) return;

		// 选中工具逻辑 (Select & Box Selection)
		if (currentTool.value === "cursor") {
			const { x, y } = getCoordinates(e);
			const dpr = window.devicePixelRatio || 1;
			const width = canvasRef.value.width / dpr;
			const height = canvasRef.value.height / dpr;

			// 归一化点击坐标
			const nx = x / width;
			const ny = y / height;

			let foundHandle: HandleType = null;
			let actionTarget = "none"; // 'group' | 'new-single' | 'none'

			// 1. 优先检查当前【已有选区】的控制柄 (Handles)
			const currentGroupBox = getGroupBoundingBox(
				selectedCommandIds.value,
				commands.value,
				currentPageId.value
			);

			if (currentGroupBox && selectedCommandIds.value.size > 0) {
				// Check Handles
				const handleSize = 8 / width;
				const corners: Record<string, { x: number; y: number }> = {
					tl: { x: currentGroupBox.minX, y: currentGroupBox.minY },
					tr: { x: currentGroupBox.maxX, y: currentGroupBox.minY },
					br: { x: currentGroupBox.maxX, y: currentGroupBox.maxY },
					bl: { x: currentGroupBox.minX, y: currentGroupBox.maxY },
				};

				for (const [key, p] of Object.entries(corners)) {
					if (
						Math.abs(nx - p.x) <= handleSize &&
						Math.abs(ny - p.y) <= handleSize * (width / height)
					) {
						foundHandle = key as HandleType;
						actionTarget = "group";
						interactionMode.value = "resizing";
						break;
					}
				}

				// Check Body (Inside Group Box)
				if (!foundHandle) {
					if (
						nx >= currentGroupBox.minX &&
						nx <= currentGroupBox.maxX &&
						ny >= currentGroupBox.minY &&
						ny <= currentGroupBox.maxY
					) {
						foundHandle = "body";
						actionTarget = "group";
						interactionMode.value = "dragging";
					}
				}
			}

			// 2. 如果没点中现有组，检查是否点中了【未选中的物体】(点击穿透)
			// 只有在没点中handle的时候才检测，避免handle误触物体
			if (actionTarget !== "group" || (actionTarget === "group" && foundHandle === "body")) {
				// 我们需要看看是否有点中具体的某个物体
				// 如果点中了已选中的物体，保持 group 模式。
				// 如果点中了未选中的物体，切换到 new-single。

				let hitCmdId = null;
				// 逆序查找最上层
				for (let i = commands.value.length - 1; i >= 0; i--) {
					const cmd = commands.value[i];
					if (!cmd) continue;
					if (cmd.isDeleted || cmd.pageId !== currentPageId.value || cmd.type !== "path")
						continue;
					const box = getCommandBoundingBox(cmd);
					if (!box) continue;
					const buffer = 10 / width;
					if (
						nx >= box.minX - buffer &&
						nx <= box.maxX + buffer &&
						ny >= box.minY - buffer &&
						ny <= box.maxY + buffer
					) {
						hitCmdId = cmd.id;
						break;
					}
				}

				if (hitCmdId) {
					if (selectedCommandIds.value.has(hitCmdId)) {
						// 点中了已选中的，确认是 drag 模式
						actionTarget = "group";
						interactionMode.value = "dragging";
						foundHandle = "body"; // Ensure body
					} else {
						// 点中了新物体 -> 单选置换
						selectedCommandIds.value.clear();
						selectedCommandIds.value.add(hitCmdId);
						actionTarget = "group"; // Now it becomes our group
						interactionMode.value = "dragging";
						foundHandle = "body";
					}
				} else {
					// 既然没点中handle，也没点中任何物体 body -> 点击空白处
					if (actionTarget !== "group") {
						actionTarget = "none";
					}
				}
			}

			activeTransformHandle.value = foundHandle;

			if (actionTarget === "group") {
				// --- 准备拖拽/缩放 ---
				(e.target as HTMLElement).setPointerCapture(e.pointerId);
				isDrawing.value = true;
				activePointerId.value = e.pointerId;
				lastX = x;
				lastY = y;
				dragStartPos.value = { x: nx, y: ny };
				lastSentPos = { x: nx, y: ny }; // 初始化上次发送位置

				// 缓存所有选中物体的原始状态
				initialCmdsState.value.clear();
				selectedCommandIds.value.forEach((id: string) => {
					const cmd = commands.value.find((c: Command) => c.id === id);
					if (cmd && cmd.points) {
						initialCmdsState.value.set(id, JSON.parse(JSON.stringify(cmd.points)));
					}
				});
				// 重新计算并缓存 GroupBox
				initialGroupBox.value = getGroupBoundingBox(
					selectedCommandIds.value,
					commands.value,
					currentPageId.value
				);

				// 注意：这里去除了原本“立即触发抠图”的逻辑。
				// 我们将这部分逻辑延迟到了 draw() 中，当用户产生了实际的移动或缩放距离时才触发。
				// 从而保证了如果用户只是单纯地“点击”了一下某个图形，它不会经历起飞再落回的闪烁过程。
			} else {
				// --- 准备框选 (Box Selection) ---
				selectedCommandIds.value.clear(); // 清空旧选择
				activeTransformHandle.value = null;
				interactionMode.value = "box-selecting";

				(e.target as HTMLElement).setPointerCapture(e.pointerId);
				isDrawing.value = true;
				activePointerId.value = e.pointerId;
				dragStartPos.value = { x: nx, y: ny };
				selectionRect.value = { x: nx, y: ny, w: 0, h: 0 };
			}
			return;
		}

		if (currentDrawingId.value) return;

		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		isDrawing.value = true;
		activePointerId.value = e.pointerId;
		activeMenu.value = null;

		const { x, y, pressure } = getCoordinates(e);
		cursorX.value = x;
		cursorY.value = y;

		// 记录上一帧状态，用于实时渲染
		lastX = x;
		lastY = y;

		// 关键修正：针对非笔类设备，起点使用极小的压感模拟，从而避免“大墨滴”
		// 同时也让线条有一个自然的由细变粗的过渡（Tapering）
		const initialPressure = e.pointerType === "pen" ? pressure : 0.2;
		// 橡皮擦不需要压感效果
		lastWidth =
			currentTool.value === "eraser"
				? currentSize.value
				: currentSize.value * (initialPressure * 2);

		// 初始化新的路径点集合
		const width = canvasRef.value.width / (window.devicePixelRatio || 1); // 逻辑宽度
		const height = canvasRef.value.height / (window.devicePixelRatio || 1); // 逻辑高度
		const newLamportCount = useLamportStore().getNextLamport();

		const p0 = {
			x: x / width,
			y: y / height,
			p: initialPressure,
			lamport: newLamportCount,
		};

		currentPathPoints = [p0];
		pendingPoints = []; // 既然 "start" 消息包含了 p0，pendingPoints 这里清空即可，不需要重复发

		// 已经移除了立即绘制角点的逻辑，等待 draw 函数的第二个点开始渲染。
		const id = uuidv4();
		currentDrawingId.value = id;

		// 压入队列
		useLamportStore().pushToQueue({
			x,
			y,
			p: initialPressure,
			cmdId: id,
			userId: userId.value,
			tool: currentTool.value,
			color: currentColor.value,
			size: currentSize.value,
			isDeleted: false,
			lastX: x,
			lastY: y,
			lastWidth: lastWidth,
			lamport: newLamportCount,
		});

		// 发送 start 消息，包含起点。远程端收到后，也会因为 renderIncrementPoint 的优化逻辑而暂不绘制。
		pushCommand(
			{
				id: id,
				type: "path",
				points: currentPathPoints, // 包含 p0
				tool: currentTool.value,
				color: currentColor.value,
				size: currentSize.value,
				timestamp: Date.now(),
				userId: userId.value,
				roomId: Array.isArray(roomId.value) ? roomId.value[0] : roomId.value,
				pageId: currentPageId.value,
				isDeleted: false,
				lamport: newLamportCount,
				box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			},
			"start"
		);
	};

	const draw = (e: PointerEvent) => {
		const { x, y, pressure } = getCoordinates(e);
		cursorX.value = x;
		cursorY.value = y;
		if (!mouseMoveCD.value) {
			mouseMoveCD.value = true;
			updateMousePosition();
		} else {
			setTimeout(() => {
				mouseMoveCD.value = false;
			}, 30); // 提高发送频率到 30ms (约30fps)
		}

		if (!isDrawing.value || !ctx.value) return;
		if (e.pointerId !== activePointerId.value) return;

		// --- 拖拽与缩放逻辑 (Transform) & 框选 (Box Select) ---
		if (currentTool.value === "cursor") {
			if (!isDrawing.value) return;

			const dpr = window.devicePixelRatio || 1;
			const width = canvasRef.value!.width / dpr;
			const height = canvasRef.value!.height / dpr;

			// 当前鼠标位置 (归一化)
			const nx = x / width;
			const ny = y / height;

			// 1. 处理框选 (Box Selection)
			if (interactionMode.value === "box-selecting" && dragStartPos.value) {
				const startX = dragStartPos.value.x;
				const startY = dragStartPos.value.y;

				// 更新选框矩形
				selectionRect.value = {
					x: Math.min(startX, nx),
					y: Math.min(startY, ny),
					w: Math.abs(nx - startX),
					h: Math.abs(ny - startY),
				};
				// 只需要重绘 UI 层即可，所以这里不需要 renderCanvas()，UI Loop 会自动绘制
				return;
			}

			// 2. 处理变换 (Drag & Resize)
			if (selectedCommandIds.value.size === 0 || !activeTransformHandle.value) return;

			const initialBox = initialGroupBox.value;
			const startPos = dragStartPos.value;

			if (!initialBox || !startPos) return;

			// --- 延迟触发抠图与悬浮动画 (避免单点击闪烁) ---
			// 只有发生了实际的物理位移，才将其提升到悬浮层
			if (transformingCmdIds.value.size === 0) {
				const dx = nx - startPos.x;
				const dy = ny - startPos.y;
				// 阈值设为很小，只要鼠标有滑动就算
				if (
					Math.abs(dx) > 0.0001 ||
					Math.abs(dy) > 0.0001 ||
					activeTransformHandle.value !== "body"
				) {
					selectedCommandIds.value.forEach((id) => transformingCmdIds.value.add(id));

					transformAnim.value = {
						progress: 0,
						phase: "entering",
						initialBox: initialBox,
					};

					// 脏矩形擦除主画布的旧图形
					const dpr = window.devicePixelRatio || 1;
					const cw = canvasRef.value!.width / dpr;
					const ch = canvasRef.value!.height / dpr;
					reRenderDirtyRect(
						{
							minX: initialBox.minX * cw,
							minY: initialBox.minY * ch,
							maxX: initialBox.maxX * cw,
							maxY: initialBox.maxY * ch,
							width: initialBox.width * cw,
							height: initialBox.height * ch,
						},
						ctx.value!,
						canvasRef.value!,
						transformingCmdIds.value
					);
				} else {
					return; // 还没有微小位移，维持原状，什么也不画
				}
			}

			// 遍历所有选中的物体进行变换
			selectedCommandIds.value.forEach((cmdId: string) => {
				const cmd = commands.value.find((c: Command) => c.id === cmdId);
				const initialPoints = initialCmdsState.value.get(cmdId);
				if (!cmd || !initialPoints) return;

				if (activeTransformHandle.value === "body") {
					// --- 移动模式 (Translation) ---
					const dx = nx - startPos.x;
					const dy = ny - startPos.y;

					cmd.points = initialPoints.map((p) => ({
						...p,
						x: p.x + dx,
						y: p.y + dy,
					}));
				} else {
					// --- 缩放模式 (Resizing) ---
					// 均以 Group Box 位准
					let anchorX = 0,
						anchorY = 0;

					// Group Anchor Logic
					switch (activeTransformHandle.value) {
						case "tl":
							anchorX = initialBox.maxX;
							anchorY = initialBox.maxY;
							break;
						case "tr":
							anchorX = initialBox.minX;
							anchorY = initialBox.maxY;
							break;
						case "bl":
							anchorX = initialBox.maxX;
							anchorY = initialBox.minY;
							break;
						case "br":
							anchorX = initialBox.minX;
							anchorY = initialBox.minY;
							break;
					}

					// 原始尺寸 (Group)
					const oldW = initialBox.maxX - initialBox.minX;
					const oldH = initialBox.maxY - initialBox.minY;
					if (oldW === 0 || oldH === 0) return;

					// 新的鼠标位置相对于 Anchor 的比例
					const currentW = nx - anchorX;
					const currentH = ny - anchorY;

					let originalW = 0,
						originalH = 0;
					switch (activeTransformHandle.value) {
						case "tl":
							originalW = initialBox.minX - initialBox.maxX;
							originalH = initialBox.minY - initialBox.maxY;
							break;
						case "tr":
							originalW = initialBox.maxX - initialBox.minX;
							originalH = initialBox.minY - initialBox.maxY;
							break;
						case "bl":
							originalW = initialBox.minX - initialBox.maxX;
							originalH = initialBox.maxY - initialBox.minY;
							break;
						case "br":
							originalW = initialBox.maxX - initialBox.minX;
							originalH = initialBox.maxY - initialBox.minY;
							break;
					}

					const scaleX = currentW / originalW;
					const scaleY = currentH / originalH;

					// 应用缩放矩阵 (Relative to Anchor)
					cmd.points = initialPoints.map((p) => ({
						...p,
						x: anchorX + (p.x - anchorX) * scaleX,
						y: anchorY + (p.y - anchorY) * scaleY,
					}));
				}
			});
			// 坐标已更新，UI 层会自动在下一帧绘制变换中的图形
			return;
		}

		const dist = Math.hypot(x - lastX, y - lastY);
		if (dist < 2) return;

		// --- 实时绘制 ---

		const velocityFactor = Math.max(0.4, 1 - dist / 120);

		const clamp = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);
		let simulatedPressure = e.pointerType === "pen" ? pressure : clamp(1 - dist / 100, 0.3, 1);
		const usedPressure = e.pointerType === "pen" ? pressure : simulatedPressure;

		const targetWidth = currentSize.value * (usedPressure * 2) * velocityFactor;
		// 增加当前权重的占比，使变细更灵敏
		const newWidth = clamp(lastWidth * 0.7 + targetWidth * 0.3, 1, currentSize.value + 2);

		const dpr = window.devicePixelRatio || 1;
		const width = canvasRef.value!.width / dpr;
		const height = canvasRef.value!.height / dpr;

		// 设置混合模式和样式
		const op = currentTool.value === "eraser" ? "destination-out" : "source-over";
		ctx.value.globalCompositeOperation = op;
		ctx.value.lineCap = "round";
		ctx.value.lineJoin = "round";

		const newLamportCount = useLamportStore().getNextLamport();
		if (currentTool.value === "eraser") {
			// 压入队列
			useLamportStore().pushToQueue({
				x: x,
				y: y,
				p: usedPressure,
				lamport: newLamportCount,
				lastX: lastX,
				lastY: lastY,
				lastWidth: lastWidth,
				cmdId: currentDrawingId.value || "",
				userId: userId.value,
				tool: currentTool.value,
				color: currentColor.value,
				size: currentSize.value,
				isDeleted: false,
			});
			ctx.value.beginPath();
			ctx.value.moveTo(lastX, lastY);
			ctx.value.lineTo(x, y);
			ctx.value.strokeStyle = "#ffffff";
			ctx.value.lineWidth = currentSize.value;
			ctx.value.stroke();
		} else {
			const midX = (lastX + x) / 2;
			const midY = (lastY + y) / 2;
			// 压入队列
			useLamportStore().pushToQueue({
				x: x,
				y: y,
				p: usedPressure,
				lamport: newLamportCount,
				lastX: lastX,
				lastY: lastY,
				lastWidth: lastWidth,
				cmdId: currentDrawingId.value || "",
				userId: userId.value,
				tool: currentTool.value,
				color: currentColor.value,
				size: currentSize.value,
				isDeleted: false,
			});
			ctx.value.beginPath();
			ctx.value.moveTo(lastX, lastY);
			ctx.value.quadraticCurveTo(midX, midY, x, y);
			ctx.value.lineWidth = newWidth;
			ctx.value.strokeStyle = currentColor.value;
			ctx.value.stroke();
		}

		// 专门为 Benchmark 端到端测算准备的全局钩子 (同步路径，零延迟)
		if (typeof window !== "undefined" && (window as any).__benchmarkHook) {
			(window as any).__benchmarkHook(null, currentDrawingId.value || "");
		}

		lastX = x;
		lastY = y;
		lastWidth = newWidth;

		// --- 记录数据 ---
		const newPoint = {
			x: x / width,
			y: y / height,
			p: usedPressure,
			lamport: newLamportCount,
		};

		currentPathPoints.push(newPoint);
		pendingPoints.push(newPoint); // 加入待发送队列

		// --- 批处理发送 (Batching) ---
		if (pendingPoints.length >= BATCH_SIZE) {
			pushCommand(
				{
					id: currentDrawingId.value || undefined,
					points: pendingPoints,
				},
				"update"
			);
			pendingPoints = []; // 清空队列
		}
	};

	function updateMousePosition() {
		if (!canvasRef.value) return;
		const dpr = window.devicePixelRatio || 1;
		const logicalWidth = canvasRef.value.width / dpr;
		const logicalHeight = canvasRef.value.height / dpr;

		const nx = logicalWidth > 0 ? cursorX.value / logicalWidth : 0;
		const ny = logicalHeight > 0 ? cursorY.value / logicalHeight : 0;
		const userName = Array.isArray(username.value) ? username.value[0] : username.value;
		// 1. 发送鼠标位置
		socket.value?.send(
			JSON.stringify({
				type: "mouseMove",
				data: {
					userId: userId.value,
					userName: userName ?? userId.value.split("-")[0],
					x: nx,
					y: ny,
					pageId: currentPageId.value,
				},
			})
		);

		// 2. 如果正在移动物体，发送增量位移 (Real-time Move Sync)
		if (
			interactionMode.value === "dragging" &&
			selectedCommandIds.value.size > 0 &&
			dragStartPos.value
		) {
			// 计算自上次发送以来的增量 (Delta)
			const dx = nx - lastSentPos.x;
			const dy = ny - lastSentPos.y;

			if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
				socket.value?.send(
					JSON.stringify({
						type: "cmd-batch-move",
						data: {
							userId: userId.value,
							cmdIds: Array.from(selectedCommandIds.value),
							dx: dx,
							dy: dy,
							isRealtime: true,
						},
					})
				);
				lastSentPos = { x: nx, y: ny }; // 更新上次发送位置
			}
		}

		// 3. 如果正在框选，发送框选矩形 (Real-time Selection Sync)
		if (interactionMode.value === "box-selecting" && selectionRect.value) {
			socket.value?.send(
				JSON.stringify({
					type: "box-selection",
					data: {
						userId: userId.value,
						rect: selectionRect.value,
					},
				})
			);
		}
	}

	// 将 finalizeDrop 抽离为单独的函数
	const finalizeDrop = () => {
		// 复制出需要印回的集合（因为后面要 clear）
		const idsToDrop = new Set(transformingCmdIds.value);
		transformingCmdIds.value.clear();
		transformAnim.value = null;

		// 落地时，不再仅仅使用局部重绘，因为点位 buffer 此时可能还是旧的
		// 触发一次 renderCanvas() 启动 Worker 同步，它会完成最新的扁平化并触发全量重绘
		renderCanvas();
	};

	const stopDrawing = (e: PointerEvent) => {
		if (isDrawing.value) {
			if (e.pointerId !== activePointerId.value) return;
			// 计算已画完的命令的包围盒
			const cmdId = currentDrawingId.value;
			const cmd = commands.value.find((c) => c.id === cmdId);
			if (cmd && cmd.points && cmd.points.length > 0) {
				cmd.box = getCommandBoundingBox(cmd) ?? {
					minX: 0,
					minY: 0,
					maxX: 0,
					maxY: 0,
					width: 0,
					height: 0,
				};
			}
			// 发送剩余点
			pushCommand(
				{
					id: currentDrawingId.value || undefined,
					points: pendingPoints || [],
					box: cmd?.box,
				},
				"stop"
			);
			pendingPoints = []; // 清空队列

			// --- 拖拽/缩放/框选 结束逻辑 ---
			if (currentTool.value === "cursor") {
				if (interactionMode.value === "box-selecting" && selectionRect.value) {
					// 框选结束：通知远程隐藏选框
					socket.value?.send(
						JSON.stringify({
							type: "box-selection",
							data: { userId: userId.value, rect: null },
						})
					);

					// 内部逻辑：计算相交物体
					const rect = selectionRect.value;
					const rectMinX = Math.min(rect.x, rect.x + rect.w);
					const rectMaxX = Math.max(rect.x, rect.x + rect.w);
					const rectMinY = Math.min(rect.y, rect.y + rect.h);
					const rectMaxY = Math.max(rect.y, rect.y + rect.h);

					selectedCommandIds.value.clear();

					commands.value.forEach((cmd: Command) => {
						if (
							cmd.isDeleted ||
							cmd.pageId !== currentPageId.value ||
							cmd.type !== "path"
						)
							return;
						const box = getCommandBoundingBox(cmd);
						if (!box) return;

						// 简单的 "全包含" 或 "相交" 检测
						// 这里采用 "相交即选中" (Intersection) 策略，比较符合直觉
						// 只要两个AABB有重叠即可
						if (
							box.minX < rectMaxX &&
							box.maxX > rectMinX &&
							box.minY < rectMaxY &&
							box.maxY > rectMinY &&
							!cmd.isDeleted &&
							cmd.tool === "pen"
						) {
							selectedCommandIds.value.add(cmd.id);
						}
					});

					selectionRect.value = null; // 清除可视框
				} else if (
					(interactionMode.value === "dragging" ||
						interactionMode.value === "resizing") &&
					selectedCommandIds.value.size > 0 &&
					dragStartPos.value
				) {
					// 无论是移动还是缩放，结束时都统一发送全量 Points
					// 这解决了实时增量导致的偏移累积问题，并方便后端直接存库
					const updates = Array.from(selectedCommandIds.value)
						.map((id: string) => {
							const cmd = commands.value.find((c: Command) => c.id === id);
							return cmd ? { cmdId: id, points: cmd.points } : null;
						})
						.filter(Boolean);

					if (updates.length > 0) {
						// 遍历updates命令，构建新的包围盒
						const newBoxes: {
							cmdId: string;
							box: {
								minX: number;
								minY: number;
								maxX: number;
								maxY: number;
								width: number;
								height: number;
							};
						}[] = [];
						updates.forEach((update: any) => {
							const cmd = commands.value.find((c: Command) => c.id === update.cmdId);
							if (cmd) {
								cmd.box = getCommandBoundingBox(cmd) ?? {
									minX: 0,
									minY: 0,
									maxX: 0,
									maxY: 0,
									width: 0,
									height: 0,
								};
								newBoxes.push({
									cmdId: cmd.id,
									box: cmd.box,
								});
							}
						});
						socket.value?.send(
							JSON.stringify({
								type: "cmd-batch-stop",
								data: {
									userId: userId.value,
									updates: updates,
									boxes: newBoxes,
								},
							})
						);
					}

					// === 解耦核心：等待动画印回 ===
					// 触发退出动画，等待跑完再真正印回到底板。
					if (transformAnim.value) {
						transformAnim.value.phase = "exiting";
					} else {
						// 兜底（如果没动画）
						finalizeDrop();
					}
				}

				// 重置状态
				isDrawing.value = false;
				activePointerId.value = -1;
				dragStartPos.value = null;
				activeTransformHandle.value = null;
				interactionMode.value = "none";
				initialCmdsState.value.clear();
				initialGroupBox.value = null;
				// transformingCmdIds.value.clear(); <-- 现在由动画结束后负责清理
				return;
			}

			// 如果只画了一个点（点击操作），在结束时补画这个点
			if (currentPathPoints.length === 1 && ctx.value && canvasRef.value) {
				const dpr = window.devicePixelRatio || 1;
				const p0 = currentPathPoints[0] || { x: 0, y: 0, p: 0.5 };
				const width = canvasRef.value.width / dpr;
				const height = canvasRef.value.height / dpr;
				const x = p0.x * width;
				const y = p0.y * height;
				let w = currentSize.value * (p0.p * 2);
				if (currentTool.value === "eraser") w = currentSize.value;

				ctx.value.beginPath();
				const color = currentTool.value === "eraser" ? "#ffffff" : currentColor.value;
				const op = currentTool.value === "eraser" ? "destination-out" : "source-over";
				ctx.value.globalCompositeOperation = op;
				ctx.value.fillStyle = color;
				ctx.value.arc(x, y, w / 2, 0, Math.PI * 2);
				ctx.value.fill();
			}

			// 发送剩余的 pendingPoints
			if (pendingPoints.length > 0) {
				pushCommand(
					{
						id: currentDrawingId.value || undefined,
						points: pendingPoints,
					},
					"update"
				);
				pendingPoints = [];
			}
			if (currentPathPoints.length > 0) {
				// 释放临时内存
				currentPathPoints = [];
			}

			// 重置当前绘制ID，确保下次绘制能正常开始
			currentDrawingId.value = null;

			// 清理当前绘制命令和释放临时内存
			isDrawing.value = false;
			activePointerId.value = null;
			if (e.target) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
		}
	};

	// 已迁移至 store

	// 该函数用于对两个命令进行排序，lamport时间戳小的在前，如果时间戳相同，则比较cmdId的ascii码
	// 返回的是lamport时间戳较小（排序靠前）的那个命令
	const resolveConflict = (cmd1: Command, cmd2: Command) => {
		if (cmd1.lamport < cmd2.lamport) {
			return cmd1;
		} else if (cmd1.lamport > cmd2.lamport) {
			return cmd2;
		} else {
			// cmdId是uuid，直接比较即可
			if (cmd1.id.toLocaleLowerCase() < cmd2.id.toLocaleLowerCase()) {
				return cmd1;
			} else {
				return cmd2;
			}
		}
	};

	// --- Tools Logic ---

	const toggleMenu = (menu: "pen" | "eraser" | "color" | "more") => {
		// 逻辑优化：如果是画笔/橡皮，只有在当前已经选中该工具的情况下，才切换二级菜单的显示
		// 第一次点击：选中工具
		// 第二次点击：弹出设置面板
		if (menu === "pen" || menu === "eraser") {
			if (currentTool.value === menu) {
				// 已选中当前工具 -> 切换菜单显示/隐藏
				activeMenu.value = activeMenu.value === menu ? null : menu;
			} else {
				// 未选中当前工具 -> 仅切换工具，但不弹窗，保持界面清爽
				setTool(menu);
				activeMenu.value = null;
			}
		}
		// 对于颜色盘，通常直接切换显示
		else if (menu === "color") {
			activeMenu.value = activeMenu.value === "color" ? null : "color";
		}
		// 更多菜单
		else if (menu === "more") {
			activeMenu.value = activeMenu.value === "more" ? null : "more";
		}
	};

	const setTool = (tool: "pen" | "eraser" | "cursor") => {
		currentTool.value = tool;

		// 切换工具时清除选中和选框
		if (tool !== "cursor") {
			selectedCommandIds.value.clear();
			selectionRect.value = null;
			interactionMode.value = "none";
		}

		if (ctx.value) {
			if (tool === "eraser") {
				ctx.value.globalCompositeOperation = "destination-out";
			} else if (tool === "pen") {
				ctx.value.globalCompositeOperation = "source-over";
				ctx.value.strokeStyle = currentColor.value;
			}
		}
		// 关闭所有可能弹出的菜单
		activeMenu.value = null;
	};

	const setColor = (color: string) => {
		currentColor.value = color;
		if (currentTool.value === "eraser") setTool("pen");
		if (ctx.value) {
			ctx.value.strokeStyle = color;
			ctx.value.globalCompositeOperation = "source-over";
		}
		activeMenu.value = null;
	};

	// --- Features ---

	const copyLink = async () => {
		const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4646";
		axios
			.get(`${apiUrl}/generate-share-token?roomId=${roomId.value}`)
			.then((res) => {
				if (res.data.code === 200) {
					const url = `${window.location.origin}/invite/${res.data.data.token}`;
					const copyStr = `${username.value} 邀请你加入协同画板房间：${roomName.value} ( ID: ${roomId.value} )，点击链接加入：${url}${res.data.data.password ? "，房间密码：" + res.data.data.password : ""}`;
					try {
						navigator.clipboard.writeText(copyStr).catch((err) => {
							console.error("Copy failed", err);
							toast.error("复制失败");
						});
						hasCopied.value = true;
						toast.success("复制成功");
						setTimeout(() => (hasCopied.value = false), 2000);
					} catch (err) {
						console.error("Copy failed", err);
					}
				}
			})
			.catch((err) => {
				toast.error(`生成分享链接失败：${err.response?.data?.msg || "未知错误"}`);
				console.error(
					"Error generating share token: ",
					err.response?.data?.msg || "未知错误"
				);
			});
	};

	const toggleFullscreen = () => {
		if (!document.fullscreenElement) {
			document.documentElement.requestFullscreen();
			isFullscreen.value = true;
		} else {
			document.exitFullscreen();
			isFullscreen.value = false;
		}
	};

	// --- 多页面管理 (Pagination) ---

	/**
	 * 通用渲染函数：将指定页面的内容绘制到目标 Context 上
	 * @param targetCtx 目标 Canvas Context
	 * @param width 宽
	 * @param height 高
	 * @param pageId 页面 ID
	 */
	// renderPageContent 已由异步 Worker 代替，此处删除旧的同步版本

	// 更加鲜艳和区分度高的颜色列表 (Tailwind Colors 500)
	const cursorColors = [
		"#ef4444", // red
		"#f97316", // orange
		"#f59e0b", // amber
		"#84cc16", // lime
		"#10b981", // emerald
		"#06b6d4", // cyan
		"#3b82f6", // blue
		"#6366f1", // indigo
		"#8b5cf6", // violet
		"#d946ef", // fuchsia
		"#f43f5e", // rose
	];

	const getCursorColor = (str: string) => {
		if (!str) return cursorColors[0];
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		const index = Math.abs(hash) % cursorColors.length;
		return cursorColors[index];
	};

	const renderUICanvas = () => {
		if (!uiCtx.value || !uiCanvasRef.value) return;

		// Clear UI Layer (Using Logical size because we scaled the context)
		const dpr = window.devicePixelRatio || 1;
		const width = uiCanvasRef.value.width / dpr;
		const height = uiCanvasRef.value.height / dpr;

		uiCtx.value.clearRect(0, 0, width, height);

		// --- 绘制框选矩形 (Rubber Band) ---
		if (interactionMode.value === "box-selecting" && selectionRect.value) {
			const r = selectionRect.value;
			const rx = r.x * width;
			const ry = r.y * height;
			const rw = r.w * width;
			const rh = r.h * height;

			uiCtx.value.save();
			uiCtx.value.fillStyle = "rgba(59, 130, 246, 0.1)"; // blue-500 alpha 0.1
			uiCtx.value.strokeStyle = "#3b82f6";
			uiCtx.value.lineWidth = 1;
			uiCtx.value.fillRect(rx, ry, rw, rh);
			uiCtx.value.strokeRect(rx, ry, rw, rh);
			uiCtx.value.restore();
		}

		// --- 绘制远程用户的框选矩形 ---
		remoteSelectionRects.value.forEach((r) => {
			const rx = r.x * width;
			const ry = r.y * height;
			const rw = r.w * width;
			const rh = r.h * height;

			uiCtx.value!.save();
			uiCtx.value!.fillStyle = "rgba(156, 163, 175, 0.1)"; // gray-400 alpha 0.1
			uiCtx.value!.strokeStyle = "#9ca3af";
			uiCtx.value!.setLineDash([2, 4]);
			uiCtx.value!.lineWidth = 1;
			uiCtx.value!.fillRect(rx, ry, rw, rh);
			uiCtx.value!.strokeRect(rx, ry, rw, rh);
			uiCtx.value!.restore();
		});

		// === 动画状态机 Tick ===
		if (transformAnim.value) {
			const animDurationFrames = 8; // 约130ms
			const step = 1 / animDurationFrames;
			if (transformAnim.value.phase === "entering") {
				transformAnim.value.progress = Math.min(1, transformAnim.value.progress + step);
				if (transformAnim.value.progress >= 1) transformAnim.value.phase = "dragging";
			} else if (transformAnim.value.phase === "exiting") {
				transformAnim.value.progress = Math.max(0, transformAnim.value.progress - step);
				if (transformAnim.value.progress <= 0) {
					finalizeDrop();
				}
			}
		}

		// === 解耦核心：在 UI 层绘制正在变换的命令 ===
		if (transformingCmdIds.value.size > 0) {
			uiCtx.value.save();

			// 应用阴影与透明度动画过渡
			if (transformAnim.value) {
				const p = transformAnim.value.progress;
				uiCtx.value.globalAlpha = 0.3 + 0.55 * p; // base 0.3, max 0.85
				uiCtx.value.shadowColor = `rgba(0, 0, 0, ${0.2 * p})`;
				uiCtx.value.shadowBlur = 12 * p;
				uiCtx.value.shadowOffsetX = 6 * p;
				uiCtx.value.shadowOffsetY = 6 * p;
			} else {
				// 兜底
				uiCtx.value.globalAlpha = 0.85;
				uiCtx.value.shadowColor = "rgba(0, 0, 0, 0.2)";
				uiCtx.value.shadowBlur = 12;
				uiCtx.value.shadowOffsetX = 6;
				uiCtx.value.shadowOffsetY = 6;
			}

			transformingCmdIds.value.forEach((cmdId: string) => {
				const cmd = commands.value.find((c: Command) => c.id === cmdId);
				if (!cmd || !cmd.points || cmd.points.length === 0) return;
				renderIncrementPoint(cmd, cmd.points, uiCtx.value!, width, height, true);
			});

			uiCtx.value.restore();
		}

		// --- 绘制选中框 (Selection Box / Group Box) ---
		if (selectedCommandIds.value.size > 0) {
			// 计算整个组的包围盒
			const groupBox = getGroupBoundingBox(
				selectedCommandIds.value,
				commands.value,
				currentPageId.value
			);
			if (groupBox) {
				const bx = groupBox.minX * width;
				const by = groupBox.minY * height;
				const bw = groupBox.width * width;
				const bh = groupBox.height * height;
				const padding = 5;

				uiCtx.value.save();
				uiCtx.value.strokeStyle = "#3b82f6"; // blue-500
				uiCtx.value.lineWidth = 1.5;
				uiCtx.value.setLineDash([4, 4]); // 虚线效果
				uiCtx.value.strokeRect(
					bx - padding,
					by - padding,
					bw + padding * 2,
					bh + padding * 2
				);

				// 绘制角落控制点
				uiCtx.value.setLineDash([]);
				uiCtx.value.fillStyle = "white";
				uiCtx.value.strokeStyle = "#3b82f6";
				uiCtx.value.lineWidth = 1.5;

				const handleSize = 8;

				const corners = [
					{ x: bx - padding, y: by - padding }, // TL
					{ x: bx + bw + padding, y: by - padding }, // TR
					{ x: bx + bw + padding, y: by + bh + padding }, // BR
					{ x: bx - padding, y: by + bh + padding }, // BL
				];

				corners.forEach((p: { x: number; y: number }) => {
					uiCtx.value!.beginPath();
					uiCtx.value!.rect(
						p.x - handleSize / 2,
						p.y - handleSize / 2,
						handleSize,
						handleSize
					);
					uiCtx.value!.fill();
					uiCtx.value!.stroke();
				});

				uiCtx.value.restore();
			} else {
				// selection is stale
			}
		}

		// Draw Remote Cursors
		remoteCursors.value.forEach((cursor: RemoteCursor) => {
			// Skip current user (handled by OS)
			if (cursor.userId === userId.value) return;

			// 幽灵光标隔离：只渲染处在同一页面的协同者的光标
			if (cursor.pageId !== currentPageId.value) return;

			// 移除超过 10 秒未更新的光标 (Cleanup stale cursors)
			if (Date.now() - (cursor.lastUpdate || 0) > 10000) {
				remoteCursors.value.delete(cursor.userId);
				return;
			}

			const x = cursor.x * width;
			const y = cursor.y * height;
			const color = cursor.color || "#ff0000";

			uiCtx.value!.save();
			uiCtx.value!.translate(x, y);

			// --- 绘制更美观的光标 (Figma-like) ---
			uiCtx.value!.fillStyle = color;

			// 1. 光标主体 (SVG Path)
			// 一个标准的倾斜箭头
			uiCtx.value!.beginPath();
			uiCtx.value!.moveTo(0, 0);
			uiCtx.value!.lineTo(5.5, 15.5); // 左下
			uiCtx.value!.lineTo(8.5, 11); // 拐点
			uiCtx.value!.lineTo(14, 11); // 右侧
			uiCtx.value!.closePath();

			// 添加阴影使光标更立体
			uiCtx.value!.shadowColor = "rgba(0, 0, 0, 0.4)";
			uiCtx.value!.shadowBlur = 3;
			uiCtx.value!.shadowOffsetX = 1;
			uiCtx.value!.shadowOffsetY = 1;

			uiCtx.value!.fill();

			// 描边 (白色轮廓，增强对比度)
			uiCtx.value!.shadowColor = "transparent"; // Reset shadow for stroke
			uiCtx.value!.strokeStyle = "white";
			uiCtx.value!.lineWidth = 1;
			uiCtx.value!.stroke();

			// 2. 绘制名字标签 (Name Tag)
			// 只有当名字存在且光标不在屏幕极上方时绘制 (避免被遮挡)
			if (cursor.userName) {
				uiCtx.value!.font = "500 12px 'Segoe UI', sans-serif";
				const textPaddingX = 6;
				const textPaddingY = 3;
				const textMetrics = uiCtx.value!.measureText(cursor.userName);
				const textWidth = textMetrics.width;
				const textHeight = 16;

				// 计算标签位置 (光标右下方)
				const tagX = 10;
				const tagY = 10;

				// 绘制标签背景 (圆角矩形)
				uiCtx.value!.fillStyle = color;

				// 手动绘制圆角矩形
				const trX = tagX,
					trY = tagY;
				const trW = textWidth + textPaddingX * 2;
				const trH = textHeight + textPaddingY * 2;
				const r = 4; // radius

				uiCtx.value!.beginPath();
				uiCtx.value!.moveTo(trX + r, trY);
				uiCtx.value!.lineTo(trX + trW - r, trY);
				uiCtx.value!.quadraticCurveTo(trX + trW, trY, trX + trW, trY + r);
				uiCtx.value!.lineTo(trX + trW, trY + trH - r);
				uiCtx.value!.quadraticCurveTo(trX + trW, trY + trH, trX + trW - r, trY + trH);
				uiCtx.value!.lineTo(trX + r, trY + trH);
				uiCtx.value!.quadraticCurveTo(trX, trY + trH, trX, trY + trH - r);
				uiCtx.value!.lineTo(trX, trY + r);
				uiCtx.value!.quadraticCurveTo(trX, trY, trX + r, trY);
				uiCtx.value!.closePath();

				uiCtx.value!.fill();

				// 绘制文字
				uiCtx.value!.fillStyle = "white";
				uiCtx.value!.textBaseline = "middle";
				uiCtx.value!.fillText(cursor.userName, trX + textPaddingX, trY + trH / 2 + 1); // +1 visual adjustment
			}

			uiCtx.value!.restore();
		});
	};

	const startUILoop = () => {
		const loop = () => {
			renderUICanvas();
			uiLoopId = requestAnimationFrame(loop);
		};
		loop();
	};

	const renderPreviewCanvas = (el: HTMLCanvasElement | any, index: number) => {
		if (!el) return;

		// 使用 requestAnimationFrame 确保元素已在 DOM 中且尺寸计算正确
		// 尤其是在 Transition 动画期间，延迟一帧能避免获取到错误的尺寸
		requestAnimationFrame(() => {
			if (!el) return;
			const ctx = el.getContext("2d");
			if (!ctx) return;

			// 获取容器尺寸 (CSS像素)
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;

			const dpr = window.devicePixelRatio || 1;

			// 设置物理分辨率 (避免过大，限制最大缩略图物理宽度)
			el.width = rect.width * dpr;
			el.height = rect.height * dpr;

			// 缩放 Context 以适应逻辑坐标
			ctx.scale(dpr, dpr);
			ctx.lineCap = "round";
			ctx.lineJoin = "round";

			// 使用逻辑尺寸进行渲染：改为主线程发请求给 Worker，异步获取点位
			const requestId = `preview-page-${index}-${Date.now()}`;
			pendingRenderCallbacks.set(requestId, (points: FlatPoint[]) => {
				renderPageContentFromPoints(ctx, rect.width, rect.height, points);
			});

			const rawCommands = (toRaw(commands.value) as Command[]).map((c: Command) => ({
				...c,
				points: c.points ? toRaw(c.points) : [],
			}));

			canvasWorker.value!.postMessage({
				type: "flat-points",
				data: JSON.parse(
					JSON.stringify({
						commands: rawCommands,
						pageId: index,
						transformingCmdIds: [],
						requestId: requestId,
					})
				),
			});
		});
	};

	const goToPage = (index: number) => {
		currentPageId.value = index;
		showPageOverview.value = false;
		renderCanvas();
		setTool(currentTool.value);
	};

	const prevPage = () => {
		if (currentPageId.value > 0) {
			currentPageId.value--;
			renderCanvas();
			setTool(currentTool.value); // 重置绘制状态
		}
	};

	const nextPage = () => {
		if (currentPageId.value === totalPages.value - 1) {
			totalPages.value++;
			// 通知其他客户端新建了页面
			if (socket.value && socket.value.readyState === WebSocket.OPEN) {
				socket.value.send(
					JSON.stringify({
						type: "cmd-page-add",
						data: {
							userId: userId.value,
							username: username.value ?? "有用户",
							totalPages: totalPages.value,
						},
					})
				);
			}
		}
		currentPageId.value++;
		renderCanvas();
		setTool(currentTool.value); // 重置绘制状态
	};

	// --- 快捷键系统 (Keyboard Shortcuts) ---
	// 监听键盘事件，提供快捷操作
	const handleKeydown = (e: KeyboardEvent) => {
		// 如果焦点在输入框中（如修改名字），则不触发快捷键
		if ((e.target as HTMLElement).tagName === "INPUT") return;

		if (e.ctrlKey || e.metaKey) {
			// Ctrl+Shift+Z 或 Cmd+Shift+Z: 重做
			if (e.shiftKey && e.key.toLowerCase() === "z") {
				e.preventDefault();
				redo();
			}
			// Ctrl+Z / Cmd+Z: 撤销
			else if (e.key.toLowerCase() === "z") {
				e.preventDefault();
				undo();
			}
			// Ctrl+Y: 重做 (Windows 习惯)
			else if (e.key.toLowerCase() === "y") {
				e.preventDefault();
				redo();
			}
		} else {
			switch (e.key.toLowerCase()) {
				case "p":
					setTool("pen");
					break; // P: 切换画笔
				case "e":
					setTool("eraser");
					break; // E: 切换橡皮
				case "c":
					activeMenu.value = "color";
					break; // C: 打开颜色盘
				case "?":
					showShortcuts.value = !showShortcuts.value;
					break; // ?: 显示快捷键指南
				case "f":
					toggleFullscreen();
					break; // F: 全屏
			}
		}
	};

	// --- 滑动清屏逻辑 (Slide to Clear) ---
	// 类似 iPhone 锁屏滑动的交互逻辑
	const sliderX = ref(0);
	const isDraggingSlider = ref(false);
	const sliderTrackRef = ref<HTMLDivElement | null>(null);
	const THUMB_WIDTH = 56; // 滑块按钮宽度
	const PADDING = 4; // 滑道内边距

	// 开始拖动
	const handleSliderStart = (e: MouseEvent | TouchEvent) => {
		isDraggingSlider.value = true;
		handleSliderMove(e);
		// 绑定全局事件，防止拖出滑道范围后失效
		window.addEventListener("mousemove", handleSliderMove);
		window.addEventListener("mouseup", handleSliderEnd);
		window.addEventListener("touchmove", handleSliderMove);
		window.addEventListener("touchend", handleSliderEnd);
	};

	// 拖动中
	const handleSliderMove = (e: MouseEvent | TouchEvent) => {
		if (!sliderTrackRef.value) return;
		const clientX = "touches" in e ? (e.touches[0]?.clientX ?? 0) : (e as MouseEvent).clientX;
		const trackRect = sliderTrackRef.value.getBoundingClientRect();
		// 计算相对位移
		const rawX = clientX - trackRect.left - THUMB_WIDTH / 2;
		// 限制滑动范围在轨道内
		const maxDist = trackRect.width - THUMB_WIDTH - PADDING * 2;
		sliderX.value = Math.max(0, Math.min(rawX, maxDist));
	};

	// 拖动结束
	const handleSliderEnd = () => {
		if (!sliderTrackRef.value) return;
		const trackRect = sliderTrackRef.value.getBoundingClientRect();
		const maxDist = trackRect.width - THUMB_WIDTH - PADDING * 2;
		// 如果滑动距离超过 90%，则确认为清屏操作
		if (sliderX.value >= maxDist * 0.9) {
			clearCanvas();
			// 关键优化：清屏是破坏性操作，清空后用户大概率想要重新绘画
			// 所以我们自动将工具切换回画笔，省去用户多点一次的操作
			setTool("pen");
		}
		// 复位滑块
		isDraggingSlider.value = false;
		sliderX.value = 0;
		// 移除事件监听
		window.removeEventListener("mousemove", handleSliderMove);
		window.removeEventListener("mouseup", handleSliderEnd);
		window.removeEventListener("touchmove", handleSliderMove);
		window.removeEventListener("touchend", handleSliderEnd);
	};

	// --- 拖动工具栏逻辑 (Draggable Toolbar) ---
	const toolbarX = ref(window.innerWidth / 2);
	const toolbarY = ref(window.innerHeight - 48);
	const isDraggingToolbar = ref(false);
	let dragStartX = 0;
	let dragStartY = 0;
	let initialToolbarX = 0;
	let initialToolbarY = 0;

	const startDragToolbar = (e: PointerEvent) => {
		// 只有点击工具栏空白处才能拖动，避免点击按钮时误触
		// 可以通过检查 target 是否为 button 或其子元素来判断
		if ((e.target as HTMLElement).closest("button, input, .slider-track")) return;

		isDraggingToolbar.value = true;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		initialToolbarX = toolbarX.value;
		initialToolbarY = toolbarY.value;

		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	};

	const onDragToolbar = (e: PointerEvent) => {
		if (!isDraggingToolbar.value) return;
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;

		// 限制在屏幕范围内
		const newX = initialToolbarX + dx;
		const newY = initialToolbarY + dy;

		// 简单的边界检查 (假设工具栏宽约400，高约80)
		// 实际项目中可以使用 ref 获取 getBoundingClientRect
		const margin = 20;
		const maxX = window.innerWidth - margin;
		const maxY = window.innerHeight - margin;

		toolbarX.value = Math.max(margin, Math.min(newX, maxX));
		toolbarY.value = Math.max(margin, Math.min(newY, maxY));
	};

	const stopDragToolbar = (e: PointerEvent) => {
		if (isDraggingToolbar.value) {
			isDraggingToolbar.value = false;
			(e.target as HTMLElement).releasePointerCapture(e.pointerId);
		}
	};

	// 窗口大小改变时，重置工具栏位置到底部中间，防止消失
	window.addEventListener("resize", () => {
		toolbarX.value = window.innerWidth / 2;
		toolbarY.value = window.innerHeight - 48;
	});

	// --- 生命周期钩子 (Lifecycle) ---

	const saveName = () => {
		if (newName.value) {
			username.value = newName.value;
			localStorage.setItem("wb_username", newName.value);
			showNamePrompt.value = false;
		}
	};

	const connectWebSocket = () => {
		try {
			// 清理旧的 socket 实例，防止多次触发 onclose
			if (socket.value) {
				socket.value.onclose = null;
				socket.value.onerror = null;
				socket.value.onmessage = null;
				socket.value.close();
			}
			console.log(import.meta.env.VITE_WS_URL);
			const wsUrl = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:4646";
			console.log("Connecting to WebSocket server");
			let tokenStr = Array.isArray(token.value) ? token.value[0] : token.value;
			if (tokenStr == undefined) tokenStr = "";
			socket.value = new WebSocket(wsUrl, [tokenStr]);

			socket.value.onopen = () => {
				console.log("Connected to WebSocket server");
			};

			socket.value.onmessage = (event) => {
				try {
					// 判断是不是合法json数据
					if (JSON.parse(event.data)) {
						const msg = JSON.parse(event.data);
						// ...下面都是msg的处理分支...
						if (msg.type === "init") {
							if (isReconnecting.value) {
								toast.success("重新连接成功！");
								isReconnecting.value = false;
								reconnectCount.value = 0;
								if (reconnectTimer) clearTimeout(reconnectTimer);
							} else {
								toast.success("已连接到服务器");
							}
							const initData = msg.data;
							// 更新userId、username和roomname
							userId.value = initData.userId;
							roomId.value = initData.roomId;
							username.value = initData.userName;
							roomName.value = initData.roomName;
							onlineCount.value = initData.onlineCount;
							totalPages.value = initData.totalPage || 1; // 同步初始化时的总页数
							if (initData.commands.length > 0) {
								const lastCommand = initData.commands[initData.commands.length - 1];
								const lastPoint =
									lastCommand.points && Object.keys(lastCommand.points).length > 0
										? lastCommand.points[
												Object.keys(lastCommand.points).length - 1
											]
										: null;
								if (lastPoint) {
									const maxLamport = lastPoint.lamport;
									useLamportStore().lamport = Math.max(
										useLamportStore().lamport,
										maxLamport
									);
								}
							}
							console.log("initData:", initData);
							initData.commands.forEach((cmd: Command) => {
								insertCommand(cmd);
							});
							renderCanvas();
						} else if (msg.type == "online-count-change") {
							onlineCount.value = msg.data.onlineCount;
							if (msg.data.userId != userId.value) {
								const action = msg.data.type == "join" ? "加入" : "离开";
								toast.info(`${msg.data.userName} ${action}了房间`);
							}

							// v8级别的优雅处理：直接操作本地的 memberList 数组，而不去发一次额外的 WS 请求
							const {
								userId: changedUserId,
								userName: changedUserName,
								type: type,
							} = msg.data;
							if (type && changedUserId && changedUserName) {
								if (type == "join") {
									// 防止重复添加
									const exists = memberList.value.some(
										(m) => m[0] === changedUserId
									);
									if (!exists) {
										memberList.value.push([changedUserId, changedUserName]);
									}
								} else if (type == "leave") {
									memberList.value = memberList.value.filter(
										(m) => m[0] !== changedUserId
									);
								}
							}
						} else if (msg.type == "push-cmd") {
							const cmd = msg.data.cmd;
							const pushType = msg.pushType; // update、normal、start
							console.log("Received command message:", pushType);
							if (pushType == "normal" || pushType == "start") {
								// 逻辑修复：无论本地是否在绘图(isDrawing)，都必须处理远端命令
								// 否则本地绘图时，远端的所有操作都会被丢弃，导致同步中断
								if (cmd.userId === userId.value) {
									currentCommandIndex.value = commands.value.length - 1;
								}
								if (pushType == "normal") {
									insertCommand(cmd);
									if (msg.data.lamport) {
										useLamportStore().syncLamport(msg.data.lamport);
									}
									if (cmd.type == "clear") {
										clearClearedCommands(cmd, msg.data.username);
										currentCommandIndex.value = 0;
									}
									renderCanvas();
								} else if (pushType == "start") {
									if (msg.data.lamport) {
										useLamportStore().syncLamport(msg.data.lamport);
									}
									// 处理待处理的更新点
									if (commandStore.pendingUpdates.has(cmd.id)) {
										const points =
											commandStore.pendingUpdates.get(cmd.id) || [];
										cmd.points = markRaw([...(cmd.points || []), ...points]);
										commandStore.pendingUpdates.delete(cmd.id);
									}
									insertCommand(cmd);
									if (cmd.pageId != currentPageId.value) {
										return;
									}
									if (canvasRef.value && ctx.value) {
										const dpr = window.devicePixelRatio || 1;
										const logicalWidth = canvasRef.value.width / dpr;
										const logicalHeight = canvasRef.value.height / dpr;
										const points = cmd.points ?? {};
										renderIncrementPoint(
											cmd,
											points,
											ctx.value,
											logicalWidth,
											logicalHeight
										);
									}
								}
							} else if (pushType == "update") {
								if (msg.data.lamport) {
									useLamportStore().syncLamport(msg.data.lamport);
								}
								// 更新当前绘制命令
								// const cmd: Command = msg.data.cmd;
								const cmdId = msg.data.cmdId;
								const points = msg.data.points ?? [];
								if (points.length == 0) {
									return;
								}
								// 找到本地命令数组中对应的命令并更新其points属性
								const localCmd = commandMap.get(cmdId);
								if (localCmd) {
									// 更新本地命令的points属性，并使用 markRaw 保持原始性
									localCmd.points = markRaw([
										...(localCmd.points || []),
										...points,
									]);
								} else {
									// 如果找不到本地命令，说明可能是新命令，添加到待处理的更新点中
									commandStore.pendingUpdates.set(cmdId, points);
									return;
								}
								if (localCmd.pageId != currentPageId.value) {
									return;
								}
								if (canvasRef.value && ctx.value) {
									const dpr = window.devicePixelRatio || 1;
									const logicalWidth = canvasRef.value.width / dpr;
									const logicalHeight = canvasRef.value.height / dpr;
									// 使用增量渲染函数，只渲染新增的点
									renderIncrementPoint(
										localCmd,
										points,
										ctx.value,
										logicalWidth,
										logicalHeight
									);
								} else {
									renderCanvas();
								}
							} else if (pushType == "stop") {
								if (msg.data.lamport) {
									useLamportStore().syncLamport(msg.data.lamport);
								}
								// 记录当前命令的lastWidth信息
								const cmdId = msg.data.cmdId;
								if (lastWidths[cmdId]) {
									delete lastWidths[cmdId];
								}
								// 关键修复：将 stop 消息中携带的剩余 points 合并到本地命令中
								const stopPoints = msg.data.points ?? msg.data.cmd?.points ?? [];
								const localCmd = commandMap.get(cmdId);

								if (localCmd) {
									if (stopPoints.length > 0) {
										// 将 stop 携带的点合并到本地命令
										localCmd.points = [
											...(localCmd.points || []),
											...stopPoints,
										];
										// 增量渲染这些新增的点
										if (localCmd.pageId != currentPageId.value) {
											return;
										}
										if (canvasRef.value && ctx.value) {
											const dpr = window.devicePixelRatio || 1;
											const logicalWidth = canvasRef.value.width / dpr;
											const logicalHeight = canvasRef.value.height / dpr;
											renderIncrementPoint(
												localCmd,
												stopPoints,
												ctx.value,
												logicalWidth,
												logicalHeight
											);
										}
									}
								} else if (msg.data.cmd) {
									// 兜底：如果 start 包因为网络拥塞丢弃，但我们收到了 stop 包
									const fallbackCmd = msg.data.cmd as Command;
									if (stopPoints.length > 0) {
										fallbackCmd.points = stopPoints;
									}
									insertCommand(fallbackCmd);
									renderCanvas();
								}
								if (
									localCmd &&
									localCmd.type === "path" &&
									localCmd.points &&
									localCmd.points.length === 1
								) {
									if (localCmd.pageId != currentPageId.value) {
										return;
									}
									if (canvasRef.value && ctx.value) {
										const dpr = window.devicePixelRatio || 1;
										const width = canvasRef.value.width / dpr;
										const height = canvasRef.value.height / dpr;

										const p0 = localCmd.points[0];
										if (!p0) {
											return;
										}
										const x = p0.x * width;
										const y = p0.y * height;
										const baseSize = localCmd.size || 3;
										let p0_width = baseSize * (p0.p * 2);
										if (localCmd.tool === "eraser") p0_width = baseSize;

										const color =
											localCmd.tool === "eraser"
												? "#ffffff"
												: localCmd.color || "#000000";
										const op =
											localCmd.tool === "eraser"
												? "destination-out"
												: "source-over";

										ctx.value.save();
										ctx.value.globalCompositeOperation = op;
										ctx.value.fillStyle = color;
										ctx.value.beginPath();
										ctx.value.arc(x, y, p0_width / 2, 0, Math.PI * 2);
										ctx.value.fill();
										ctx.value.restore();
									}
								}

								// 更新lamport时间戳
								const maxLamport = msg.data.lamport;
								useLamportStore().lamport = Math.max(
									useLamportStore().lamport,
									maxLamport
								);
							}
						} else if (msg.type == "cmd-batch-move") {
							// 处理批量移动
							const { userId: msgUserId, cmdIds, dx, dy } = msg.data;
							if (msgUserId === userId.value) return;

							let hasUpdates = false;

							cmdIds.forEach((id: string) => {
								const cmd = commands.value.find((c: Command) => c.id === id);
								if (cmd && cmd.points) {
									cmd.points.forEach((p) => {
										p.x += dx;
										p.y += dy;
									});
									hasUpdates = true;
								}
							});
							if (hasUpdates) renderCanvas();
						} else if (msg.type == "cmd-batch-update") {
							// 处理批量更新 (缩放结果)
							const { userId: msgUserId, updates } = msg.data;
							if (msgUserId === userId.value) return;

							let hasUpdates = false;
							updates.forEach((update: any) => {
								const cmd = commands.value.find(
									(c: Command) => c.id === update.cmdId
								);
								if (cmd) {
									cmd.points = update.points;
									hasUpdates = true;
								}
							});
							if (hasUpdates) renderCanvas();
						} else if (msg.type == "cmd-batch-stop") {
							// 处理批量更新 (缩放结果)
							const { userId: msgUserId, updates } = msg.data;
							if (msgUserId === userId.value) return;

							let hasUpdates = false;
							updates.forEach((update: any) => {
								const cmd = commands.value.find(
									(c: Command) => c.id === update.cmdId
								);
								if (cmd) {
									cmd.points = update.points;
									cmd.box = update.boxes;
									hasUpdates = true;
								}
							});
							if (hasUpdates) renderCanvas();
						} else if (msg.type === "cmd-page-add") {
							// 同步页面增加
							const { totalPages: newTotalPages } = msg.data;
							if (newTotalPages > totalPages.value) {
								toast.info(
									`${msg.data.username} 新建了页面 ${msg.data.totalPages}`,
									{
										action: {
											label: "点击前往",
											onClick: () => goToPage(msg.data.totalPages - 1),
										},
									}
								);
								totalPages.value = newTotalPages;
							}
						} else if (msg.type == "mouseMove") {
							// 在屏幕上更新用户鼠标位置
							const { userId, userName, x, y, pageId } = msg.data;
							remoteCursors.value.set(userId, {
								userId,
								userName,
								x,
								y,
								pageId: pageId ?? 0, // 兼容老版本报文
								color: getCursorColor(userId), // 使用动态哈希色彩分配
								lastUpdate: Date.now(),
							});
						} else if (msg.type === "get-member-list") {
							memberList.value = msg.data.memberList || [];
						} else if (msg.type == "mouseLeave") {
							const { userId } = msg.data;
							if (remoteCursors.value.has(userId)) {
								remoteCursors.value.delete(userId);
							}
							if (remoteSelectionRects.value.has(userId)) {
								remoteSelectionRects.value.delete(userId);
							}
						} else if (msg.type == "box-selection") {
							const { userId, rect } = msg.data;
							if (rect) {
								remoteSelectionRects.value.set(userId, rect);
							} else {
								remoteSelectionRects.value.delete(userId);
							}
						} else if (msg.type == "undo-cmd") {
							const cmdId = msg.data.cmdId;
							const cmd = commands.value.find((c: Command) => c.id === cmdId);
							if (cmd) {
								cmd.isDeleted = true;
								renderCanvas();
								setTool(currentTool.value);
							}
						} else if (msg.type == "redo-cmd") {
							const cmdId = msg.data.cmdId;
							const cmd = commands.value.find((c: Command) => c.id === cmdId);
							if (cmd) {
								cmd.isDeleted = false;
								renderCanvas();
								setTool(currentTool.value);
							}
						}
					}
				} catch (error) {
					console.error(
						"[WebSocket Message Error]: Failed to parse or process message.",
						error,
						event.data
					);
				}
			};

			socket.value.onclose = () => {
				console.log("WebSocket connection closed");
				if (isIntentionalClose.value) return; // 如果是主动关闭，则不进行重连

				// 为了防止某种极其离谱的同步触发，只在一个宏任务后发起重连
				if (!reconnectFailed.value) {
					setTimeout(() => doReconnect(), 100);
				}
			};

			socket.value.onerror = (error) => {
				console.error("WebSocket error:", error);
				// onerror 也会导致 onclose，所以这里不需要额外触发 doReconnect
			};
		} catch (error) {
			console.error("Failed to connect to WebSocket:", error);
			toast.error("无法连接到服务器");
			// 如果 new WebSocket() 同步抛出错误，onclose 不会被触发，需要手动触发重连逻辑
			if (!isIntentionalClose.value && !reconnectFailed.value) {
				setTimeout(() => doReconnect(), 100);
			}
		}
	};

	// 脏矩形批合并 + requestAnimationFrame 防抖
	let pendingDirtyRect: any = null;
	let dirtyRafId: number | null = null;

	const handleDirtyRerender = (event: Event) => {
		const rect = (event as CustomEvent).detail?.rect;
		if (!rect) return;

		// 合并到累积脏矩形（取并集）
		if (!pendingDirtyRect) {
			pendingDirtyRect = { ...rect };
		} else {
			const newMinX = Math.min(pendingDirtyRect.minX, rect.minX);
			const newMinY = Math.min(pendingDirtyRect.minY, rect.minY);
			const newMaxX = Math.max(
				pendingDirtyRect.minX + pendingDirtyRect.width,
				rect.minX + rect.width
			);
			const newMaxY = Math.max(
				pendingDirtyRect.minY + pendingDirtyRect.height,
				rect.minY + rect.height
			);
			pendingDirtyRect = {
				minX: newMinX,
				minY: newMinY,
				maxX: newMaxX,
				maxY: newMaxY,
				width: newMaxX - newMinX,
				height: newMaxY - newMinY,
			};
		}

		// 下一帧统一重绘一次
		if (!dirtyRafId) {
			dirtyRafId = requestAnimationFrame(() => {
				if (pendingDirtyRect) {
					reRenderDirtyRect(pendingDirtyRect, ctx.value!, canvasRef.value!);
					console.log("接收到重绘事件，正在重绘区域:", pendingDirtyRect);
				}
				pendingDirtyRect = null;
				dirtyRafId = null;
			});
		}
	};

	onMounted(() => {
		// 专门为 Benchmark 状态强制对账暴露的 commands 引用
		if (typeof window !== "undefined") {
			(window as any).__benchmarkCommands = commands;
			(window as any).__benchmarkLamportStore = useLamportStore();
			(window as any).__benchmarkCurrentColor = currentColor;
		}

		connectWebSocket();

		if (canvasRef.value) {
			ctx.value = canvasRef.value.getContext("2d");
		}
		if (uiCanvasRef.value) {
			uiCtx.value = uiCanvasRef.value.getContext("2d");
		}

		resizeCanvas();
		startUILoop(); // 启动 UI 渲染循环

		// 监听命令交叉重绘事件
		window.addEventListener("point-collision", handleDirtyRerender);

		// 监听窗口大小变化
		window.addEventListener("resize", resizeCanvas);
		// 监听键盘快捷键
		window.addEventListener("keydown", handleKeydown);

		canvasRef.value?.addEventListener("pointerleave", () => {
			socket.value?.send(
				JSON.stringify({
					type: "mouseLeave",
					data: {
						userId: userId.value,
						userName: username.value,
					},
				})
			);
		});
		document.addEventListener("fullscreenchange", () => {
			isFullscreen.value = !!document.fullscreenElement;
		});
	});

	onUnmounted(() => {
		isIntentionalClose.value = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (uiLoopId) cancelAnimationFrame(uiLoopId);
		if (socket.value) {
			socket.value.close();
		}
		// 组件销毁前清理事件监听，防止内存泄漏
		window.removeEventListener("resize", resizeCanvas);
		window.removeEventListener("keydown", handleKeydown);
		window.removeEventListener("point-collision", handleDirtyRerender);
	});
</script>

<template>
	<div class="fixed inset-0 overflow-hidden bg-slate-50 touch-none select-none">
		<!-- Name Prompt -->
		<div
			v-if="showNamePrompt"
			class="fixed inset-0 z-100 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
		>
			<div class="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
				<h3 class="text-xl font-bold mb-4">请输入你的名字</h3>
				<input
					v-model="newName"
					@keyup.enter="saveName"
					class="w-full px-4 py-2 border rounded-xl mb-4 focus:ring-2 focus:ring-indigo-500 outline-none"
					placeholder="你的名字"
				/>
				<button
					@click="saveName"
					class="w-full py-2 bg-indigo-600 text-white rounded-xl font-medium"
				>
					开始绘画
				</button>
			</div>
		</div>

		<!-- Reconnecting Overlay -->
		<div
			v-if="isReconnecting"
			class="fixed inset-0 z-100 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
		>
			<div
				class="bg-white rounded-2xl p-4 sm:p-8 max-h-full overflow-y-auto max-w-sm w-full shadow-2xl flex flex-col items-center text-center"
			>
				<RotateCw
					class="w-8 h-8 sm:w-12 sm:h-12 text-indigo-500 animate-[spin_2s_linear_infinite] mb-2 sm:mb-4"
				/>
				<h3 class="text-lg sm:text-xl font-bold text-slate-800 mb-1 sm:mb-2">
					正在尝试重连...
				</h3>
				<p class="text-slate-500 mb-3 sm:mb-4 text-xs sm:text-base">与服务器的连接已断开</p>
				<div
					class="w-full bg-slate-100 rounded-full h-1.5 sm:h-2 mb-2 overflow-hidden items-start flex"
				>
					<div
						class="bg-indigo-500 h-1.5 sm:h-2 rounded-full transition-all duration-300"
						:style="{ width: (reconnectCount / MAX_RECONNECT) * 100 + '%' }"
					></div>
				</div>
				<p class="text-xs sm:text-sm font-medium text-slate-400">
					第 {{ reconnectCount }} / {{ MAX_RECONNECT }} 次尝试
				</p>
			</div>
		</div>

		<!-- Reconnect Failed Overlay -->
		<div
			v-if="reconnectFailed"
			class="fixed inset-0 z-100 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-2 sm:p-4"
		>
			<div
				class="bg-white rounded-2xl p-4 sm:p-8 max-h-full overflow-y-auto max-w-sm w-full shadow-2xl flex flex-col items-center text-center pointer-events-auto"
			>
				<div
					class="w-12 h-12 sm:w-16 sm:h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-3 sm:mb-6"
				>
					<X class="w-6 h-6 sm:w-8 sm:h-8" />
				</div>
				<h3 class="text-lg sm:text-xl font-bold text-slate-800 mb-1 sm:mb-2">连接失败</h3>
				<p class="text-slate-500 mb-4 sm:mb-6 text-xs sm:text-base">
					服务器连接超时，请返回首页或重新尝试连接。
				</p>
				<div class="flex gap-2 sm:gap-3 w-full">
					<button
						@click="router.push('/')"
						class="flex-1 py-2 sm:py-3 px-2 sm:px-4 text-sm sm:text-base bg-slate-100 text-slate-700 hover:bg-slate-200 font-bold rounded-xl transition-colors"
					>
						返回首页
					</button>
					<button
						@click="retryReconnect"
						class="flex-1 py-2 sm:py-3 px-2 sm:px-4 text-sm sm:text-base bg-indigo-600 text-white hover:bg-indigo-700 font-bold rounded-xl transition-colors"
					>
						重试连接
					</button>
				</div>
			</div>
		</div>

		<!-- Size Preview (Center Overlay) -->
		<transition
			enter-active-class="transition duration-200 ease-out"
			enter-from-class="opacity-0 scale-50"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition duration-150 ease-in"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-50"
		>
			<div
				v-if="showSizePreview"
				class="fixed inset-0 pointer-events-none z-80 flex items-center justify-center"
			>
				<div
					class="bg-white/80 backdrop-blur-md rounded-3xl p-6 shadow-2xl border border-white/50 flex flex-col items-center gap-4"
				>
					<div
						class="rounded-full shadow-inner border border-slate-200 transition-all duration-75"
						:style="{
							width: currentSize + 'px',
							height: currentSize + 'px',
							backgroundColor: currentTool === 'eraser' ? '#cbd5e1' : currentColor,
						}"
					></div>
					<div class="text-slate-500 font-bold font-mono text-lg">
						{{ currentSize }}px
					</div>
				</div>
			</div>
		</transition>

		<!-- Shortcuts Dialog -->
		<transition
			enter-active-class="transition duration-300 ease-out"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition duration-200 ease-in"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="showShortcuts"
				class="fixed inset-0 z-90 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
				@click.self="showShortcuts = false"
			>
				<div
					class="bg-white/90 backdrop-blur-sm rounded-4xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto border border-white/50 ring-1 ring-white/50 scrollbar-hide"
				>
					<!-- Header -->
					<div
						class="sticky top-0 z-10 flex justify-between items-start px-4 hmd:px-6 py-3 hmd:py-4 bg-white/80 backdrop-blur-xl border-b border-slate-100/50"
					>
						<div>
							<h3
								class="text-lg hmd:text-xl font-black text-slate-800 tracking-tight flex items-center gap-2"
							>
								<Keyboard class="w-4 h-4 hmd:w-5 hmd:h-5 text-indigo-500" />
								快捷指令
								<span
									class="text-[10px] hmd:text-xs font-medium text-slate-400 opacity-80 animate-pulse"
									>(Scrollable)</span
								>
							</h3>
							<p
								class="hidden hmd:block text-slate-400 text-[11px] hmd:text-xs mt-0.5 font-medium"
							>
								高效创作必备
							</p>
						</div>
						<button
							@click="showShortcuts = false"
							class="p-2 -mr-2 -mt-2 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
						>
							<X class="w-6 h-6" />
						</button>
					</div>

					<div class="p-3 hmd:p-4 grid grid-cols-2 gap-2 hmd:gap-3">
						<div
							class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-indigo-100 hover:shadow-md transition-all group"
						>
							<div class="flex items-center gap-2 mb-1">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center group-hover:scale-110 transition-transform"
								>
									<Pencil class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="font-bold text-slate-700 text-xs hmd:text-sm"
									>画笔</span
								>
							</div>
							<div class="flex justify-end">
								<kbd
									class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-indigo-200 group-hover:text-indigo-500 transition-colors"
									>P</kbd
								>
							</div>
						</div>

						<div
							class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-pink-100 hover:shadow-md transition-all group"
						>
							<div class="flex items-center gap-2 mb-1">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-pink-50 text-pink-600 flex items-center justify-center group-hover:scale-110 transition-transform"
								>
									<Eraser class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="font-bold text-slate-700 text-xs hmd:text-sm"
									>橡皮擦</span
								>
							</div>
							<div class="flex justify-end">
								<kbd
									class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-pink-200 group-hover:text-pink-500 transition-colors"
									>E</kbd
								>
							</div>
						</div>

						<div
							class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-orange-100 hover:shadow-md transition-all group"
						>
							<div class="flex items-center gap-2 mb-1">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-orange-50 text-orange-600 flex items-center justify-center group-hover:scale-110 transition-transform"
								>
									<Palette class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="font-bold text-slate-700 text-xs hmd:text-sm"
									>调色板</span
								>
							</div>
							<div class="flex justify-end">
								<kbd
									class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-orange-200 group-hover:text-orange-500 transition-colors"
									>C</kbd
								>
							</div>
						</div>

						<div
							class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-blue-100 hover:shadow-md transition-all group"
						>
							<div class="flex items-center gap-2 mb-1">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center group-hover:scale-110 transition-transform"
								>
									<Maximize class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="font-bold text-slate-700 text-xs hmd:text-sm"
									>全屏</span
								>
							</div>
							<div class="flex justify-end">
								<kbd
									class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-blue-200 group-hover:text-blue-500 transition-colors"
									>F</kbd
								>
							</div>
						</div>

						<div
							class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-slate-200 hover:shadow-md transition-all group"
						>
							<div class="flex items-center gap-2 mb-1">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform"
								>
									<RotateCcw class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="font-bold text-slate-700 text-xs hmd:text-sm"
									>撤销</span
								>
							</div>
							<div class="flex justify-end gap-1">
								<kbd
									class="px-1 py-0.5 bg-slate-100 rounded-md border-b-2 border-slate-200 font-mono text-[10px] font-bold text-slate-500 group-hover:bg-white group-hover:border-slate-300 group-hover:text-slate-700 transition-colors"
									>Ctrl+Z</kbd
								>
							</div>
						</div>

						<div
							class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-slate-200 hover:shadow-md transition-all group"
						>
							<div class="flex items-center gap-2 mb-1">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform"
								>
									<RotateCw class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="font-bold text-slate-700 text-xs hmd:text-sm"
									>重做</span
								>
							</div>
							<div class="flex justify-end gap-1">
								<kbd
									class="px-1 py-0.5 bg-slate-100 rounded-md border-b-2 border-slate-200 font-mono text-[10px] font-bold text-slate-500 group-hover:bg-white group-hover:border-slate-300 group-hover:text-slate-700 transition-colors"
									>Ctrl+Y</kbd
								>
							</div>
						</div>
					</div>

					<div
						class="px-4 hmd:px-6 py-2 hmd:py-3 bg-slate-50 border-t border-slate-100 text-center sticky bottom-0 z-10 hidden hsm:block"
					>
						<button
							@click="showShortcuts = false"
							class="text-xs hmd:text-sm font-bold text-indigo-500 hover:text-indigo-600 transition-colors"
						>
							我知道了
						</button>
					</div>
				</div>
			</div>
		</transition>

		<!-- Page Overview Modal -->
		<transition
			enter-active-class="transition duration-300 ease-out"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition duration-200 ease-in"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="showPageOverview"
				class="fixed inset-0 z-90 bg-slate-100/95 backdrop-blur-md flex flex-col p-6 sm:p-10"
			>
				<!-- Header -->
				<div class="flex justify-between items-center mb-4 hmd:mb-8">
					<div>
						<h3
							class="text-xl hmd:text-3xl font-black text-slate-800 tracking-tight flex items-center gap-2 hmd:gap-3"
						>
							<LayoutGrid class="w-6 h-6 hmd:w-8 hmd:h-8 text-indigo-500" /> 总览视图
						</h3>
						<p
							class="text-slate-500 font-medium mt-1 hmd:mt-2 ml-1 text-xs hmd:text-sm"
						>
							总计 {{ totalPages }} 张画布
						</p>
					</div>
					<button
						@click="showPageOverview = false"
						class="p-2 hmd:p-3 rounded-full bg-white hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors shadow-sm"
					>
						<X class="w-5 h-5 hmd:w-6 hmd:h-6" />
					</button>
				</div>

				<!-- Grid -->
				<div class="flex-1 overflow-y-auto min-h-0 scrollbar-hide pb-20">
					<div
						class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 hmd:gap-6 p-2 hmd:p-4"
					>
						<div
							v-for="i in totalPages"
							:key="i"
							@click="goToPage(i - 1)"
							class="aspect-video bg-white rounded-xl hmd:rounded-2xl shadow-sm border-2 transition-all cursor-pointer relative group overflow-hidden"
							:class="
								currentPageId === i - 1
									? 'border-indigo-500 ring-4 ring-indigo-500/20 shadow-xl scale-[1.02]'
									: 'border-transparent hover:border-slate-300 hover:shadow-md hover:-translate-y-1'
							"
						>
							<!-- Preview Canvas -->
							<div
								class="absolute inset-1 hmd:inset-2 bg-slate-50/50 rounded-lg hmd:rounded-xl overflow-hidden border border-slate-100"
							>
								<canvas
									:ref="(el) => renderPreviewCanvas(el, i - 1)"
									class="w-full h-full object-contain pointer-events-none"
								></canvas>
							</div>

							<!-- Page Number Label -->
							<div
								class="absolute bottom-2 hmd:bottom-4 left-2 hmd:left-4 px-2 hmd:px-3 py-0.5 hmd:py-1 bg-white/90 backdrop-blur-sm rounded-md hmd:rounded-lg shadow-sm border border-slate-200 text-[10px] hmd:text-xs font-bold text-slate-600 font-mono"
							>
								{{ i }}
							</div>

							<!-- Current Indicator -->
							<div
								v-if="currentPageId === i - 1"
								class="absolute top-2 hmd:top-4 right-2 hmd:right-4 w-2 h-2 hmd:w-3 hmd:h-3 bg-indigo-500 rounded-full shadow-sm ring-2 ring-white"
							></div>

							<!-- 跨页状态探针 (Cross-page Activity Heatmap) -->
							<div
								class="absolute bottom-2 hmd:bottom-4 right-2 hmd:right-4 flex -space-x-1.5 hmd:-space-x-2"
							>
								<template
									v-for="(cursor, key) in Array.from(remoteCursors.values())
										.filter((c) => c.pageId === i - 1)
										.slice(0, 3)"
									:key="cursor.userId"
								>
									<div
										class="w-3 h-3 hmd:w-4 hmd:h-4 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-[8px] font-bold text-white relative z-10"
										:style="{ backgroundColor: cursor.color }"
										:title="cursor.userName + ' 正在此页活跃'"
									>
										{{ cursor.userName.charAt(0).toUpperCase() }}
									</div>
								</template>
								<!-- 超出3个人的气泡 -->
								<div
									v-if="
										Array.from(remoteCursors.values()).filter(
											(c: RemoteCursor) => c.pageId === i - 1
										).length > 3
									"
									class="w-3 h-3 hmd:w-4 hmd:h-4 bg-slate-200 text-slate-500 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-[7px] font-bold relative z-0"
								>
									+
								</div>
							</div>
						</div>

						<!-- Add Page Button in Grid -->
						<div
							@click="
								nextPage();
								goToPage(totalPages - 1);
							"
							class="aspect-video bg-slate-50/50 rounded-xl hmd:rounded-2xl border-2 border-dashed border-slate-300 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all cursor-pointer flex flex-col items-center justify-center gap-1 hmd:gap-2 group text-slate-400 hover:text-indigo-500"
						>
							<div
								class="w-8 h-8 hmd:w-12 hmd:h-12 rounded-full bg-white shadow-sm border border-slate-200 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<Plus class="w-4 h-4 hmd:w-6 hmd:h-6" />
							</div>
							<span class="font-bold text-xs hmd:text-sm">新建页面</span>
						</div>
					</div>
				</div>
			</div>
		</transition>

		<!-- Member List Sidebar -->
		<transition
			enter-active-class="transition-transform duration-300 ease-in-out"
			enter-from-class="translate-x-full"
			enter-to-class="translate-x-0"
			leave-active-class="transition-transform duration-300 ease-in-out"
			leave-from-class="translate-x-0"
			leave-to-class="translate-x-full"
		>
			<div
				v-if="showMemberList"
				class="fixed top-0 right-0 bottom-0 w-64 hmd:w-72 bg-white/95 backdrop-blur-md shadow-2xl border-l border-slate-100 z-80 flex flex-col pointer-events-auto"
			>
				<div
					class="flex items-center justify-between p-3 border-b border-slate-100 shrink-0"
				>
					<h3 class="text-sm font-bold text-slate-800 flex items-center gap-2">
						<Users class="w-4 h-4 text-indigo-500" />
						在线协作成员
						<span
							class="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold"
							>{{ onlineCount }}</span
						>
					</h3>
					<button
						@click="showMemberList = false"
						class="p-1.5 -mr-1.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
					>
						<X class="w-4 h-4" />
					</button>
				</div>
				<!-- 成员列表滚动区 -->
				<div class="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0 scrollbar-hide">
					<div
						v-if="memberList.length === 0"
						class="flex flex-col items-center justify-center py-8 text-slate-400 gap-2"
					>
						<div
							class="w-5 h-5 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin"
						></div>
						<span class="text-xs font-medium">加载中...</span>
					</div>
					<div
						v-else
						v-for="(member, index) in memberList"
						:key="index"
						class="flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-50 border border-transparent hover:border-slate-100 transition-colors group"
					>
						<!-- 用户头像 (首字母) + 在线小绿点 -->
						<div
							class="relative w-8 h-8 shrink-0 rounded-full bg-linear-to-br from-indigo-100 to-purple-100 text-indigo-600 flex items-center justify-center font-black text-xs shadow-sm shadow-indigo-100/50 border border-indigo-50 group-hover:scale-105 transition-transform duration-300"
						>
							{{ member[1] ? member[1].charAt(0).toUpperCase() : "?" }}
							<span
								class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 border-2 border-white rounded-full"
							></span>
						</div>
						<div class="flex-1 min-w-0 pr-1">
							<!-- 用户名与标签同行显示 -->
							<div
								class="font-bold text-slate-700 text-[13px] truncate flex items-center gap-1.5"
							>
								<span class="truncate">{{ member[1] }}</span>
								<span
									v-if="
										member[1] ===
										(Array.isArray(username) ? username[0] : username)
									"
									class="px-1.5 py-px rounded-[4px] shrink-0 text-[9px] items-center bg-emerald-50 text-emerald-600 font-bold tracking-widest border border-emerald-100"
									>我</span
								>
							</div>
						</div>
					</div>
				</div>
			</div>
		</transition>

		<!-- Rotate Hint -->
		<div
			class="hidden md:hidden portrait:flex fixed inset-0 z-100 bg-slate-900/95 text-white items-center justify-center flex-col p-8 text-center backdrop-blur-sm"
		>
			<RotateCcw class="w-12 h-12 mb-4 animate-[spin_4s_linear_infinite]" />
			<h2 class="text-2xl font-bold mb-2">请旋转设备</h2>
			<p class="text-slate-400">为了获得最佳绘画体验，请横屏使用。</p>
		</div>

		<!-- Header (Hidden in Fullscreen if desired, or auto-hide. User said "Hide most functional areas") -->
		<!-- Simple logic: hide header in fullscreen -->
		<transition
			enter-active-class="transition duration-300"
			enter-from-class="-translate-y-full opacity-0"
			enter-to-class="translate-y-0 opacity-100"
			leave-active-class="transition duration-300"
			leave-from-class="translate-y-0 opacity-100"
			leave-to-class="-translate-y-full opacity-0"
		>
			<div
				v-if="!isFullscreen"
				class="absolute top-0 left-0 right-0 h-16 px-4 flex justify-between items-center z-10 pointer-events-none"
			>
				<!-- Left: Mock Room Name -->
				<div
					class="pointer-events-auto flex items-center gap-1 hmd:gap-3 bg-white/80 backdrop-blur-md shadow-sm border border-white/50 px-2 hmd:px-2 py-1.5 hmd:py-2 rounded-xl hmd:rounded-2xl"
				>
					<div
						class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-linear-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white shadow-md"
					>
						<Monitor class="w-3 h-3 hmd:w-5 hmd:h-5" />
					</div>
					<div>
						<div class="font-bold text-slate-800 text-sm hmd:text-base leading-tight">
							{{ roomName }}
						</div>
						<div
							class="hidden hmd:block text-[10px] text-slate-400 font-mono font-medium tracking-wider"
						>
							ID: {{ roomId }}
						</div>
					</div>
				</div>

				<!-- Right: Online Status & Menu -->
				<div class="pointer-events-auto flex items-center pr-2">
					<div class="flex items-center">
						<div class="relative z-20">
							<!-- Online Status Pill -->
							<button
								@click="activeMenu = activeMenu === 'more' ? null : 'more'"
								class="group flex items-center gap-1.5 hmd:gap-2 p-0.5 hmd:p-1 pr-2.5 hmd:pr-4 rounded-lg hmd:rounded-full bg-white/90 backdrop-blur-md shadow-sm border border-slate-200/60 hover:border-indigo-300 hover:bg-white hover:shadow-md transition-all duration-300"
								:class="{
									'ring-4 ring-indigo-500/10 border-indigo-300 bg-white':
										activeMenu === 'more',
								}"
							>
								<div class="relative flex items-center justify-center">
									<div
										class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg hmd:rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center group-hover:bg-indigo-100 transition-colors"
										:class="{
											'bg-indigo-500 text-white group-hover:bg-indigo-600':
												activeMenu === 'more',
										}"
									>
										<Users class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
									</div>
									<span
										class="absolute -top-0.5 -right-0.5 flex h-2 w-2 hmd:h-2.5 hmd:w-2.5"
									>
										<span
											class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"
										></span>
										<span
											class="relative inline-flex rounded-full h-2 w-2 hmd:h-2.5 hmd:w-2.5 bg-emerald-500 border border-white"
										></span>
									</span>
								</div>
								<span
									class="text-[11px] hmd:text-xs font-bold text-slate-700 group-hover:text-indigo-600 transition-colors"
								>
									{{ onlineCount }}
									<span class="hidden hmd:inline">人协作中</span>
								</span>
							</button>

							<!-- Secondary Menu Popover -->
							<transition
								enter-active-class="transition duration-200 ease-out"
								enter-from-class="opacity-0 scale-95 translate-y-2"
								enter-to-class="opacity-100 scale-100 translate-y-0"
								leave-active-class="transition duration-150 ease-in"
								leave-from-class="opacity-100 scale-100 translate-y-0"
								leave-to-class="opacity-0 scale-95 translate-y-2"
							>
								<div
									v-if="activeMenu === 'more'"
									class="absolute top-full right-0 mt-3 w-56 hmd:w-64 bg-white/95 backdrop-blur-sm border border-white/20 rounded-2xl shadow-2xl overflow-hidden origin-top-right p-1.5 flex flex-col gap-1 z-50"
								>
									<button
										@click="copyLink"
										class="flex items-center gap-2 hmd:gap-3 w-full p-1.5 hmd:p-3 rounded-xl hover:bg-indigo-50 group text-left transition-colors"
									>
										<div
											class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center group-hover:bg-indigo-200 transition-colors shrink-0"
										>
											<Check
												v-if="hasCopied"
												class="w-3 h-3 hmd:w-4 hmd:h-4"
											/>
											<Copy v-else class="w-3 h-3 hmd:w-4 hmd:h-4" />
										</div>
										<div class="flex-1">
											<div
												class="text-[11px] hmd:text-sm font-bold text-slate-700"
											>
												{{ hasCopied ? "已复制链接" : "复制邀请链接" }}
											</div>
											<div
												class="hidden hmd:block text-[10px] text-slate-400"
											>
												点击复制房间地址
											</div>
										</div>
									</button>

									<div class="h-px bg-slate-100 mx-2 my-0.5"></div>

									<button
										@click="openMemberList"
										class="flex items-center gap-2 hmd:gap-3 w-full p-1.5 hmd:p-3 rounded-xl hover:bg-slate-50 text-left transition-colors"
									>
										<div
											class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"
										>
											<Users class="w-3 h-3 hmd:w-4 hmd:h-4" />
										</div>
										<div class="flex-1">
											<div
												class="text-[11px] hmd:text-sm font-bold text-slate-700"
											>
												在线人数
											</div>
											<div
												class="hidden hmd:block text-[10px] text-slate-400"
											>
												{{ onlineCount }} 人正在协作
											</div>
										</div>
									</button>

									<button
										@click="
											showShortcuts = !showShortcuts;
											activeMenu = null;
										"
										class="flex items-center gap-2 hmd:gap-3 w-full p-1.5 hmd:p-3 rounded-xl hover:bg-slate-50 text-left transition-colors"
									>
										<div
											class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"
										>
											<Keyboard class="w-3 h-3 hmd:w-4 hmd:h-4" />
										</div>
										<div class="flex-1">
											<div
												class="text-[11px] hmd:text-sm font-bold text-slate-700"
											>
												快捷键指南
											</div>
											<div
												class="hidden hmd:block text-[10px] text-slate-400"
											>
												查看常用快捷操作
											</div>
										</div>
									</button>
								</div>
							</transition>
						</div>
					</div>
				</div>
			</div>
		</transition>

		<!-- Custom Cursor for Eraser -->
		<div
			v-show="currentTool === 'eraser' && showEraserCursor"
			class="fixed pointer-events-none rounded-full border border-slate-500 bg-slate-400/20 z-50 transform -translate-x-1/2 -translate-y-1/2 transition-transform duration-75 ease-out"
			:style="{
				left: cursorX + 'px',
				top: cursorY + 'px',
				width: currentSize + 'px',
				height: currentSize + 'px',
			}"
		></div>

		<!-- Pagination Controls (Fixed Bottom Right) -->
		<div
			class="fixed bottom-3 hmd:bottom-4 right-3 hmd:right-4 z-50 flex items-center gap-0.5 hmd:gap-1 bg-white/90 backdrop-blur-sm border border-slate-200/60 p-1 hmd:p-1.5 rounded-xl shadow-lg ring-1 ring-slate-100 touch-none select-none"
		>
			<button
				@click="prevPage"
				:disabled="currentPageId === 0"
				class="p-1.5 hmd:p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
				title="上一页"
			>
				<ChevronLeft class="w-4 h-4 hmd:w-5 hmd:h-5" />
			</button>

			<button
				@click="showPageOverview = true"
				class="px-1.5 hmd:px-2 font-mono text-xs hmd:text-sm font-bold text-slate-600 flex items-center justify-center min-w-10 hmd:min-w-12 gap-0.5 hmd:gap-1 hover:bg-slate-100 rounded-lg py-1 transition-colors relative"
				title="页面概览"
			>
				<LayoutGrid
					v-if="showPageOverview"
					class="w-3.5 h-3.5 hmd:w-4 hmd:h-4 text-indigo-500"
				/>
				<template v-else>
					<span>{{ currentPageId + 1 }}</span>
					<span class="text-slate-300 text-[10px] hmd:text-xs">/</span>
					<span>{{ totalPages }}</span>
				</template>
			</button>

			<button
				@click="nextPage"
				class="p-1.5 hmd:p-2 rounded-lg transition-colors relative group"
				:class="
					currentPageId === totalPages - 1
						? 'text-indigo-500 hover:bg-indigo-50'
						: 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
				"
				:title="currentPageId === totalPages - 1 ? '新建页面' : '下一页'"
			>
				<Plus
					v-if="currentPageId === totalPages - 1"
					class="w-4 h-4 hmd:w-5 hmd:h-5 group-hover:scale-110 transition-transform"
				/>
				<ChevronRight v-else class="w-4 h-4 hmd:w-5 hmd:h-5" />
			</button>
		</div>

		<!-- Canvas Wrapper -->
		<div class="fixed inset-0 w-full h-full touch-none select-none overflow-hidden bg-white">
			<!-- Main Drawing Canvas (Bottom Layer) -->
			<canvas
				ref="canvasRef"
				@pointerdown="startDrawing"
				@pointermove="draw"
				@pointerup="stopDrawing"
				@pointercancel="stopDrawing"
				@pointerenter="showEraserCursor = true"
				@pointerleave="showEraserCursor = false"
				class="absolute inset-0 w-full h-full touch-none z-5"
				:class="{
					'cursor-none': currentTool === 'eraser',
					'cursor-crosshair': currentTool === 'pen',
					'cursor-default': currentTool === 'cursor',
				}"
			></canvas>

			<!-- UI Overlay Canvas (Top Layer: Cursors, Select Box) -->
			<canvas
				ref="uiCanvasRef"
				class="absolute inset-0 w-full h-full pointer-events-none z-10"
			></canvas>
		</div>

		<!-- Toolbar -->
		<div
			class="fixed z-20 touch-none flex items-center justify-center"
			:style="{
				left: toolbarX + 'px',
				top: toolbarY + 'px',
				transform: 'translate(-50%, -50%)',
				cursor: isDraggingToolbar ? 'grabbing' : 'grab',
			}"
			@pointerdown="startDragToolbar"
			@pointermove="onDragToolbar"
			@pointerup="stopDragToolbar"
			@pointercancel="stopDragToolbar"
		>
			<transition name="toolbar-pop" mode="out-in">
				<!-- ================= FULL TOOLBAR ================= -->
				<div
					v-if="!isToolbarCollapsed"
					key="expanded"
					class="pointer-events-auto bg-white/80 backdrop-blur-sm shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-white/40 p-1 hmd:p-2 rounded-2xl flex items-center gap-1 hmd:gap-2"
				>
					<!-- Toggle Button (Collapse) -->
					<button
						@click.stop="isToolbarCollapsed = true"
						class="p-1.5 hmd:p-2 cursor-pointer rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors shrink-0 z-10"
						title="收起工具栏"
					>
						<ChevronRight class="w-4 h-4 hmd:w-5 hmd:h-5 transition-transform" />
					</button>

					<!-- Cursor / Select -->
					<div class="relative shrink-0">
						<button
							@click="setTool('cursor')"
							class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all"
							:class="
								currentTool === 'cursor'
									? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
									: 'text-slate-400 hover:bg-slate-50'
							"
						>
							<MousePointer2 class="w-4 h-4 hmd:w-5 hmd:h-5" />
						</button>
					</div>

					<!-- Pen -->
					<div class="relative shrink-0">
						<transition
							enter-active-class="transition duration-200"
							enter-from-class="opacity-0 translate-y-4 scale-95"
							enter-to-class="opacity-100 translate-y-0 scale-100"
							leave-active-class="transition duration-150"
							leave-from-class="opacity-100 translate-y-0 scale-100"
							leave-to-class="opacity-0 translate-y-4 scale-95"
						>
							<div
								v-if="activeMenu === 'pen'"
								class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-3 hmd:p-4 bg-white/90 backdrop-blur-sm border border-white rounded-xl shadow-xl w-40 hmd:w-48 origin-bottom"
							>
								<div
									class="text-[10px] hmd:text-xs font-bold text-slate-400 mb-1.5 hmd:mb-2 flex justify-between"
								>
									<span>画笔粗细</span>
									<span>{{ currentSize }}px</span>
								</div>
								<input
									type="range"
									min="1"
									max="30"
									v-model.number="currentSize"
									@pointerdown="showSizePreview = true"
									@pointerup="showSizePreview = false"
									@pointercancel="showSizePreview = false"
									class="w-full h-1.5 hmd:h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
								/>
							</div>
						</transition>
						<button
							@click="toggleMenu('pen')"
							class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10"
							:class="
								currentTool === 'pen'
									? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
									: 'text-slate-400 hover:bg-slate-50'
							"
						>
							<Pencil class="w-4 h-4 hmd:w-5 hmd:h-5" />
						</button>
					</div>

					<!-- Eraser -->
					<div class="relative shrink-0">
						<transition
							enter-active-class="transition duration-200"
							enter-from-class="opacity-0 translate-y-4 scale-95"
							enter-to-class="opacity-100 translate-y-0 scale-100"
							leave-active-class="transition duration-150"
							leave-from-class="opacity-100 translate-y-0 scale-100"
							leave-to-class="opacity-0 translate-y-4 scale-95"
						>
							<div
								v-if="activeMenu === 'eraser'"
								class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-3 hmd:p-4 bg-white/90 backdrop-blur-sm border border-white rounded-xl shadow-xl w-48 hmd:w-56 origin-bottom"
							>
								<div class="space-y-3 hmd:space-y-4">
									<div>
										<div
											class="text-[10px] hmd:text-xs font-bold text-slate-400 mb-1.5 hmd:mb-2 flex justify-between"
										>
											<span>橡皮粗细</span>
											<span>{{ currentSize }}px</span>
										</div>
										<input
											type="range"
											min="5"
											max="50"
											v-model.number="currentSize"
											@pointerdown="showSizePreview = true"
											@pointerup="showSizePreview = false"
											@pointercancel="showSizePreview = false"
											class="w-full h-1.5 hmd:h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
										/>
									</div>
									<div class="h-px bg-slate-100"></div>
									<div
										ref="sliderTrackRef"
										@mousedown="handleSliderStart"
										@touchstart.passive="handleSliderStart"
										class="slider-track relative h-8 hmd:h-10 bg-slate-100 rounded-lg flex items-center p-1 cursor-pointer overflow-hidden select-none"
									>
										<div
											class="absolute inset-0 flex items-center justify-center text-[9px] hmd:text-[10px] text-slate-400 font-bold uppercase tracking-wider"
										>
											滑动清空画布
										</div>
										<div
											class="absolute top-1 bottom-1 w-10 hmd:w-12 bg-white rounded-md shadow-sm border border-slate-200 flex items-center justify-center text-red-500 z-10"
											:style="{ transform: 'translateX(' + sliderX + 'px)' }"
										>
											<Trash2 class="w-3.5 h-3.5 hmd:w-4 hmd:h-4" />
										</div>
									</div>
								</div>
							</div>
						</transition>
						<button
							@click="toggleMenu('eraser')"
							class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10"
							:class="
								currentTool === 'eraser'
									? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
									: 'text-slate-400 hover:bg-slate-50'
							"
						>
							<Eraser class="w-4 h-4 hmd:w-5 hmd:h-5" />
						</button>
					</div>

					<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

					<!-- Color Picker -->
					<div class="relative shrink-0">
						<transition
							enter-active-class="transition duration-200"
							enter-from-class="opacity-0 translate-y-4 scale-95"
							enter-to-class="opacity-100 translate-y-0 scale-100"
							leave-active-class="transition duration-150"
							leave-from-class="opacity-100 translate-y-0 scale-100"
							leave-to-class="opacity-0 translate-y-4 scale-95"
						>
							<div
								v-if="activeMenu === 'color'"
								class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-2 hmd:p-3 bg-white/90 backdrop-blur-sm border border-white rounded-xl shadow-xl w-48 hmd:w-64 origin-bottom grid grid-cols-6 gap-1.5 hmd:gap-2"
							>
								<button
									v-for="c in colors"
									:key="c"
									@click="setColor(c)"
									class="w-6 h-6 cursor-pointer hmd:w-8 hmd:h-8 rounded-full border border-slate-100 shadow-sm hover:scale-110 transition-transform relative"
									:style="{ backgroundColor: c }"
								>
									<div
										v-if="currentColor === c"
										class="absolute inset-0 flex items-center justify-center"
									>
										<div
											class="w-2 h-2 hmd:w-2.5 hmd:h-2.5 bg-white rounded-full shadow-sm"
											:class="{ 'bg-black': c === '#ffffff' }"
										></div>
									</div>
								</button>
							</div>
						</transition>
						<button
							@click="toggleMenu('color')"
							class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10 hover:bg-slate-50 group"
						>
							<div
								class="w-4 h-4 hmd:w-5 hmd:h-5 rounded-full border-2 border-slate-200 shadow-sm group-hover:scale-110 transition-transform"
								:style="{ backgroundColor: currentColor }"
							></div>
						</button>
					</div>

					<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

					<!-- Undo / Redo Group -->
					<div
						class="flex items-center bg-slate-100 rounded-xl p-0.5 space-x-0.5 shrink-0"
					>
						<button
							@click="undo"
							class="p-1.5 hmd:p-2.5 cursor-pointer rounded-lg text-slate-500 hover:bg-white hover:text-slate-700 hover:shadow-sm transition-all disabled:opacity-30 disabled:hover:bg-transparent"
							title="撤销 (Ctrl+Z)"
						>
							<RotateCcw class="w-3.5 h-3.5 hmd:w-4 hmd:h-4" />
						</button>
						<button
							@click="redo"
							class="p-1.5 hmd:p-2.5 cursor-pointer rounded-lg text-slate-500 hover:bg-white hover:text-slate-700 hover:shadow-sm transition-all disabled:opacity-30 disabled:hover:bg-transparent"
							title="重做 (Ctrl+Y)"
						>
							<RotateCw class="w-3.5 h-3.5 hmd:w-4 hmd:h-4" />
						</button>
					</div>

					<!-- Fullscreen -->
					<button
						@click="toggleFullscreen"
						class="p-2 hmd:p-3 rounded-xl cursor-pointer text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors shrink-0"
						title="全屏 (F)"
					>
						<Maximize v-if="!isFullscreen" class="w-4 h-4 hmd:w-5 hmd:h-5" />
						<Minimize v-else class="w-4 h-4 hmd:w-5 hmd:h-5" />
					</button>

					<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

					<!-- Drag Handle -->
					<div
						class="px-1.5 hmd:px-2 py-1 text-slate-300 hover:text-indigo-500 cursor-grab active:cursor-grabbing shrink-0 transition-colors group"
						title="按住拖拽工具栏"
					>
						<Grip
							class="w-4 h-4 hmd:w-5 hmd:h-5 group-hover:scale-110 group-active:scale-100 transition-transform"
						/>
					</div>
				</div>

				<!-- ================= MINIFIED TOOLBAR ================= -->
				<div
					v-else
					key="collapsed"
					class="pointer-events-auto bg-white/80 backdrop-blur-sm shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-white/40 p-1 hmd:p-2 rounded-2xl flex items-center gap-1 hmd:gap-2"
				>
					<!-- Toggle Button (Expand) -->
					<button
						@click.stop="isToolbarCollapsed = false"
						class="p-1.5 hmd:p-2 cursor-pointer rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors shrink-0 z-10"
						title="展开工具栏"
					>
						<ChevronLeft class="w-4 h-4 hmd:w-5 hmd:h-5 transition-transform" />
					</button>

					<!-- Active Tool View -->
					<div class="relative shrink-0">
						<button
							class="p-2 hmd:p-3 cursor-pointer rounded-xl bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200"
						>
							<MousePointer2
								v-if="currentTool === 'cursor'"
								class="w-4 h-4 hmd:w-5 hmd:h-5"
							/>
							<Pencil
								v-else-if="currentTool === 'pen'"
								class="w-4 h-4 hmd:w-5 hmd:h-5"
							/>
							<Eraser
								v-else-if="currentTool === 'eraser'"
								class="w-4 h-4 hmd:w-5 hmd:h-5"
							/>
							<div
								v-else
								class="w-4 h-4 hmd:w-5 hmd:h-5 rounded-full"
								:style="{ backgroundColor: currentColor }"
							></div>
						</button>
					</div>

					<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

					<!-- Drag Handle (Also in collapsed mode) -->
					<div
						class="px-1.5 hmd:px-2 py-1 text-slate-300 hover:text-indigo-500 cursor-grab active:cursor-grabbing shrink-0 transition-colors group"
						title="按住拖拽工具栏"
					>
						<Grip
							class="w-4 h-4 hmd:w-5 hmd:h-5 group-hover:scale-110 group-active:scale-100 transition-transform"
						/>
					</div>
				</div>
			</transition>
		</div>
	</div>
</template>

<style>
	/* Custom Scrollbar for popovers if needed */
	.scrollbar-hide::-webkit-scrollbar {
		display: none;
	}
	.scrollbar-hide {
		-ms-overflow-style: none;
		scrollbar-width: none;
	}

	::-webkit-scrollbar {
		width: 4px;
	}
	::-webkit-scrollbar-track {
		background: transparent;
	}
	::-webkit-scrollbar-thumb {
		background: #cbd5e1;
		border-radius: 4px;
	}

	/* Toolbar Pop Animation */
	.toolbar-pop-enter-active,
	.toolbar-pop-leave-active {
		transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.toolbar-pop-enter-from,
	.toolbar-pop-leave-to {
		opacity: 0;
		transform: scale(0.9) translateY(10px);
	}
</style>
