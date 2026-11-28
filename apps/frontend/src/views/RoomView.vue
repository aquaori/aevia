<script setup lang="ts">
	import {
		ref,
		onMounted,
		onUnmounted,
		computed,
		toRaw,
		watch,
		nextTick,
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
		finishIncrementalStroke,
		renderWithPoints,
		renderSceneCommands,
		hasPendingSceneDependencies,
		getFallbackRenderIR,
		quarantineSceneMissingElements,
		hitTestScene,
		querySceneElements,
		renderIncrementPoint,
		resetIncrementalStroke,
	} from "../service/canvas";
	import { createWhiteboardSession } from "../service/whiteboardSession";
	import { createRoomCollabTransport } from "../service/roomCollabTransport";
	import { createLabInstrumentationPlugin } from "../instrumentation/labPlugin";
	import { labEnabled } from "../instrumentation/labMarks";
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
		type GroupBoxState,
		type TransformAnimState,
	} from "../states/roomInteractionState";
	import RoomToolbar from "../components/RoomToolbar.vue";
	import RoomPagination from "../components/RoomPagination.vue";
	import RoomShortcutsDialog from "../components/RoomShortcutsDialog.vue";
	import RoomPageOverview from "../components/RoomPageOverview.vue";
	import RoomMemberList from "../components/RoomMemberList.vue";
	import RoomConnectionOverlays from "../components/RoomConnectionOverlays.vue";
	import RoomSizePreview from "../components/RoomSizePreview.vue";
	import RoomHeader from "../components/RoomHeader.vue";
	import RoomInvites from "../components/RoomInvites.vue";
	import RoomSettings from "../components/RoomSettings.vue";
	import AccountPanel from "../components/AccountPanel.vue";
	import { useAccountStore } from "../store/accountStore";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { apiUrl } from "../config/endpoints";
	import RoomTextEditor from "../components/RoomTextEditor.vue";
	import ApgPanel from "../components/ApgPanel.vue";
	import { createApgRuntime } from "../service/apgRuntime";
	import { compileApgSceneMutations } from "../service/apgSceneCompiler";
	import { useLamportStore } from "../store/lamportStore";
	import { v4 as apgUuid } from "uuid";
	import { fetchPageOverview, type PageOverviewItem } from "../service/pageOverviewService";
		import {
			buildApgContributionIndex,
			watchApgCatalog,
			type ApgCatalog,
			isUserPaletteEnabled,
			setUserPaletteEnabled,
			isApgBrushCurrent,
			resolveApgBrushSelection,
			watchApgPalettePreferences,
			type ApgBrushView,
		} from "../service/apgCatalog";
	import { acceptApgStateNotice } from "../service/apgStateNotice";
	import { describeApgCommandError } from "../service/apgErrorText";
	import { selectApgSceneSnapshot } from "../service/apgSceneSnapshot";
	import type { SelectionState } from "../utils/editorTypes";
	import type { Command, FlatPoint, Point } from "@collaborative-whiteboard/shared";

	// 路由钩子，获取URL中的token参数
	const router = useRouter();
	const userStore = useUserStore();
	const mainCanvasGeneration = ref(0);
	const initialSceneReady = ref(false);
	let roomDisposed = false;
	const accountStore = useAccountStore();
	const showInvites = ref(false);
	const showRoomSettings = ref(false);
	const changeGuest = async (userId: string, action: string) => {
		if (action === "kick" && !window.confirm("游客未登录，踢出后无法永久阻止其再次进入。需要更严格的管理时，可关闭游客入口或修改房间密码。确定踢出吗？")) return;
		try { await axios.post(apiUrl(`/v2/rooms/${roomId.value}/guests/${userId}`), { action }, { headers: accountStore.headers() }); }
		catch { toast.error("操作失败，请重试"); }
	};
	const enterWithAccount = async () => {
		const join = (password: string) => axios.post(apiUrl(`/v2/rooms/${encodeURIComponent(roomId.value)}/admission`), { roomId: roomId.value, password }, { headers: accountStore.headers() });
		try {
			let response;
			try { response = await join(""); }
			catch (error) {
				if (!axios.isAxiosError(error) || error.response?.data?.msg !== "Password incorrect") throw error;
				const password = window.prompt("请输入房间密码，以账号身份重新进入")
				if (password === null) return;
				response = await join(password);
			}
			userStore.setToken(response.data.data.sessionToken);
			userStore.setSessionExpiresAt(response.data.data.expiresAt);
			userStore.setRoomRole(response.data.data.role || "editor");
			window.location.reload();
		} catch { toast.error("无法以账号身份进入房间，请返回首页重试"); }
	};

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
		headerMenuOpen,
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
			currentBrushOpacity,
		currentStrokePattern,
		currentSticker,
		currentSize,
		userId,
		currentPageId,
		totalPages,
		remoteCursors,
	} = createRoomEditorState();
		const apgCatalog = ref<ApgCatalog>({ version: 1, plugins: [] });
	const apgBusy = ref("");
	const apgPreview = ref<{ pluginId: string; text: string } | null>(null);
	const apgStateRevisions = ref<Record<string, number>>({});
	const apgPreferenceRevision = ref(0);
	const apgEnabled = (id: string) => {
		void apgPreferenceRevision.value;
		const plugin = apgCatalog.value.plugins.find(p => p.manifest.id === id);
		return !!plugin && (plugin.manifest.scope === "system" || isUserPaletteEnabled(id, userId.value));
	};
	// Single source of truth for host-visible APG contributions; rebuilt from the
	// catalog snapshot plus the user's own preferences, so revocation is implicit.
	const apgContributionIndex = computed(() => {
		void apgPreferenceRevision.value;
		return buildApgContributionIndex(apgCatalog.value, apgEnabled, userId.value);
	});
	const apgPalettes = computed(() => apgContributionIndex.value.palettes);
	const apgBrushes = computed(() => apgContributionIndex.value.brushes);

	const commandStore = useCommandStore();
	const textEditorRef = ref<InstanceType<typeof RoomTextEditor> | null>(null);
	const { commands, pendingUpdates, currentCommandIndex, loadedPageIds } = storeToRefs(commandStore);
	const replaceLoadedPageWindow = commandStore.replaceLoadedPageWindow;
	const applyLoadedPageDelta = commandStore.applyLoadedPageDelta;
	// 统一使用 Store 中的状态，并通过 storeToRefs 保持响应性
	const commandMapRef = commandStore.commandMap;
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
		previewTransform,
		initialGroupBox,
		selectedSceneBounds,
		productPreview,
		canvasCursor,
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
		} catch {
			if (requestId !== pageOverviewRequestId) return;
			pageOverviewError.value = "页面总览加载失败";
		} finally {
			if (requestId === pageOverviewRequestId) {
				pageOverviewLoading.value = false;
			}
		}
	};

	let lastIntegrityResyncAt = 0;
	let dependencyTimer: ReturnType<typeof setTimeout> | undefined;
	let missingElementIds: string[] = [];
	const requestSceneIntegrityResync = () => {
		const now = Date.now();
		if (now - lastIntegrityResyncAt < 5000) return;
		lastIntegrityResyncAt = now;
		queueMicrotask(() => roomPageService.requestCurrentPageResync());
	};
	const renderCanvas = () => {
		if (!canvasRef.value) return;
		if (workerBridge.isOffscreenEnabled()) {
			workerBridge.rerenderScene(
				currentPageId.value,
				Array.from(transformingCmdIds.value)
			);
			return;
		}

		const rawCommands = toRaw(commands.value).map((c: Command) => ({
			...c,
			points: c.points ? toRaw(c.points) : [],
		}));
		if (renderSceneCommands(rawCommands, currentPageId.value, transformingCmdIds.value)) requestSceneIntegrityResync();
		quarantineSceneMissingElements(missingElementIds);
		if (hasPendingSceneDependencies() && !dependencyTimer) {
			dependencyTimer = setTimeout(() => {
				dependencyTimer = undefined;
				if (hasPendingSceneDependencies()) requestSceneIntegrityResync();
			}, 5000);
		}
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

	const finishIncrementalCommand = (cmd: Command) => {
		if (workerBridge.isOffscreenEnabled()) {
			workerBridge.finishCommandStroke(cmd.id);
			return;
		}
		if (!canvasRef.value || !ctx.value || cmd.pageId !== currentPageId.value) return;
		const dpr = window.devicePixelRatio || 1;
		finishIncrementalStroke(
			cmd,
			ctx.value,
			canvasRef.value.width / dpr,
			canvasRef.value.height / dpr
		);
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
		requestWorkerDirtyRenderBatch: (rects) =>
			workerBridge.renderDirtyRects(
				rects,
				currentPageId.value,
				Array.from(transformingCmdIds.value)
			),
		syncToolState: () => roomEditorController.setTool(currentTool.value),
		isOffscreenEnabled: () => workerBridge.isOffscreenEnabled(),
		hasRenderableScene: () => commands.value.length > 0,
		syncMainCanvasViewport: (payload) => {
			if (canvasRef.value) {
				const bound = workerBridge.bindMainCanvas(canvasRef.value, payload);
				if (!bound && !workerBridge.isOffscreenEnabled() && !ctx.value) {
					ctx.value = canvasRef.value.getContext("2d");
					if (ctx.value) {
						ctx.value.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0);
						ctx.value.lineCap = "round";
						ctx.value.lineJoin = "round";
					}
				}
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
		onDirtyRects: (rects) => canvasRuntime.handleMergedDirtyRects(rects),
		onSceneResyncRequired: requestSceneIntegrityResync,
		onSceneHistoryIncomplete: (ids) => {
			missingElementIds = ids;
			quarantineSceneMissingElements(ids);
			if (ids.length) toast.warning(`${ids.length} 个画布对象的历史记录不完整，相关内容暂时无法显示；原始记录仍保留。`);
		},
		onWorkerFailure: () => roomCollabTransport.handleRenderWorkerFailure(),
	});

	const roomPointerControllerRef = ref<ReturnType<typeof createRoomPointerController> | null>(null);
	const roomEditorController = createRoomEditorController({
		pointerController: roomPointerControllerRef,
		currentTool,
		currentColor,
		currentBrushOpacity,
		activeMenu,
		transformingCmdIds,
		transformAnim,
		renderCanvas,
		selectionRect,
		interactionMode,
	});
	const activateApgBrush = (brush: ApgBrushView) => {
		if (!initialSceneReady.value || userStore.roomRole === "viewer") return;
		if (!isApgBrushCurrent(brush, apgBrushes.value)) return;
		const selection = resolveApgBrushSelection(brush);
		roomEditorController.setTool(selection.base);
		if (selection.color !== undefined) roomEditorController.setColor(selection.color);
		if (selection.size !== undefined) currentSize.value = selection.size;
		currentBrushOpacity.value = selection.opacity;
	};
	const toggleApgPalette = (pluginId: string, enabled: boolean) => {
		if (!apgPalettes.value.some(p => p.pluginId === pluginId && p.toggleable)) return;
		setUserPaletteEnabled(pluginId, enabled, userId.value);
		apgPreferenceRevision.value++;
		apgRuntime.reconcile(apgCatalog.value);
		if (!enabled && apgPreview.value?.pluginId === pluginId) apgPreview.value = null;
	};
	let apgCatalogWatch: ReturnType<typeof watchApgCatalog> | undefined;
	let apgPreferenceWatch: (() => void) | undefined;
	// Another tab toggled a user-level plugin: adopt the change instead of waiting for a reload.
	const handleApgPreferenceChanged = (pluginId: string | null) => {
		if (roomDisposed) return;
		apgPreferenceRevision.value++;
		apgRuntime.reconcile(apgCatalog.value);
		if (pluginId === null || !isUserPaletteEnabled(pluginId, userId.value)) {
			if (apgPreview.value && (pluginId === null || apgPreview.value.pluginId === pluginId)) apgPreview.value = null;
		}
	};
	const applyApgCatalogSnapshot = (catalog: ApgCatalog) => {
		if (roomDisposed) return;
		apgCatalog.value = catalog;
		apgStateRevisions.value = {};
		apgRuntime.reconcile(catalog);
		apgPreview.value = null;
		// A revoked preset must not retain privileged configuration. Native strokes
		// already committed remain ordinary V2 operations and require no plugin.
		currentBrushOpacity.value = undefined;
	};

	const startDrawing = (e: PointerEvent) => {
		textEditorRef.value?.submit();
		return roomPointerControllerRef.value?.startDrawing(e);
	};
	const draw = (e: PointerEvent) => roomPointerControllerRef.value?.draw(e);
	const stopDrawing = (e: PointerEvent) => roomPointerControllerRef.value?.stopDrawing(e);

	const goToPage = (index: number) => roomPageService.goToPage(index);
	const requestCurrentPageResync = () => roomPageService.requestCurrentPageResync();
	const cancelRejectedLocalCommand = (cmdId: string) => {
		resetIncrementalStroke(cmdId);
		roomPointerControllerRef.value?.cancelLocalDrawing(cmdId);
	};
	const cancelRejectedOperation = () => {
		selectedCommandIds.value.clear();
		selectionRect.value = null;
		transformingCmdIds.value.clear();
		transformAnim.value = null;
		initialCmdsState.value.clear();
		previewTransform.value = null;
		dragStartPos.value = null;
		activeTransformHandle.value = null;
		interactionMode.value = "none";
	};


	const roomCollabTransport = createRoomCollabTransport({
		onInitialSceneReady: () => { initialSceneReady.value = true; },
		recoverRenderer: async () => {
			workerBridge.dispose();
			ctx.value = null;
			mainCanvasGeneration.value += 1;
			await nextTick();
			if (roomDisposed || !canvasRef.value || !workerBridge.init()) return false;
			canvasRuntime.resize();
			return workerBridge.isOffscreenEnabled() || !!ctx.value;
		},
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
		removeCommandState: (cmdId) => workerBridge.removeCommandState(cmdId),
		requestSceneRefresh: refreshWorkerScene,
		renderIncrementalCommand,
		renderSinglePointCommand,
		finishIncrementalCommand,
		isOffscreenMainCanvas: () => workerBridge.isOffscreenEnabled(),
		beginInitRenderStream: (pageId?: number) => workerBridge.beginInitRenderStream(pageId),
		appendInitRenderChunk: (points: FlatPoint[]) => workerBridge.appendInitRenderChunk(points),
		appendInitRenderBinaryChunk: (meta, buffer) =>
			workerBridge.appendInitRenderBinaryChunk(meta, buffer),
		finishInitRenderStream: () => workerBridge.finishInitRenderStream(),
		confirmInitScene: () => workerBridge.confirmInitScene(),
		setInitSceneOperations: (nextCommands, pageId) =>
			workerBridge.setInitSceneOperations(nextCommands, pageId),
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
		cancelRejectedOperation,
		notifyRemoteTextPatch: (elementId) => textEditorRef.value?.notifyRemotePatch(elementId),
		persistSessionAuth: ({ sessionToken, expiresAt }) => {
			userStore.setToken(sessionToken);
			userStore.setSessionExpiresAt(expiresAt);
		},
		onRoomRoleChanged: (role) => userStore.setRoomRole(role),
		onApgStateChanged: (notice) => {
			const accepted = acceptApgStateNotice(notice, apgCatalog.value, apgStateRevisions.value);
			if (!accepted) return;
			apgStateRevisions.value = { ...apgStateRevisions.value, [accepted.pluginId]: accepted.revision };
			// Clear stale derived UI; the next command reads the authoritative state.
			if (apgPreview.value?.pluginId === accepted.pluginId) apgPreview.value = null;
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
		isHistoryReady: () => loadedPageIds.value.includes(currentPageId.value) && roomCollabTransport.isPageHistoryReady(currentPageId.value),
		commandMap: commandMapRef,
		getCommandCount: () => commandStore.commandCount,
		insertCommand,
		renderCanvas,
		requestDirtyRender: (rect) => canvasRuntime.requestDirtyRender(rect),
		syncCommandState: (command) => workerBridge.syncCommandState(command),
		isOffscreenMainCanvas: () => workerBridge.isOffscreenEnabled(),
		requestSceneRefresh: refreshWorkerScene,
		syncWorkerScene: (nextCommands, pageId, transformingIds = []) =>
			workerBridge.syncWorkerScene(nextCommands, pageId, transformingIds),
		setTool: roomEditorController.setTool,
		send: roomCollabTransport.send,
	});
	const roomCommandController = createRoomCommandController({
		localCommandService,
		activeMenu,
	});
	const apgCanEdit = () => !roomDisposed && initialSceneReady.value && !isReconnecting.value && userStore.roomRole !== "viewer" && roomCollabTransport.isPageHistoryReady(currentPageId.value);
	const apgRuntime = createApgRuntime({
		contextKey: () => JSON.stringify([roomId.value, userId.value, currentPageId.value, userStore.roomRole, isReconnecting.value, roomDisposed]),
		canEdit: apgCanEdit,
		readScene: async () => {
			if (roomDisposed || !initialSceneReady.value || isReconnecting.value) throw new Error("Scene unavailable");
			const frame = await workerBridge.requestRenderIR();
			// Offscreen rendering may be unavailable (no worker or no OffscreenCanvas);
			// the fallback engine is the authoritative scene there, so plugins are not
			// silently blind on that render path.
			return selectApgSceneSnapshot(frame, workerBridge.isOffscreenEnabled(), getFallbackRenderIR());
		},
		mutate: (_pluginId, request) => {
			if (!apgCanEdit()) throw new Error("Scene mutation denied");
			// A bundle shares one host history group, so undo removes the whole template. Each
			// element is still an ordinary scene operation; the guest never sees ids or clocks.
			const commands = compileApgSceneMutations(request, { actorId: userId.value, roomId: roomId.value, pageId: currentPageId.value, allocateId: apgUuid, nextLamport: () => useLamportStore().getNextLamport() });
			for (const command of commands) if (!roomCommandController.pushCommand(command).ok) throw new Error("Scene mutation failed");
		},
		preview: (pluginId, text) => { apgPreview.value = { pluginId, text }; },
		download: (_pluginId, file) => {
			// The host writes the export: the guest hands over inert text and a safe name,
			// and never receives a file handle, a DOM node or a URL of its own.
			const bytes = new TextEncoder().encode(file.text);
			if (bytes.length > 65536) throw new Error("APG download too large");
			const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
			try {
				const link = document.createElement("a");
				link.href = url;
				link.download = file.name;
				link.rel = "noopener";
				document.body.appendChild(link);
				link.click();
				link.remove();
			} finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
		},
		readSharedState: async (plugin) => {
			const response = await axios.get(apiUrl("/api/apg/state/" + encodeURIComponent(plugin.manifest.id)), { params: { digest: plugin.digest }, headers: { Authorization: "Bearer " + token.value }, timeout: 5000 });
			if (!Number.isSafeInteger(response.data.data?.revision) || response.data.data.revision < 0) throw new Error("Invalid APG state revision");
			const state = response.data.data;
			apgStateRevisions.value = { ...apgStateRevisions.value, [plugin.manifest.id]: Math.max(apgStateRevisions.value[plugin.manifest.id] ?? 0, state.revision) };
			return state;
		},
		writeSharedState: async (plugin, revision, value) => {
			if (!apgCanEdit()) throw new Error("Shared state write denied");
			const response = await axios.put(apiUrl("/api/apg/state/" + encodeURIComponent(plugin.manifest.id)), { revision, value }, { params: { digest: plugin.digest }, headers: { Authorization: "Bearer " + token.value }, timeout: 5000 });
			if (response.data.data?.revision !== revision + 1) throw new Error("Invalid APG state acknowledgement");
			apgStateRevisions.value = { ...apgStateRevisions.value, [plugin.manifest.id]: Math.max(apgStateRevisions.value[plugin.manifest.id] ?? 0, revision + 1) };
		},
		readResource: async (plugin, path) => {
			if (!plugin.digest || plugin.manifest.scope !== "system" || !plugin.manifest.contributes.commands?.some(c => c.resource === path)) throw new Error("Resource denied");
			const response = await axios.get(apiUrl("/api/apg/asset/" + plugin.digest + "/" + path.split("/").map(encodeURIComponent).join("/")), { responseType: "text", timeout: 5000 });
			if (typeof response.data !== "string" || new TextEncoder().encode(response.data).length > 16384) throw new Error("Invalid resource");
			return JSON.parse(response.data);
		},
		cleanup: (id) => { if (apgPreview.value?.pluginId === id) apgPreview.value = null; },
	});
	const toggleApgPlugin = (id: string, enabled: boolean) => {
		if (!apgCatalog.value.plugins.some(p => p.manifest.id === id && p.manifest.scope === "user")) return;
		setUserPaletteEnabled(id, enabled, userId.value);
		apgPreferenceRevision.value++;
		apgRuntime.reconcile(apgCatalog.value);
		if (!enabled && apgPreview.value?.pluginId === id) apgPreview.value = null;
	};
	const runApgCommand = async (id: string, command: string) => {
		if (apgBusy.value || !initialSceneReady.value || isReconnecting.value) return;
		apgBusy.value = id;
		try { await apgRuntime.run(id, command); }
		catch (error) { console.warn("[APG] Command failed", id, command, error); if (!roomDisposed) toast.error(describeApgCommandError(error)); }
		finally { apgBusy.value = ""; }
	};
	const handleApgShortcut = (event: KeyboardEvent) => {
		if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing || !/^Digit[0-9]$/.test(event.code)) return;
		if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,textarea,select,[role=textbox]"))) return;
		const shortcut = "Alt+Shift+" + event.code.slice(-1);
		// `null` means several enabled plugins claim the same chord: refuse rather
		// than silently running whichever one happens to be listed first.
		const binding = apgContributionIndex.value.shortcuts.get(shortcut);
		if (!binding) return;
		event.preventDefault();
		void runApgCommand(binding.pluginId, binding.command);
	};
	watch([roomId, currentPageId, isReconnecting, () => userStore.roomRole], () => {
		apgRuntime.reconcile({ version: 1, plugins: [] });
		apgRuntime.reconcile(apgCatalog.value);
		apgPreview.value = null;
		apgStateRevisions.value = {};
		if (!isReconnecting.value) void apgCatalogWatch?.refresh();
	}, { flush: "sync" });

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
		headerMenuOpen,
		currentTool,
		currentSize: currentSize as unknown as Ref<number>,
		currentStrokePattern,
		currentSticker,
		showSizePreview,
		setTool: roomEditorController.setTool,
	});
	const roomPanelController = createRoomPanelController({
		activeMenu,
		headerMenuOpen,
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
		canEdit: () => initialSceneReady.value && userStore.roomRole !== "viewer",
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
		currentBrushOpacity,
		currentSize,
		currentStrokePattern,
		currentSticker,
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
		previewTransform,
		initialGroupBox: initialGroupBox as Ref<GroupBoxState | null>,
		selectedSceneBounds: selectedSceneBounds as Ref<GroupBoxState | null>,
		productPreview,
		canvasCursor,
		transformAnim: transformAnim as Ref<TransformAnimState | null>,
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
		finishIncrementalCommand,
		isOffscreenMainCanvas: () => workerBridge.isOffscreenEnabled(),
		syncCommandState: (cmd) => workerBridge.syncCommandState(cmd),
		waitForSceneOperationRender: (opId) => workerBridge.waitForSceneOperationRender(opId),
		hydrateCommandPoints: async (cmdIds) => {
			const missingIds = cmdIds.filter((cmdId) => {
				const cmd = commandMapRef.get(cmdId);
				return cmd && (!cmd.points || cmd.points.length === 0);
			});
			if (missingIds.length === 0) return;
			const result = await workerBridge.requestCommandPoints(missingIds);
			result.forEach(({ cmdId, points }) => {
				const cmd = commandMapRef.get(cmdId);
				if (cmd && points.length > 0) {
					cmd.points = points;
				}
			});
		},
		computeEraseTargets: async (points, size, wholeObjects) => {
			if (!canvasRef.value) return [];
			const dpr = window.devicePixelRatio || 1;
			return workerBridge.requestEraseTargets({
				points,
				size,
				wholeObjects,
				pageId: currentPageId.value,
				width: canvasRef.value.width / dpr,
				height: canvasRef.value.height / dpr,
				commands: workerBridge.isOffscreenEnabled() ? undefined : toRaw(commands.value),
			});
		},
		hitTestScene: (x, y) => workerBridge.isOffscreenEnabled()
			? workerBridge.requestSceneHit(x, y)
			: Promise.resolve(hitTestScene(x, y)),
		querySceneElements: (rect) => workerBridge.isOffscreenEnabled()
			? workerBridge.requestSceneQuery(rect)
			: Promise.resolve(querySceneElements(rect)),
		requestTextInput: (input) => textEditorRef.value?.open({
			...input,
			getCanvasRect: () => canvasRef.value?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
		}) ?? Promise.resolve(null),
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
		transformAnim,
		transformingCmdIds,
		previewTransform,
		selectedCommandIds,
		selectedSceneBounds: selectedSceneBounds as Ref<GroupBoxState | null>,
		productPreview,
		currentTool,
		currentColor,
		currentSize,
		currentStrokePattern,
		currentSticker,
		commands,
		commandMap: commandMapRef,
		currentPageId,
		remoteCursors,
		userId,
		finalizeDrop: roomEditorController.finalizeDrop,
		getGroupBoundingBox,
		requestFlatPoints: workerBridge.requestFlatPoints,
	});

	const canUndo = computed(() => currentCommandIndex.value >= 0);
	const canRedo = computed(() => currentCommandIndex.value < commandStore.commandCount - 1);
	const session = createWhiteboardSession({
		getRenderIR: () => workerBridge.requestRenderIR(),
		getConsistencyWatermarks: async () => ({
			roomSeq: roomCollabTransport.getRecoveryRoomSeq(),
			render: await workerBridge.requestRenderWatermarks(),
		}),
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
			roomDisposed = true;
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
	roomSessionRef.value = session;
	if (labEnabled()) {
		session.use(createLabInstrumentationPlugin());
	}
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

	const handleVisibilityChange = () => {
		if (document.visibilityState !== "visible") return;
		void apgCatalogWatch?.refresh();
		refreshWorkerScene();
		roomCanvasOverlay.render();
	};

	onMounted(() => {
		apgCatalogWatch = watchApgCatalog(applyApgCatalogSnapshot);
		apgPreferenceWatch = watchApgPalettePreferences(handleApgPreferenceChanged);
		roomLifecycleController.mount();
		document.addEventListener("visibilitychange", handleVisibilityChange);
		document.addEventListener("keydown", handleApgShortcut);
	});
	onUnmounted(() => {
		apgCatalogWatch?.dispose();
		apgPreferenceWatch?.();
		apgRuntime.dispose();
		if (dependencyTimer) clearTimeout(dependencyTimer);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		document.removeEventListener("keydown", handleApgShortcut);
		roomLifecycleController.unmount();
	});

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
			:can-edit="userStore.roomRole !== 'viewer'"
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
			:current-user-id="userId"
			:is-owner="userStore.roomRole === 'owner'"
			:on-guest-action="changeGuest"
			:on-close="roomPanelController.closeMemberList"
		/>

		<RoomTextEditor ref="textEditorRef" />

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
			:can-share="userStore.roomRole !== 'viewer'"
			:can-manage-room="!!accountStore.account && accountStore.account.id === userId"
			:room-name="roomName"
			:room-id="roomId"
			:more-open="headerMenuOpen"
			:online-count="onlineCount"
			:has-copied="hasCopied"
			:on-toggle-more="roomPanelController.toggleMoreMenu"
			:on-copy-link="() => { showInvites = true; }"
			:on-open-member-list="roomPanelController.openMemberList"
			:on-open-room-settings="() => { headerMenuOpen = false; showRoomSettings = true; }"
			:on-toggle-shortcuts="roomPanelController.toggleShortcuts"
		/>
		<RoomInvites v-if="showInvites" :room-id="roomId" :token="token" @close="showInvites = false" />
		<RoomSettings v-if="showRoomSettings" :room-id="roomId" :room-name="roomName" :role="userStore.roomRole" @close="showRoomSettings = false" @changed="(name) => { roomName = name; }" @exit="() => { userStore.clearAll(); router.push('/'); }" />
		<AccountPanel v-if="!accountStore.account" in-room @authenticated="enterWithAccount" />

		<!-- Custom Cursor for Eraser -->
		<div
			v-if="(currentTool === 'eraser' || currentTool === 'object-eraser') && showEraserCursor"
			class="fixed pointer-events-none rounded-full border border-slate-500 bg-slate-400/20 z-50 transform -translate-x-1/2 -translate-y-1/2 transition-transform duration-75 ease-out"
			:style="{
				left: cursorX + 'px',
				top: cursorY + 'px',
				width: currentSize + 'px',
				height: currentSize + 'px',
			}"
		></div>

		<RoomPagination
			:inert="!initialSceneReady"
			:can-edit="userStore.roomRole !== 'viewer'"
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
				:key="mainCanvasGeneration"
				@dblclick="initialSceneReady && userStore.roomRole !== 'viewer' && roomPointerControllerRef?.editSelectedText($event)"
				@pointerdown="initialSceneReady && userStore.roomRole !== 'viewer' && startDrawing($event)"
				@pointermove="userStore.roomRole !== 'viewer' && draw($event)"
				@pointerup="userStore.roomRole !== 'viewer' && stopDrawing($event)"
				@pointercancel="userStore.roomRole !== 'viewer' && stopDrawing($event)"
				@pointerenter="showEraserCursor = true"
				@pointerleave="showEraserCursor = false; canvasCursor = 'default'"
				class="absolute inset-0 w-full h-full touch-none z-5"
				:class="{
					'cursor-none': currentTool === 'eraser' || currentTool === 'object-eraser',
					'cursor-crosshair': currentTool !== 'cursor' && currentTool !== 'eraser' && currentTool !== 'object-eraser',
				}"
				:style="currentTool === 'cursor' ? { cursor: canvasCursor } : undefined"
			></canvas>

			<!-- UI Overlay Canvas (Top Layer: Cursors, Select Box) -->
			<canvas
				ref="uiCanvasRef"
				class="absolute inset-0 w-full h-full pointer-events-none z-10"
			></canvas>
		</div>

		<RoomToolbar v-if="userStore.roomRole !== 'viewer'" :inert="!initialSceneReady"
			:active-menu="activeMenu"
			:current-tool="currentTool"
			:current-color="currentColor"
			:current-size="currentSize"
			:current-stroke-pattern="currentStrokePattern"
			:current-sticker="currentSticker"
			:is-fullscreen="isFullscreen"
			:is-toolbar-collapsed="isToolbarCollapsed"
			:toggle-fullscreen="roomHeaderController.toggleFullscreen"
			:toggle-menu="roomToolController.toggleMenu"
			:set-tool="roomEditorController.setTool"
			:set-color="roomEditorController.setColor"
				:apg-palettes="apgPalettes"
				:apg-brushes="apgBrushes"
				:activate-apg-brush="activateApgBrush"
				:toggle-apg-palette="toggleApgPalette"
			:set-stroke-pattern="roomToolController.setStrokePattern"
			:set-sticker="roomToolController.setSticker"
			:clear-canvas="roomCommandController.clearCanvas"
			:undo="roomCommandController.undo"
			:redo="roomCommandController.redo"
			:update-current-size="roomToolController.updateCurrentSize"
			:set-size-preview="roomToolController.setSizePreview"
			:on-toggle-collapsed="(collapsed) => (isToolbarCollapsed = collapsed)"
		/>
		<ApgPanel :catalog="apgCatalog" :enabled="apgEnabled" :busy="apgBusy" :preview="apgPreview" :ready="initialSceneReady && !isReconnecting" @toggle="toggleApgPlugin" @run="runApgCommand" @close="apgPreview = null" />
		<div v-if="!initialSceneReady" class="fixed inset-0 z-[60] flex items-center justify-center bg-white/30" role="status" aria-live="polite">
			<div class="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">正在准备画布…</div>
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
