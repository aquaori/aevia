<script setup lang="ts">
	import { onMounted, ref } from "vue";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { apiUrl } from "../config/endpoints";
	const props = defineProps<{ roomId: string; token: string }>();
	const emit = defineEmits<{ close: [] }>();
	const hours = ref(24);
	const invites = ref<{ id: string; expiresAt: number; createdAt: number }[]>([]);
	const headers = () => ({ Authorization: `Bearer ${props.token}` });
	async function load() {
		try { invites.value = (await axios.get(apiUrl("/room-invites"), { headers: headers() })).data.data; }
		catch { toast.error("无法获取邀请列表"); }
	}
	async function create() {
		try {
			const data = (await axios.get(apiUrl(`/generate-share-token?roomId=${encodeURIComponent(props.roomId)}&hours=${hours.value}`), { headers: headers() })).data.data;
			await navigator.clipboard.writeText(`${window.location.origin}/invite/${data.inviteToken}`);
			toast.success("邀请链接已复制"); await load();
		} catch { toast.error("创建邀请失败"); }
	}
	async function revoke(id: string) {
		try { await axios.post(apiUrl("/room-invites/revoke"), { id }, { headers: headers() }); await load(); }
		catch { toast.error("撤销失败"); }
	}
	onMounted(load);
</script>

<template>
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" @click.self="emit('close')">
		<section class="w-full max-w-md rounded-3xl border border-white bg-white/95 p-7 shadow-2xl backdrop-blur-xl">
			<div class="mb-3 flex justify-between"><h2 class="text-xl font-bold text-slate-800">邀请协作</h2><button aria-label="关闭" class="text-slate-400" @click="emit('close')">✕</button></div>
			<p class="mb-4 text-sm text-slate-500">邀请链接可重复使用，加入时仍需遵守房间设置。</p>
			<div class="flex gap-2"><select v-model="hours" class="rounded-xl border border-slate-200 bg-slate-50 px-3"><option :value="1">1 小时</option><option :value="24">1 天</option><option :value="168">7 天</option><option :value="720">30 天</option></select><button class="flex-1 rounded-xl bg-indigo-600 py-3 font-bold text-white" @click="create">创建并复制链接</button></div>
			<h3 class="mb-2 mt-6 text-sm font-bold text-slate-700">有效的邀请</h3>
			<p v-if="!invites.length" class="text-sm text-slate-400">暂无有效邀请</p>
			<div v-for="invite in invites" :key="invite.id" class="flex justify-between border-t border-slate-100 py-3 text-sm"><span class="text-slate-500">{{ new Date(invite.expiresAt * 1000).toLocaleString() }} 到期</span><button class="text-rose-500" @click="revoke(invite.id)">撤销</button></div>
		</section>
	</div>
</template>
