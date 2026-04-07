<script setup lang="ts">
	import {
		Keyboard,
		X,
		Pencil,
		Eraser,
		Palette,
		Maximize,
		RotateCcw,
		RotateCw,
	} from "lucide-vue-next";

	const props = defineProps<{
		visible: boolean;
		onClose: () => void;
	}>();
</script>

<template>
	<transition
		enter-active-class="transition duration-300 ease-out"
		enter-from-class="opacity-0"
		enter-to-class="opacity-100"
		leave-active-class="transition duration-200 ease-in"
		leave-from-class="opacity-100"
		leave-to-class="opacity-0"
	>
		<div
			v-if="props.visible"
			class="fixed inset-0 z-90 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
			@click.self="props.onClose"
		>
			<div
				class="bg-white/90 backdrop-blur-sm rounded-4xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto border border-white/50 ring-1 ring-white/50 scrollbar-hide"
			>
				<div
					class="sticky top-0 z-10 flex justify-between items-start px-4 hmd:px-6 py-3 hmd:py-4 bg-white/80 backdrop-blur-xl border-b border-slate-100/50"
				>
					<div>
						<h3
							class="text-lg hmd:text-xl font-black text-slate-800 tracking-tight flex items-center gap-2"
						>
							<Keyboard class="w-4 h-4 hmd:w-5 hmd:h-5 text-indigo-500" />
							快捷指令
							<span
								class="text-[10px] hmd:text-xs font-medium text-slate-400 opacity-80 animate-pulse"
								>(Scrollable)</span
							>
						</h3>
						<p
							class="hidden hmd:block text-slate-400 text-[11px] hmd:text-xs mt-0.5 font-medium"
						>
							高效创作必备
						</p>
					</div>
					<button
						@click="props.onClose"
						class="p-2 -mr-2 -mt-2 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
					>
						<X class="w-6 h-6" />
					</button>
				</div>

				<div class="p-3 hmd:p-4 grid grid-cols-2 gap-2 hmd:gap-3">
					<div
						class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-indigo-100 hover:shadow-md transition-all group"
					>
						<div class="flex items-center gap-2 mb-1">
							<div
								class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<Pencil class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
							</div>
							<span class="font-bold text-slate-700 text-xs hmd:text-sm">画笔</span>
						</div>
						<div class="flex justify-end">
							<kbd
								class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-indigo-200 group-hover:text-indigo-500 transition-colors"
								>P</kbd
							>
						</div>
					</div>

					<div
						class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-pink-100 hover:shadow-md transition-all group"
					>
						<div class="flex items-center gap-2 mb-1">
							<div
								class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-pink-50 text-pink-600 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<Eraser class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
							</div>
							<span class="font-bold text-slate-700 text-xs hmd:text-sm">橡皮擦</span>
						</div>
						<div class="flex justify-end">
							<kbd
								class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-pink-200 group-hover:text-pink-500 transition-colors"
								>E</kbd
							>
						</div>
					</div>

					<div
						class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-orange-100 hover:shadow-md transition-all group"
					>
						<div class="flex items-center gap-2 mb-1">
							<div
								class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-orange-50 text-orange-600 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<Palette class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
							</div>
							<span class="font-bold text-slate-700 text-xs hmd:text-sm">调色板</span>
						</div>
						<div class="flex justify-end">
							<kbd
								class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-orange-200 group-hover:text-orange-500 transition-colors"
								>C</kbd
							>
						</div>
					</div>

					<div
						class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-blue-100 hover:shadow-md transition-all group"
					>
						<div class="flex items-center gap-2 mb-1">
							<div
								class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<Maximize class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
							</div>
							<span class="font-bold text-slate-700 text-xs hmd:text-sm">全屏</span>
						</div>
						<div class="flex justify-end">
							<kbd
								class="px-1.5 py-0.5 bg-slate-100 rounded-lg border-b-2 border-slate-200 font-mono text-[10px] hmd:text-xs font-bold text-slate-500 group-hover:bg-white group-hover:border-blue-200 group-hover:text-blue-500 transition-colors"
								>F</kbd
							>
						</div>
					</div>

					<div
						class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-slate-200 hover:shadow-md transition-all group"
					>
						<div class="flex items-center gap-2 mb-1">
							<div
								class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<RotateCcw class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
							</div>
							<span class="font-bold text-slate-700 text-xs hmd:text-sm">撤销</span>
						</div>
						<div class="flex justify-end gap-1">
							<kbd
								class="px-1 py-0.5 bg-slate-100 rounded-md border-b-2 border-slate-200 font-mono text-[10px] font-bold text-slate-500 group-hover:bg-white group-hover:border-slate-300 group-hover:text-slate-700 transition-colors"
								>Ctrl+Z</kbd
							>
						</div>
					</div>

					<div
						class="p-2 hmd:p-3 rounded-xl hmd:rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-slate-200 hover:shadow-md transition-all group"
					>
						<div class="flex items-center gap-2 mb-1">
							<div
								class="w-6 h-6 hmd:w-7 hmd:h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform"
							>
								<RotateCw class="w-3 h-3 hmd:w-3.5 hmd:h-3.5" />
							</div>
							<span class="font-bold text-slate-700 text-xs hmd:text-sm">重做</span>
						</div>
						<div class="flex justify-end gap-1">
							<kbd
								class="px-1 py-0.5 bg-slate-100 rounded-md border-b-2 border-slate-200 font-mono text-[10px] font-bold text-slate-500 group-hover:bg-white group-hover:border-slate-300 group-hover:text-slate-700 transition-colors"
								>Ctrl+Y</kbd
							>
						</div>
					</div>
				</div>

				<div
					class="px-4 hmd:px-6 py-2 hmd:py-3 bg-slate-50 border-t border-slate-100 text-center sticky bottom-0 z-10 hidden hsm:block"
				>
					<button
						@click="props.onClose"
						class="text-xs hmd:text-sm font-bold text-indigo-500 hover:text-indigo-600 transition-colors"
					>
						我知道了
					</button>
				</div>
			</div>
		</div>
	</transition>
</template>
