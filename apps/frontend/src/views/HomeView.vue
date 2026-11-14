<script setup lang="ts">
	import { ref, computed, nextTick, watch, onMounted } from "vue";
	import { useRouter } from "vue-router";
	import { ArrowRight, ArrowLeft, Loader2, RefreshCw, LogIn, LayoutGrid, Settings2, Palette, FileText, ChevronRight } from "lucide-vue-next";
	import "../entry.css";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { useUserStore } from "../store/userStore";
	import { apiUrl } from "../config/endpoints";
	import AccountPanel from "../components/AccountPanel.vue";
	import RoomSettings from "../components/RoomSettings.vue";
	import { useAccountStore } from "../store/accountStore";

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

	// --- 状态 ---
	type Mode = "join" | "create";
	const mode = ref<Mode>("join");
	const step = ref(1);
	const isLoading = ref(false);

	const roomCheckStatus = ref<"idle" | "checking" | "valid" | "invalid">("idle"); // 验证状态

	// 表单数据
	const otpDigits = ref<string[]>(["", "", "", "", "", ""]);
	const username = ref(localStorage.getItem("wb_username") || "");
	const roomName = ref("");
	const password = ref("");
	const isRandomId = ref(true);

	// Refs
	const otpInputRefs = ref<HTMLInputElement[]>([]);

	// --- Computed ---
	const roomId = computed(() => otpDigits.value.join(""));
	const isFormComplete = computed(() => {
		if (step.value === 1) {
			return roomId.value.length === 6;
		}
		// 第二步验证
		if (mode.value === "join") return !!username.value;
		if (mode.value === "create") return !!username.value && !!roomName.value;
		return false;
	});

	// --- Methods ---

	// 生成随机 ID
	const getRandomId = () => {
		axios
			.get(apiUrl("/generate-room-id"))
			.then((res) => {
				try {
					otpDigits.value = res.data.data.roomId.split("");
				} catch (err) {
					console.error("Failed to parse room ID:", err);
					toast.error("ID 生成失败，请刷新页面或稍后重试。");
					return;
				}
			})
			.catch((err) => {
				toast.error(err.response?.data?.msg || "ID 生成失败，请检查网络设置。");
			});
	};

	// OTP 输入逻辑
	const handleOtpInput = (index: number, event: Event) => {
		const input = event.target as HTMLInputElement;
		const val = input.value;

		// 仅允许输入数字
		if (!/^\d*$/.test(val)) {
			otpDigits.value[index] = "";
			return;
		}

		otpDigits.value[index] = val.slice(-1); // 保留最后一个字符

		if (val && index < 5) {
			otpInputRefs.value[index + 1]?.focus();
		}
	};

	const handleOtpKeyDown = (index: number, event: KeyboardEvent) => {
		if (event.key === "Backspace" && !otpDigits.value[index] && index > 0) {
			otpInputRefs.value[index - 1]?.focus();
		}
	};

	const handlePaste = (event: ClipboardEvent) => {
		event.preventDefault();
		const pastedData = event.clipboardData?.getData("text");
		if (!pastedData || !/^\d{6}$/.test(pastedData)) return;

		otpDigits.value = pastedData.split("");
		otpInputRefs.value[5]?.focus();
	};

	// 模拟验证
	const checkRoomUnique = async () => {
		if (roomId.value.length === 6) {

			roomCheckStatus.value = "checking";
			try {
				const res = await axios.get(apiUrl(`/check-room?roomId=${roomId.value}`));
				if (res.data.data.status == true) {
					roomCheckStatus.value = "invalid";
					if (mode.value === "create") {
						otpDigits.value = ["", "", "", "", "", ""];
						nextTick(() => otpInputRefs.value[0]?.focus());
					}
				} else {
					roomCheckStatus.value = "valid";
				}
			} catch (err: unknown) {
				const responseError = err as ResponseError;
				roomCheckStatus.value = "idle";
				toast.error(responseError.response?.data?.msg || "无法连接到服务器，请检查网络设置。");
			}

		} else {
			roomCheckStatus.value = "idle";
		}
	};

	// 导航
	const nextStep = async () => {
		if (step.value === 1) {
			if (roomId.value.length !== 6) return;
			isLoading.value = true;
			try {
				if (mode.value === "create") {
					await checkRoomUnique();
					if (roomCheckStatus.value === "valid") {
						step.value = 2;
					} else if (roomCheckStatus.value === "invalid") {
						toast.error("房间已存在！");
					}
				} else {
					// 模拟检查
					await new Promise((resolve, reject) => {
						axios
							.get(apiUrl(`/check-room?roomId=${roomId.value}`))
							.then((res) => {
								if (res.data.data.status == true) {
									step.value = 2;
									resolve(true);
								} else {
									toast.error("房间不存在！");
									reject(new Error("房间不存在"));
								}
							})
							.catch((err) => reject(err));
					});
				}
			} finally {
				isLoading.value = false;
			}
		} else {
			await submit();
		}
	};

	const prevStep = () => {
		step.value = 1;
	};

	const setMode = (m: Mode) => {
		mode.value = m;
		otpDigits.value = ["", "", "", "", "", ""];
		if (m === "create" && isRandomId.value) {
			getRandomId();
		}
		step.value = 1;
	};

	// 监听是否使用随机 ID
	watch(isRandomId, (newVal) => {
		if (mode.value === "create") {
			if (newVal) {
				getRandomId();
			} else {
				otpDigits.value = ["", "", "", "", "", ""];
				nextTick(() => otpInputRefs.value[0]?.focus());
			}
		}
	});

	type AccountRoom = { roomId: string; name: string; role: string; passwordRequired: boolean };
	const rooms = ref<AccountRoom[]>([]);
	const transfers = ref<{ roomId: string; roomName: string; ownerNickname: string }[]>([]);
	const settingsRoom = ref<AccountRoom | null>(null);
	const loadRooms = async () => {
		if (!accountStore.token) { rooms.value = []; transfers.value = []; return; }
		try {
			rooms.value = (await axios.get(apiUrl("/v2/rooms"), { headers: accountStore.headers() })).data.data;
			transfers.value = (await axios.get(apiUrl("/v2/transfers"), { headers: accountStore.headers() })).data.data;
		}
		catch { rooms.value = []; }
	};
	const respondTransfer = async (roomId: string, accept: boolean) => {
		try { await axios.post(apiUrl(`/v2/rooms/${roomId}/transfer/respond`), { accept }, { headers: accountStore.headers() }); await loadRooms(); }
		catch { toast.error("处理转让请求失败"); }
	};
	watch(() => accountStore.account, (value) => {
		if (value) username.value = value.nickname;
		else if (mode.value === "create") setMode("join");
		void loadRooms();
	}, { immediate: true });

	const submit = async () => {
		isLoading.value = true;
		try {
			if (mode.value === "create") {
				if (!accountStore.token) { toast.error("请先登录后创建房间"); return; }
				await axios.post(apiUrl("/v2/rooms"), { roomId: roomId.value, roomName: roomName.value, password: password.value }, { headers: accountStore.headers() });
			}
			localStorage.setItem("wb_username", username.value);
			const response = await axios.post(apiUrl("/join-room"), {
				roomId: roomId.value, userName: username.value, password: password.value,
			}, { headers: accountStore.token ? accountStore.headers() : {} });
			applySessionAuth(response.data.data);
			await router.push({ name: "room" });
		} catch (error) {
			const responseError = error as ResponseError;
			toast.error(responseError.response?.data?.msg || "无法连接到服务器，请检查网络设置。");
		} finally { isLoading.value = false; }
	};

	const enterSavedRoom = (room: AccountRoom) => {
		mode.value = "join";
		otpDigits.value = room.roomId.split("");
		password.value = "";
		step.value = 2;
	};

	onMounted(() => {
		void accountStore.refresh();
		if (userStore.token) {
			userStore.clearAll();
		}
	});
