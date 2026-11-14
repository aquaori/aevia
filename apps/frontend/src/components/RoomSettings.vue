<script setup lang="ts">
	import { nextTick, onMounted, ref, watch } from "vue";
	import { X, ShieldCheck, Users, AlertTriangle } from "lucide-vue-next";
	import "../entry.css";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { apiUrl } from "../config/endpoints";
	import { useAccountStore } from "../store/accountStore";

	const props = defineProps<{ roomId: string; roomName: string; role: string }>();
	const emit = defineEmits<{ close: []; changed: [name: string]; exit: [] }>();
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
	const confirmation = ref<{ title: string; message: string; action: string; run: () => Promise<void> } | null>(null);
	const confirmBusy = ref(false);
	const dialogRef = ref<HTMLElement | null>(null);
	const confirmationRef = ref<HTMLElement | null>(null);
	watch(confirmation, async (value) => { await nextTick(); if (value) confirmationRef.value?.focus(); else dialogRef.value?.focus(); });
	async function confirmAction() {
		const item = confirmation.value;
		if (!item) return;
		confirmBusy.value = true;
		try { await item.run(); confirmation.value = null; }
		finally { confirmBusy.value = false; }
	}

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
			emit("changed", name.value.trim()); emit("close");
		} catch { toast.error("保存失败，请重试"); }
	}
	async function memberAction(userId: string, action: string) {
		try {
			if (action === "editor" || action === "viewer") await axios.patch(apiUrl(`${base}/members/${userId}`), { role: action }, options());
			else await axios.post(apiUrl(`${base}/members/${userId}/${action}`), {}, options());
			await load();
		} catch { toast.error("操作失败，请重试"); }
	}
	function leave() {
		confirmation.value = { title: "退出房间", message: "退出后，房间将从你的列表中移除。如加入规则允许，你仍可以重新加入。", action: "确认退出", run: async () => {
			try { await axios.post(apiUrl(`${base}/leave`), {}, options()); emit("exit"); emit("close"); }
			catch { toast.error("退出失败，请重试"); }
		} };
	}
	function transfer(userId: string, nickname: string) {
		const nextRole = savedDefaultRole.value === "editor" ? "编辑者" : "只读者";
		confirmation.value = { title: "转让房主", message: `向 ${nickname} 发起转让？对方接受后，你将成为${nextRole}。`, action: "发起转让", run: async () => {
			try { await axios.post(apiUrl(`${base}/transfer`), { userId }, options()); toast.success("转让请求已发送，等待对方确认"); }
			catch { toast.error("发起转让失败"); }
		} };
	}
	function deleteRoom() {
		confirmation.value = { title: "永久删除房间", message: "房间及全部白板内容将被永久删除，所有成员都将失去访问权限。此操作无法撤销。", action: "确认删除", run: async () => {
			try { await axios.delete(apiUrl(base), options()); emit("exit"); emit("close"); }
			catch { toast.error("删除失败，请重试"); }
		} };
	}
	onMounted(() => { void load(); dialogRef.value?.focus(); });
</script>

