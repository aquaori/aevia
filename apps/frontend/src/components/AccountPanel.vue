<script setup lang="ts">
	import { nextTick, ref, watch } from "vue";
	import { X, UserRound, ChevronDown } from "lucide-vue-next";
	import "../entry.css";
	import { toast } from "vue-sonner";
	import { useAccountStore } from "../store/accountStore";
	import axios from "axios";

	const account = useAccountStore();
	const props = defineProps<{ inRoom?: boolean }>();
	const emit = defineEmits<{ authenticated: [] }>();
	const open = ref(false);
	const mode = ref<"login" | "register">("login");
	const username = ref("");
	const password = ref("");
	const nickname = ref("");
	const busy = ref(false);
	const dialogRef = ref<HTMLElement | null>(null);
	const triggerRef = ref<HTMLButtonElement | null>(null);
	watch(open, async (value) => { await nextTick(); if (value) dialogRef.value?.focus(); else triggerRef.value?.focus(); });

	async function submit() {
		busy.value = true;
		try {
			await account.authenticate(mode.value, username.value, password.value, nickname.value);
			password.value = "";
			open.value = false;
			emit("authenticated");
		} catch (error) {
			toast.error(axios.isAxiosError(error) ? error.response?.data?.msg || "无法连接到服务器" : "登录失败");
		} finally { busy.value = false; }
	}

	async function saveNickname() {
		try { await account.setNickname(nickname.value.trim()); open.value = false; }
		catch { toast.error("昵称保存失败"); }
	}

	async function logout() {
		try { await account.logout(); open.value = false; }
		catch { toast.error("退出失败，请重试"); }
	}
</script>

<template>
 <div class="entry-account-position" :class="{ 'in-room': props.inRoom }"><button ref="triggerRef" class="entry-account-trigger" @click="nickname = account.account?.nickname || ''; open = true"><span class="entry-avatar"><UserRound :size="16"/></span><span>{{ account.account?.nickname || '登录 / 注册' }}</span><ChevronDown :size="14"/></button></div>
 <Teleport to="body"><div v-if="open" class="entry-modal" @click.self="open = false" @keydown.esc="open = false"><section ref="dialogRef" tabindex="-1" class="entry-dialog entry-account-dialog" role="dialog" aria-modal="true" aria-label="账号">
  <div class="entry-dialog-header"><div><h2>{{ account.account ? '账号设置' : mode === 'login' ? '登录 Aevia' : '创建账号' }}</h2><p>{{ account.account ? '管理你的个人资料' : mode === 'login' ? '登录后管理你的房间' : '注册后即可创建和管理房间' }}</p></div><button class="entry-icon-button" aria-label="关闭" @click="open = false"><X :size="18"/></button></div>
  <template v-if="account.account"><div class="entry-profile-line"><span>登录用户名</span><strong>{{ account.account.username }}</strong></div><div class="entry-form"><label>昵称<input v-model="nickname" maxlength="40" /></label></div><button class="entry-button primary wide" @click="saveNickname">保存昵称</button><button class="entry-dialog-link" @click="logout">退出当前设备</button></template>
  <form v-else @submit.prevent="submit"><div class="entry-form"><label>用户名<input v-model="username" autocomplete="username" required /></label><label>密码<input v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" required /></label><label v-if="mode === 'register'">昵称 <span class="entry-optional">选填</span><input v-model="nickname" maxlength="40" /></label><p v-if="mode === 'register'" class="entry-form-hint">用户名至少 3 个字符，密码至少 8 个字符。</p></div><button :disabled="busy" class="entry-button primary wide">{{ busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录' }}</button><button type="button" class="entry-dialog-link" @click="mode = mode === 'login' ? 'register' : 'login'">{{ mode === 'login' ? '还没有账号？注册' : '已有账号？登录' }}</button></form>
 </section></div></Teleport>
</template>
