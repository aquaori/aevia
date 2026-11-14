<script setup lang="ts">
	import { ref, computed, nextTick, watch, onMounted } from "vue";
	import { useRouter } from "vue-router";
	import {
		ArrowRight,
		ArrowLeft,
		Loader2,
		RefreshCw,
		Lock,
		User,
		Type,
		Palette,
	} from "lucide-vue-next";
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
	const isCheckingId = ref(false);
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
			isCheckingId.value = true;
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
			isCheckingId.value = false;
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
	<div
		class="min-h-screen relative flex items-center justify-center p-4 bg-slate-50 overflow-hidden font-sans"
	>
		<AccountPanel />
		<RoomSettings v-if="settingsRoom" :room-id="settingsRoom.roomId" :room-name="settingsRoom.name" :role="settingsRoom.role" @close="settingsRoom = null" @changed="loadRooms" />
		<!-- 动画背景斑点 -->
		<div class="fixed inset-0 overflow-hidden pointer-events-none">
			<div
				class="blob absolute -top-[10%] -left-[10%] w-[50vh] h-[50vh] rounded-full mix-blend-multiply filter blur-[80px] opacity-70 bg-purple-300"
			></div>
			<div
				class="blob absolute top-[10%] -right-[10%] w-[60vh] h-[60vh] rounded-full mix-blend-multiply filter blur-[80px] opacity-70 bg-yellow-200"
				style="animation-delay: 2s"
			></div>
			<div
				class="blob absolute -bottom-[20%] left-[20%] w-[50vh] h-[50vh] rounded-full mix-blend-multiply filter blur-[80px] opacity-70 bg-pink-300"
				style="animation-delay: 4s"
			></div>
		</div>

		<!-- 主卡片容器 -->
		<div class="relative z-10 w-full max-w-[460px] perspective-1000">
			<div
				ref="containerRef"
				class="bg-white/80 backdrop-blur-2xl rounded-4xl shadow-2xl shadow-indigo-500/10 border border-white overflow-hidden transition-all duration-500 will-change-transform hover:shadow-indigo-500/20"
				style="min-height: 540px"
			>
				<!-- 顶部装饰线 -->
				<div
					class="h-1.5 w-full bg-linear-to-r from-indigo-500 via-purple-500 to-pink-500"
				></div>

				<div class="p-8 sm:p-10 h-full flex flex-col">
					<!-- 头部区域 -->
					<div class="text-center mb-8">
						<div
							class="inline-flex items-center justify-center p-3 mb-4 rounded-2xl bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-100"
						>
							<Palette class="w-6 h-6" />
						</div>
						<h1
							class="text-2xl sm:text-3xl font-black text-slate-800 tracking-tight mb-2"
						>
							协同画板
						</h1>
						<p class="text-slate-500 text-sm sm:text-base font-medium">
							即时灵感，无缝协作
						</p>
					</div>

					<div v-if="accountStore.account && transfers.length && step === 1" class="mb-5 space-y-2">
						<div v-for="transfer in transfers" :key="transfer.roomId" class="rounded-xl bg-indigo-50 p-3 text-sm text-slate-700">
							<p>{{ transfer.ownerNickname }} 邀请你接任「{{ transfer.roomName }}」的房主</p>
							<div class="mt-2 flex gap-4 text-indigo-600"><button @click="respondTransfer(transfer.roomId, true)">接受</button><button @click="respondTransfer(transfer.roomId, false)">拒绝</button></div>
						</div>
					</div>
					<div v-if="accountStore.account && rooms.length && step === 1" class="mb-6">
						<h2 class="mb-2 text-sm font-bold text-slate-700">我的房间</h2>
						<div class="max-h-40 space-y-2 overflow-y-auto">
							<div v-for="room in rooms" :key="room.roomId" class="flex items-center rounded-xl bg-slate-50 hover:bg-indigo-50">
								<button class="flex flex-1 items-center justify-between px-4 py-3 text-left" @click="enterSavedRoom(room)"><span class="font-medium text-slate-700">{{ room.name }}</span><span class="text-xs text-slate-400">{{ room.roomId }} →</span></button>
								<button class="px-3 text-xs text-indigo-600" @click="settingsRoom = room">设置</button>
							</div>
						</div>
					</div>

					<!-- 步骤视图 -->
					<!-- 移除了 'out-in' 模式，以便在使用绝对定位时允许叠加，实现更平滑的高度过渡 -->
					<!-- 但用户不喜欢叠加。所以我将使用 Grid 技巧保留空间 -->

					<div class="relative overflow-hidden w-full flex-1">
						<transition
							enter-active-class="transition-all duration-500 ease-in-out"
							enter-from-class="opacity-0 translate-x-10"
							enter-to-class="opacity-100 translate-x-0"
							leave-active-class="transition-all duration-500 ease-in-out absolute w-full top-0 left-0"
							leave-from-class="opacity-100 translate-x-0"
							leave-to-class="opacity-0 -translate-x-10"
						>
							<!-- 第一步 -->
							<div v-if="step === 1" key="step1" class="w-full">
								<!-- 切换开关 -->
								<div
									class="bg-slate-100/80 p-1.5 rounded-2xl flex mb-8 relative border border-slate-200/50"
								>
									<div
										class="absolute top-1.5 bottom-1.5 w-[calc(50%-6px)] bg-white rounded-xl shadow-sm transition-all duration-300 ease-in-out"
										:class="mode === 'join' ? 'left-1.5' : 'left-[50%]'"
									></div>
									<button
										v-for="m in ['join', 'create']"
										:key="m"
										@click="setMode(m as Mode)"
										class="flex-1 relative z-10 py-2.5 text-sm font-bold transition-colors duration-300 text-center"
										:class="
											mode === m
												? 'text-slate-800'
												: 'text-slate-400 hover:text-slate-600'
										"
									>
										{{ m === "join" ? "加入房间" : "创建房间" }}
									</button>
								</div>

								<!-- OTP 输入区域 -->
								<div class="flex-col justify-center mb-4">
									<div class="flex justify-between items-center mb-5 px-1">
										<span
											class="text-xs font-bold text-slate-400 uppercase tracking-widest"
										>
											{{
												mode === "join"
													? "请输入房间号"
													: isRandomId
														? "自动生成"
														: "自定义"
											}}
										</span>
										<button
											v-if="mode === 'create'"
											@click="
												() => {
													isRandomId = !isRandomId;
													roomCheckStatus = 'idle';
												}
											"
											class="text-xs font-bold text-indigo-500 hover:text-indigo-600 flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-indigo-50 transition-colors"
										>
											<RefreshCw class="w-3.5 h-3.5" />
											{{ isRandomId ? "切换手动" : "切换随机" }}
										</button>
									</div>

									<div class="grid grid-cols-6 gap-2 sm:gap-3 relative">
										<input
											v-for="(digit, index) in 6"
											:key="index"
											ref="otpInputRefs"
											type="text"
											inputmode="numeric"
											maxlength="1"
											:value="otpDigits[index]"
											@input="(e) => handleOtpInput(index, e)"
											@keydown="(e) => handleOtpKeyDown(index, e)"
											@paste="handlePaste"
											@blur="checkRoomUnique"
											:disabled="mode === 'create' && isRandomId"
											class="w-full aspect-3/4 sm:aspect-4/5 bg-slate-50 border-2 rounded-xl text-center text-xl sm:text-2xl font-bold text-slate-800 caret-indigo-500 shadow-sm transition-all focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:shadow-lg focus:shadow-indigo-500/10 outline-none disabled:opacity-50 disabled:bg-slate-100 disabled:cursor-not-allowed"
											:class="
												otpDigits[index]
													? 'border-indigo-500/50 bg-white'
													: 'border-slate-200'
											"
										/>
									</div>

									<!-- 验证消息 -->
									<div v-if="mode === 'create'" class="h-6 mt-2 flex justify-end">
										<div
											v-if="roomCheckStatus === 'checking'"
											class="flex items-center text-xs font-medium text-indigo-500 animate-pulse"
										>
											<Loader2 class="w-3 h-3 animate-spin mr-1.5" />
											<span>验证中...</span>
										</div>
										<div
											v-else-if="roomCheckStatus === 'valid'"
											class="flex items-center text-xs font-bold text-green-600"
										>
											<span>√ 房间号可用</span>
										</div>
										<div
											v-else-if="roomCheckStatus === 'invalid'"
											class="flex items-center text-xs font-bold text-red-500"
										>
											<span>× 房间号已存在</span>
										</div>
									</div>
								</div>

								<!-- 主操作按钮 -->
								<button
									@click="nextStep"
									:disabled="!isFormComplete || isLoading"
									class="group w-full py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-lg shadow-xl shadow-slate-900/10 hover:shadow-slate-900/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 flex items-center justify-center gap-2 mt-auto"
								>
									<span v-if="isLoading" class="flex items-center gap-2">
										<Loader2 class="w-5 h-5 animate-spin" />
										<span>请稍候</span>
									</span>
									<span v-else class="flex items-center gap-2">
										<span>下一步</span>
										<ArrowRight
											class="w-5 h-5 group-hover:translate-x-1 transition-transform"
										/>
									</span>
								</button>
							</div>

							<!-- 第二步 -->
							<div v-else-if="step === 2" key="step2" class="w-full">
								<div class="flex items-center mb-8">
									<button
										@click="prevStep"
										class="p-2 -ml-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
									>
										<ArrowLeft class="w-6 h-6" />
									</button>
									<h2 class="text-xl font-bold text-slate-800 ml-2">
										{{ mode === "join" ? "完善加入信息" : "设置房间详情" }}
									</h2>
								</div>

								<div class="space-y-6 flex-1 mb-8">
									<!-- 用户名 -->
									<div class="group">
										<label
											class="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 ml-1"
											>你的名字</label
										>
										<div
											class="relative transition-all duration-300 focus-within:transform focus-within:-translate-y-1"
										>
											<div
												class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors"
											>
												<User class="w-5 h-5" />
											</div>
											<input
												v-model="username"
												type="text"
												placeholder="怎么称呼你？"
												class="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all font-medium text-slate-800 placeholder:text-slate-400"
											/>
										</div>
									</div>

									<!-- 房间名称 (仅创建) -->
									<div v-if="mode === 'create'" class="group">
										<label
											class="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 ml-1"
											>房间名称</label
										>
										<div
											class="relative transition-all duration-300 focus-within:transform focus-within:-translate-y-1"
										>
											<div
												class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors"
											>
												<Type class="w-5 h-5" />
											</div>
											<input
												v-model="roomName"
												type="text"
												placeholder="给房间起个有意思的名字"
												class="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all font-medium text-slate-800 placeholder:text-slate-400"
											/>
										</div>
									</div>

									<!-- 密码 -->
									<div class="group">
										<label
											class="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 ml-1"
										>
											{{
												mode === "create"
													? "房间密码 (选填)"
													: "房间密码 (如有)"
											}}
										</label>
										<div
											class="relative transition-all duration-300 focus-within:transform focus-within:-translate-y-1"
										>
											<div
												class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors"
											>
												<Lock class="w-5 h-5" />
											</div>
											<input
												v-model="password"
												type="password"
												placeholder=""
												class="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all font-medium text-slate-800 placeholder:text-slate-400"
											/>
										</div>
									</div>
								</div>
								<button
									@click="submit"
									:disabled="!isFormComplete"
									class="group w-full py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-lg shadow-xl shadow-slate-900/10 hover:shadow-slate-900/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 flex items-center justify-center gap-2 mt-auto"
								>
									<span class="flex items-center gap-2">
										<span>{{ mode === "join" ? "立即加入" : "创建房间" }}</span>
										<ArrowRight
											class="w-5 h-5 group-hover:translate-x-1 transition-transform"
										/>
									</span>
								</button>
							</div>
						</transition>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style>
	/* 全局动画定义 */
	@keyframes blob {
		0% {
			transform: translate(0px, 0px) scale(1);
		}
		33% {
			transform: translate(30px, -50px) scale(1.1);
		}
		66% {
			transform: translate(-20px, 20px) scale(0.9);
		}
		100% {
			transform: translate(0px, 0px) scale(1);
		}
	}

	.blob {
		animation: blob 10s infinite cubic-bezier(0.4, 0, 0.2, 1);
		will-change: transform;
		opacity: 0.6;
	}

	.perspective-1000 {
		perspective: 1000px;
	}
</style>