<template>
 <Teleport to="body"><div class="entry-modal" @click.self="emit('close')" @keydown.esc="emit('close')"><section ref="dialogRef" tabindex="-1" class="entry-dialog entry-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
  <div class="entry-dialog-header"><div><h2 id="settings-title">房间设置</h2><p>{{ roomName }} · {{ roomId }}</p></div><button class="entry-icon-button" aria-label="关闭" @click="emit('close')"><X :size="18"/></button></div>
  <div class="entry-settings-scroll"><div v-if="role === 'owner'" class="entry-settings-section"><div class="entry-settings-title"><ShieldCheck :size="17"/><h3>基本设置</h3></div><div class="entry-form"><label>房间名称<input v-model="name" /></label></div>
   <div class="entry-setting-row"><div><strong>房间号加入</strong><p>允许通过房间号进入房间</p></div><label class="entry-switch"><input v-model="policy.allowRoomCode" type="checkbox" aria-label="允许房间号加入"/><span></span></label></div>
   <div class="entry-setting-row"><div><strong>游客通过房间号加入</strong><p>允许未登录的访客使用房间号</p></div><label class="entry-switch"><input v-model="policy.guestByCode" type="checkbox" aria-label="允许游客通过房间号加入"/><span></span></label></div>
   <div class="entry-setting-row"><div><strong>游客通过邀请链接加入</strong><p>允许未登录的访客使用邀请链接</p></div><label class="entry-switch"><input v-model="policy.guestByInvite" type="checkbox" aria-label="允许游客通过邀请链接加入"/><span></span></label></div>
   <div class="entry-setting-row"><div><strong>新成员默认角色</strong><p>加入时获得的初始权限</p></div><div class="entry-segment"><button :class="{selected: policy.defaultRole === 'editor'}" @click="policy.defaultRole = 'editor'">编辑</button><button :class="{selected: policy.defaultRole === 'viewer'}" @click="policy.defaultRole = 'viewer'">只读</button></div></div>
   <div class="entry-setting-row"><div><strong>修改房间密码</strong><p>为进入房间增加一层验证</p></div><label class="entry-switch"><input v-model="setPassword" type="checkbox" aria-label="修改房间密码"/><span></span></label></div>
   <div v-if="setPassword" class="entry-password-options"><div class="entry-form"><label>新密码 <span class="entry-optional">留空则移除密码</span><input v-model="password" type="password" placeholder="输入新密码"/></label></div><label class="entry-check"><input v-model="requirePassword" type="checkbox"/> 要求已有成员下次重新输入密码</label></div>
   <button class="entry-button primary" @click="save">保存设置</button></div>
   <div class="entry-settings-section"><div class="entry-settings-title"><Users :size="17"/><h3>房间成员</h3><span>{{ members.length }}</span></div><div v-if="!members.length" class="entry-members-empty">暂无成员信息</div><div v-for="member in members" :key="member.userId" class="entry-member"><div class="entry-member-avatar">{{ (member.nickname || '?').slice(0,1) }}</div><div class="entry-member-info"><strong>{{ member.nickname }}</strong><span>{{ member.banned ? '已封禁' : member.role === 'owner' ? '房主' : member.role === 'viewer' ? '只读者' : '编辑者' }}</span></div><div v-if="role === 'owner' && member.role !== 'owner'" class="entry-member-actions"><button v-if="!member.banned" @click="memberAction(member.userId, member.role === 'viewer' ? 'editor' : 'viewer')">设为{{ member.role === 'viewer' ? '编辑' : '只读' }}</button><button v-if="!member.banned" @click="memberAction(member.userId, 'kick')">踢出</button><button @click="memberAction(member.userId, member.banned ? 'unban' : 'ban')">{{ member.banned ? '解除封禁' : '封禁' }}</button><button v-if="!member.banned" @click="transfer(member.userId, member.nickname)">转让房主</button></div></div></div>
   <div class="entry-settings-footer"><button class="entry-danger-link" @click="role !== 'owner' ? leave() : deleteRoom()">{{ role !== 'owner' ? '退出房间' : '永久删除房间' }}</button></div></div>
 </section></div>
 <div v-if="confirmation" class="entry-modal entry-confirm-layer" @click.self="confirmation = null" @keydown.esc.stop="confirmation = null"><section ref="confirmationRef" tabindex="-1" class="entry-dialog entry-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title"><div class="entry-confirm-icon"><AlertTriangle :size="20"/></div><h2 id="confirmation-title">{{ confirmation.title }}</h2><p>{{ confirmation.message }}</p><div class="entry-confirm-actions"><button class="entry-button secondary" :disabled="confirmBusy" @click="confirmation = null">取消</button><button class="entry-button danger" :disabled="confirmBusy" @click="confirmAction">{{ confirmBusy ? '处理中…' : confirmation.action }}</button></div></section></div></Teleport>
</template>
