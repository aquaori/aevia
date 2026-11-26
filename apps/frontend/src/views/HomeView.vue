<script setup lang="ts">
	import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from "vue";
	import { useRouter } from "vue-router";
	import {
		AlertCircle,
		ArrowRight,
		ArrowRightLeft,
		Check,
		CheckCircle2,
		ClipboardPaste,
		Copy,
		Eraser,
		Eye,
		Folder,
		Highlighter,
		KeyRound,
		LayoutGrid,
		List,
		Loader2,
		Lock,
		PenTool,
		Plus,
		RefreshCw,
		RotateCcw,
		Search,
		Settings2,
		SlidersHorizontal,
		Sticker,
		Users,
		X,
	} from "lucide-vue-next";
	import "../entry.css";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { useUserStore } from "../store/userStore";
	import { apiUrl } from "../config/endpoints";
	import AccountPanel from "../components/AccountPanel.vue";
	import RoomSettings from "../components/RoomSettings.vue";
	import { useAccountStore } from "../store/accountStore";
	import { stickerAssets } from "../scene/stickerAssets";
	import aeviaLogoUrl from "../assets/brand/aevia-logo.png";
	import aeviaIconUrl from "../assets/brand/aevia-icon.png";

	const router = useRouter();
	const userStore = useUserStore();
	const accountStore = useAccountStore();

	const applySessionAuth = (payload: {
		sessionToken?: string;
		token?: string;
		expiresAt?: number | null;
		role?: string;
	}) => {
		userStore.setToken(payload.sessionToken || payload.token || "");
		userStore.setSessionExpiresAt(payload.expiresAt ?? null);
		userStore.setRoomRole(payload.role || "editor");
	};

	type ResponseError = {
		response?: {
			data?: {
				msg?: string;
			};
		};
	};

	type AccountRoom = { roomId: string; name: string; role: string; passwordRequired: boolean };
	type RoleFilter = "all" | "owner" | "editor" | "viewer";
	type ViewMode = "grid" | "list";
	type PlaygroundTool = "pen" | "highlighter" | "sticker";

	const starterPresets = [
		{ title: "产品架构评审", desc: "流程图与系统拓扑", variant: 0 },
		{ title: "团队头脑风暴", desc: "便签墙与灵感收集", variant: 1 },
		{ title: "UI 原型草图", desc: "界面线框与批注", variant: 2 },
		{ title: "Sprint 迭代复盘", desc: "分支脑图与行动项", variant: 3 },
	] as const;

	const inkPalette = ["#4f46e5", "#ec4899", "#f59e0b", "#10b981", "#0f172a"] as const;

	// Refs
	const accountPanelRef = ref<InstanceType<typeof AccountPanel> | null>(null);
	const createNameInputRef = ref<HTMLInputElement | null>(null);
	const joinDigitRefs = ref<HTMLInputElement[]>([]);
	const joinPasswordInputRef = ref<HTMLInputElement | null>(null);
	const customCreateDigitRefs = ref<HTMLInputElement[]>([]);
	const unlockPasswordRef = ref<HTMLInputElement | null>(null);
	const scratchCanvasRef = ref<HTMLCanvasElement | null>(null);

	// --- Create Studio State ---
	const newRoomName = ref("");
	const createPassword = ref("");
	const generatedRoomId = ref("");
	const useCustomCreateCode = ref(false);
	const customCreateDigits = ref<string[]>(["", "", "", "", "", ""]);
	const showCreateAdvanced = ref(false);
	const createCodeStatus = ref<"idle" | "checking" | "valid" | "invalid">("idle");
	const isCreating = ref(false);
	const hoveredPresetVariant = ref<number | null>(null);

	// --- Quick Join State (Signed-in & Guest) ---
	const joinDigits = ref<string[]>(["", "", "", "", "", ""]);
	const joinPassword = ref("");
	const showJoinPassword = ref(false);
	const joinProbeStatus = ref<"idle" | "checking" | "exists" | "missing">("idle");
	const isJoining = ref(false);
	const username = ref(localStorage.getItem("wb_username") || "");

	// --- Spaces Gallery State ---
	const rooms = ref<AccountRoom[]>([]);
	const transfers = ref<{ roomId: string; roomName: string; ownerNickname: string }[]>([]);
	const settingsRoom = ref<AccountRoom | null>(null);
	const searchQuery = ref("");
	const filterRole = ref<RoleFilter>("all");
	const viewMode = ref<ViewMode>("grid");
	const copiedRoomId = ref<string | null>(null);
	const enteringRoomId = ref<string | null>(null);
	const unlockTargetRoom = ref<AccountRoom | null>(null);
	const unlockPassword = ref("");
	const isUnlocking = ref(false);

	// --- Guest Full-Viewport Playground State ---
	const playgroundTool = ref<PlaygroundTool>("pen");
	const activeInk = ref<string>(inkPalette[0]);
	const activeSticker = ref<string>(stickerAssets[0]?.value ?? "✨");
	let isScratchDrawing = false;
	let lastScratchX = 0;
	let lastScratchY = 0;
	let scratchHasUserStrokes = false;

	interface StickyNoteState {
		id: string;
		theme: "yellow" | "pink" | "indigo";
		tag: string;
		text: string;
		meta: string;
		x: number;
		y: number;
		rotate: number;
	}

	const stickyNotes = ref<StickyNoteState[]>([
		{
			id: "note-1",
			theme: "yellow",
			tag: "01 · 灵感便签",
			text: "拖动我试试！进房后所有人都能一起贴便签与圈画重点。",
			meta: "@Lin · 3 分钟前",
			x: 8,
			y: 22,
			rotate: -3.2,
		},
		{
			id: "note-2",
			theme: "pink",
			tag: "02 · 创意手绘",
			text: "点底部「钢笔 / 荧光笔 / 贴纸」即可在整张页面自由试画。",
			meta: "@Mia · 刚刚",
			x: 242,
			y: 52,
			rotate: 2.6,
		},
		{
			id: "note-3",
			theme: "indigo",
			tag: "03 · 多人同屏",
			text: "输完 6 位房号，一秒加入实时同步的协作白板。",
			meta: "@Aevia Studio",
			x: 92,
			y: 196,
			rotate: -1.4,
		},
	]);

	const draggingNoteId = ref<string | null>(null);
	let noteDragStartX = 0;
	let noteDragStartY = 0;
	let noteOriginX = 0;
	let noteOriginY = 0;

	const startNoteDrag = (note: StickyNoteState, event: PointerEvent) => {
		draggingNoteId.value = note.id;
		noteDragStartX = event.clientX;
		noteDragStartY = event.clientY;
		noteOriginX = note.x;
		noteOriginY = note.y;
		window.addEventListener("pointermove", moveNoteDrag);
		window.addEventListener("pointerup", endNoteDrag);
		window.addEventListener("pointercancel", endNoteDrag);
	};

	const moveNoteDrag = (event: PointerEvent) => {
		if (!draggingNoteId.value) return;
		const note = stickyNotes.value.find((item) => item.id === draggingNoteId.value);
		if (!note) return;
		note.x = Math.max(-40, Math.min(480, noteOriginX + (event.clientX - noteDragStartX)));
		note.y = Math.max(-20, Math.min(340, noteOriginY + (event.clientY - noteDragStartY)));
	};

	const endNoteDrag = () => {
		draggingNoteId.value = null;
		window.removeEventListener("pointermove", moveNoteDrag);
		window.removeEventListener("pointerup", endNoteDrag);
		window.removeEventListener("pointercancel", endNoteDrag);
	};

	const drawInitialScratchpad = () => {
		const canvas = scratchCanvasRef.value;
		if (!canvas) return;
		try {
			const rect = canvas.getBoundingClientRect();
			const w = Math.max(rect.width || window.innerWidth || 1280, 360);
			const h = Math.max(rect.height || window.innerHeight || 800, 360);
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
			const ctx = canvas.getContext?.("2d");
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);

			// Sweeping Aevia Prismatic Ribbon Brush Stroke across left playground
			const ribbonGrad = ctx.createLinearGradient(w * 0.04, h * 0.72, w * 0.56, h * 0.24);
			ribbonGrad.addColorStop(0, "rgba(37, 99, 235, 0.24)");
			ribbonGrad.addColorStop(0.35, "rgba(124, 58, 237, 0.24)");
			ribbonGrad.addColorStop(0.7, "rgba(236, 72, 153, 0.22)");
			ribbonGrad.addColorStop(1, "rgba(245, 158, 11, 0.22)");

			ctx.strokeStyle = ribbonGrad;
			ctx.lineWidth = 18;
			ctx.lineCap = "round";
			ctx.beginPath();
			ctx.moveTo(w * 0.04, h * 0.78);
			ctx.bezierCurveTo(w * 0.16, h * 0.48, w * 0.34, h * 0.84, w * 0.53, h * 0.36);
			ctx.stroke();

			// Crisp ink sketch loop + doodle arrow around playground notes
			ctx.strokeStyle = "rgba(79, 70, 229, 0.55)";
			ctx.lineWidth = 2.4;
			ctx.beginPath();
			ctx.moveTo(w * 0.08, h * 0.62);
			ctx.bezierCurveTo(w * 0.14, h * 0.52, w * 0.28, h * 0.68, w * 0.38, h * 0.56);
			ctx.stroke();

			// Highlighter swipe accent
			ctx.strokeStyle = "rgba(250, 204, 21, 0.38)";
			ctx.lineWidth = 12;
			ctx.beginPath();
			ctx.moveTo(w * 0.12, h * 0.29);
			ctx.lineTo(w * 0.31, h * 0.29);
			ctx.stroke();

			// Dashed connector & target ring near lower-left
			ctx.save();
			ctx.setLineDash([6, 6]);
			ctx.strokeStyle = "rgba(236, 72, 153, 0.45)";
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(w * 0.44, h * 0.68, 34, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
		} catch {
			// Headless environments without 2D context ignore drawing cleanly.
		}
	};

	const resetScratchpad = () => {
		scratchHasUserStrokes = false;
		drawInitialScratchpad();
	};

	const clearScratchpad = () => {
		scratchHasUserStrokes = true;
		const canvas = scratchCanvasRef.value;
		if (!canvas) return;
		try {
			const ctx = canvas.getContext?.("2d");
			if (!ctx) return;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		} catch {
			// ignore
		}
	};

	const scratchCoords = (event: PointerEvent) => {
		const canvas = scratchCanvasRef.value;
		if (!canvas) return { x: 0, y: 0 };
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};

	const stampStickerOnCanvas = (x: number, y: number) => {
		const canvas = scratchCanvasRef.value;
		if (!canvas) return;
		try {
			const ctx = canvas.getContext?.("2d");
			if (!ctx) return;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
			ctx.strokeStyle = "rgba(199, 210, 254, 0.9)";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(x, y, 22, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();

			ctx.font = "22px system-ui, Apple Color Emoji, Segoe UI Emoji, sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(activeSticker.value, x, y + 1);
		} catch {
			// ignore
		}
	};

	const startScratch = (event: PointerEvent) => {
		const canvas = scratchCanvasRef.value;
		if (!canvas) return;
		if (!scratchHasUserStrokes) {
			scratchHasUserStrokes = true;
		}
		const pt = scratchCoords(event);
		if (playgroundTool.value === "sticker") {
			stampStickerOnCanvas(pt.x, pt.y);
			return;
		}
		isScratchDrawing = true;
		lastScratchX = pt.x;
		lastScratchY = pt.y;
		canvas.setPointerCapture?.(event.pointerId);
	};

	const moveScratch = (event: PointerEvent) => {
		if (!isScratchDrawing || playgroundTool.value === "sticker") return;
		const canvas = scratchCanvasRef.value;
		if (!canvas) return;
		try {
			const ctx = canvas.getContext?.("2d");
			if (!ctx) return;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const pt = scratchCoords(event);
			ctx.save();
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.strokeStyle = activeInk.value;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			if (playgroundTool.value === "highlighter") {
				ctx.globalAlpha = 0.28;
				ctx.lineWidth = 16;
			} else {
				ctx.globalAlpha = 1;
				ctx.lineWidth = 2.8;
			}
			ctx.beginPath();
			ctx.moveTo(lastScratchX, lastScratchY);
			ctx.lineTo(pt.x, pt.y);
			ctx.stroke();
			ctx.restore();
			lastScratchX = pt.x;
			lastScratchY = pt.y;
		} catch {
			// ignore
		}
	};

	const endScratch = () => {
		isScratchDrawing = false;
	};

	// --- Computed ---
	const joinCode = computed(() => joinDigits.value.join(""));
	const customCreateCode = computed(() => customCreateDigits.value.join(""));
	const activeCreateCode = computed(() => (useCustomCreateCode.value ? customCreateCode.value : generatedRoomId.value));
	const ownerRoomCount = computed(() => rooms.value.filter((room) => room.role === "owner").length);
	const editorRoomCount = computed(() => rooms.value.filter((room) => room.role === "editor").length);
	const viewerRoomCount = computed(() => rooms.value.filter((room) => room.role === "viewer").length);

	const activePresetVariant = computed(() => {
		if (hoveredPresetVariant.value !== null) return hoveredPresetVariant.value;
		const matched = starterPresets.find((p) => p.title === newRoomName.value);
		return matched ? matched.variant : 0;
	});

	const activePresetInfo = computed(
		() => starterPresets[activePresetVariant.value] ?? starterPresets[0],
	);

	const activeFilterLabel = computed(() => {
		if (filterRole.value === "owner") return "我创建的";
		if (filterRole.value === "editor") return "协作加入";
		if (filterRole.value === "viewer") return "只读访问";
		return "全部画布";
	});

	const filteredRooms = computed(() => {
		const keyword = searchQuery.value.trim().toLowerCase();
		return rooms.value.filter((room) => {
			if (filterRole.value === "owner" && room.role !== "owner") return false;
			if (filterRole.value === "editor" && room.role !== "editor") return false;
			if (filterRole.value === "viewer" && room.role !== "viewer") return false;
			if (!keyword) return true;
			return room.name.toLowerCase().includes(keyword) || room.roomId.toLowerCase().includes(keyword);
		});
	});

	const canSubmitJoin = computed(() => {
		if (joinCode.value.length !== 6 || isJoining.value) return false;
		if (accountStore.account) return true;
		return username.value.trim().length > 0;
	});

	// --- Helpers ---
	const formatRoomCode = (code: string) => {
		if (!code || code.length !== 6) return code || "---·---";
		return `${code.slice(0, 3)}·${code.slice(3)}`;
	};

	const getPreviewVariant = (id: string, index = 0) => {
		const firstId = filteredRooms.value[0]?.roomId || id;
		let hash = 0;
		for (let i = 0; i < firstId.length; i += 1) {
			hash = (hash + firstId.charCodeAt(i)) % 4;
		}
		return (hash + index) % 4;
	};

	const getRoleLabel = (role: string) => {
		if (role === "owner") return "房主";
		if (role === "viewer") return "只读";
		return "协作";
	};

	const fetchGeneratedRoomId = async () => {
		try {
			const res = await axios.get(apiUrl("/generate-room-id"));
			const id = res.data?.data?.roomId;
			if (typeof id === "string" && id.length === 6) {
				generatedRoomId.value = id;
				return id;
			}
			toast.error("房间号生成失败，请稍后重试。");
			return "";
		} catch (err: unknown) {
			const responseError = err as ResponseError;
			toast.error(responseError.response?.data?.msg || "ID 生成失败，请检查网络设置。");
			return "";
		}
	};

	const applyPreset = async (presetTitle: string) => {
		newRoomName.value = presetTitle;
		await nextTick();
		createNameInputRef.value?.focus();
	};

	// --- Digit Keycaps Handlers ---
	const handleDigitInput = (
		digits: string[],
		refs: HTMLInputElement[],
		index: number,
		event: Event,
	) => {
		const input = event.target as HTMLInputElement;
		const val = input.value;
		if (!/^\d*$/.test(val)) {
			digits[index] = "";
			return;
		}
		digits[index] = val.slice(-1);
		if (val && index < 5) {
			refs[index + 1]?.focus();
		}
	};

	const handleDigitKeyDown = (
		digits: string[],
		refs: HTMLInputElement[],
		index: number,
		event: KeyboardEvent,
		onEnter?: () => void,
	) => {
		if (event.key === "Backspace" && !digits[index] && index > 0) {
			refs[index - 1]?.focus();
		} else if (event.key === "ArrowLeft" && index > 0) {
			event.preventDefault();
			refs[index - 1]?.focus();
		} else if (event.key === "ArrowRight" && index < 5) {
			event.preventDefault();
			refs[index + 1]?.focus();
		} else if (event.key === "Enter" && onEnter) {
			onEnter();
		}
	};

	const applyPastedDigits = (raw: string, digits: string[], refs: HTMLInputElement[]) => {
		const clean = raw.replace(/\D/g, "");
		if (clean.length !== 6) return false;
		const parts = clean.split("");
		for (let i = 0; i < 6; i += 1) {
			digits[i] = parts[i] || "";
		}
		refs[5]?.focus();
		return true;
	};

	const handleJoinPaste = (event: ClipboardEvent) => {
		event.preventDefault();
		const text = event.clipboardData?.getData("text") || "";
		applyPastedDigits(text, joinDigits.value, joinDigitRefs.value);
	};

	const handleCustomCreatePaste = (event: ClipboardEvent) => {
		event.preventDefault();
		const text = event.clipboardData?.getData("text") || "";
		applyPastedDigits(text, customCreateDigits.value, customCreateDigitRefs.value);
	};

	const pasteFromClipboard = async () => {
		try {
			const text = await navigator.clipboard?.readText();
			if (!text || !applyPastedDigits(text, joinDigits.value, joinDigitRefs.value)) {
				toast.error("剪贴板中未检测到 6 位数字房间号");
			}
		} catch {
			toast.error("无法读取剪贴板，请直接在输入框内 Ctrl+V 粘贴");
		}
	};

	// --- Live Room Checks ---
	let joinProbeSeq = 0;
	watch(joinCode, async (code) => {
		joinProbeSeq += 1;
		const reqSeq = joinProbeSeq;
		if (code.length !== 6) {
			joinProbeStatus.value = "idle";
			return;
		}
		joinProbeStatus.value = "checking";
		try {
			const res = await axios.get(apiUrl(`/check-room?roomId=${encodeURIComponent(code)}`));
			if (reqSeq !== joinProbeSeq) return;
			joinProbeStatus.value = res.data?.data?.status === true ? "exists" : "missing";
		} catch {
			if (reqSeq !== joinProbeSeq) return;
			joinProbeStatus.value = "idle";
		}
	});

	let createProbeSeq = 0;
	watch(customCreateCode, async (code) => {
		createProbeSeq += 1;
		const reqSeq = createProbeSeq;
		if (!useCustomCreateCode.value || code.length !== 6) {
			createCodeStatus.value = "idle";
			return;
		}
		createCodeStatus.value = "checking";
		try {
			const res = await axios.get(apiUrl(`/check-room?roomId=${encodeURIComponent(code)}`));
			if (reqSeq !== createProbeSeq) return;
			createCodeStatus.value = res.data?.data?.status === true ? "invalid" : "valid";
		} catch {
			if (reqSeq !== createProbeSeq) return;
			createCodeStatus.value = "idle";
		}
	});

	// --- 1-Step Create Room ---
	const handleCreateRoom = async () => {
		if (!accountStore.token) {
			toast.error("请先登录后创建房间");
			accountPanelRef.value?.openDialog("login");
			return;
		}
		if (isCreating.value) return;

		let targetRoomId: string;
		if (useCustomCreateCode.value) {
			if (customCreateCode.value.length !== 6) {
				toast.error("请输入完整的 6 位自定义房间号");
				return;
			}
			if (createCodeStatus.value === "invalid") {
				toast.error("该房间号已被占用，请更换");
				return;
			}
			targetRoomId = customCreateCode.value;
		} else {
			targetRoomId = generatedRoomId.value || (await fetchGeneratedRoomId());
			if (!targetRoomId) return;
		}

		isCreating.value = true;
		try {
			if (useCustomCreateCode.value) {
				const checkRes = await axios.get(apiUrl(`/check-room?roomId=${encodeURIComponent(targetRoomId)}`));
				if (checkRes.data?.data?.status === true) {
					createCodeStatus.value = "invalid";
					toast.error("该房间号已被占用，请更换");
					return;
				}
			}
			const activeName = accountStore.account?.nickname || username.value || "成员";
			const finalRoomName = newRoomName.value.trim() || `白板 ${targetRoomId.slice(-3)}`;
			await axios.post(
				apiUrl("/v2/rooms"),
				{ roomId: targetRoomId, roomName: finalRoomName, password: createPassword.value },
				{ headers: accountStore.headers() },
			);
			localStorage.setItem("wb_username", activeName);
			const admission = await axios.post(
				apiUrl(`/v2/rooms/${encodeURIComponent(targetRoomId)}/admission`),
				{ roomId: targetRoomId, userName: activeName, password: createPassword.value },
				{ headers: accountStore.headers() },
			);
			applySessionAuth(admission.data.data);
			await router.push({ name: "room" });
		} catch (error) {
			const responseError = error as ResponseError;
			toast.error(responseError.response?.data?.msg || "创建房间失败，请检查网络设置。");
		} finally {
			isCreating.value = false;
		}
	};

	// --- 1-Step Quick Join (Signed-in & Guest) ---
	const handleJoinByCode = async () => {
		if (joinCode.value.length !== 6 || isJoining.value) return;
		const activeName = accountStore.account?.nickname || username.value.trim();
		if (!activeName) {
			toast.error("请输入你的称呼");
			return;
		}

		isJoining.value = true;
		try {
			localStorage.setItem("wb_username", activeName);
			const response = await axios.post(
				apiUrl(`/v2/rooms/${encodeURIComponent(joinCode.value)}/admission`),
				{ roomId: joinCode.value, userName: activeName, password: joinPassword.value },
				{ headers: accountStore.token ? accountStore.headers() : {} },
			);
			applySessionAuth(response.data.data);
			await router.push({ name: "room" });
		} catch (error) {
			const responseError = error as ResponseError;
			const msg = responseError.response?.data?.msg;
			if (msg === "Password incorrect") {
				if (!showJoinPassword.value) {
					showJoinPassword.value = true;
					toast.info("此房间设有访问密码，请输入后继续");
					await nextTick();
					joinPasswordInputRef.value?.focus();
				} else {
					toast.error("房间密码错误，请重试");
				}
			} else if (msg === "Room does not exist") {
				joinProbeStatus.value = "missing";
				toast.error("房间不存在，请核对 6 位房间号");
			} else {
				toast.error(msg || "无法连接到服务器，请检查网络设置。");
			}
		} finally {
			isJoining.value = false;
		}
	};

	// --- Saved Rooms Actions ---
	const copyRoomCode = async (code: string) => {
		try {
			await navigator.clipboard?.writeText(code);
			copiedRoomId.value = code;
			toast.success(`已复制房间号 #${code}`);
			setTimeout(() => {
				if (copiedRoomId.value === code) copiedRoomId.value = null;
			}, 1800);
		} catch {
			toast.error("复制失败，请手动复制房间号");
		}
	};

	const enterSavedRoom = async (room: AccountRoom) => {
		if (enteringRoomId.value) return;
		const activeName = accountStore.account?.nickname || username.value;
		if (!room.passwordRequired && activeName) {
			enteringRoomId.value = room.roomId;
			try {
				localStorage.setItem("wb_username", activeName);
				const response = await axios.post(
					apiUrl(`/v2/rooms/${encodeURIComponent(room.roomId)}/admission`),
					{ roomId: room.roomId, userName: activeName, password: "" },
					{ headers: accountStore.token ? accountStore.headers() : {} },
				);
				applySessionAuth(response.data.data);
				await router.push({ name: "room" });
				return;
			} catch (error) {
				const responseError = error as ResponseError;
				if (responseError.response?.data?.msg !== "Password incorrect") {
					toast.error(responseError.response?.data?.msg || "进入房间失败");
					return;
				}
			} finally {
				enteringRoomId.value = null;
			}
		}

		unlockTargetRoom.value = room;
		unlockPassword.value = "";
		await nextTick();
		unlockPasswordRef.value?.focus();
	};

	const submitUnlockRoom = async () => {
		const room = unlockTargetRoom.value;
		if (!room || isUnlocking.value) return;
		const activeName = accountStore.account?.nickname || username.value || "成员";
		isUnlocking.value = true;
		try {
			localStorage.setItem("wb_username", activeName);
			const response = await axios.post(
				apiUrl(`/v2/rooms/${encodeURIComponent(room.roomId)}/admission`),
				{ roomId: room.roomId, userName: activeName, password: unlockPassword.value },
				{ headers: accountStore.token ? accountStore.headers() : {} },
			);
			applySessionAuth(response.data.data);
			unlockTargetRoom.value = null;
			await router.push({ name: "room" });
		} catch (error) {
			const responseError = error as ResponseError;
			const msg = responseError.response?.data?.msg;
			toast.error(msg === "Password incorrect" ? "房间密码错误" : msg || "进入房间失败");
		} finally {
			isUnlocking.value = false;
		}
	};

	// --- Account & Data Loading ---
	const loadRooms = async () => {
		if (!accountStore.token) {
			rooms.value = [];
			transfers.value = [];
			return;
		}
		try {
			rooms.value = (await axios.get(apiUrl("/v2/rooms"), { headers: accountStore.headers() })).data.data;
			transfers.value = (await axios.get(apiUrl("/v2/transfers"), { headers: accountStore.headers() })).data.data;
		} catch {
			rooms.value = [];
		}
	};

	const respondTransfer = async (targetRoomId: string, accept: boolean) => {
		try {
			await axios.post(
				apiUrl(`/v2/rooms/${targetRoomId}/transfer/respond`),
				{ accept },
				{ headers: accountStore.headers() },
			);
			await loadRooms();
		} catch {
			toast.error("处理转让请求失败");
		}
	};

	watch(
		() => accountStore.account,
		(value) => {
			if (value) {
				username.value = value.nickname;
				if (!generatedRoomId.value) {
					void fetchGeneratedRoomId();
				}
			} else {
				generatedRoomId.value = "";
				void nextTick(() => drawInitialScratchpad());
			}
			void loadRooms();
		},
		{ immediate: true },
	);

	const handleWindowResize = () => {
		if (!accountStore.account && !scratchHasUserStrokes) {
			drawInitialScratchpad();
		}
	};

	onMounted(() => {
		void accountStore.refresh();
		if (userStore.token) {
			userStore.clearAll();
		}
		if (!accountStore.account) {
			void nextTick(() => drawInitialScratchpad());
		}
		window.addEventListener("resize", handleWindowResize);
	});

	onBeforeUnmount(() => {
		endNoteDrag();
		window.removeEventListener("resize", handleWindowResize);
	});
</script>

<template>
 <div class="entry-app">
  <!-- =======================================================
       SIGNED-IN: CREATIVE SKETCHBOOK DESK & FOLIO PINBOARD
       ======================================================= -->
  <div v-if="accountStore.account" class="af-desk-container">
   <!-- Floating 3-Island Studio Bar -->
   <header class="af-studio-nav">
    <div class="af-nav-island">
     <div class="entry-brand">
      <img :src="aeviaLogoUrl" alt="Aevia" class="entry-brand-logo" />
      <span class="sr-only">Aevia</span>
      <span class="af-ctx-pill">创作空间</span>
     </div>
    </div>

    <nav class="studio-filter-pills" aria-label="按角色筛选画布">
     <button type="button" :class="{ selected: filterRole === 'all' }" @click="filterRole = 'all'">
      <Folder :size="14" />
      <span>全部画布</span>
      <span class="af-nav-count">{{ rooms.length }}</span>
     </button>
     <button type="button" :class="{ selected: filterRole === 'owner' }" @click="filterRole = 'owner'">
      <PenTool :size="14" />
      <span>我创建的</span>
      <span class="af-nav-count">{{ ownerRoomCount }}</span>
     </button>
     <button type="button" :class="{ selected: filterRole === 'editor' }" @click="filterRole = 'editor'">
      <Users :size="14" />
      <span>协作加入</span>
      <span class="af-nav-count">{{ editorRoomCount }}</span>
     </button>
     <button type="button" :class="{ selected: filterRole === 'viewer' }" @click="filterRole = 'viewer'">
      <Eye :size="14" />
      <span>只读访问</span>
      <span class="af-nav-count">{{ viewerRoomCount }}</span>
     </button>
    </nav>

    <div class="af-nav-right-cluster">
     <label class="studio-search-box">
      <span class="sr-only">搜索画布</span>
      <Search :size="14" class="studio-search-icon" aria-hidden="true" />
      <input v-model="searchQuery" type="search" placeholder="搜索画布或房间号…" />
      <button v-if="searchQuery" type="button" class="studio-search-clear" aria-label="清空搜索" @click="searchQuery = ''">
       <X :size="12" />
      </button>
     </label>

     <div class="studio-view-switch" role="group" aria-label="切换视图模式">
      <button type="button" :class="{ selected: viewMode === 'grid' }" aria-label="画廊视图" title="画廊视图" @click="viewMode = 'grid'">
       <LayoutGrid :size="14" />
      </button>
      <button type="button" :class="{ selected: viewMode === 'list' }" aria-label="列表视图" title="列表视图" @click="viewMode = 'list'">
       <List :size="14" />
      </button>
     </div>

     <AccountPanel ref="accountPanelRef" />
    </div>
   </header>

   <!-- Hero Asymmetric Creative Bento -->
   <section class="af-workbench-bento" aria-label="创作与快捷加入">
    <!-- Left (~64%): Interactive New Canvas Easel -->
    <div class="af-easel-card">
     <div class="af-easel-split">
      <div>
       <h1 class="af-easel-title">展开一张新的创意白板</h1>
       <p class="af-easel-sub">挑选模板或直接命名画布，系统已预留专属房间号，一点即刻开画。</p>

       <div class="af-create-row">
        <label class="sr-only" for="af-create-name">新画布名称</label>
        <input
         id="af-create-name"
         ref="createNameInputRef"
         v-model="newRoomName"
         class="af-create-input"
         placeholder="输入白板名称（留空将自动命名）…"
         @keyup.enter="handleCreateRoom"
        />

        <button
         type="button"
         data-testid="toggle-create-advanced"
         class="af-create-meta-btn"
         :class="{ open: showCreateAdvanced }"
         @click="showCreateAdvanced = !showCreateAdvanced"
        >
         <SlidersHorizontal :size="13" />
         <code>#{{ formatRoomCode(activeCreateCode) }}</code>
         <Lock v-if="createPassword" :size="12" />
        </button>

        <button
         type="button"
         data-testid="create-room-submit"
         class="entry-button primary"
         :disabled="isCreating"
         @click="handleCreateRoom"
        >
         <Loader2 v-if="isCreating" class="entry-spin" :size="15" />
         <template v-else><Plus :size="15" /> 新建白板</template>
        </button>
       </div>

       <div class="af-preset-grid" role="group" aria-label="创意模板快捷预设">
        <button
         v-for="preset in starterPresets"
         :key="preset.title"
         type="button"
         class="studio-preset-chip"
         :class="{ active: newRoomName === preset.title }"
         @mouseenter="hoveredPresetVariant = preset.variant"
         @mouseleave="hoveredPresetVariant = null"
         @click="applyPreset(preset.title)"
        >
         <span class="af-preset-dot" :class="`v${preset.variant}`" aria-hidden="true">
          <PenTool :size="13" />
         </span>
         <span>{{ preset.title }}</span>
        </button>
       </div>
      </div>

      <!-- Right Tilted Reactive Washi-Tape Artboard Preview -->
      <div class="af-easel-stage" aria-hidden="true">
       <div class="af-easel-stage-label">
        <span>画布预演</span>
        <span>{{ activePresetInfo.desc }}</span>
       </div>

       <!-- Reactive Scene 0 -->
       <svg v-if="activePresetVariant === 0" class="af-easel-stage-svg" viewBox="0 0 240 128" fill="none">
        <rect x="12" y="34" width="60" height="44" rx="10" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.5" />
        <rect x="22" y="47" width="38" height="6" rx="3" fill="#4F46E5" />
        <rect x="22" y="59" width="24" height="4.5" rx="2.25" fill="#A5B4FC" />
        <path d="M72 56C96 56 96 42 120 42" stroke="#6366F1" stroke-width="2.2" stroke-linecap="round" />
        <path d="M120 42C146 42 146 80 170 80" stroke="#EC4899" stroke-width="2.2" stroke-linecap="round" />
        <rect x="166" y="18" width="60" height="32" rx="9" fill="#FEF9C3" stroke="#FACC15" stroke-width="1.4" transform="rotate(-3 196 34)" />
        <rect x="176" y="31" width="36" height="5" rx="2.5" fill="#CA8A04" transform="rotate(-3 196 34)" />
        <rect x="164" y="68" width="62" height="38" rx="10" fill="#FDF2F8" stroke="#F472B6" stroke-width="1.5" />
        <circle cx="182" cy="87" r="6" fill="#EC4899" fill-opacity="0.24" />
        <rect x="193" y="84" width="24" height="5.5" rx="2.75" fill="#DB2777" />
       </svg>

       <!-- Reactive Scene 1 -->
       <svg v-else-if="activePresetVariant === 1" class="af-easel-stage-svg" viewBox="0 0 240 128" fill="none">
        <rect x="18" y="20" width="68" height="56" rx="8" fill="#FEF9C3" stroke="#FACC15" stroke-width="1.4" transform="rotate(-4 52 48)" />
        <rect x="30" y="38" width="40" height="5" rx="2.5" fill="#A16207" transform="rotate(-4 52 48)" />
        <rect x="92" y="16" width="68" height="56" rx="8" fill="#FCE7F3" stroke="#F472B6" stroke-width="1.4" transform="rotate(3 126 44)" />
        <rect x="104" y="34" width="42" height="5" rx="2.5" fill="#BE185D" transform="rotate(3 126 44)" />
        <rect x="152" y="48" width="70" height="58" rx="8" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.4" transform="rotate(-2 187 77)" />
        <rect x="164" y="68" width="44" height="5" rx="2.5" fill="#4338CA" transform="rotate(-2 187 77)" />
        <path d="M56 88C92 108 122 102 150 86" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-dasharray="4 4" />
       </svg>

       <!-- Reactive Scene 2 -->
       <svg v-else-if="activePresetVariant === 2" class="af-easel-stage-svg" viewBox="0 0 240 128" fill="none">
        <rect x="24" y="14" width="192" height="100" rx="12" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.4" />
        <line x1="24" y1="34" x2="216" y2="34" stroke="#E2E8F0" stroke-width="1.2" />
        <circle cx="38" cy="24" r="3" fill="#F43F5E" />
        <circle cx="48" cy="24" r="3" fill="#F59E0B" />
        <circle cx="58" cy="24" r="3" fill="#10B981" />
        <rect x="36" y="45" width="74" height="54" rx="9" fill="#EEF2FF" stroke="#C7D2FE" stroke-width="1.2" />
        <rect x="122" y="48" width="80" height="7" rx="3.5" fill="#0F172A" />
        <rect x="122" y="62" width="58" height="5" rx="2.5" fill="#94A3B8" />
        <rect x="122" y="78" width="52" height="18" rx="9" fill="#4F46E5" />
        <path d="M18 98C66 56 124 94 218 44" stroke="#EC4899" stroke-opacity="0.65" stroke-width="2.4" stroke-linecap="round" />
       </svg>

       <!-- Reactive Scene 3 -->
       <svg v-else class="af-easel-stage-svg" viewBox="0 0 240 128" fill="none">
        <path d="M120 64L52 28M120 64L50 100M120 64L188 28M120 64L190 100" stroke="#CBD5E1" stroke-width="1.8" />
        <rect x="84" y="44" width="72" height="40" rx="20" fill="#4F46E5" />
        <rect x="102" y="61" width="36" height="6" rx="3" fill="#FFFFFF" />
        <rect x="22" y="14" width="52" height="26" rx="9" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.3" />
        <rect x="20" y="88" width="52" height="26" rx="9" fill="#ECFDF5" stroke="#34D399" stroke-width="1.3" />
        <rect x="166" y="14" width="52" height="26" rx="9" fill="#FEF9C3" stroke="#FACC15" stroke-width="1.3" />
        <rect x="168" y="88" width="52" height="26" rx="9" fill="#FCE7F3" stroke="#F472B6" stroke-width="1.3" />
       </svg>
      </div>
     </div>

     <div v-if="showCreateAdvanced" class="studio-advanced-drawer">
      <div class="af-advanced-top">
       <div class="entry-segment" role="group" aria-label="房间号分配方式">
        <button type="button" :class="{ selected: !useCustomCreateCode }" @click="useCustomCreateCode = false">
         随机分配
        </button>
        <button type="button" :class="{ selected: useCustomCreateCode }" @click="useCustomCreateCode = true">
         自定义 6 位房号
        </button>
       </div>

       <button v-if="!useCustomCreateCode" type="button" class="af-text-action" @click="fetchGeneratedRoomId">
        <RefreshCw :size="12" /> 换一组房间号
       </button>
      </div>

      <div v-if="useCustomCreateCode" class="af-advanced-digits">
       <div class="af-advanced-digits-grid">
        <input
         v-for="(_, index) in 6"
         :key="index"
         ref="customCreateDigitRefs"
         type="text"
         inputmode="numeric"
         maxlength="1"
         :aria-label="`自定义房间号第 ${index + 1} 位`"
         :value="customCreateDigits[index]"
         @input="handleDigitInput(customCreateDigits, customCreateDigitRefs, index, $event)"
         @keydown="handleDigitKeyDown(customCreateDigits, customCreateDigitRefs, index, $event, handleCreateRoom)"
         @paste="handleCustomCreatePaste"
        />
       </div>
       <span class="af-probe-status" :class="createCodeStatus === 'valid' ? 'exists' : createCodeStatus === 'invalid' ? 'missing' : ''">
        {{
         createCodeStatus === 'checking'
          ? '校验中…'
          : createCodeStatus === 'valid'
          ? '房间号可用'
          : createCodeStatus === 'invalid'
          ? '房间号已被占用'
          : '输入 6 位数字'
        }}
       </span>
      </div>

      <div class="entry-form" style="margin-bottom: 0;">
       <label>
        <span>访问密码 <span class="entry-optional">选填</span></span>
        <input
         v-model="createPassword"
         type="password"
         style="height: 38px; background: #ffffff;"
         placeholder="留空则受邀或凭号成员可直接进入"
         @keyup.enter="handleCreateRoom"
        />
       </label>
      </div>
     </div>
    </div>

    <!-- Right (~36%): Stacked Room Code Teleporter -->
    <div class="af-teleporter-card">
     <div>
      <div class="af-teleporter-head">
       <div>
        <div class="af-teleporter-title">
         <span class="af-teleporter-badge" aria-hidden="true"><KeyRound :size="16" /></span>
         <span>凭房号快速空降</span>
        </div>
        <p class="af-teleporter-sub">输入伙伴分享的 6 位数字房号，直达同屏画布</p>
       </div>
       <button type="button" class="af-text-action" @click="pasteFromClipboard">
        <ClipboardPaste :size="12" /> 粘贴
       </button>
      </div>

      <div class="studio-keycaps" style="margin-top: 14px;">
       <input
        v-for="index in 3"
        :key="`j1-${index - 1}`"
        ref="joinDigitRefs"
        type="text"
        inputmode="numeric"
        maxlength="1"
        :class="{ 'is-filled': !!joinDigits[index - 1] }"
        :aria-label="`加入房间号第 ${index} 位`"
        :value="joinDigits[index - 1]"
        @input="handleDigitInput(joinDigits, joinDigitRefs, index - 1, $event)"
        @keydown="handleDigitKeyDown(joinDigits, joinDigitRefs, index - 1, $event, handleJoinByCode)"
        @paste="handleJoinPaste"
       />
       <span class="af-keycap-sep" aria-hidden="true">·</span>
       <input
        v-for="index in 3"
        :key="`j2-${index + 2}`"
        ref="joinDigitRefs"
        type="text"
        inputmode="numeric"
        maxlength="1"
        :class="{ 'is-filled': !!joinDigits[index + 2] }"
        :aria-label="`加入房间号第 ${index + 3} 位`"
        :value="joinDigits[index + 2]"
        @input="handleDigitInput(joinDigits, joinDigitRefs, index + 2, $event)"
        @keydown="handleDigitKeyDown(joinDigits, joinDigitRefs, index + 2, $event, handleJoinByCode)"
        @paste="handleJoinPaste"
       />
      </div>

      <div class="af-probe-line" style="margin-top: 10px;">
       <span class="af-probe-status" :class="joinProbeStatus">
        <Loader2 v-if="joinProbeStatus === 'checking'" class="entry-spin" :size="11" />
        <CheckCircle2 v-else-if="joinProbeStatus === 'exists'" :size="11" />
        <AlertCircle v-else-if="joinProbeStatus === 'missing'" :size="11" />
        <span>{{
         joinProbeStatus === 'checking'
          ? '查找中…'
          : joinProbeStatus === 'exists'
          ? '房间在线'
          : joinProbeStatus === 'missing'
          ? '未找到房间'
          : '支持 Ctrl+V 粘贴完整房号'
        }}</span>
       </span>

       <button type="button" class="af-text-action" @click="showJoinPassword = !showJoinPassword">
        <Lock :size="11" /> {{ showJoinPassword ? '收起' : '密码' }}
       </button>
      </div>

      <div v-if="showJoinPassword" class="entry-form" style="margin-top: 10px; margin-bottom: 0;">
       <label>
        <span class="sr-only">房间密码</span>
        <input
         ref="joinPasswordInputRef"
         v-model="joinPassword"
         type="password"
         style="height: 36px; font-size: 12.5px;"
         placeholder="输入房间密码"
         @keyup.enter="handleJoinByCode"
        />
       </label>
      </div>
     </div>

     <button
      type="button"
      data-testid="join-room-submit"
      class="entry-button primary wide"
      :disabled="!canSubmitJoin"
      @click="handleJoinByCode"
     >
      <Loader2 v-if="isJoining" class="entry-spin" :size="15" />
      <template v-else>进入房间 <ArrowRight :size="15" /></template>
     </button>
    </div>
   </section>

   <!-- Ownership Transfer Notices -->
   <div v-if="transfers.length" class="entry-notices">
    <div v-for="transfer in transfers" :key="transfer.roomId" class="entry-notice">
     <div class="entry-notice-text">
      <span class="entry-notice-icon" aria-hidden="true"><ArrowRightLeft :size="15" /></span>
      <span>{{ transfer.ownerNickname }} 邀请你接任「{{ transfer.roomName }}」的房主</span>
     </div>
     <div class="entry-notice-actions">
      <button type="button" @click="respondTransfer(transfer.roomId, true)">接受</button>
      <button type="button" @click="respondTransfer(transfer.roomId, false)">拒绝</button>
     </div>
    </div>
   </div>

   <!-- Gallery Header -->
   <div class="af-gallery-header">
    <div class="af-gallery-title">
     <h2>{{ activeFilterLabel }}</h2>
     <span class="af-gallery-count">{{ filteredRooms.length }} 块白板</span>
    </div>
   </div>

   <!-- Empty States -->
   <div v-if="!rooms.length" class="entry-empty">
    <img :src="aeviaIconUrl" alt="" width="36" height="36" aria-hidden="true" />
    <strong>还没有协作白板</strong>
    <p>在上方展开你的第一块创意白板，或直接输入 6 位房间号加入伙伴画布。</p>
    <button type="button" class="entry-button primary" @click="createNameInputRef?.focus()">新建第一块白板</button>
   </div>

   <div v-else-if="!filteredRooms.length" class="entry-empty">
    <Search :size="22" style="color: var(--af-faint);" />
    <strong>没有符合条件的画布</strong>
    <p>尝试更换关键词，或切换回全部画布视图。</p>
    <button type="button" class="entry-button secondary" @click="searchQuery = ''; filterRole = 'all'">重置筛选</button>
   </div>

   <!-- Tactile Multi-Sheet Folio Gallery -->
   <div v-else-if="viewMode === 'grid'" class="entry-room-list grid-mode">
    <article v-for="(room, idx) in filteredRooms" :key="room.roomId" class="entry-room-row">
     <div class="af-artboard">
      <button type="button" class="af-artboard-btn" :aria-label="`进入 ${room.name}`" @click="enterSavedRoom(room)">
       <!-- Scene 0: Ribbon Flow + Yellow Sticky + Live Cursor -->
       <svg v-if="getPreviewVariant(room.roomId, idx) === 0" class="af-artboard-svg" viewBox="0 0 260 140" fill="none" aria-hidden="true">
        <path d="M18 106C72 34 118 112 174 44C198 16 220 44 242 32" stroke="#6366F1" stroke-opacity="0.28" stroke-width="10" stroke-linecap="round" />
        <rect x="20" y="42" width="66" height="44" rx="10" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.5" />
        <rect x="30" y="55" width="40" height="6" rx="3" fill="#4F46E5" />
        <rect x="30" y="67" width="26" height="4.5" rx="2.25" fill="#A5B4FC" />
        <path d="M86 64H122" stroke="#6366F1" stroke-width="2" stroke-linecap="round" />
        <rect x="122" y="22" width="66" height="52" rx="9" fill="#FEF9C3" stroke="#FACC15" stroke-width="1.4" transform="rotate(3 155 48)" />
        <rect x="134" y="38" width="38" height="5" rx="2.5" fill="#CA8A04" transform="rotate(3 155 48)" />
        <rect x="134" y="49" width="26" height="4.5" rx="2.25" fill="#EAB308" transform="rotate(3 155 48)" />
        <rect x="172" y="88" width="54" height="22" rx="11" fill="#4F46E5" />
        <rect x="184" y="96.5" width="30" height="5" rx="2.5" fill="#FFFFFF" />
       </svg>

       <!-- Scene 1: Brainstorm Sticky Wall -->
       <svg v-else-if="getPreviewVariant(room.roomId, idx) === 1" class="af-artboard-svg" viewBox="0 0 260 140" fill="none" aria-hidden="true">
        <rect x="20" y="22" width="64" height="52" rx="8" fill="#FEF9C3" stroke="#FACC15" stroke-width="1.4" transform="rotate(-4 52 48)" />
        <rect x="32" y="39" width="38" height="5" rx="2.5" fill="#A16207" transform="rotate(-4 52 48)" />
        <rect x="32" y="50" width="24" height="4" rx="2" fill="#CA8A04" transform="rotate(-4 52 48)" />
        <rect x="98" y="18" width="64" height="52" rx="8" fill="#FCE7F3" stroke="#F472B6" stroke-width="1.4" transform="rotate(3 130 44)" />
        <rect x="110" y="35" width="38" height="5" rx="2.5" fill="#BE185D" transform="rotate(3 130 44)" />
        <rect x="110" y="46" width="26" height="4" rx="2" fill="#EC4899" transform="rotate(3 130 44)" />
        <rect x="166" y="48" width="68" height="56" rx="9" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.4" transform="rotate(-2 200 76)" />
        <rect x="178" y="66" width="42" height="5" rx="2.5" fill="#4338CA" transform="rotate(-2 200 76)" />
        <path d="M54 96C94 120 132 114 160 94" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-dasharray="4 4" />
        <circle cx="52" cy="96" r="10" fill="#ECFDF5" stroke="#10B981" stroke-width="1.4" />
       </svg>

       <!-- Scene 2: UI Wireframe + Prismatic Marker -->
       <svg v-else-if="getPreviewVariant(room.roomId, idx) === 2" class="af-artboard-svg" viewBox="0 0 260 140" fill="none" aria-hidden="true">
        <rect x="26" y="16" width="208" height="106" rx="12" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.4" />
        <line x1="26" y1="36" x2="234" y2="36" stroke="#E2E8F0" stroke-width="1.2" />
        <circle cx="40" cy="26" r="3" fill="#F43F5E" />
        <circle cx="50" cy="26" r="3" fill="#F59E0B" />
        <circle cx="60" cy="26" r="3" fill="#10B981" />
        <rect x="40" y="48" width="76" height="58" rx="9" fill="#EEF2FF" stroke="#C7D2FE" stroke-width="1.2" />
        <rect x="128" y="52" width="88" height="7" rx="3.5" fill="#0F172A" />
        <rect x="128" y="66" width="64" height="5.5" rx="2.75" fill="#94A3B8" />
        <rect x="128" y="82" width="54" height="18" rx="9" fill="#4F46E5" />
        <path d="M18 110C72 64 134 106 238 48" stroke="#EC4899" stroke-opacity="0.72" stroke-width="2.5" stroke-linecap="round" />
        <circle cx="192" cy="98" r="14" fill="#FFFBEB" stroke="#F59E0B" stroke-width="1.4" stroke-dasharray="3 3" />
       </svg>

       <!-- Scene 3: Radial Mindmap Constellation -->
       <svg v-else class="af-artboard-svg" viewBox="0 0 260 140" fill="none" aria-hidden="true">
        <path d="M130 70L54 32M130 70L52 108M130 70L206 32M130 70L208 108" stroke="#CBD5E1" stroke-width="1.8" />
        <rect x="92" y="48" width="76" height="44" rx="22" fill="#4F46E5" />
        <rect x="111" y="67" width="38" height="6" rx="3" fill="#FFFFFF" />
        <rect x="22" y="16" width="56" height="28" rx="10" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.4" />
        <rect x="20" y="94" width="56" height="28" rx="10" fill="#ECFDF5" stroke="#34D399" stroke-width="1.4" />
        <rect x="182" y="16" width="56" height="28" rx="10" fill="#FEF9C3" stroke="#FACC15" stroke-width="1.4" />
        <rect x="184" y="94" width="56" height="28" rx="10" fill="#FCE7F3" stroke="#F472B6" stroke-width="1.4" />
       </svg>
      </button>

      <div class="af-artboard-controls">
       <span v-if="room.passwordRequired" class="af-lock-badge" title="需要密码" aria-label="需要密码">
        <Lock :size="12" />
       </span>
       <button
        type="button"
        class="entry-icon-button"
        :aria-label="`设置${room.name}`"
        title="房间设置"
        @click.stop="settingsRoom = room"
       >
        <Settings2 :size="14" />
       </button>
      </div>
     </div>

     <div class="af-card-meta">
      <div class="af-card-top">
       <button type="button" class="af-card-title-btn" @click="enterSavedRoom(room)">
        <strong>{{ room.name }}</strong>
       </button>
       <span class="entry-role" :class="room.role">{{ getRoleLabel(room.role) }}</span>
      </div>

      <div class="af-card-bottom">
       <button
        type="button"
        class="entry-code-chip"
        :class="{ copied: copiedRoomId === room.roomId }"
        :title="`复制房间号 ${room.roomId}`"
        @click.stop="copyRoomCode(room.roomId)"
       >
        <span>#{{ formatRoomCode(room.roomId) }}</span>
        <Check v-if="copiedRoomId === room.roomId" :size="11" />
        <Copy v-else :size="11" />
       </button>

       <button
        type="button"
        class="entry-room-link"
        :disabled="enteringRoomId === room.roomId"
        @click="enterSavedRoom(room)"
       >
        <Loader2 v-if="enteringRoomId === room.roomId" class="entry-spin" :size="12" />
        <template v-else>进入 <ArrowRight :size="12" /></template>
       </button>
      </div>
     </div>
    </article>
   </div>

   <!-- Compact List Mode -->
   <div v-else class="entry-room-list list-mode">
    <article v-for="room in filteredRooms" :key="room.roomId" class="entry-room-row">
     <div class="af-list-left">
      <svg class="af-list-thumb" viewBox="0 0 48 32" fill="none" aria-hidden="true">
       <rect x="4" y="6" width="16" height="12" rx="3" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.2" />
       <path d="M20 12H28" stroke="#6366F1" stroke-width="1.4" />
       <rect x="28" y="14" width="16" height="12" rx="3" fill="#FDF2F8" stroke="#F472B6" stroke-width="1.2" />
      </svg>
      <button type="button" class="af-card-title-btn" @click="enterSavedRoom(room)">
       <strong>{{ room.name }}</strong>
      </button>
     </div>

     <div class="af-list-right">
      <span class="entry-role" :class="room.role">{{ getRoleLabel(room.role) }}</span>
      <Lock v-if="room.passwordRequired" :size="13" style="color: var(--af-amber-text);" />
      <button
       type="button"
       class="entry-code-chip"
       :class="{ copied: copiedRoomId === room.roomId }"
       @click.stop="copyRoomCode(room.roomId)"
      >
       <span>#{{ formatRoomCode(room.roomId) }}</span>
       <Check v-if="copiedRoomId === room.roomId" :size="11" />
       <Copy v-else :size="11" />
      </button>
      <button type="button" class="entry-room-link" :disabled="enteringRoomId === room.roomId" @click="enterSavedRoom(room)">
       <Loader2 v-if="enteringRoomId === room.roomId" class="entry-spin" :size="12" />
       <template v-else>进入 <ArrowRight :size="12" /></template>
      </button>
      <button
       type="button"
       class="entry-icon-button"
       :aria-label="`设置${room.name}`"
       title="房间设置"
       @click.stop="settingsRoom = room"
      >
       <Settings2 :size="14" />
      </button>
     </div>
    </article>
   </div>
  </div>

  <!-- =======================================================
       GUEST VIEW: FULL-VIEWPORT LIVE CREATIVE PLAYGROUND
       ======================================================= -->
  <div v-else class="af-guest-root">
   <canvas
    ref="scratchCanvasRef"
    class="af-guest-canvas-bg"
    aria-label="全屏试笔画布"
    @pointerdown="startScratch"
    @pointermove="moveScratch"
    @pointerup="endScratch"
    @pointercancel="endScratch"
    @pointerleave="endScratch"
   ></canvas>

   <header class="af-minimal-header">
    <div class="af-minimal-header-inner">
     <div class="af-header-pill">
      <div class="entry-brand">
       <img :src="aeviaLogoUrl" alt="Aevia" class="entry-brand-logo" />
       <span class="sr-only">Aevia</span>
       <span class="af-ctx-pill">协作白板</span>
      </div>
     </div>
     <div class="af-header-actions">
      <AccountPanel ref="accountPanelRef" />
     </div>
    </div>
   </header>

   <main class="af-guest-stage">
    <!-- Left Open Creative Playground -->
    <section class="af-playground-zone" aria-label="试笔画布体验区">
     <div class="af-playground-badge">
      <span class="af-live-dot" aria-hidden="true"></span>
      <span>试笔画布已就绪 · 拿起底部画笔、贴纸或拖动便签直接体验</span>
     </div>

     <h2 class="af-playground-headline">
      把零散灵感，铺成同一张<span>自由画布</span>。
     </h2>
     <p class="af-playground-desc">
      不用提前注册，此刻就能试画一笔、盖上贴纸或拖拽便签；输入右侧 6 位房号，直接融入团队实时白板。
     </p>

     <!-- Draggable Washi-Tape Sticky Notes & Collaborator Cursors -->
     <div class="af-notes-board">
      <div
       v-for="note in stickyNotes"
       :key="note.id"
       class="af-sticky-note is-draggable"
       :class="[note.theme, { 'is-dragging': draggingNoteId === note.id }]"
       :style="{
        left: `${note.x}px`,
        top: `${note.y}px`,
        transform: `rotate(${draggingNoteId === note.id ? 0 : note.rotate}deg)`,
       }"
       @pointerdown="startNoteDrag(note, $event)"
      >
       <div class="af-sticky-tag">
        <span>{{ note.tag }}</span>
       </div>
       <div class="af-sticky-text">{{ note.text }}</div>
       <div class="af-sticky-meta">{{ note.meta }}</div>
      </div>

      <div class="af-collab-cursor af-playground-cursor-a af-drift-a" aria-hidden="true">
       <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path d="M3 2L17 9.5L10.2 11.4L7.8 18L3 2Z" fill="#4F46E5" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" />
       </svg>
       <span class="af-cursor-pill indigo">Lin · 正在勾勒草图</span>
      </div>

      <div class="af-collab-cursor af-playground-cursor-b af-drift-b" aria-hidden="true">
       <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path d="M3 2L17 9.5L10.2 11.4L7.8 18L3 2Z" fill="#EC4899" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" />
       </svg>
       <span class="af-cursor-pill pink">Mia · 贴上灵感便签</span>
      </div>
     </div>
    </section>

    <!-- Right Stacked Studio Boarding Easel Card -->
    <section class="af-portal-stack" aria-label="访客加入房间">
     <div class="af-portal-card">
      <div class="af-ribbon-lip"></div>
      <div class="af-portal-body">
       <div class="af-portal-top">
        <div class="af-slip-emblem">
         <img :src="aeviaIconUrl" alt="" aria-hidden="true" />
        </div>
        <div>
         <h1>加入协作画布</h1>
         <p class="af-portal-sub">免注册，输入 6 位房间号即可同屏创作</p>
        </div>
       </div>

       <div class="af-field-head">
        <span>房间号</span>
        <button type="button" class="af-text-action" @click="pasteFromClipboard">
         <ClipboardPaste :size="12" /> 粘贴
        </button>
       </div>

       <div class="studio-keycaps">
        <input
         v-for="index in 3"
         :key="`g1-${index - 1}`"
         ref="joinDigitRefs"
         type="text"
         inputmode="numeric"
         maxlength="1"
         :class="{ 'is-filled': !!joinDigits[index - 1] }"
         :aria-label="`房间号第 ${index} 位`"
         :value="joinDigits[index - 1]"
         @input="handleDigitInput(joinDigits, joinDigitRefs, index - 1, $event)"
         @keydown="handleDigitKeyDown(joinDigits, joinDigitRefs, index - 1, $event, handleJoinByCode)"
         @paste="handleJoinPaste"
        />
        <span class="af-keycap-sep" aria-hidden="true">·</span>
        <input
         v-for="index in 3"
         :key="`g2-${index + 2}`"
         ref="joinDigitRefs"
         type="text"
         inputmode="numeric"
         maxlength="1"
         :class="{ 'is-filled': !!joinDigits[index + 2] }"
         :aria-label="`房间号第 ${index + 3} 位`"
         :value="joinDigits[index + 2]"
         @input="handleDigitInput(joinDigits, joinDigitRefs, index + 2, $event)"
         @keydown="handleDigitKeyDown(joinDigits, joinDigitRefs, index + 2, $event, handleJoinByCode)"
         @paste="handleJoinPaste"
        />
       </div>

       <div class="af-probe-line" style="margin: 10px 0 14px;">
        <span class="af-probe-status" :class="joinProbeStatus">
         <Loader2 v-if="joinProbeStatus === 'checking'" class="entry-spin" :size="11" />
         <CheckCircle2 v-else-if="joinProbeStatus === 'exists'" :size="11" />
         <AlertCircle v-else-if="joinProbeStatus === 'missing'" :size="11" />
         <span>{{
          joinProbeStatus === 'checking'
           ? '正在查找房间…'
           : joinProbeStatus === 'exists'
           ? '房间在线 · 可立即进入'
           : joinProbeStatus === 'missing'
           ? '未找到该房间号'
           : '支持粘贴完整 6 位数字'
         }}</span>
        </span>
       </div>

       <div class="entry-form">
        <label>
         <span>你的名字</span>
         <input v-model="username" placeholder="输入名字" @keyup.enter="handleJoinByCode" />
        </label>

        <div v-if="!showJoinPassword">
         <button type="button" class="af-password-disclosure" @click="showJoinPassword = true">
          <Lock :size="12" /> 房间设有访问密码？
         </button>
        </div>

        <label v-else>
         <span class="entry-label-head">
          <span>房间密码</span>
          <span class="entry-optional">如有</span>
         </span>
         <input
          ref="joinPasswordInputRef"
          v-model="joinPassword"
          type="password"
          placeholder="输入房间密码"
          @keyup.enter="handleJoinByCode"
         />
        </label>
       </div>

       <button
        type="button"
        data-testid="guest-join-submit"
        class="entry-button primary wide"
        :disabled="!canSubmitJoin"
        @click="handleJoinByCode"
       >
        <Loader2 v-if="isJoining" class="entry-spin" :size="15" />
        <template v-else>进入协作画布 <ArrowRight :size="15" /></template>
       </button>

       <div class="af-guest-auth-foot">
        <span>想要新建并长期保存白板？</span>
        <button type="button" class="af-guest-auth-link" @click="accountPanelRef?.openDialog('login')">
         登录 / 注册 <ArrowRight :size="13" />
        </button>
       </div>
      </div>
     </div>
    </section>
   </main>

   <!-- Floating RoomToolbar-Style Creative Dock -->
   <div class="af-guest-dock-wrap">
    <div class="af-playground-toolbar" role="toolbar" aria-label="试笔画布工具栏">
     <button
      type="button"
      class="af-tool-btn"
      :class="{ active: playgroundTool === 'pen' }"
      @click="playgroundTool = 'pen'"
     >
      <PenTool :size="14" /> 钢笔
     </button>
     <button
      type="button"
      class="af-tool-btn"
      :class="{ active: playgroundTool === 'highlighter' }"
      @click="playgroundTool = 'highlighter'"
     >
      <Highlighter :size="14" /> 荧光笔
     </button>
     <button
      type="button"
      class="af-tool-btn"
      :class="{ active: playgroundTool === 'sticker' }"
      @click="playgroundTool = 'sticker'"
     >
      <Sticker :size="14" /> 贴纸
     </button>

     <span class="af-dock-sep" aria-hidden="true"></span>

     <template v-if="playgroundTool !== 'sticker'">
      <button
       v-for="color in inkPalette"
       :key="color"
       type="button"
       class="af-ink-dot"
       :class="{ active: activeInk === color }"
       :style="{ backgroundColor: color }"
       :aria-label="`选择颜色 ${color}`"
       @click="activeInk = color"
      ></button>
     </template>
     <template v-else>
      <button
       v-for="asset in stickerAssets"
       :key="asset.key"
       type="button"
       class="af-sticker-btn"
       :class="{ active: activeSticker === asset.value }"
       :title="`盖章贴纸：${asset.label}`"
       :aria-label="`选择贴纸 ${asset.label}`"
       @click="activeSticker = asset.value"
      >
       {{ asset.value }}
      </button>
     </template>

     <span class="af-dock-sep" aria-hidden="true"></span>

     <button type="button" class="af-tool-btn" title="恢复示范彩绘" @click="resetScratchpad">
      <RotateCcw :size="13" /> 重绘
     </button>
     <button type="button" class="af-tool-btn" title="清空试笔画布" @click="clearScratchpad">
      <Eraser :size="13" /> 清空
     </button>
    </div>
   </div>
  </div>

  <!-- Quick Password Unlock Modal -->
  <Teleport to="body">
   <div
    v-if="unlockTargetRoom"
    class="entry-modal"
    @click.self="unlockTargetRoom = null"
    @keydown.esc="unlockTargetRoom = null"
   >
    <section class="entry-dialog entry-confirm-dialog" role="dialog" aria-modal="true" aria-label="输入房间密码">
     <div class="entry-dialog-header">
      <div>
       <h2>进入「{{ unlockTargetRoom.name }}」</h2>
       <p>房间 #{{ formatRoomCode(unlockTargetRoom.roomId) }} 设有访问密码，请输入后进入。</p>
      </div>
      <button type="button" class="entry-icon-button" aria-label="关闭" @click="unlockTargetRoom = null">
       <X :size="17" />
      </button>
     </div>
     <div class="entry-form">
      <label>
       <span>房间密码</span>
       <input
        ref="unlockPasswordRef"
        v-model="unlockPassword"
        type="password"
        placeholder="输入房间密码"
        @keyup.enter="submitUnlockRoom"
       />
      </label>
     </div>
     <button type="button" class="entry-button primary wide" :disabled="isUnlocking" @click="submitUnlockRoom">
      <Loader2 v-if="isUnlocking" class="entry-spin" :size="15" />
      <template v-else>验证并进入 <ArrowRight :size="15" /></template>
     </button>
    </section>
   </div>
  </Teleport>

  <RoomSettings
   v-if="settingsRoom"
   :room-id="settingsRoom.roomId"
   :room-name="settingsRoom.name"
   :role="settingsRoom.role"
   @close="settingsRoom = null"
   @changed="loadRooms"
   @exit="loadRooms"
  />
 </div>
</template>
