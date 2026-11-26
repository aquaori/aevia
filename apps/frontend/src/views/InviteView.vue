<script setup lang="ts">
	import { ref, onMounted, watch, nextTick } from "vue";
	import { useRoute, useRouter } from "vue-router";
	import {
		ArrowLeft,
		ArrowRight,
		Loader2,
		Lock,
	} from "lucide-vue-next";
	import "../entry.css";
	import axios from "axios";
	import { toast } from "vue-sonner";
	import { useUserStore } from "../store/userStore";
	import { useAccountStore } from "../store/accountStore";
	import { roomTransition } from "../states/roomTransitionState";
	import { getInviteMeta } from "../service/sessionApi";
	import { apiUrl } from "../config/endpoints";
	import AccountPanel from "../components/AccountPanel.vue";
	import aeviaLogoUrl from "../assets/brand/aevia-logo.png";
	import aeviaIconUrl from "../assets/brand/aevia-icon.png";

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
	const showOptionalPassword = ref(false);
	const inviteError = ref(false);

	const accountPanelRef = ref<InstanceType<typeof AccountPanel> | null>(null);
	const passwordInputRef = ref<HTMLInputElement | null>(null);

	const formatRoomCode = (code: string) => {
		if (!code || code.length !== 6) return code || "---·---";
		return `${code.slice(0, 3)}·${code.slice(3)}`;
	};

	watch(
		() => accountStore.account,
		(value) => {
			if (value) {
				username.value = value.nickname;
			}
		},
		{ immediate: true },
	);

	onMounted(() => {
		void accountStore.refresh();
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
				.post(apiUrl(`/v2/rooms/${encodeURIComponent(roomId.value)}/admission`), {
					roomId: roomId.value,
					userName: username.value,
					password: password.value,
					inviteToken: token,
				}, { headers: accountStore.token ? accountStore.headers() : {} })
				.then(async (res) => {
					if (res.data.code === 200) {
						localStorage.setItem("wb_username", username.value);
						userStore.setToken(res.data.data.sessionToken || res.data.data.token);
						userStore.setSessionExpiresAt(res.data.data.expiresAt ?? null);
						userStore.setRoomRole(res.data.data.role || "editor");
						await roomTransition.beginRoomEntryTransition({
							roomId: roomId.value,
							roomName: roomName.value,
						});
						await router.push({ name: "room" });
					} else {
						console.error("Error joining room: ", res.data.msg || "未知错误");
					}
				});
		} catch (err: unknown) {
			const responseError = err as ResponseError;
			if (responseError.response?.data?.msg === "Password incorrect") {
				if (!passwordRequired.value && !showOptionalPassword.value) {
					showOptionalPassword.value = true;
					toast.info("此房间需要密码验证，请输入后进入");
					await nextTick();
					passwordInputRef.value?.focus();
				} else {
					toast.error("密码错误");
				}
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
 <div class="entry-app af-invite-scene" :class="{ 'is-stage-clearing': roomTransition.isClearingStage.value }">
  <!-- Sweeping Aevia Prismatic Ribbon Artwork Backdrop -->
  <svg class="af-invite-ribbon-bg" viewBox="0 0 1440 900" fill="none" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
   <defs>
    <linearGradient id="afInviteRibbon" x1="120" y1="740" x2="1320" y2="180" gradientUnits="userSpaceOnUse">
     <stop offset="0%" stop-color="#2563EB" stop-opacity="0.16" />
     <stop offset="38%" stop-color="#7C3AED" stop-opacity="0.16" />
     <stop offset="72%" stop-color="#EC4899" stop-opacity="0.15" />
     <stop offset="100%" stop-color="#F59E0B" stop-opacity="0.16" />
    </linearGradient>
   </defs>
   <path
    d="M-60 720C180 510 340 760 610 470C840 220 1040 530 1500 220"
    stroke="url(#afInviteRibbon)"
    stroke-width="26"
    stroke-linecap="round"
   />
   <path
    d="M80 210C290 360 440 160 660 320"
    stroke="#6366F1"
    stroke-opacity="0.14"
    stroke-width="3"
    stroke-linecap="round"
    stroke-dasharray="7 9"
   />
   <circle cx="1160" cy="640" r="46" stroke="#EC4899" stroke-opacity="0.18" stroke-width="2.5" stroke-dasharray="6 6" />
  </svg>

  <header class="af-minimal-header">
   <div class="af-minimal-header-inner">
    <div class="af-header-pill">
     <a href="/" class="entry-brand">
      <img :src="aeviaLogoUrl" alt="Aevia" class="entry-brand-logo" />
      <span class="sr-only">Aevia</span>
      <span class="af-ctx-pill">房间邀请</span>
     </a>
    </div>
    <div class="af-header-actions">
     <a href="/" class="af-header-link"><ArrowLeft :size="14" /><span>返回首页</span></a>
     <AccountPanel ref="accountPanelRef" />
    </div>
   </div>
  </header>

  <main class="af-invite-stage">
   <!-- Ambient Washi-Tape Sticky Notes & Live Cursor -->
   <div class="af-sticky-note yellow af-invite-prop-left" aria-hidden="true">
    <div class="af-sticky-tag"><span>画布便签</span></div>
    <div class="af-sticky-text">伙伴已经铺好框架与灵感便利贴，等你一起补全！</div>
    <div class="af-sticky-meta">实时多人同屏</div>
   </div>

   <div class="af-sticky-note pink af-invite-prop-right" aria-hidden="true">
    <div class="af-sticky-tag"><span>快捷创作</span></div>
    <div class="af-sticky-text">进房就能使用钢笔、荧光笔与贴纸自由涂鸦。</div>
    <div class="af-sticky-meta">无需下载插件</div>
   </div>

   <div class="af-collab-cursor af-invite-cursor af-drift-a" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
     <path d="M3 2L17 9.5L10.2 11.4L7.8 18L3 2Z" fill="#4F46E5" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
    <span class="af-cursor-pill indigo">同屏画布已就绪</span>
   </div>

   <!-- Collectible Perforated Studio Boarding Pass -->
   <div class="af-ticket-stack">
    <article class="af-ticket">
     <div class="af-ticket-lanyard" :class="{ 'is-error': inviteError }">
      <div class="af-ticket-slot" aria-hidden="true"></div>

      <div class="af-ticket-hero">
       <div class="af-invite-top-row">
        <span class="af-invite-badge">画布协作邀请</span>
        <span v-if="inviteError" class="af-invite-status error">
         <span class="af-live-dot" aria-hidden="true"></span>链接已失效
        </span>
        <span v-else-if="roomId" class="af-invite-status" :class="passwordRequired ? 'locked' : 'open'">
         <span class="af-live-dot" aria-hidden="true"></span>{{ passwordRequired ? '需验证密码' : '免密直接通行' }}
        </span>
       </div>

       <div class="af-invite-room-head">
        <div class="af-invite-icon-tile" aria-hidden="true">
         <img :src="aeviaIconUrl" alt="" />
        </div>
        <div>
         <h1>{{ inviteError ? '邀请链接无效或已过期' : (roomName || '正在同步画布信息…') }}</h1>
         <div class="af-invite-coord">ID: #{{ inviteError ? '---·---' : formatRoomCode(roomId) }}</div>
        </div>
       </div>

       <div v-if="!inviteError" class="af-ticket-chips" aria-hidden="true">
        <span class="af-ticket-chip">钢笔</span>
        <span class="af-ticket-chip">荧光笔</span>
        <span class="af-ticket-chip">便签</span>
        <span class="af-ticket-chip">贴纸</span>
       </div>
      </div>
     </div>

     <!-- Perforated Tear-Off Seam -->
     <div class="af-ticket-tear" aria-hidden="true">
      <div class="af-ticket-tear-line"></div>
      <span class="af-ticket-tear-tag">确认署名 · 即刻登板</span>
     </div>

     <div class="af-ticket-body">
      <template v-if="!inviteError">
       <p class="af-invite-lead">确认显示名称后，即可拿着这张通行卡进入实时协作白板。</p>

       <div class="entry-form">
        <label>
         <span class="entry-label-head">
          <span>你的名字</span>
          <button
           v-if="accountStore.account"
           type="button"
           class="af-switch-account"
           @click="accountPanelRef?.openDialog()"
          >
           切换账号
          </button>
         </span>
         <input
          v-model="username"
          :disabled="!!accountStore.account"
          placeholder="输入名字"
          @keyup.enter="joinRoom"
         />
        </label>

        <div v-if="!passwordRequired && !showOptionalPassword">
         <button type="button" class="af-password-disclosure" @click="showOptionalPassword = true">
          <Lock :size="12" /> 房间设有访问密码？
         </button>
        </div>

        <label v-else>
         <span class="entry-label-head">
          <span>房间密码</span>
          <span class="entry-optional" :class="{ required: passwordRequired }">{{ passwordRequired ? '必填' : '如有' }}</span>
         </span>
         <input
          ref="passwordInputRef"
          v-model="password"
          type="password"
          placeholder="输入房间密码"
          @keyup.enter="joinRoom"
         />
        </label>
       </div>

       <button
        type="button"
        class="entry-button primary wide"
        :disabled="!roomId || !username || isLoading"
        @click="joinRoom"
       >
        <Loader2 v-if="isLoading" class="entry-spin" :size="15" />
        <template v-else>加入协作画布 <ArrowRight :size="15" /></template>
       </button>
      </template>

      <template v-else>
       <div class="af-invite-error-msg">
        该邀请链接可能已过期、被房主撤销，或对应房间已删除。请联系邀请人重新生成链接，或返回首页通过 6 位房间号加入。
       </div>
       <a class="entry-button secondary wide" href="/">返回首页</a>
      </template>
     </div>
    </article>
   </div>
  </main>
 </div>
</template>
