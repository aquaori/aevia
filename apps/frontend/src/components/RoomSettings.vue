<script setup lang="ts">
	import { onMounted, ref } from "vue";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { apiUrl } from "../config/endpoints";
	import { useAccountStore } from "../store/accountStore";

	const props = defineProps<{ roomId: string; roomName: string; role: string }>();
	const emit = defineEmits<{ close: []; changed: [] }>();
	const account = useAccountStore();
	const name = ref(props.roomName);
	const password = ref("");
	const setPassword = ref(false);
	const requirePassword = ref(false);
	const policy = ref({ defaultRole: "editor", allowRoomCode: true, guestByCode: true, guestByInvite: true });
	const savedDefaultRole = ref("editor");
	const members = ref<{ userId: string; nickname: string; username: string; role: string; banned: boolean }[]>([]);
	const base = `/v2/rooms/${props.roomId}`;
	const options = () => ({ headers: account.headers() });

	async function load() {
		try {
			members.value = (await axios.get(apiUrl(`${base}/members`), options())).data.data;
			if (props.role === "owner") {
				const data = (await axios.get(apiUrl(`${base}/settings`), options())).data.data;
				name.value = data.name; policy.value = data.policy; savedDefaultRole.value = data.policy.defaultRole;
			}
		} catch { toast.error("无法读取房间信息"); }
	}
	async function save() {
		try {
			await axios.patch(apiUrl(`${base}/settings`), { name: name.value, password: password.value, setPassword: setPassword.value, requirePassword: requirePassword.value, policy: policy.value }, options());
			emit("changed"); emit("close");
		} catch { toast.error("保存失败，请重试"); }
	}
	async function memberAction(userId: string, action: string) {
		try {
			if (action === "editor" || action === "viewer") await axios.patch(apiUrl(`${base}/members/${userId}`), { role: action }, options());
			else await axios.post(apiUrl(`${base}/members/${userId}/${action}`), {}, options());
			await load();
		} catch { toast.error("操作失败，请重试"); }
	}
	async function leave() {
		if (!window.confirm("退出后，这个房间将从你的列表移除。确定退出吗？")) return;
		try { await axios.post(apiUrl(`${base}/leave`), {}, options()); emit("changed"); emit("close"); }
		catch { toast.error("退出失败，请重试"); }
	}
	async function transfer(userId: string, nickname: string) {
		const nextRole = savedDefaultRole.value === "editor" ? "编辑者" : "只读者";
		if (!window.confirm(`向 ${nickname} 发起房主转让？对方接受后，你将成为${nextRole}。`)) return;
		try { await axios.post(apiUrl(`${base}/transfer`), { userId }, options()); toast.success("转让请求已发送，等待对方确认"); }
		catch { toast.error("发起转让失败"); }
	}
	async function deleteRoom() {
		if (!window.confirm("确定永久删除房间及全部白板内容？此操作无法撤销。")) return;
		try { await axios.delete(apiUrl(base), options()); emit("changed"); emit("close"); }
		catch { toast.error("删除失败，请重试"); }
	}
	onMounted(load);
</script>

<template>
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" @click.self="emit('close')">
		<section class="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white bg-white/95 p-7 shadow-2xl backdrop-blur-xl">
			<div class="mb-5 flex justify-between"><h2 class="text-xl font-bold text-slate-800">房间设置</h2><button aria-label="关闭" class="text-slate-400" @click="emit('close')">✕</button></div>
			<div v-if="role === 'owner'" class="space-y-4 text-sm text-slate-600">
				<label class="block">房间名称<input v-model="name" class="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" /></label>
				<label class="flex gap-2"><input v-model="policy.allowRoomCode" type="checkbox" />允许通过房间号加入</label>
				<label class="flex gap-2"><input v-model="policy.guestByCode" type="checkbox" />允许游客通过房间号加入</label>
				<label class="flex gap-2"><input v-model="policy.guestByInvite" type="checkbox" />允许游客通过邀请链接加入</label>
				<label class="flex items-center justify-between">新成员默认角色<select v-model="policy.defaultRole" class="rounded-lg border border-slate-200 p-2"><option value="editor">编辑者</option><option value="viewer">只读者</option></select></label>
				<label class="flex gap-2"><input v-model="setPassword" type="checkbox" />修改房间密码</label>
				<template v-if="setPassword"><input v-model="password" type="password" placeholder="留空则移除密码" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" /><label class="flex gap-2"><input v-model="requirePassword" type="checkbox" />要求已有成员下次重新输入密码</label></template>
				<button class="w-full rounded-xl bg-indigo-600 py-2.5 font-semibold text-white" @click="save">保存设置</button>
			</div>
			<h3 class="mb-2 mt-6 font-bold text-slate-700">房间成员</h3>
			<div v-for="member in members" :key="member.userId" class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-3 text-sm">
				<div><span class="font-medium text-slate-700">{{ member.nickname }}</span><span class="ml-2 text-xs text-slate-400">{{ member.banned ? "已封禁" : member.role === "owner" ? "房主" : member.role === "viewer" ? "只读者" : "编辑者" }}</span></div>
				<div v-if="role === 'owner' && member.role !== 'owner'" class="flex gap-2 text-indigo-600">
					<button v-if="!member.banned" @click="memberAction(member.userId, member.role === 'viewer' ? 'editor' : 'viewer')">设为{{ member.role === "viewer" ? "编辑" : "只读" }}</button>
					<button v-if="!member.banned" @click="memberAction(member.userId, 'kick')">踢出</button>
					<button @click="memberAction(member.userId, member.banned ? 'unban' : 'ban')">{{ member.banned ? "解除封禁" : "封禁" }}</button>
					<button v-if="!member.banned" @click="transfer(member.userId, member.nickname)">转让房主</button>
				</div>
			</div>
			<button v-if="role !== 'owner'" class="mt-4 text-sm text-rose-600" @click="leave">退出房间</button>
			<button v-else class="mt-4 text-sm text-rose-600" @click="deleteRoom">永久删除房间</button>
		</section>
	</div>
</template>
