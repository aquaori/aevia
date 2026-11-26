<!-- File role: cross-route frosted stagehand signboard curtain with blurred backstage workshop Easter eggs and camera focus-pull reveal. -->
<script setup lang="ts">
	import { computed } from "vue";
	import "../entry.css";
	import aeviaIconUrl from "../assets/brand/aevia-icon.png";
	import { roomTransition, STAGE_MESSAGES } from "../states/roomTransitionState";

	const formatRoomCode = (code: string) => {
		if (!code || code.length !== 6) return code;
		return `${code.slice(0, 3)}·${code.slice(3)}`;
	};

	const roomBadgeText = computed(() => {
		const code = formatRoomCode(roomTransition.targetRoomId.value);
		const name = roomTransition.targetRoomName.value;
		if (name && code) return `${name} · #${code}`;
		if (name) return name;
		if (code) return `房间 #${code}`;
		return "Aevia 创作工坊";
	});

	const stageSubtitle = computed(
		() => STAGE_MESSAGES[roomTransition.stageStepIndex.value] ?? STAGE_MESSAGES[0],
	);
</script>

<template>
	<div
		v-if="roomTransition.isCurtainVisible.value"
		class="af-transition-curtain"
		:class="{ 'is-focusing': roomTransition.isFocusingOut.value }"
		role="status"
		aria-live="polite"
	>
		<!-- Backstage Blurred Workshop Easter Eggs (hidden behind frosted veil) -->
		<div class="af-backstage-workshop" aria-hidden="true">
			<div class="af-egg-corners">
				<span class="af-egg-corner tl"></span>
				<span class="af-egg-corner tr"></span>
				<span class="af-egg-corner bl"></span>
				<span class="af-egg-corner br"></span>
			</div>

			<div class="af-egg-roller"></div>

			<div class="af-egg-knock k1">
				<span class="af-knock-ring r1"></span>
				<span class="af-knock-ring r2"></span>
				<span class="af-knock-mallet"></span>
			</div>

			<div class="af-egg-knock k2">
				<span class="af-knock-ring r1"></span>
				<span class="af-knock-ring r2"></span>
				<span class="af-knock-mallet"></span>
			</div>

			<div class="af-egg-sticky s1"></div>
			<div class="af-egg-sticky s2"></div>

			<div class="af-egg-worker w1">
				<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
					<path d="M3 2L17 9.5L10.2 11.4L7.8 18L3 2Z" fill="#4F46E5" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" />
				</svg>
				<span class="af-worker-tag indigo">布景师</span>
			</div>

			<div class="af-egg-worker w2">
				<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
					<path d="M3 2L17 9.5L10.2 11.4L7.8 18L3 2Z" fill="#EC4899" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" />
				</svg>
				<span class="af-worker-tag pink">调色师</span>
			</div>
		</div>

		<!-- Frosted Glass Backdrop Veil (focus pulls 16px -> 0px on reveal) -->
		<div class="af-curtain-glass" aria-hidden="true"></div>

		<!-- Style ①: Suspended Frosted Studio Signboard with Prismatic Braided Cords -->
		<div class="af-hanging-rig">
			<div class="af-hanging-cords" aria-hidden="true">
				<span class="af-cord left"></span>
				<span class="af-cord right"></span>
			</div>

			<div class="af-hanging-board">
				<div class="af-ribbon-lip" aria-hidden="true"></div>

				<div class="af-board-grommets" aria-hidden="true">
					<span class="af-grommet"></span>
					<span class="af-grommet"></span>
				</div>

				<div class="af-board-body">
					<div class="af-board-room-pill">
						<span class="af-live-dot" aria-hidden="true"></span>
						<span>{{ roomBadgeText }}</span>
					</div>

					<div class="af-board-emblem-wrap" aria-hidden="true">
						<span class="af-board-halo"></span>
						<div class="af-board-emblem">
							<img :src="aeviaIconUrl" alt="" />
						</div>
					</div>

					<h2 class="af-board-title">正在准备画布</h2>
					<p class="af-board-subtitle">{{ stageSubtitle }}</p>

					<div class="af-board-shimmer" aria-hidden="true">
						<span></span>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