</script>

<template>
 <div class="entry-app">
  <header class="entry-topbar"><div class="entry-brand"><span class="entry-brand-icon"><Palette :size="19" /></span><strong>Aevia</strong><span class="entry-brand-separator"></span><span class="entry-brand-sub">协作白板</span></div><AccountPanel /></header>
  <div class="entry-layout">
   <main class="entry-main" :class="{ 'entry-guest-main': !accountStore.account }">
    <div v-if="accountStore.account" class="entry-heading"><div><h1>我的房间</h1><p>在这里管理和进入你的协作空间。</p></div></div>
    <div v-if="transfers.length" class="entry-notices"><div v-for="transfer in transfers" :key="transfer.roomId" class="entry-notice"><span>{{ transfer.ownerNickname }} 邀请你接任「{{ transfer.roomName }}」的房主</span><div><button @click="respondTransfer(transfer.roomId, true)">接受</button><button @click="respondTransfer(transfer.roomId, false)">拒绝</button></div></div></div>
    <div class="entry-grid" :class="{ 'entry-guest-grid': !accountStore.account }">
     <section v-if="accountStore.account" class="entry-room-section"><div class="entry-section-heading"><div><h2>房间列表</h2><span>共 {{ rooms.length }} 个房间</span></div></div>
      <div v-if="!rooms.length" class="entry-empty"><div class="entry-empty-icon"><LayoutGrid :size="21"/></div><strong>还没有房间</strong><p>创建房间，或通过房间号加入。</p></div>
      <div v-else class="entry-room-list"><div v-for="room in rooms" :key="room.roomId" class="entry-room-row"><button class="entry-room-link" @click="enterSavedRoom(room)"><span class="entry-room-icon"><FileText :size="19"/></span><span class="entry-room-meta"><strong>{{ room.name }}</strong><small>房间号 {{ room.roomId }}</small></span><span class="entry-role">{{ room.role === 'owner' ? '我创建的' : room.role === 'viewer' ? '只读' : '我加入的' }}</span><ChevronRight :size="16" class="entry-room-arrow"/></button><button class="entry-icon-button" :aria-label="`设置${room.name}`" title="房间设置" @click="settingsRoom = room"><Settings2 :size="17"/></button></div></div>
     </section>
     <section class="entry-action-card" :class="{ 'entry-guest-card': !accountStore.account }">
      <div v-if="!accountStore.account" class="entry-guest-intro"><div class="entry-guest-icon"><LogIn :size="21"/></div><div><span class="entry-guest-tag">游客访问</span><h1>加入协作房间</h1><p>无需创建账号，可使用房间号加入。</p></div><p class="entry-guest-note">能否以游客身份加入由房主设置；游客房间不会保存在房间列表中。</p></div>
      <div class="entry-action-content"><div v-if="accountStore.account" class="entry-tabs"><button :class="{ selected: mode === 'join' }" @click="setMode('join')">加入房间</button><button :class="{ selected: mode === 'create' }" @click="setMode('create')">创建房间</button></div>
      <template v-if="step === 1"><div class="entry-action-heading"><h2>{{ accountStore.account ? (mode === 'join' ? '加入协作房间' : '创建新的房间') : '输入房间号' }}</h2><p>{{ accountStore.account ? (mode === 'join' ? '输入房间号，与你的伙伴一起协作。' : '设置房间号后，填写房间信息。') : '请输入房主分享的 6 位房间号。' }}</p></div><div class="entry-label-row"><label>房间号</label><button v-if="mode === 'create'" class="entry-text-button" @click="isRandomId = !isRandomId; roomCheckStatus = 'idle'"><RefreshCw :size="13"/>{{ isRandomId ? '自定义房间号' : '随机生成' }}</button></div><div class="entry-digits"><input v-for="(_, index) in 6" :key="index" ref="otpInputRefs" type="text" inputmode="numeric" maxlength="1" :aria-label="`房间号第 ${index + 1} 位`" :value="otpDigits[index]" :disabled="mode === 'create' && isRandomId" @input="handleOtpInput(index, $event)" @keydown="handleOtpKeyDown(index, $event)" @paste="handlePaste" @blur="checkRoomUnique" /></div><p class="entry-help">{{ mode === 'create' && roomCheckStatus === 'valid' ? '房间号可用' : mode === 'create' && roomCheckStatus === 'invalid' ? '房间号已存在' : mode === 'create' && isRandomId ? '已为你生成房间号' : '支持粘贴完整的 6 位房间号' }}</p><button class="entry-button primary wide" :disabled="!isFormComplete || isLoading" @click="nextStep"><Loader2 v-if="isLoading" class="entry-spin" :size="16"/><template v-else>下一步 <ArrowRight :size="16"/></template></button></template>
      <template v-else><div class="entry-back-row"><button class="entry-icon-button" aria-label="返回" @click="prevStep"><ArrowLeft :size="18"/></button><div><h2>{{ mode === 'join' ? '加入房间' : '房间信息' }}</h2><p>房间号 {{ roomId }}</p></div></div><div class="entry-form"><label>你的名字<input v-model="username" :disabled="!!accountStore.account" placeholder="输入名字" /></label><label v-if="mode === 'create'">房间名称<input v-model="roomName" placeholder="输入房间名称" /></label><label>房间密码 <span class="entry-optional">{{ mode === 'create' ? '选填' : '如有' }}</span><input v-model="password" type="password" placeholder="输入房间密码" @keyup.enter="submit" /></label></div><button class="entry-button primary wide" :disabled="!isFormComplete || isLoading" @click="submit"><Loader2 v-if="isLoading" class="entry-spin" :size="16"/><template v-else>{{ mode === 'join' ? '进入房间' : '创建并进入' }} <ArrowRight :size="16"/></template></button></template>
      </div>
     </section>
    </div>
   </main>
  </div>
  <RoomSettings v-if="settingsRoom" :room-id="settingsRoom.roomId" :room-name="settingsRoom.name" :role="settingsRoom.role" @close="settingsRoom = null" @changed="loadRooms" @exit="loadRooms" />
 </div>
</template>
