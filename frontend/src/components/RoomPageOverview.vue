<script setup lang="ts">
	import { LayoutGrid, X, Plus } from "lucide-vue-next";
	import type { ComponentPublicInstance } from "vue";
	import type { RemoteCursor } from "../utils/type";

	const props = defineProps<{
		visible: boolean;
		totalPages: number;
		currentPageId: number;
		remoteCursors: Map<string, RemoteCursor>;
		onClose: () => void;
		goToPage: (index: number) => void;
		renderPreviewCanvas: (
			el: Element | ComponentPublicInstance | null,
			index: number
		) => void;
		onAddPage: () => void;
	}>();
</script>

<template>
	<transition
		enter-active-class="transition duration-300 ease-out"
		enter-from-class="opacity-0 scale-95"
		enter-to-class="opacity-100 scale-100"
		leave-active-class="transition duration-200 ease-in"
		leave-from-class="opacity-100 scale-100"
		leave-to-class="opacity-0 scale-95"
	>
		<div
			v-if="props.visible"
			class="fixed inset-0 z-90 bg-slate-100/95 backdrop-blur-md flex flex-col p-6 sm:p-10"
		>
			<div class="flex justify-between items-center mb-4 hmd:mb-8">
				<div>
					<h3
						class="text-xl hmd:text-3xl font-black text-slate-800 tracking-tight flex items-center gap-2 hmd:gap-3"
					>
						<LayoutGrid class="w-6 h-6 hmd:w-8 hmd:h-8 text-indigo-500" /> 总览视图
					</h3>
					<p class="text-slate-500 font-medium mt-1 hmd:mt-2 ml-1 text-xs hmd:text-sm">
						总计 {{ props.totalPages }} 张画布
					</p>
				</div>
				<button
					@click="props.onClose"
					class="p-2 hmd:p-3 rounded-full bg-white hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors shadow-sm"
				>
					<X class="w-5 h-5 hmd:w-6 hmd:h-6" />
				</button>
			</div>

			<div class="flex-1 overflow-y-auto min-h-0 scrollbar-hide pb-20">
				<div
					class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 hmd:gap-6 p-2 hmd:p-4"
				>
					<div
						v-for="i in props.totalPages"
						:key="i"
						@click="props.goToPage(i - 1)"
						class="aspect-video bg-white rounded-xl hmd:rounded-2xl shadow-sm border-2 transition-all cursor-pointer relative group overflow-hidden"
						:class="
							props.currentPageId === i - 1
								? 'border-indigo-500 ring-4 ring-indigo-500/20 shadow-xl scale-[1.02]'
								: 'border-transparent hover:border-slate-300 hover:shadow-md hover:-translate-y-1'
						"
					>
						<div
							class="absolute inset-1 hmd:inset-2 bg-slate-50/50 rounded-lg hmd:rounded-xl overflow-hidden border border-slate-100"
						>
							<canvas
								:ref="(el) => props.renderPreviewCanvas(el, i - 1)"
								class="w-full h-full object-contain pointer-events-none"
							></canvas>
						</div>

						<div
							class="absolute bottom-2 hmd:bottom-4 left-2 hmd:left-4 px-2 hmd:px-3 py-0.5 hmd:py-1 bg-white/90 backdrop-blur-sm rounded-md hmd:rounded-lg shadow-sm border border-slate-200 text-[10px] hmd:text-xs font-bold text-slate-600 font-mono"
						>
							{{ i }}
						</div>

						<div
							v-if="props.currentPageId === i - 1"
							class="absolute top-2 hmd:top-4 right-2 hmd:right-4 w-2 h-2 hmd:w-3 hmd:h-3 bg-indigo-500 rounded-full shadow-sm ring-2 ring-white"
						></div>

						<div
							class="absolute bottom-2 hmd:bottom-4 right-2 hmd:right-4 flex -space-x-1.5 hmd:-space-x-2"
						>
							<template
								v-for="cursor in Array.from(props.remoteCursors.values())
									.filter((c) => c.pageId === i - 1)
									.slice(0, 3)"
								:key="cursor.userId"
							>
								<div
									class="w-3 h-3 hmd:w-4 hmd:h-4 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-[8px] font-bold text-white relative z-10"
									:style="{ backgroundColor: cursor.color }"
									:title="cursor.userName + ' 正在此页活跃'"
								>
									{{ cursor.userName.charAt(0).toUpperCase() }}
								</div>
							</template>
							<div
								v-if="Array.from(props.remoteCursors.values()).filter((c) => c.pageId === i - 1).length > 3"
								class="w-3 h-3 hmd:w-4 hmd:h-4 bg-slate-200 text-slate-500 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-[7px] font-bold relative z-0"
							>
								+
							</div>
						</div>
					</div>

					<div
						@click="props.onAddPage"
						class="aspect-video bg-slate-50/50 rounded-xl hmd:rounded-2xl border-2 border-dashed border-slate-300 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all cursor-pointer flex flex-col items-center justify-center gap-1 hmd:gap-2 group text-slate-400 hover:text-indigo-500"
					>
						<div
							class="w-8 h-8 hmd:w-12 hmd:h-12 rounded-full bg-white shadow-sm border border-slate-200 flex items-center justify-center group-hover:scale-110 transition-transform"
						>
							<Plus class="w-4 h-4 hmd:w-6 hmd:h-6" />
						</div>
						<span class="font-bold text-xs hmd:text-sm">新建页面</span>
					</div>
				</div>
			</div>
		</div>
	</transition>
</template>
