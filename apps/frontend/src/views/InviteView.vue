<script setup lang="ts">
	import { ref, onMounted } from "vue";
	import { useRoute, useRouter } from "vue-router";
	import { ArrowRight, Loader2, Palette, Users } from "lucide-vue-next";
	import "../entry.css";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { useUserStore } from "../store/userStore";
	import { useAccountStore } from "../store/accountStore";
	import { getInviteMeta } from "../service/sessionApi";
	import { apiUrl } from "../config/endpoints";

	const userStore = useUserStore();
	const accountStore = useAccountStore();
	const route = useRoute();
	const router = useRouter();

	const token = route.params.token as string;
	const scrubInviteTokenFromUrl = () => {
		if (typeof window === "undefined") return;
		window.history.replaceState(window.history.state, "", "/invite/redacted");
	};
	type ResponseError = {
		response?: {
			data?: {
				msg?: string;
			};
		};
	};
	const roomId = ref("");
	const roomName = ref("");
	const username = ref(accountStore.account?.nickname || localStorage.getItem("wb_username") || "");
	const password = ref("");
	const isLoading = ref(false);
	const passwordRequired = ref(false);

	const inviteError = ref(false);

	onMounted(() => {
		userStore.clearAll();
		scrubInviteTokenFromUrl();
		getInviteMeta(token)
			.then((meta) => {
				roomId.value = meta.roomId;
				roomName.value = meta.roomName;
				passwordRequired.value = meta.passwordRequired;
			})
			.catch((err) => {
				inviteError.value = true;
				console.error("Error fetching room info: ", err.response?.data?.msg || "未知错误");
			});
	});

	const joinRoom = async () => {
		if (!username.value) return;

		isLoading.value = true;

		try {
			await axios
				.post(apiUrl("/join-room"), {
					roomId: roomId.value,
					userName: username.value,
					password: password.value,
					inviteToken: token,
				}, { headers: accountStore.token ? accountStore.headers() : {} })
				.then((res) => {
					if (res.data.code === 200) {
						localStorage.setItem("wb_username", username.value);
						userStore.setToken(res.data.data.sessionToken || res.data.data.token);
						userStore.setSessionExpiresAt(res.data.data.expiresAt ?? null);
						userStore.setRoomRole(res.data.data.role || "editor");
						router.push({ name: "room" });
					} else {
						console.error("Error joining room: ", res.data.msg || "未知错误");
					}
				});
		} catch (err: unknown) {
			const responseError = err as ResponseError;
			if (responseError.response?.data?.msg === "Password incorrect") {
				toast.error("密码错误");
			} else if (responseError.response?.data?.msg === "Room does not exist") {
				toast.error("房间不存在");
			}
			console.error("Error joining room: ", responseError.response?.data?.msg || "未知错误");
			return;
		} finally {
			isLoading.value = false;
		}
	};
</script>

<template>
 <div class="entry-app"><header class="entry-topbar"><div class="entry-brand"><span class="entry-brand-icon"><Palette :size="19"/></span><strong>Aevia</strong><span class="entry-brand-separator"></span><span class="entry-brand-sub">协作白板</span></div></header>
  <main class="entry-invite-wrap"><a href="/" class="entry-back-link">← 返回首页</a><section class="entry-invite-card"><div class="entry-invite-icon"><Users :size="21"/></div><h1>加入协作房间</h1><p class="entry-invite-lead">{{ inviteError ? '邀请链接无效或已过期' : '你收到了一条房间邀请' }}</p><div v-if="!inviteError" class="entry-invite-room"><strong>{{ roomName || '正在加载房间…' }}</strong><span>房间号 {{ roomId || '—' }}</span></div><div v-if="!inviteError" class="entry-form"><label>你的名字<input v-model="username" :disabled="!!accountStore.account" placeholder="输入名字" @keyup.enter="joinRoom" /></label><label>房间密码 <span class="entry-optional">{{ passwordRequired ? '必填' : '如有' }}</span><input v-model="password" type="password" placeholder="输入房间密码" @keyup.enter="joinRoom" /></label></div><button v-if="!inviteError" class="entry-button primary wide" :disabled="!roomId || !username || isLoading" @click="joinRoom"><Loader2 v-if="isLoading" class="entry-spin" :size="16"/><template v-else>进入房间 <ArrowRight :size="16"/></template></button><a v-else class="entry-button secondary wide" href="/">返回首页</a></section></main>
 </div>
</template>
