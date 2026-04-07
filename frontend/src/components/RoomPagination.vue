<script setup lang="ts">
	import { Plus, ChevronLeft, ChevronRight, LayoutGrid } from "lucide-vue-next";

	const props = defineProps<{
		currentPageId: number;
		totalPages: number;
		showPageOverview: boolean;
		prevPage: () => void;
		nextPage: () => void;
		openOverview: () => void;
	}>();
</script>

<template>
	<div
		class="fixed bottom-3 hmd:bottom-4 right-3 hmd:right-4 z-50 flex items-center gap-0.5 hmd:gap-1 bg-white/90 backdrop-blur-sm border border-slate-200/60 p-1 hmd:p-1.5 rounded-xl shadow-lg ring-1 ring-slate-100 touch-none select-none"
	>
		<button
			@click="props.prevPage"
			:disabled="props.currentPageId === 0"
			class="p-1.5 hmd:p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
			title="上一页"
		>
			<ChevronLeft class="w-4 h-4 hmd:w-5 hmd:h-5" />
		</button>

		<button
			@click="props.openOverview"
			class="px-1.5 hmd:px-2 font-mono text-xs hmd:text-sm font-bold text-slate-600 flex items-center justify-center min-w-10 hmd:min-w-12 gap-0.5 hmd:gap-1 hover:bg-slate-100 rounded-lg py-1 transition-colors relative"
			title="页面概览"
		>
			<LayoutGrid
				v-if="props.showPageOverview"
				class="w-3.5 h-3.5 hmd:w-4 hmd:h-4 text-indigo-500"
			/>
			<template v-else>
				<span>{{ props.currentPageId + 1 }}</span>
				<span class="text-slate-300 text-[10px] hmd:text-xs">/</span>
				<span>{{ props.totalPages }}</span>
			</template>
		</button>

		<button
			@click="props.nextPage"
			class="p-1.5 hmd:p-2 rounded-lg transition-colors relative group"
			:class="
				props.currentPageId === props.totalPages - 1
					? 'text-indigo-500 hover:bg-indigo-50'
					: 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
			"
			:title="props.currentPageId === props.totalPages - 1 ? '新建页面' : '下一页'"
		>
			<Plus
				v-if="props.currentPageId === props.totalPages - 1"
				class="w-4 h-4 hmd:w-5 hmd:h-5 group-hover:scale-110 transition-transform"
			/>
			<ChevronRight v-else class="w-4 h-4 hmd:w-5 hmd:h-5" />
		</button>
	</div>
</template>
