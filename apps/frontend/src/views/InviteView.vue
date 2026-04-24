<script setup lang="ts">
	import { ref, onMounted } from "vue";
	import { useRoute, useRouter } from "vue-router";
	import { User, Lock, ArrowRight, Loader2, Sparkles } from "lucide-vue-next";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { useUserStore } from "../store/userStore";

	const userStore = useUserStore();
	const route = useRoute();
	const router = useRouter();

	const token = route.params.token as string;
	const roomId = ref("");
	const roomName = ref("");
	const username = ref(localStorage.getItem("wb_username") || "");
	const password = ref("");
	const isLoading = ref(false);

	const mockRoomName = ref(roomName); // Mock data

	onMounted(() => {
		userStore.clearAll();
		axios
			.get(
				`${import.meta.env.VITE_API_URL || "http://127.0.0.1:4646"}/get-token-info?token=${token}`
			)
			.then((res) => {
				if (res.data.code === 200) {
					roomId.value = res.data.data.roomId;
					roomName.value = res.data.data.roomName;
				}
			})
			.catch((err) => {
				console.error("Error fetching room info: ", err.response?.data?.msg || "未知错误");
			});
	});

	const joinRoom = async () => {
		if (!username.value) return;

		isLoading.value = true;

		try {
			await axios
				.post(`${import.meta.env.VITE_API_URL || "http://127.0.0.1:4646"}/join-room`, {
					roomId: roomId.value,
					userName: username.value,
					password: password.value,
				})
				.then((res) => {
					if (res.data.code === 200) {
						localStorage.setItem("wb_username", username.value);
						userStore.setToken(res.data.data.token);
						router.push({ name: "room" });
					} else {
						console.error("Error joining room: ", res.data.msg || "未知错误");
					}
				});
		} catch (err: any) {
			if (err.response?.data?.msg === "Password incorrect") {
				toast.error("密码错误");
			} else if (err.response?.data?.msg === "Room does not exist") {
				toast.error("房间不存在");
			}
			console.error("Error joining room: ", err.response?.data?.msg || "未知错误");
			return;
		} finally {
			isLoading.value = false;
		}
	};
</script>

<template>
	<div
		class="min-h-screen relative flex items-center justify-center p-4 bg-slate-50 overflow-hidden font-sans"
	>
		<!-- Animated Background (Simplified from HomeView) -->
		<div class="fixed inset-0 overflow-hidden pointer-events-none">
			<div
				class="absolute -top-[10%] -left-[10%] w-[50vh] h-[50vh] rounded-full mix-blend-multiply filter blur-[80px] opacity-70 bg-purple-300 animate-blob"
			></div>
			<div
				class="absolute bottom-[10%] right-[10%] w-[60vh] h-[60vh] rounded-full mix-blend-multiply filter blur-[80px] opacity-70 bg-indigo-200 animate-blob"
				style="animation-delay: 2s"
			></div>
		</div>

		<!-- Card -->
		<div class="relative z-10 w-full max-w-[420px]">
			<div
				class="bg-white/80 backdrop-blur-2xl rounded-4xl shadow-2xl shadow-indigo-500/10 border border-white overflow-hidden"
			>
				<!-- Header Decoration -->
				<div
					class="h-1.5 w-full bg-linear-to-r from-indigo-500 via-purple-500 to-pink-500"
				></div>

				<div class="p-8 sm:p-10">
					<div class="text-center mb-8">
						<div
							class="inline-flex items-center justify-center p-3 mb-4 rounded-2xl bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-100"
						>
							<Sparkles class="w-6 h-6" />
						</div>
						<h1 class="text-2xl font-black text-slate-800 tracking-tight mb-2">
							邀请你加入
						</h1>
						<p
							class="text-lg font-bold text-transparent bg-clip-text bg-linear-to-r from-indigo-600 to-purple-600"
						>
							{{ mockRoomName }}
						</p>
						<p class="text-slate-400 text-sm mt-1 font-mono">ID: {{ roomId }}</p>
					</div>

					<div class="space-y-5">
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
									@keyup.enter="joinRoom"
									class="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all font-medium text-slate-800 placeholder:text-slate-400"
								/>
							</div>
						</div>

						<div class="group">
							<label
								class="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 ml-1"
								>房间密码 (如有)</label
							>
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
									placeholder="••••••"
									@keyup.enter="joinRoom"
									class="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all font-medium text-slate-800 placeholder:text-slate-400"
								/>
							</div>
						</div>

						<button
							@click="joinRoom"
							:disabled="!username || isLoading"
							class="w-full py-4 bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white rounded-2xl font-bold text-lg shadow-xl shadow-indigo-500/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 flex items-center justify-center gap-2 mt-2"
						>
							<span v-if="isLoading">
								<Loader2 class="w-5 h-5 animate-spin" />
							</span>
							<span v-else class="flex items-center gap-2">
								立即加入 <ArrowRight class="w-5 h-5" />
							</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style>
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

	.animate-blob {
		animation: blob 10s infinite cubic-bezier(0.4, 0, 0.2, 1);
	}
</style>
