<script setup lang="ts">
	import {
		ref,
		onMounted,
		onUnmounted,
		computed,
		toRaw,
		watch,
		type Ref,
	} from "vue";
	import { useRouter } from "vue-router";
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
		ctx,
		renderWithPoints,
		renderIncrementPoint,
	} from "../service/canvas";
	import { createWhiteboardSession } from "../service/whiteboardSession";
	import {
		createBenchmarkPlugin,
		shouldEnableBenchmarkRuntime,
	} from "../plugins/benchmark/benchmarkPlugin";
	import { createRoomCollabTransport } from "../service/roomCollabTransport";
	import { createRoomUiState } from "../states/roomUiState";
	import { createCanvasRuntime } from "../service/canvasRuntime";
	import { createRenderWorkerBridge } from "../service/renderWorkerBridge";
	import { createInteractionController } from "../controllers/interactionController";
	import { createLocalCommandService } from "../service/localCommandService";
	import { createRoomCommandController } from "../controllers/roomCommandController";
	import { createRoomPageService } from "../service/roomPageService";
	import { createRoomCanvasOverlay } from "../service/roomCanvasOverlay";
	import { createRoomPointerController } from "../controllers/roomPointerController";
	import { createRoomHeaderController } from "../controllers/roomHeaderController";
	import { createRoomKeyboardController } from "../controllers/roomKeyboardController";
	import { createRoomToolController } from "../controllers/roomToolController";
	import { createRoomPanelController } from "../controllers/roomPanelController";
	import { createRoomEditorState } from "../states/roomEditorState";
	import { createRoomEditorController } from "../controllers/roomEditorController";
	import { createRoomSessionState } from "../states/roomSessionState";
	import { createRoomLifecycleController } from "../controllers/roomLifecycleController";
	import { provideRoomSession } from "../service/roomSessionContext";
	import {
		createRoomInteractionState,
	} from "../states/roomInteractionState";
	import RoomToolbar from "../components/RoomToolbar.vue";
	import RoomPagination from "../components/RoomPagination.vue";
	import RoomShortcutsDialog from "../components/RoomShortcutsDialog.vue";
	import RoomPageOverview from "../components/RoomPageOverview.vue";
	import RoomMemberList from "../components/RoomMemberList.vue";
	import RoomConnectionOverlays from "../components/RoomConnectionOverlays.vue";
	import RoomSizePreview from "../components/RoomSizePreview.vue";
	import RoomHeader from "../components/RoomHeader.vue";
	import { fetchPageOverview, type PageOverviewItem } from "../service/pageOverviewService";
	import type { SelectionState } from "../utils/editorTypes";
	import type { Command, FlatPoint, Point } from "@collaborative-whiteboard/shared";

	// 路由钩子，获取URL中的token参数
	const router = useRouter();
	const userStore = useUserStore();

	// --- 断线重连状态 (Reconnection State) ---
	const {
		username,
		roomId,
		roomName,
		token,
		sessionExpiresAt,
		showNamePrompt,
		newName,
		onlineCount,
		reconnectFailed,
		reconnectFailureMessage,
	} = createRoomSessionState(userStore.token || "", userStore.sessionExpiresAt);

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

	const {
		memberList,
		currentTool,
		currentColor,
		currentSize,
		userId,
		currentPageId,
		totalPages,
		remoteCursors,
	} = createRoomEditorState();

	const commandStore = useCommandStore();
	const { commands, pendingUpdates, currentCommandIndex, loadedPageIds } = storeToRefs(commandStore);
	const replaceLoadedPageWindow = commandStore.replaceLoadedPageWindow;
	const applyLoadedPageDelta = commandStore.applyLoadedPageDelta;
	const pruneDeletedCommandsAfterPointer = commandStore.pruneDeletedCommandsAfterPointer;
	// 统一使用 Store 中的状态，并通过 storeToRefs 保持响应性
	const commandMapRef = commandStore.commandMap;
	const commandMap = commandStore.commandMap;
	const insertCommand = commandStore.insertCommand;
	const clearClearedCommands = commandStore.clearClearedCommands;
	const removeCommand = commandStore.removeCommand;
	const {
		cursorX,
		cursorY,
		isDrawing,
		activePointerId,
		currentDrawingId,
		selectedCommandIds,
		transformingCmdIds,
		transformAnim,
		selectionRect,
		remoteSelectionRects,
		dragStartPos,
		interactionMode,
		activeTransformHandle,
		initialCmdsState,
		initialGroupBox,
		lastX,
		lastY,
		lastWidth,
		pointerHotState,
	} = createRoomInteractionState();

	const interactionController = createInteractionController();
	const roomSessionRef = provideRoomSession();
	const pageOverviewPages = ref<PageOverviewItem[]>([]);
	const pageOverviewTotalPages = ref(0);
	const pageOverviewLoading = ref(false);
	const pageOverviewError = ref("");
	let pageOverviewRequestId = 0;

	const loadPageOverview = async () => {
		const normalizedRoomId = Array.isArray(roomId.value) ? (roomId.value[0] ?? "") : roomId.value;
		if (!normalizedRoomId) return;
		const requestId = ++pageOverviewRequestId;
		pageOverviewLoading.value = true;
		pageOverviewError.value = "";
		try {
			const overview = await fetchPageOverview(normalizedRoomId, token.value);
			if (requestId !== pageOverviewRequestId) return;
			pageOverviewTotalPages.value = overview.totalPages;
			pageOverviewPages.value = overview.pages;
		} catch (error) {
			if (requestId !== pageOverviewRequestId) return;
			pageOverviewError.value = "页面总览加载失败";
		} finally {
			if (requestId === pageOverviewRequestId) {
				pageOverviewLoading.value = false;
			}
		}
	};

	const renderCanvas = () => {
		if (!canvasRef.value) return;

		// 向 Worker 发送请求，计算排好序的点集
		const rawCommands = toRaw(commands.value).map((c: Command) => ({
			...c,
			points: c.points ? toRaw(c.points) : [],
		}));

		workerBridge.renderMainCanvas({
			commands: rawCommands,
			pageId: currentPageId.value,
			transformingCmdIds: Array.from(transformingCmdIds.value),
			requestId: "main-canvas",
		});
	};

	const renderIncrementalCommand = (
		cmd: Command,
		points: Point[],
		source: "local" | "remote" = cmd.userId === userId.value ? "local" : "remote"
	) => {
		if (workerBridge.isOffscreenEnabled()) {
			workerBridge.renderIncrementalCommand(cmd, points, currentPageId.value, source);
			return;
		}
		if (!canvasRef.value || !ctx.value || cmd.pageId !== currentPageId.value) return;
		const dpr = window.devicePixelRatio || 1;
		const logicalWidth = canvasRef.value.width / dpr;
		const logicalHeight = canvasRef.value.height / dpr;
		renderIncrementPoint(cmd, points, ctx.value, logicalWidth, logicalHeight, false, source);
	};

	const renderSinglePointCommand = (
		cmd: Command,
		source: "local" | "remote" = cmd.userId === userId.value ? "local" : "remote"
	) => {
		if (workerBridge.isOffscreenEnabled()) {
			workerBridge.renderSinglePointCommand(cmd, currentPageId.value, source);
			return;
		}
		renderIncrementalCommand(cmd, cmd.points ?? []);
	};

	const refreshWorkerScene = () => {
		if (workerBridge.isOffscreenEnabled()) {
			workerBridge.rerenderScene(
				currentPageId.value,
				Array.from(transformingCmdIds.value)
			);
			return;
		}
		renderCanvas();
	};

	const canvasRuntime = createCanvasRuntime({
		requestRender: renderCanvas,
		requestWorkerDirtyRender: (rect) =>
			workerBridge.renderDirtyRect(
				rect,
				currentPageId.value,
				Array.from(transformingCmdIds.value)
			),
		syncToolState: () => roomEditorController.setTool(currentTool.value),
		isOffscreenEnabled: () => workerBridge.isOffscreenEnabled(),
		syncMainCanvasViewport: (payload) => {
			if (canvasRef.value) {
				workerBridge.bindMainCanvas(canvasRef.value, payload);
			}
			workerBridge.syncViewport(payload);
		},
		requestMergeDirtyRects: (payload) => workerBridge.requestMergeDirtyRects(payload),
	});

	const workerBridge = createRenderWorkerBridge({
		onMainPoints: (points) => {
			const currentPagePoints = points.filter((point) => point.pageId === currentPageId.value);
			commandStore.updateLastSortedPoints(currentPagePoints);
			renderWithPoints(currentPagePoints);
		},
		onDirtyRects: (rects) => canvasRuntime.handleMergedDirtyRects(rects as any),
	});

	const roomPointerControllerRef = ref<ReturnType<typeof createRoomPointerController> | null>(null);
	const roomEditorController = createRoomEditorController({
		pointerController: roomPointerControllerRef,
		currentTool,
		currentColor,
		activeMenu,
		transformingCmdIds,
		transformAnim,
		renderCanvas,
		selectionRect,
		interactionMode,
	});

	const startDrawing = (e: PointerEvent) => roomPointerControllerRef.value?.startDrawing(e);
	const draw = (e: PointerEvent) => roomPointerControllerRef.value?.draw(e);
	const stopDrawing = (e: PointerEvent) => roomPointerControllerRef.value?.stopDrawing(e);

	const goToPage = (index: number) => roomPageService.goToPage(index);
	const requestCurrentPageResync = () => roomPageService.requestCurrentPageResync();
	const cancelRejectedLocalCommand = (cmdId: string) => {
		roomPointerControllerRef.value?.cancelLocalDrawing(cmdId);
	};


	const roomCollabTransport = createRoomCollabTransport({
		token,
		userId,
		roomId,
		username,
		roomName,
		onlineCount,
		totalPages,
		loadedPageIds,
		currentPageId,
		currentTool,
		reconnectFailed,
		sessionExpiresAt,
		reconnectFailureMessage,
		commands,
		currentCommandIndex,
		pendingUpdates,
		commandMap: commandMapRef,
		memberList,
		remoteCursors,
		remoteSelectionRects,
		renderCanvas,
		requestDirtyRender: (rect) => canvasRuntime.requestDirtyRender(rect),
		syncCommandState: (command) => workerBridge.syncCommandState(command),
		requestSceneRefresh: refreshWorkerScene,
		renderIncrementalCommand,
		renderSinglePointCommand,
		beginInitRenderStream: (pageId?: number) => workerBridge.beginInitRenderStream(pageId),
		appendInitRenderChunk: (points: FlatPoint[]) => workerBridge.appendInitRenderChunk(points),
		appendInitRenderBinaryChunk: (meta, buffer) =>
			workerBridge.appendInitRenderBinaryChunk(meta, buffer),
		finishInitRenderStream: () => workerBridge.finishInitRenderStream(),
		syncWorkerScene: (
			nextCommands: Command[],
			pageId: number,
			transformingCmdIds: string[] = []
		) =>
			workerBridge.syncWorkerScene(nextCommands, pageId, transformingCmdIds),
		renderSceneFromFlatPoints: (points: FlatPoint[], pageId: number) =>
			workerBridge.renderSceneFromFlatPoints(points, pageId),
		goToPage,
		applyRemotePageChange: (page, nextTotalPages, config) =>
			roomPageService.applyRemotePageChange(page, nextTotalPages, config),
		getActivePageChangeRequestId: () => roomPageService.getActivePageChangeRequestId(),
		getActivePageChangeTargetId: () => roomPageService.getActivePageChangeTargetId(),
		clearActivePageChangeRequest: (requestId) =>
			roomPageService.clearActivePageChangeRequest(requestId),
		setTool: roomEditorController.setTool,
		insertCommand,
		removeCommand,
		replaceLoadedPageWindow,
		applyLoadedPageDelta,
		clearClearedCommands,
		requestCurrentPageResync,
		cancelRejectedLocalCommand,
		persistSessionAuth: ({ sessionToken, expiresAt }) => {
			userStore.setToken(sessionToken);
			userStore.setSessionExpiresAt(expiresAt);
		},
		onSessionExpired: () => {
			userStore.clearAll();
		},
	});
	const isReconnecting = roomCollabTransport.isReconnecting;
	const reconnectCount = roomCollabTransport.reconnectCount;
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
		pruneDeletedCommandsAfterPointer,
		renderCanvas,
		requestDirtyRender: (rect) => canvasRuntime.requestDirtyRender(rect),
		syncCommandState: (command) => workerBridge.syncCommandState(command),
		requestSceneRefresh: refreshWorkerScene,
		setTool: roomEditorController.setTool,
		send: roomCollabTransport.send,
	});
	const roomCommandController = createRoomCommandController({
		localCommandService,
		activeMenu,
	});

	const roomPageService = createRoomPageService({
		currentPageId,
		totalPages,
		loadedPageIds,
		username,
		userId,
		closeOverview: () => {
			showPageOverview.value = false;
		},
		renderCanvas,
		setTool: roomEditorController.setTool,
		currentTool,
		send: roomCollabTransport.send,
	});
	const roomToolController = createRoomToolController({
		activeMenu,
		currentTool,
		currentSize: currentSize as unknown as Ref<number>,
		showSizePreview,
		setTool: roomEditorController.setTool,
	});
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
		token,
		newName,
		showNamePrompt,
		hasCopied,
		isFullscreen,
	});

	const roomKeyboardController = createRoomKeyboardController({
		undo: roomCommandController.undo,
		redo: roomCommandController.redo,
		setTool: roomEditorController.setTool,
		openColorMenu: roomToolController.openColorMenu,
		toggleShortcuts: roomPanelController.toggleShortcuts,
		toggleFullscreen: roomHeaderController.toggleFullscreen,
	});

	roomPointerControllerRef.value = createRoomPointerController({
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
		commandMap: commandMapRef,
		lastXRef: lastX,
		lastYRef: lastY,
		lastWidthRef: lastWidth,
		pointerHotState,
		interactionController,
		canvasRuntime,
		renderIncrementalCommand: (cmd, points, source) => renderIncrementalCommand(cmd, points, source),
		renderSinglePointCommand: (cmd, source) => renderSinglePointCommand(cmd, source),
		isOffscreenMainCanvas: () => workerBridge.isOffscreenEnabled(),
		send: roomCollabTransport.send,
		pushCommand: roomCommandController.pushCommand,
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
		commandMap: commandMapRef,
		currentPageId,
		remoteCursors,
		userId,
		finalizeDrop: roomEditorController.finalizeDrop,
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
		setTool: roomEditorController.setTool,
		undo: roomCommandController.undo,
		redo: roomCommandController.redo,
		goToPage,
		resize: canvasRuntime.resize,
		requestDirtyRender: canvasRuntime.requestDirtyRender,
		requestRender: renderCanvas,
		requestOverlayRender: roomCanvasOverlay.render,
	});
	if (shouldEnableBenchmarkRuntime()) {
		session.use(
			createBenchmarkPlugin({
				commands,
				currentColor,
			})
		);
	}
	roomSessionRef.value = session;
	const roomLifecycleController = createRoomLifecycleController({
		roomCanvasOverlay,
		roomKeyboardController,
		roomHeaderController,
		interactionController,
		send: roomCollabTransport.send,
		userId,
		username,
		selectedCommandIds,
	});

	onMounted(roomLifecycleController.mount);
	onUnmounted(roomLifecycleController.unmount);

	watch(showPageOverview, (visible) => {
		if (visible) {
			loadPageOverview();
		}
	});

	watch([currentPageId, totalPages], () => {
		if (showPageOverview.value) {
			loadPageOverview();
		}
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
					@keyup.enter="roomHeaderController.saveName"
					class="w-full px-4 py-2 border rounded-xl mb-4 focus:ring-2 focus:ring-indigo-500 outline-none"
					placeholder="你的名字"
				/>
				<button
					@click="roomHeaderController.saveName"
					class="w-full py-2 bg-indigo-600 text-white rounded-xl font-medium"
				>
					开始绘画
				</button>
			</div>
		</div>

		<RoomConnectionOverlays
			:is-reconnecting="isReconnecting"
			:reconnect-count="reconnectCount"
			:max-reconnect="roomCollabTransport.MAX_RECONNECT"
			:reconnect-failed="reconnectFailed"
			:reconnect-failure-message="reconnectFailureMessage"
			:on-retry-reconnect="roomCollabTransport.retryReconnect"
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
			:total-pages="pageOverviewTotalPages || totalPages"
			:current-page-id="currentPageId"
			:pages="pageOverviewPages"
			:loading="pageOverviewLoading"
			:error="pageOverviewError"
			:on-close="roomPanelController.closeOverview"
			:go-to-page="roomPageService.goToPage"
			:on-add-page="roomPageService.addPageAndOpenLast"
			:on-retry="loadPageOverview"
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
			:on-copy-link="roomHeaderController.copyLink"
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
			:toggle-fullscreen="roomHeaderController.toggleFullscreen"
			:toggle-menu="roomToolController.toggleMenu"
			:set-tool="roomEditorController.setTool"
			:set-color="roomEditorController.setColor"
			:clear-canvas="roomCommandController.clearCanvas"
			:undo="roomCommandController.undo"
			:redo="roomCommandController.redo"
			:update-current-size="roomToolController.updateCurrentSize"
			:set-size-preview="roomToolController.setSizePreview"
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
