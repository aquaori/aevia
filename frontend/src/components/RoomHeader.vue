<script setup lang="ts">
	import { Monitor, Users, Copy, Check, Keyboard } from "lucide-vue-next";

	type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;

	const props = defineProps<{
		visible: boolean;
		roomName: string;
		roomId: string;
		activeMenu: ActiveMenu;
		onlineCount: number;
		hasCopied: boolean;
		onToggleMore: () => void;
		onCopyLink: () => void;
		onOpenMemberList: () => void;
		onToggleShortcuts: () => void;
	}>();
</script>

<template>
	<transition
		enter-active-class="transition duration-300"
		enter-from-class="-translate-y-full opacity-0"
		enter-to-class="translate-y-0 opacity-100"
		leave-active-class="transition duration-300"
		leave-from-class="translate-y-0 opacity-100"
		leave-to-class="-translate-y-full opacity-0"
	>
		<div
			v-if="props.visible"
			class="absolute top-0 left-0 right-0 h-16 px-4 flex justify-between items-center z-10 pointer-events-none"
		>
			<div
				class="pointer-events-auto flex items-center gap-1 hmd:gap-3 bg-white/80 backdrop-blur-md shadow-sm border border-white/50 px-2 hmd:px-2 py-1.5 hmd:py-2 rounded-xl hmd:rounded-2xl"
			>
				<div
					class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-linear-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white shadow-md"
				>
					<Monitor class="w-3 h-3 hmd:w-5 hmd:h-5" />
				</div>
				<div>
					<div class="font-bold text-slate-800 text-sm hmd:text-base leading-tight">
						{{ props.roomName }}
					</div>
					<div
						class="hidden hmd:block text-[10px] text-slate-400 font-mono font-medium tracking-wider"
					>
						ID: {{ props.roomId }}
					</div>
				</div>
			</div>

			<div class="pointer-events-auto flex items-center pr-2">
				<div class="flex items-center">
					<div class="relative z-20">
						<button
							@click="props.onToggleMore"
							class="group flex items-center gap-1.5 hmd:gap-2 p-0.5 hmd:p-1 pr-2.5 hmd:pr-4 rounded-lg hmd:rounded-full bg-white/90 backdrop-blur-md shadow-sm border border-slate-200/60 hover:border-indigo-300 hover:bg-white hover:shadow-md transition-all duration-300"
							:class="{
								'ring-4 ring-indigo-500/10 border-indigo-300 bg-white':
									props.activeMenu === 'more',
							}"
						>
							<div class="relative flex items-center justify-center">
								<div
									class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg hmd:rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center group-hover:bg-indigo-100 transition-colors"
									:class="{
										'bg-indigo-500 text-white group-hover:bg-indigo-600':
											props.activeMenu === 'more',
									}"
								>
									<Users class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
								</div>
								<span class="absolute -top-0.5 -right-0.5 flex h-2 w-2 hmd:h-2.5 hmd:w-2.5">
									<span
										class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"
									></span>
									<span
										class="relative inline-flex rounded-full h-2 w-2 hmd:h-2.5 hmd:w-2.5 bg-emerald-500 border border-white"
									></span>
								</span>
							</div>
							<span
								class="text-[11px] hmd:text-xs font-bold text-slate-700 group-hover:text-indigo-600 transition-colors"
							>
								{{ props.onlineCount }}
								<span class="hidden hmd:inline">人协作中</span>
							</span>
						</button>

						<transition
							enter-active-class="transition duration-200 ease-out"
							enter-from-class="opacity-0 scale-95 translate-y-2"
							enter-to-class="opacity-100 scale-100 translate-y-0"
							leave-active-class="transition duration-150 ease-in"
							leave-from-class="opacity-100 scale-100 translate-y-0"
							leave-to-class="opacity-0 scale-95 translate-y-2"
						>
							<div
								v-if="props.activeMenu === 'more'"
								class="absolute top-full right-0 mt-3 w-56 hmd:w-64 bg-white/95 backdrop-blur-sm border border-white/20 rounded-2xl shadow-2xl overflow-hidden origin-top-right p-1.5 flex flex-col gap-1 z-50"
							>
								<button
									@click="props.onCopyLink"
									class="flex items-center gap-2 hmd:gap-3 w-full p-1.5 hmd:p-3 rounded-xl hover:bg-indigo-50 group text-left transition-colors"
								>
									<div
										class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center group-hover:bg-indigo-200 transition-colors shrink-0"
									>
										<Check v-if="props.hasCopied" class="w-3 h-3 hmd:w-4 hmd:h-4" />
										<Copy v-else class="w-3 h-3 hmd:w-4 hmd:h-4" />
									</div>
									<div class="flex-1">
										<div class="text-[11px] hmd:text-sm font-bold text-slate-700">
											{{ props.hasCopied ? "已复制链接" : "复制邀请链接" }}
										</div>
										<div class="hidden hmd:block text-[10px] text-slate-400">
											点击复制房间地址
										</div>
									</div>
								</button>

								<div class="h-px bg-slate-100 mx-2 my-0.5"></div>

								<button
									@click="props.onOpenMemberList"
									class="flex items-center gap-2 hmd:gap-3 w-full p-1.5 hmd:p-3 rounded-xl hover:bg-slate-50 text-left transition-colors"
								>
									<div
										class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"
									>
										<Users class="w-3 h-3 hmd:w-4 hmd:h-4" />
									</div>
									<div class="flex-1">
										<div class="text-[11px] hmd:text-sm font-bold text-slate-700">在线人数</div>
										<div class="hidden hmd:block text-[10px] text-slate-400">
											{{ props.onlineCount }} 人正在协作
										</div>
									</div>
								</button>

								<button
									@click="props.onToggleShortcuts"
									class="flex items-center gap-2 hmd:gap-3 w-full p-1.5 hmd:p-3 rounded-xl hover:bg-slate-50 text-left transition-colors"
								>
									<div
										class="w-6 h-6 hmd:w-8 hmd:h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"
									>
										<Keyboard class="w-3 h-3 hmd:w-4 hmd:h-4" />
									</div>
									<div class="flex-1">
										<div class="text-[11px] hmd:text-sm font-bold text-slate-700">快捷键指南</div>
										<div class="hidden hmd:block text-[10px] text-slate-400">
											查看常用快捷操作
										</div>
									</div>
								</button>
							</div>
						</transition>
					</div>
				</div>
			</div>
		</div>
	</transition>
</template>
