<script setup lang="ts">
	import { Users, X } from "lucide-vue-next";

	const props = defineProps<{
		visible: boolean;
		onlineCount: number;
		memberList: [string, string][];
		currentUsername: string;
		onClose: () => void;
	}>();
</script>

<template>
	<transition
		enter-active-class="transition-transform duration-300 ease-in-out"
		enter-from-class="translate-x-full"
		enter-to-class="translate-x-0"
		leave-active-class="transition-transform duration-300 ease-in-out"
		leave-from-class="translate-x-0"
		leave-to-class="translate-x-full"
	>
		<div
			v-if="props.visible"
			class="fixed top-0 right-0 bottom-0 w-64 hmd:w-72 bg-white/95 backdrop-blur-md shadow-2xl border-l border-slate-100 z-80 flex flex-col pointer-events-auto"
		>
			<div class="flex items-center justify-between p-3 border-b border-slate-100 shrink-0">
				<h3 class="text-sm font-bold text-slate-800 flex items-center gap-2">
					<Users class="w-4 h-4 text-indigo-500" />
					在线协作成员
					<span
						class="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold"
						>{{ props.onlineCount }}</span
					>
				</h3>
				<button
					@click="props.onClose"
					class="p-1.5 -mr-1.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
			<div class="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0 scrollbar-hide">
				<div
					v-if="props.memberList.length === 0"
					class="flex flex-col items-center justify-center py-8 text-slate-400 gap-2"
				>
					<div
						class="w-5 h-5 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin"
					></div>
					<span class="text-xs font-medium">加载中...</span>
				</div>
				<div
					v-for="(member, index) in props.memberList"
					v-else
					:key="index"
					class="flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-50 border border-transparent hover:border-slate-100 transition-colors group"
				>
					<div
						class="relative w-8 h-8 shrink-0 rounded-full bg-linear-to-br from-indigo-100 to-purple-100 text-indigo-600 flex items-center justify-center font-black text-xs shadow-sm shadow-indigo-100/50 border border-indigo-50 group-hover:scale-105 transition-transform duration-300"
					>
						{{ member[1] ? member[1].charAt(0).toUpperCase() : "?" }}
						<span
							class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 border-2 border-white rounded-full"
						></span>
					</div>
					<div class="flex-1 min-w-0 pr-1">
						<div class="font-bold text-slate-700 text-[13px] truncate flex items-center gap-1.5">
							<span class="truncate">{{ member[1] }}</span>
							<span
								v-if="member[1] === props.currentUsername"
								class="px-1.5 py-px rounded-[4px] shrink-0 text-[9px] items-center bg-emerald-50 text-emerald-600 font-bold tracking-widest border border-emerald-100"
								>我</span
							>
						</div>
					</div>
				</div>
			</div>
		</div>
	</transition>
</template>
