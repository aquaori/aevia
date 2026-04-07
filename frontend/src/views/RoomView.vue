<script setup lang="ts">
	import {
		ref,
		onMounted,
		onUnmounted,
		computed,
		toRaw,
		type Ref,
		type ComponentPublicInstance,
	} from "vue";
	import { useRouter } from "vue-router";
	import { useLamportStore } from "../store/lamportStore";
	import {
		RotateCcw,
	} from "lucide-vue-next";
	import { storeToRefs } from "pinia";
	import { useUserStore } from "../store/userStore";
	import { useCommandStore } from "../store/commandStore";
	import { getCommandBoundingBox, getGroupBoundingBox } from "../utils/geometry";
	import {
		canvasRef,
		uiCanvasRef,
		renderWithPoints,
	} from "../service/canvas";
	import { createWhiteboardSession } from "../service/whiteboardSession";
	import { createRoomCollabTransport } from "../service/roomCollabTransport";
	import { createRoomUiState } from "../service/roomUiState";
	import { createCanvasRuntime } from "../service/canvasRuntime";
	import { createRenderWorkerBridge } from "../service/renderWorkerBridge";
	import { createInteractionController } from "../service/interactionController";
	import { createLocalCommandService } from "../service/localCommandService";
	import { createRoomCommandController } from "../service/roomCommandController";
	import { createRoomPageService } from "../service/roomPageService";
	import { createRoomCanvasOverlay } from "../service/roomCanvasOverlay";
	import { createRoomPointerController } from "../service/roomPointerController";
	import { createRoomHeaderController } from "../service/roomHeaderController";
	import { createRoomKeyboardController } from "../service/roomKeyboardController";
	import { createRoomToolController } from "../service/roomToolController";
	import { createRoomPanelController } from "../service/roomPanelController";
	import {
		createRoomInteractionState,
	} from "../service/roomInteractionState";
	import RoomToolbar from "../components/RoomToolbar.vue";
	import RoomPagination from "../components/RoomPagination.vue";
	import RoomShortcutsDialog from "../components/RoomShortcutsDialog.vue";
	import RoomPageOverview from "../components/RoomPageOverview.vue";
	import RoomMemberList from "../components/RoomMemberList.vue";
	import RoomConnectionOverlays from "../components/RoomConnectionOverlays.vue";
	import RoomSizePreview from "../components/RoomSizePreview.vue";
	import RoomHeader from "../components/RoomHeader.vue";
	import type { SelectionState } from "../utils/editorTypes";
	import type { Command, RemoteCursor } from "../utils/type";

	// 路由钩子，获取URL中的token参数
	const router = useRouter();
	const userStore = useUserStore();

	// --- 断线重连状态 (Reconnection State) ---
	const reconnectFailed = ref(false);

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
	const {
		activeMenu,
		showShortcuts,
		isFullscreen,
		hasCopied,
		showEraserCursor,
		showSizePreview,
		showPageOverview,
		showMemberList,
		isToolbarCollapsed,
	} = createRoomUiState();

	// --- 协作成员列表状态 ---
	const memberList = ref<[string, string][]>([]); // [userId, userName]

	// --- 画布核心状态 (Canvas State已解耦至 service/canvas.ts) ---

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

	// 画布状态标识
	const userId = ref(""); // Mock User ID
	const currentPageId = ref(0); // Mock Page ID
	const totalPages = ref(1); // 总页数

	const commandStore = useCommandStore();
	// 统一使用 Store 中的状态，并通过 storeToRefs 保持响应性
	const { commands, pendingUpdates, currentCommandIndex } = storeToRefs(commandStore);
	const commandMap = commandStore.commandMap;
	const insertCommand = commandStore.insertCommand;
	const clearClearedCommands = commandStore.clearClearedCommands;

	const remoteCursors = ref<Map<string, RemoteCursor>>(new Map());

	const {
		cursorX,
		cursorY,
		mouseMoveCD,
		isDrawing,
		activePointerId,
		currentDrawingId,
		currentPathPoints,
		pendingPoints,
		selectedCommandIds,
		transformingCmdIds,
		transformAnim,
		selectionRect,
		remoteSelectionRects,
		dragStartPos,
		interactionMode,
		activeTransformHandle,
		lastSentPos,
		initialCmdsState,
		initialGroupBox,
		lastX,
		lastY,
		lastWidth,
	} = createRoomInteractionState();

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

	const interactionController = createInteractionController();

	const renderCanvas = () => {
		if (!canvasRef.value) return;

		// 向 Worker 发送请求，计算排好序的点集
		const rawCommands = toRaw(commands.value).map((c: Command) => ({
			...c,
			points: c.points ? toRaw(c.points) : [],
		}));

		workerBridge.requestFlatPoints({
			commands: rawCommands,
			pageId: currentPageId.value,
			transformingCmdIds: Array.from(transformingCmdIds.value),
			requestId: "main-canvas",
		});
	};

	const canvasRuntime = createCanvasRuntime({
		requestRender: renderCanvas,
		syncToolState: () => setTool(currentTool.value),
		requestMergeDirtyRects: (payload) => workerBridge.requestMergeDirtyRects(payload),
	});

	const workerBridge = createRenderWorkerBridge({
		onMainPoints: (points) => {
			commandStore.updateLastSortedPoints(points);
			renderWithPoints(points);
		},
		onDirtyRects: (rects) => canvasRuntime.handleMergedDirtyRects(rects as any),
	});

	let roomPointerController: ReturnType<typeof createRoomPointerController> | null = null;

	const setTool = (tool: "pen" | "eraser" | "cursor") => {
		if (roomPointerController) {
			roomPointerController.setTool(tool);
			return;
		}
		currentTool.value = tool;
		activeMenu.value = null;
	};

	const setColor = (color: string) => {
		if (roomPointerController) {
			roomPointerController.setColor(color);
			return;
		}
		currentColor.value = color;
		activeMenu.value = null;
	};

	const finalizeDrop = () => {
		if (roomPointerController) {
			roomPointerController.finalizeDrop();
			return;
		}
		transformingCmdIds.value.clear();
		transformAnim.value = null;
		renderCanvas();
	};

	const startDrawing = (e: PointerEvent) => roomPointerController?.startDrawing(e);
	const draw = (e: PointerEvent) => roomPointerController?.draw(e);
	const stopDrawing = (e: PointerEvent) => roomPointerController?.stopDrawing(e);

	const renderUICanvas = () => roomCanvasOverlay.render();

	const startUILoop = () => roomCanvasOverlay.startLoop();

	const renderPreviewCanvas = (
		el: Element | ComponentPublicInstance | null,
		index: number
	) => roomCanvasOverlay.renderPreviewCanvas(el, index);

	const goToPage = (index: number) => roomPageService.goToPage(index);


	const roomCollabTransport = createRoomCollabTransport({
		token,
		userId,
		roomId,
		username,
		roomName,
		onlineCount,
		totalPages,
		currentPageId,
		currentTool,
		reconnectFailed,
		commands,
		currentCommandIndex,
		pendingUpdates,
		commandMap,
		memberList,
		remoteCursors,
		remoteSelectionRects,
		renderCanvas,
		goToPage,
		setTool,
		insertCommand,
		clearClearedCommands,
	});
	const isReconnecting = roomCollabTransport.isReconnecting;
	const reconnectCount = roomCollabTransport.reconnectCount;
	const MAX_RECONNECT = roomCollabTransport.MAX_RECONNECT;
	const retryReconnect = roomCollabTransport.retryReconnect;
	const localCommandService = createLocalCommandService({
		commands,
		currentCommandIndex,
		userId,
		roomId,
		currentPageId,
		username,
		currentTool,
		insertCommand,
		clearClearedCommands,
		renderCanvas,
		setTool,
		send: roomCollabTransport.send,
	});
	const roomCommandController = createRoomCommandController({
		localCommandService,
		activeMenu,
	});
	const pushCommand = roomCommandController.pushCommand;
	const undo = roomCommandController.undo;
	const redo = roomCommandController.redo;
	const clearCanvas = roomCommandController.clearCanvas;

	const roomPageService = createRoomPageService({
		currentPageId,
		totalPages,
		username,
		userId,
		closeOverview: () => {
			showPageOverview.value = false;
		},
		renderCanvas,
		setTool,
		currentTool,
		send: roomCollabTransport.send,
	});
	const roomToolController = createRoomToolController({
		activeMenu,
		currentTool,
		currentSize: currentSize as unknown as Ref<number>,
		showSizePreview,
		setTool,
	});
	const toggleMenu = roomToolController.toggleMenu;
	const updateCurrentSize = roomToolController.updateCurrentSize;
	const setSizePreview = roomToolController.setSizePreview;
	const roomPanelController = createRoomPanelController({
		activeMenu,
		showShortcuts,
		showPageOverview,
		showMemberList,
		openMemberListTransport: roomCollabTransport.openMemberList,
	});

	const roomHeaderController = createRoomHeaderController({
		roomId,
		roomName,
		username,
		newName,
		showNamePrompt,
		hasCopied,
		isFullscreen,
	});

	const copyLink = roomHeaderController.copyLink;
	const toggleFullscreen = roomHeaderController.toggleFullscreen;
	const saveName = roomHeaderController.saveName;

	const roomKeyboardController = createRoomKeyboardController({
		undo,
		redo,
		setTool,
		openColorMenu: roomToolController.openColorMenu,
		toggleShortcuts: roomPanelController.toggleShortcuts,
		toggleFullscreen,
	});

	roomPointerController = createRoomPointerController({
		currentTool,
		currentColor,
		currentSize,
		currentPageId,
		roomId,
		userId,
		username,
		isDrawing,
		activePointerId,
		currentDrawingId,
		cursorX,
		cursorY,
		mouseMoveCD,
		interactionMode,
		activeTransformHandle,
		dragStartPos,
		selectionRect,
		selectedCommandIds,
		transformingCmdIds,
		initialCmdsState,
		initialGroupBox: initialGroupBox as Ref<any>,
		transformAnim: transformAnim as Ref<any>,
		activeMenu,
		commands,
		lastXRef: lastX,
		lastYRef: lastY,
		lastWidthRef: lastWidth,
		lastSentPosRef: lastSentPos,
		currentPathPointsRef: currentPathPoints,
		pendingPointsRef: pendingPoints,
		interactionController,
		canvasRuntime,
		send: roomCollabTransport.send,
		pushCommand,
		renderCanvas,
		getCommandBoundingBox,
		getGroupBoundingBox,
	});

	const roomCanvasOverlay = createRoomCanvasOverlay({
		interactionMode,
		selectionRect,
		remoteSelectionRects,
		transformAnim: transformAnim as any,
		transformingCmdIds,
		selectedCommandIds,
		commands,
		currentPageId,
		remoteCursors,
		userId,
		finalizeDrop,
		getGroupBoundingBox,
		requestFlatPoints: workerBridge.requestFlatPoints,
	});

	const canUndo = computed(() => currentCommandIndex.value > 0);
	const canRedo = computed(() => currentCommandIndex.value < commands.value.length - 1);
	const session = createWhiteboardSession({
		state: {
			currentTool,
			currentColor,
			currentPageId,
			totalPages,
			onlineCount,
			isReconnecting,
			remoteCursors,
			selection: selectionRect as unknown as Ref<SelectionState | null>,
		},
		canUndo,
		canRedo,
		initialize: workerBridge.init,
		dispose: () => {
			canvasRuntime.dispose();
			workerBridge.dispose();
		},
		connect: roomCollabTransport.connect,
		disconnect: roomCollabTransport.disconnect,
		setTool,
		undo,
		redo,
		goToPage,
		resize: canvasRuntime.resize,
		requestDirtyRender: canvasRuntime.requestDirtyRender,
		requestRender: renderCanvas,
		requestOverlayRender: renderUICanvas,
	});

	onMounted(() => {
		if (typeof window !== "undefined") {
			(window as any).__benchmarkCommands = commands;
			(window as any).__benchmarkLamportStore = useLamportStore();
			(window as any).__benchmarkCurrentColor = currentColor;
		}

		if (canvasRef.value && uiCanvasRef.value) {
			session.mountCanvas({
				canvas: canvasRef.value,
				uiCanvas: uiCanvasRef.value,
			});
		}
		session.connect();

		startUILoop();

		window.addEventListener("resize", session.resize);
		roomKeyboardController.mount();

		canvasRef.value?.addEventListener("pointerleave", () => {
			interactionController.notifyPointerLeave(roomCollabTransport.send, {
				userId: userId.value,
				userName: username.value,
			});
		});
		document.addEventListener("fullscreenchange", roomHeaderController.syncFullscreenState);
	});

	onUnmounted(() => {
		roomCanvasOverlay.stopLoop();
		session.unmount();
		window.removeEventListener("resize", session.resize);
		roomKeyboardController.unmount();
		document.removeEventListener(
			"fullscreenchange",
			roomHeaderController.syncFullscreenState
		);
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

		<RoomConnectionOverlays
			:is-reconnecting="isReconnecting"
			:reconnect-count="reconnectCount"
			:max-reconnect="MAX_RECONNECT"
			:reconnect-failed="reconnectFailed"
			:on-retry-reconnect="retryReconnect"
			:on-back-home="() => router.push('/')"
		/>
		<RoomSizePreview
			:visible="showSizePreview"
			:current-size="currentSize"
			:current-tool="currentTool"
			:current-color="currentColor"
		/>

		<RoomShortcutsDialog
			:visible="showShortcuts"
			:on-close="roomPanelController.closeShortcuts"
		/>
		<RoomPageOverview
			:visible="showPageOverview"
			:total-pages="totalPages"
			:current-page-id="currentPageId"
			:remote-cursors="remoteCursors"
			:on-close="roomPanelController.closeOverview"
			:go-to-page="roomPageService.goToPage"
			:render-preview-canvas="renderPreviewCanvas"
			:on-add-page="roomPageService.addPageAndOpenLast"
		/>
		<RoomMemberList
			:visible="showMemberList"
			:online-count="onlineCount"
			:member-list="memberList"
			:current-username="Array.isArray(username) ? username[0] : username"
			:on-close="roomPanelController.closeMemberList"
		/>

		<!-- Rotate Hint -->
		<div
			class="hidden md:hidden portrait:flex fixed inset-0 z-100 bg-slate-900/95 text-white items-center justify-center flex-col p-8 text-center backdrop-blur-sm"
		>
			<RotateCcw class="w-12 h-12 mb-4 animate-[spin_4s_linear_infinite]" />
			<h2 class="text-2xl font-bold mb-2">请旋转设备</h2>
			<p class="text-slate-400">为了获得最佳绘画体验，请横屏使用。</p>
		</div>

		<RoomHeader
			:visible="!isFullscreen"
			:room-name="roomName"
			:room-id="roomId"
			:active-menu="activeMenu"
			:online-count="onlineCount"
			:has-copied="hasCopied"
			:on-toggle-more="roomPanelController.toggleMoreMenu"
			:on-copy-link="copyLink"
			:on-open-member-list="roomPanelController.openMemberList"
			:on-toggle-shortcuts="roomPanelController.toggleShortcuts"
		/>

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

		<RoomPagination
			:current-page-id="currentPageId"
			:total-pages="totalPages"
			:show-page-overview="showPageOverview"
			:prev-page="roomPageService.prevPage"
			:next-page="roomPageService.nextPage"
			:open-overview="roomPanelController.openOverview"
		/>

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

		<RoomToolbar
			:active-menu="activeMenu"
			:current-tool="currentTool"
			:current-color="currentColor"
			:current-size="currentSize"
			:is-fullscreen="isFullscreen"
			:is-toolbar-collapsed="isToolbarCollapsed"
			:colors="colors"
			:toggle-fullscreen="toggleFullscreen"
			:toggle-menu="toggleMenu"
			:set-tool="setTool"
			:set-color="setColor"
			:clear-canvas="clearCanvas"
			:undo="undo"
			:redo="redo"
			:update-current-size="updateCurrentSize"
			:set-size-preview="setSizePreview"
			:on-toggle-collapsed="(collapsed) => (isToolbarCollapsed = collapsed)"
		/>
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
