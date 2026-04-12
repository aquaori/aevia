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
	import { createRoomEditorState } from "../service/roomEditorState";
	import { createRoomEditorController } from "../service/roomEditorController";
	import { createRoomSessionState } from "../service/roomSessionState";
	import { createRoomLifecycleController } from "../service/roomLifecycleController";
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
	import type { EditorHookMap, SelectionState } from "../utils/editorTypes";
	import type { Command, Point } from "../utils/type";

	// 路由钩子，获取URL中的token参数
	const router = useRouter();
	const userStore = useUserStore();

	// --- 断线重连状态 (Reconnection State) ---
	const {
		username,
		roomId,
		roomName,
		token,
		showNamePrompt,
		newName,
		onlineCount,
		reconnectFailed,
	} = createRoomSessionState(userStore.token || "");

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
	// 统一使用 Store 中的状态，并通过 storeToRefs 保持响应性
	const { commands, pendingUpdates, currentCommandIndex } = storeToRefs(commandStore);
	const commandMap = commandStore.commandMap;
	const insertCommand = commandStore.insertCommand;
	const clearClearedCommands = commandStore.clearClearedCommands;
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

	const interactionController = createInteractionController();
	let emitHostHook:
		| (<K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => void)
		| undefined;

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
		renderIncrementPoint(cmd, points, ctx.value, logicalWidth, logicalHeight);
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
			commandStore.updateLastSortedPoints(points);
			renderWithPoints(points);
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
		emitHook: (event, payload) => emitHostHook?.(event, payload),
	});

	const startDrawing = (e: PointerEvent) => roomPointerControllerRef.value?.startDrawing(e);
	const draw = (e: PointerEvent) => roomPointerControllerRef.value?.draw(e);
	const stopDrawing = (e: PointerEvent) => roomPointerControllerRef.value?.stopDrawing(e);

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
		requestDirtyRender: (rect) => canvasRuntime.requestDirtyRender(rect),
		syncCommandState: (command) => workerBridge.syncCommandState(command),
		requestSceneRefresh: refreshWorkerScene,
		renderIncrementalCommand,
		renderSinglePointCommand,
		goToPage,
		setTool: roomEditorController.setTool,
		insertCommand,
		clearClearedCommands,
		emitHook: (event, payload) => emitHostHook?.(event, payload),
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
		emitHook: (event, payload) => emitHostHook?.(event, payload),
	});

	const roomPageService = createRoomPageService({
		currentPageId,
		totalPages,
		username,
		userId,
		closeOverview: () => {
			showPageOverview.value = false;
		},
		renderCanvas,
		setTool: roomEditorController.setTool,
		currentTool,
		send: roomCollabTransport.send,
		emitHook: (event, payload) => emitHostHook?.(event, payload),
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
	emitHostHook = session.emitHook;
	const roomLifecycleController = createRoomLifecycleController({
		session,
		commands,
		currentColor,
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
