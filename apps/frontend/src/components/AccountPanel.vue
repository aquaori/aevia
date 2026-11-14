<script setup lang="ts">
	import { ref } from "vue";
	import { toast } from "vue-sonner";
	import { useAccountStore } from "../store/accountStore";
	import axios from "axios";

	const account = useAccountStore();
	const open = ref(false);
	const mode = ref<"login" | "register">("login");
	const username = ref("");
	const password = ref("");
	const nickname = ref("");
	const busy = ref(false);

	async function submit() {
		busy.value = true;
		try {
			await account.authenticate(mode.value, username.value, password.value, nickname.value);
			password.value = "";
			open.value = false;
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
	<div class="absolute right-5 top-5 z-20">
		<button class="rounded-full bg-white/80 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm ring-1 ring-slate-200 hover:text-indigo-600" @click="nickname = account.account?.nickname || ''; open = true">
			{{ account.account?.nickname || "登录 / 注册" }}
		</button>
	</div>
	<div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" @click.self="open = false">
		<section class="w-full max-w-sm rounded-3xl border border-white bg-white/95 p-7 shadow-2xl backdrop-blur-xl" aria-label="账号">
			<div class="mb-5 flex items-center justify-between">
				<h2 class="text-xl font-bold text-slate-800">{{ account.account ? "账号设置" : mode === "login" ? "欢迎回来" : "创建账号" }}</h2>
				<button class="text-slate-400 hover:text-slate-700" aria-label="关闭" @click="open = false">✕</button>
			</div>
			<template v-if="account.account">
				<p class="mb-4 text-sm text-slate-500">登录用户名：{{ account.account.username }}</p>
				<label class="block text-sm font-medium text-slate-600">昵称<input v-model="nickname" class="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none focus:border-indigo-400" maxlength="40" /></label>
				<button class="mt-5 w-full rounded-xl bg-indigo-600 py-3 font-bold text-white hover:bg-indigo-700" @click="saveNickname">保存昵称</button>
				<button class="mt-3 w-full py-2 text-sm text-slate-500 hover:text-slate-800" @click="logout">退出当前设备</button>
			</template>
			<form v-else class="space-y-4" @submit.prevent="submit">
				<label class="block text-sm font-medium text-slate-600">用户名<input v-model="username" autocomplete="username" required class="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none focus:border-indigo-400" /></label>
				<label class="block text-sm font-medium text-slate-600">密码<input v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" required class="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none focus:border-indigo-400" /></label>
				<label v-if="mode === 'register'" class="block text-sm font-medium text-slate-600">昵称（选填）<input v-model="nickname" maxlength="40" class="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none focus:border-indigo-400" /></label>
				<p v-if="mode === 'register'" class="text-xs text-slate-400">用户名至少 3 个字符，密码至少 8 个字符。</p>
				<button :disabled="busy" class="w-full rounded-xl bg-indigo-600 py-3 font-bold text-white hover:bg-indigo-700 disabled:opacity-50">{{ busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录" }}</button>
				<button type="button" class="w-full text-sm text-indigo-600" @click="mode = mode === 'login' ? 'register' : 'login'">{{ mode === "login" ? "还没有账号？注册" : "已有账号？登录" }}</button>
			</form>
		</section>
	</div>
</template>
