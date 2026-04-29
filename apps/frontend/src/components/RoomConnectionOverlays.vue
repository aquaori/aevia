<script setup lang="ts">
	import { RotateCw, X } from "lucide-vue-next";

	const props = defineProps<{
		isReconnecting: boolean;
		reconnectCount: number;
		maxReconnect: number;
		reconnectFailed: boolean;
		reconnectFailureMessage?: string;
		onRetryReconnect: () => void;
		onBackHome: () => void;
	}>();
</script>

<template>
	<div
		v-if="props.isReconnecting"
		class="fixed inset-0 z-100 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
	>
		<div
			class="bg-white rounded-2xl p-4 sm:p-8 max-h-full overflow-y-auto max-w-sm w-full shadow-2xl flex flex-col items-center text-center"
		>
			<RotateCw
				class="w-8 h-8 sm:w-12 sm:h-12 text-indigo-500 animate-[spin_2s_linear_infinite] mb-2 sm:mb-4"
			/>
			<h3 class="text-lg sm:text-xl font-bold text-slate-800 mb-1 sm:mb-2">正在尝试重连...</h3>
			<p class="text-slate-500 mb-3 sm:mb-4 text-xs sm:text-base">与服务器的连接已断开</p>
			<div class="w-full bg-slate-100 rounded-full h-1.5 sm:h-2 mb-2 overflow-hidden items-start flex">
				<div
					class="bg-indigo-500 h-1.5 sm:h-2 rounded-full transition-all duration-300"
					:style="{ width: (props.reconnectCount / props.maxReconnect) * 100 + '%' }"
				></div>
			</div>
			<p class="text-xs sm:text-sm font-medium text-slate-400">
				第 {{ props.reconnectCount }} / {{ props.maxReconnect }} 次尝试
			</p>
		</div>
	</div>

	<div
		v-if="props.reconnectFailed"
		class="fixed inset-0 z-100 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-2 sm:p-4"
	>
		<div
			class="bg-white rounded-2xl p-4 sm:p-8 max-h-full overflow-y-auto max-w-sm w-full shadow-2xl flex flex-col items-center text-center pointer-events-auto"
		>
			<div
				class="w-12 h-12 sm:w-16 sm:h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-3 sm:mb-6"
			>
				<X class="w-6 h-6 sm:w-8 sm:h-8" />
			</div>
			<h3 class="text-lg sm:text-xl font-bold text-slate-800 mb-1 sm:mb-2">连接失败</h3>
			<p class="text-slate-500 mb-4 sm:mb-6 text-xs sm:text-base">
				{{ props.reconnectFailureMessage || "服务器连接超时，请返回首页或重新尝试连接。" }}
			</p>
			<div class="flex gap-2 sm:gap-3 w-full">
				<button
					@click="props.onBackHome"
					class="flex-1 py-2 sm:py-3 px-2 sm:px-4 text-sm sm:text-base bg-slate-100 text-slate-700 hover:bg-slate-200 font-bold rounded-xl transition-colors"
				>
					返回首页
				</button>
				<button
					@click="props.onRetryReconnect"
					class="flex-1 py-2 sm:py-3 px-2 sm:px-4 text-sm sm:text-base bg-indigo-600 text-white hover:bg-indigo-700 font-bold rounded-xl transition-colors"
				>
					重试连接
				</button>
			</div>
		</div>
	</div>
</template>
