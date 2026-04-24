<script setup lang="ts">
	import { LayoutGrid, X, Plus, LoaderCircle } from "lucide-vue-next";
	import type { PageOverviewItem } from "../service/pageOverviewService";

	const props = defineProps<{
		visible: boolean;
		totalPages: number;
		currentPageId: number;
		pages: PageOverviewItem[];
		loading: boolean;
		error: string;
		onClose: () => void;
		goToPage: (index: number) => void;
		onAddPage: () => void;
		onRetry: () => void;
	}>();

	const pageStatus = (pageId: number) => (pageId === props.currentPageId ? "当前页" : "其它页");
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
						<LayoutGrid class="w-6 h-6 hmd:w-8 hmd:h-8 text-indigo-500" /> 页面总览
					</h3>
					<p class="text-slate-500 font-medium mt-1 hmd:mt-2 ml-1 text-xs hmd:text-sm">
						共 {{ props.totalPages }} 页，数据来自服务端总览接口
					</p>
				</div>
				<button
					@click="props.onClose"
					class="p-2 hmd:p-3 rounded-full bg-white hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors shadow-sm"
				>
					<X class="w-5 h-5 hmd:w-6 hmd:h-6" />
				</button>
			</div>

			<div
				v-if="props.loading"
				class="flex-1 flex items-center justify-center text-slate-500 gap-3"
			>
				<LoaderCircle class="w-5 h-5 animate-spin" />
				<span>正在加载页面总览...</span>
			</div>

			<div
				v-else-if="props.error"
				class="flex-1 flex flex-col items-center justify-center gap-4 text-center"
			>
				<p class="text-slate-600 font-medium">{{ props.error }}</p>
				<button
					type="button"
					@click="props.onRetry"
					class="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
				>
					重新加载
				</button>
			</div>

			<div v-else class="flex-1 overflow-y-auto min-h-0 scrollbar-hide pb-20">
				<div
					class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 hmd:gap-6 p-2 hmd:p-4"
				>
					<button
						v-for="page in props.pages"
						:key="page.pageId"
						type="button"
						@click="props.goToPage(page.pageId)"
						class="aspect-video rounded-xl hmd:rounded-2xl border-2 transition-all text-left p-4 hmd:p-5 shadow-sm relative overflow-hidden"
						:class="
							props.currentPageId === page.pageId
								? 'border-indigo-500 bg-white shadow-xl ring-4 ring-indigo-500/15 scale-[1.02]'
								: 'border-slate-200 bg-white/85 hover:border-slate-300 hover:shadow-md hover:-translate-y-1'
						"
					>
						<div
							class="absolute inset-x-0 top-0 h-1"
							:class="props.currentPageId === page.pageId ? 'bg-indigo-500' : 'bg-slate-200'"
						></div>

						<div class="h-full flex flex-col justify-between">
							<div class="flex items-start justify-between gap-3">
								<div>
									<div class="text-[11px] hmd:text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
										Page
									</div>
									<div class="text-3xl hmd:text-4xl font-black text-slate-800 leading-none mt-1">
										{{ page.pageNumber }}
									</div>
								</div>
								<div
									class="px-2.5 py-1 rounded-full text-[10px] hmd:text-xs font-bold"
									:class="
										props.currentPageId === page.pageId
											? 'bg-indigo-100 text-indigo-700'
											: 'bg-slate-100 text-slate-500'
									"
								>
									{{ pageStatus(page.pageId) }}
								</div>
							</div>

							<div class="space-y-2">
								<div class="flex items-center justify-between text-sm hmd:text-base">
									<span class="text-slate-500 font-medium">协作人数</span>
									<span class="text-slate-800 font-bold">
										{{ page.collaboratorCount }} 人
									</span>
								</div>
								<div class="flex items-center gap-2">
									<div
										class="h-2.5 flex-1 rounded-full"
										:class="
											page.collaboratorCount > 0 ? 'bg-emerald-100' : 'bg-slate-100'
										"
									>
										<div
											class="h-full rounded-full transition-all"
											:class="
												page.collaboratorCount > 0
													? 'bg-emerald-500'
													: 'bg-slate-300'
											"
											:style="{
												width: `${Math.min(100, page.collaboratorCount * 24)}%`,
											}"
										></div>
									</div>
									<span class="text-[11px] hmd:text-xs font-semibold text-slate-400 min-w-10 text-right">
										{{ page.collaboratorCount > 0 ? '活跃' : '空闲' }}
									</span>
								</div>
							</div>
						</div>
					</button>

					<button
						type="button"
						@click="props.onAddPage"
						class="aspect-video bg-slate-50/50 rounded-xl hmd:rounded-2xl border-2 border-dashed border-slate-300 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all flex flex-col items-center justify-center gap-2 group text-slate-400 hover:text-indigo-500"
					>
						<div
							class="w-10 h-10 hmd:w-12 hmd:h-12 rounded-full bg-white shadow-sm border border-slate-200 flex items-center justify-center group-hover:scale-110 transition-transform"
						>
							<Plus class="w-5 h-5 hmd:w-6 hmd:h-6" />
						</div>
						<span class="font-bold text-sm">新建页面</span>
					</button>
				</div>
			</div>
		</div>
	</transition>
</template>
